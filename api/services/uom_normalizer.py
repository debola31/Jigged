"""Unit-of-measure normalization for inventory imports.

Two-phase resolution:

1. **Alias map** — case-insensitive lookup against the canonical units and
   common abbreviations (`IN` -> `inches`, `EA` -> `each`, etc). This is a
   pure-Python operation with no AI cost.

2. **AI inference** — for rows where the alias map fails AND we have item
   name/description context, ask Claude to pick a canonical unit. Calls
   are batched (deduped by raw-uom + name) and capped to keep token cost
   low.

The canonical set mirrors `lib/unitPresets.ts`. Keep them in sync by hand.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

import anthropic

logger = logging.getLogger(__name__)


# Mirror of lib/unitPresets.ts UNIT_CATEGORIES (canonical names only).
CANONICAL_UNITS: set[str] = {
    # weight
    "pounds", "kilograms", "ounces", "grams",
    # length
    "inches", "feet", "millimeters", "centimeters", "meters",
    # volume
    "gallons", "liters", "quarts", "milliliters", "fluid ounces",
    # count
    "pieces", "each", "dozen",
    # area
    "square inches", "square feet", "square centimeters", "square meters",
}

# Mirror of lib/unitPresets.ts UNIT_ALIASES (lowercased keys for matching).
UNIT_ALIASES: dict[str, str] = {
    # count
    "ea": "each",
    "pcs": "pieces",
    "pc": "pieces",
    "dz": "dozen",
    # weight
    "lb": "pounds",
    "lbs": "pounds",
    "kg": "kilograms",
    "kgs": "kilograms",
    "oz": "ounces",
    "g": "grams",
    # length
    "in": "inches",
    "ft": "feet",
    "mm": "millimeters",
    "cm": "centimeters",
    "m": "meters",
    # volume
    "gal": "gallons",
    "l": "liters",
    "qt": "quarts",
    "ml": "milliliters",
    "fl oz": "fluid ounces",
    # area
    "sq in": "square inches",
    "sq ft": "square feet",
    "sq cm": "square centimeters",
    "sq m": "square meters",
}


def normalize_uom_alias(raw: str) -> Optional[str]:
    """Map a raw UOM string to a canonical name without calling AI.

    Returns the canonical unit, or None if the value can't be resolved by
    alias lookup alone (caller may then fall through to AI inference).
    """
    if not raw:
        return None

    cleaned = raw.strip().lower()
    if not cleaned:
        return None

    if cleaned in CANONICAL_UNITS:
        return cleaned

    if cleaned in UNIT_ALIASES:
        return UNIT_ALIASES[cleaned]

    return None


_AI_PROMPT_TEMPLATE = """You are normalizing units of measurement for a manufacturing inventory import.

For each item below, decide which canonical unit best matches its raw UOM string,
falling back to the item name/description when the raw UOM is empty or ambiguous.

## Canonical units (return EXACTLY one of these, or null if unsure):
{canonical_units}

## Items to normalize:
{items_json}

