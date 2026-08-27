"""Claude (Anthropic) AI provider implementation."""

import json
import logging
import os
from typing import Optional

import anthropic

from .base_provider import (
    AIProvider,
    ErpDetectionResult,
    FileStructure,
    FixSuggestionResult,
    ImportNarrativeResult,
    StructureResult,
)
from .model_config import DEFAULT_ANTHROPIC_MODEL

logger = logging.getLogger(__name__)


def _parse_json_response(response_text: str) -> dict:
    """Extract a JSON object from a Claude text response.

    Strips a leading/trailing ```json ... ``` fence if present, then json.loads.
    Raises json.JSONDecodeError on malformed content (callers handle the fallback).
    Shared by every ClaudeProvider method that expects a JSON object back.
    """
    text = response_text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        json_lines: list[str] = []
        in_json = False
        for line in lines:
            if line.startswith("```") and not in_json:
                in_json = True
                continue
            elif line.startswith("```") and in_json:
                break
            elif in_json:
                json_lines.append(line)
        text = "\n".join(json_lines)
    return json.loads(text)


def _clamp01(value) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


STRUCTURE_PROMPT_TEMPLATE = """You are analyzing CSV files a machine shop exported from its previous manufacturing ERP, to help it migrate the data into a new platform. Do TWO things: (1) classify each file to one entity type and map its raw columns to canonical fields, and (2) identify the likely source ERP.

## Canonical entity schemas (map raw columns onto THESE fields):
{schemas_json}

## Known source ERPs (for naming only — do not force a match):
{erp_catalog_json}

## Uploaded files (raw headers + one sample value per non-empty column):
{files_json}

## Instructions:
1. For each file, choose the single best `entity_type` from: {entity_names}, or "unknown" if none fits.
2. Build `column_roles`: a map of canonical_field -> the RAW header (verbatim from that file) that holds it. Only include fields you can identify; omit the rest. NEVER invent a header that isn't in the file, and NEVER invent a canonical field that isn't in that entity's schema.
3. Give `entity_confidence` 0.0-1.0.
4. Detect the source ERP: set `source` (a short slug like "jobboss2"/"e2"/"tangle" or your best guess), `display_name`, `confidence` 0.0-1.0, `matched_headers` (the specific headers that point to it, each with a short `signal`), a one-sentence `evidence`, and up to 2 `alternatives`. If nothing clearly indicates an ERP, return source "unknown" with low confidence — do NOT guess to seem confident.

Return ONLY valid JSON in this exact shape (no markdown, no prose):
{{
  "erp": {{"source": "unknown", "display_name": "Unknown", "confidence": 0.0, "matched_headers": [{{"header": "WorkCenter", "signal": "job-shop op vocabulary"}}], "evidence": "", "alternatives": [{{"source": "e2", "confidence": 0.3}}]}},
  "files": [
    {{"filename": "parts.csv", "entity_type": "parts", "entity_confidence": 0.9, "column_roles": {{"part_name": "PartNo", "preferred_vendor_name": "Vendor"}}}}
  ]
}}"""


NARRATIVE_PROMPT_TEMPLATE = """You are helping a machine-shop owner get their legacy data ready to import into a new manufacturing platform. Write a clear, practical, plain-English report about what's in their files and what to fix. Audience: a hands-on shop owner (not technical). Be thorough and specific — surface everything that would help them get all their data in correctly.

## Detected source ERP:
{erp_json}

## Files uploaded:
{files_json}

## Deterministic findings (the ONLY facts you may cite):
{findings_json}

## Grounding rules (critical):
- You may reference ONLY the findings above. Every number you state MUST be the `count` of a specific finding — do not compute or invent any other number.
- Do NOT introduce any issue, record count, or ERP behavior that is not in the findings.
- If there is little to report, say so plainly. Never pad with invented problems.
- `gotchas` are OPTIONAL, clearly-hedged tips about likely source-system quirks worth double-checking; phrase them as "worth verifying", never as established fact.

Return ONLY valid JSON in this exact shape (no markdown, plain text in every string):
{{
  "summary": "2-4 short paragraphs summarizing the import review, citing finding counts.",
  "recommendations": ["ordered, concrete next steps the owner can act on"],
  "gotchas": [{{"title": "short", "detail": "why it might matter", "recommended_action": "what to check"}}]
}}"""