## Rules:
- Return null if you cannot make a confident pick (better to skip than guess wrong).
- Do NOT invent units. Only use values from the canonical list.
- For length stock (bars, tubes, sheets): typically `feet` or `inches`.
- For powders, granular materials: typically `pounds` or `kilograms`.
- For piece-count items (washers, fasteners): typically `each` or `pieces`.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{{
  "resolutions": [
    {{"key": "<key from input>", "canonical": "<one of the canonical units, or null>"}}
  ]
}}"""


def infer_uom_with_ai(
    items: list[dict],
    *,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> dict[str, Optional[str]]:
    """Batched Claude call to infer canonical units from name/description context.

    Args:
        items: List of dicts with keys ``key`` (caller-defined identifier),
            ``raw_uom``, ``name``, ``description``. Caller is responsible for
            deduping before calling.

    Returns:
        Dict mapping each input key to a canonical unit (or None when the
        model cannot decide). Keys missing from the response are treated as
        None.
    """
    if not items:
        return {}

    api_key = api_key or os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        logger.warning("ANTHROPIC_API_KEY not set; skipping UOM inference")
        return {item["key"]: None for item in items}

    client = anthropic.Anthropic(api_key=api_key)
    model_name = model or "claude-sonnet-4-20250514"

    prompt = _AI_PROMPT_TEMPLATE.format(
        canonical_units=json.dumps(sorted(CANONICAL_UNITS)),
        items_json=json.dumps(items, indent=2),
    )

    try:
        response = client.messages.create(
            model=model_name,
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()

        if text.startswith("```"):
            lines = text.split("\n")
            inner: list[str] = []
            in_block = False
            for line in lines:
                if line.startswith("```"):
                    if in_block:
                        break
                    in_block = True
                    continue
                if in_block:
                    inner.append(line)
            text = "\n".join(inner)

        data = json.loads(text)
    except Exception as e:
        logger.warning(f"UOM inference call failed: {e}")
        return {item["key"]: None for item in items}

    out: dict[str, Optional[str]] = {item["key"]: None for item in items}
    for entry in data.get("resolutions", []):
        key = entry.get("key")
        canonical = entry.get("canonical")
        if key in out and canonical in CANONICAL_UNITS:
            out[key] = canonical
    return out


def resolve_units_for_rows(
    rows: list[dict[str, str]],
    *,
    name_column: Optional[str],
    description_column: Optional[str],
    uom_column: Optional[str],
    max_ai_items: int = 100,
) -> dict[int, Optional[str]]:
    """Resolve canonical UOMs for each row, using alias lookup then AI inference.

    Returns a mapping from 1-based row_number to canonical UOM (or None for
    rows where neither alias nor AI could decide). Rows whose raw UOM is
    already canonical or empty are still represented in the dict (with the
    canonical value or None respectively) to make the caller's logic
    uniform.
    """
    if not uom_column:
        return {}

    resolutions: dict[int, Optional[str]] = {}

    # Phase 1: alias-only resolution. Collect rows that need AI assist.
    # Empty UOMs still go to phase 2 if we have a name — the AI can often
    # infer the unit from "Aluminum Bar Stock" alone.
    unresolved: list[tuple[int, str, str, str]] = []  # (row_number, raw, name, description)
    for i, row in enumerate(rows):
        row_number = i + 1
        raw_uom = (row.get(uom_column, "") or "").strip()
        name = (row.get(name_column, "") or "").strip() if name_column else ""
        description = (row.get(description_column, "") or "").strip() if description_column else ""

        if raw_uom:
            canonical = normalize_uom_alias(raw_uom)
            if canonical is not None:
                resolutions[row_number] = canonical
                continue

        if not name:
            # No raw UOM AND no name to infer from — leave unresolved.
            resolutions[row_number] = None
            continue

        unresolved.append((row_number, raw_uom, name, description))

    if not unresolved:
        return resolutions

    # Phase 2: dedupe and call AI. Key by (raw_uom, name, description).
    deduped: dict[tuple[str, str, str], list[int]] = {}
    for row_number, raw, name, description in unresolved:
        key = (raw.lower(), name.lower(), description.lower())
        deduped.setdefault(key, []).append(row_number)

    if len(deduped) > max_ai_items:
        logger.info(
            f"UOM inference batch capped: {len(deduped)} unique items, "
            f"only sending first {max_ai_items} to AI; remainder will be None"
        )
        keys_to_send = list(deduped.keys())[:max_ai_items]
    else:
        keys_to_send = list(deduped.keys())

    items_for_ai = []
    for idx, key in enumerate(keys_to_send):
        raw, name, description = key
        items_for_ai.append({
            "key": str(idx),
            "raw_uom": raw,
            "name": name,
            "description": description,
        })

    inferences = infer_uom_with_ai(items_for_ai)

    for idx, key in enumerate(keys_to_send):
        canonical = inferences.get(str(idx))
        for row_number in deduped[key]:
            resolutions[row_number] = canonical

    # Anything past the AI cap stays unresolved.
    for key in list(deduped.keys())[max_ai_items:]:
        for row_number in deduped[key]:
            resolutions[row_number] = None

    return resolutions