class ClaudeProvider(AIProvider):
    """Claude (Anthropic) AI provider."""

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        """Initialize Claude provider.

        Args:
            api_key: Anthropic API key. If not provided, uses ANTHROPIC_API_KEY env var.
            model: Model to use. Defaults to DEFAULT_ANTHROPIC_MODEL (model_config.py).
        """
        self.api_key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not self.api_key:
            raise ValueError("ANTHROPIC_API_KEY is required")

        self.client = anthropic.Anthropic(api_key=self.api_key)
        self.model = model or DEFAULT_ANTHROPIC_MODEL

    @property
    def provider_name(self) -> str:
        return "anthropic"


    async def analyze_structure(
        self,
        files: list[dict],
        entity_schemas: dict[str, dict],
        erp_catalog: list[dict],
    ) -> StructureResult:
        """Classify each file (entity + raw->canonical column_roles) and detect the ERP."""

        def _fmt_samples(samples: dict) -> str:
            lines = [f'    {c}: "{v}"' for c, v in (samples or {}).items()]
            return "\n".join(lines) if lines else "    (no sample data)"

        files_block = "\n".join(
            f"### {f.get('filename', '(unnamed)')}\n"
            f"  headers: {json.dumps(f.get('headers', []))}\n"
            f"  samples:\n{_fmt_samples(f.get('column_samples'))}"
            for f in files
        )
        prompt = STRUCTURE_PROMPT_TEMPLATE.format(
            schemas_json=json.dumps(entity_schemas, indent=2),
            erp_catalog_json=json.dumps(erp_catalog, indent=2),
            files_json=files_block,
            entity_names=", ".join(entity_schemas.keys()),
        )

        try:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=8192,
                messages=[{"role": "user", "content": prompt}],
            )
            data = _parse_json_response(response.content[0].text.strip())
        except Exception as e:  # noqa: BLE001 — degrade to unknown, never raise into the route
            logger.warning(f"analyze_structure failed to parse AI response: {e}")
            return StructureResult(
                erp=ErpDetectionResult(evidence=f"ERP detection unavailable: {e}"),
                files=[FileStructure(filename=f.get("filename", "")) for f in files],
            )

        erp_raw = data.get("erp", {}) or {}
        erp = ErpDetectionResult(
            source=str(erp_raw.get("source", "unknown") or "unknown"),
            display_name=str(erp_raw.get("display_name", "Unknown") or "Unknown"),
            confidence=_clamp01(erp_raw.get("confidence", 0.0)),
            matched_headers=[
                {"header": str(m.get("header", "")), "signal": str(m.get("signal", ""))}
                for m in (erp_raw.get("matched_headers") or [])
                if isinstance(m, dict)
            ],
            evidence=str(erp_raw.get("evidence", "") or ""),
            alternatives=[
                {"source": str(a.get("source", "")), "confidence": _clamp01(a.get("confidence", 0.0))}
                for a in (erp_raw.get("alternatives") or [])
                if isinstance(a, dict)
            ],
        )

        valid_headers_by_file = {f.get("filename", ""): set(f.get("headers", []) or []) for f in files}
        file_structs: list[FileStructure] = []
        for item in data.get("files", []):
            if not isinstance(item, dict):
                continue
            fname = str(item.get("filename", ""))
            allowed = valid_headers_by_file.get(fname, set())
            roles_raw = item.get("column_roles", {}) or {}
            # Keep only roles whose raw header actually exists in that file (guards against
            # the model hallucinating a header). If we can't validate the file, keep as-is.
            roles = {
                str(k): str(v)
                for k, v in roles_raw.items()
                if not allowed or str(v) in allowed
            }
            file_structs.append(
                FileStructure(
                    filename=fname,
                    entity_type=str(item.get("entity_type", "unknown") or "unknown"),
                    entity_confidence=_clamp01(item.get("entity_confidence", 0.0)),
                    column_roles=roles,
                )
            )
        return StructureResult(erp=erp, files=file_structs)

    async def generate_import_narrative(
        self,
        erp: dict,
        findings: list[dict],
        file_summaries: list[dict],
    ) -> ImportNarrativeResult:
        """Write a plain-text narrative grounded strictly in the deterministic findings."""
        prompt = NARRATIVE_PROMPT_TEMPLATE.format(
            erp_json=json.dumps(erp, indent=2),
            files_json=json.dumps(file_summaries, indent=2),
            findings_json=json.dumps(findings, indent=2),
        )
        try:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            )
            data = _parse_json_response(response.content[0].text.strip())
        except Exception as e:  # noqa: BLE001 — surface the gap, never fabricate prose
            logger.warning(f"generate_import_narrative failed: {e}")
            return ImportNarrativeResult(available=False)

        recs = [str(r) for r in (data.get("recommendations") or []) if str(r).strip()]
        gotchas = [
            {
                "title": str(g.get("title", "")),
                "detail": str(g.get("detail", "")),
                "recommended_action": str(g.get("recommended_action", "")),
            }
            for g in (data.get("gotchas") or [])
            if isinstance(g, dict) and str(g.get("title", "")).strip()
        ]
        return ImportNarrativeResult(
            summary=str(data.get("summary", "") or ""),
            recommendations=recs,
            gotchas=gotchas,
            available=True,
        )

    async def suggest_fixes(
        self,
        findings: list[dict],
        file_summaries: list[dict],
    ) -> FixSuggestionResult:
        """Per-finding recommended step + uncertainty, grounded strictly in the findings."""
        prompt = (
            "You are helping a non-technical machine-shop owner get their legacy data into a "
            "new system. Below are DATA ISSUES already found in their files — trust these "
            "exactly and never invent numbers.\n\n"
            "For EACH issue, write ONE concrete, plain-language next step the owner can take "
            'with the in-app fix tools (edit a cell, "Find & replace" a column, "Fill blanks", '
            '"Merge look-alikes"). Be specific and encouraging, not technical. If you are NOT '
            'sure your suggestion is right, say so plainly in "uncertainty" (e.g. "I\'m not '
            'certain these are the same — please confirm"). NEVER use confidence scores or '
            "percentages.\n\n"
            f"FILES:\n{json.dumps(file_summaries, indent=2)}\n\n"
            f"ISSUES (echo each finding_id back):\n{json.dumps(findings, indent=2)}\n\n"
            "Return ONLY valid JSON (plain text in every string, no markdown):\n"
            '{"suggestions": [{"finding_id": "<echo the issue id>", "action": "one concrete '
            'step", "uncertainty": "an honest note if unsure, else empty"}]}'
        )
        try:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            )
            data = _parse_json_response(response.content[0].text.strip())
        except Exception as e:  # noqa: BLE001 — surface the gap, never fabricate
            logger.warning(f"suggest_fixes failed: {e}")
            return FixSuggestionResult(available=False)

        suggestions = [
            {
                "finding_id": str(s.get("finding_id", "")),
                "action": str(s.get("action", "")),
                "uncertainty": str(s.get("uncertainty", "")),
            }
            for s in (data.get("suggestions") or [])
            if isinstance(s, dict) and str(s.get("action", "")).strip()
        ]
        return FixSuggestionResult(suggestions=suggestions, available=True)
