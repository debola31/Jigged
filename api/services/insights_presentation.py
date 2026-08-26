"""Turning one AI answer into something the dashboard can render.

Extracted from routes/insights_routes.py 2026-08-25, unchanged, so the DESKTOP
WORKER can run it. These are the deterministic half of the insights feature --
the half that decides a chart is not worth drawing and that a markdown table has
to be flattened -- and with the tool loop moving worker-side they have to run
where the answer is produced, not where the request arrived.

routes/insights_routes.py re-exports every name, so existing call sites and the
two unit-test modules that import from there keep resolving. Same trick as
quickbooks_routes.py keeping `_service_client` pointed at company_auth.
"""
from __future__ import annotations

import json
import math
import re

def _extract_chart_config(content: str) -> dict | None:
    """
    Try to extract a chart_config JSON block from the AI response.
    The AI may include chart configuration as ```json blocks or inline JSON.
    """
    try:
        # Look for ```chart_config or ```json blocks
        if "```" in content:
            blocks = content.split("```")
            for i, block in enumerate(blocks):
                if i % 2 == 1:  # Inside code fence
                    # Remove language identifier if present
                    lines = block.strip().split("\n")
                    if lines[0].strip().lower() in ("json", "chart_config", "chart"):
                        json_text = "\n".join(lines[1:])
                    else:
                        json_text = block.strip()

                    try:
                        data = json.loads(json_text)
                        if isinstance(data, dict) and "chart_type" in data:
                            return data
                    except json.JSONDecodeError:
                        continue
    except Exception:
        pass

    return None


def _strip_code_blocks(content: str) -> str:
    """Remove all fenced code blocks (```...```) from AI response text."""
    if "```" not in content:
        return content.strip()

    parts = content.split("```")
    # Keep only even-indexed parts (outside code fences)
    clean_parts = [parts[i] for i in range(len(parts)) if i % 2 == 0]
    return "\n".join(clean_parts).strip()


# Markdown table separator row, e.g. |---|---| or | :--- | ---: |
_MD_TABLE_SEPARATOR = re.compile(r"^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$")


def _flatten_markdown_tables(content: str) -> str:
    """Collapse any markdown tables in the text into plain readable lines.

    The chat answer renders as plain text in the UI, so a raw markdown table
    shows up as literal `| col | col |` / `|---|---|` ("fake column
    demarcations"). This drops separator rows and rewrites table rows as
    `cell — cell`, leaving non-table lines untouched. Defensive backstop — the
    system prompt also instructs the model not to emit tables.
    """
    if "|" not in content:
        return content

    out: list[str] = []
    for line in content.split("\n"):
        stripped = line.strip()
        # Drop separator rows like |---|---|
        if "-" in stripped and _MD_TABLE_SEPARATOR.match(stripped):
            continue
        # Flatten table rows (start or end with a pipe) into "a — b — c"
        if stripped.startswith("|") or stripped.endswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            cells = [c for c in cells if c]
            if cells:
                out.append(" — ".join(cells))
            continue
        out.append(line)
    return "\n".join(out).strip()


# Inline markdown patterns to neutralize in the plain-text answer. We only touch
# clearly-paired/anchored markup so shop data like a part number "PART_101" or an
# expression "a * b" survives untouched. Underscore emphasis is intentionally NOT
# handled (snake_case identifiers are common in shop data).
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")              # [label](url) -> label
_MD_BOLD = re.compile(r"\*\*(\S(?:.*?\S)?)\*\*")            # **bold** -> bold
_MD_ITALIC = re.compile(r"(?<![\w*])\*(\S(?:.*?\S)?)\*(?![\w*])")  # *italic* -> italic
_MD_CODE = re.compile(r"`([^`]+)`")                         # `code` -> code
_MD_HEADING = re.compile(r"(?m)^\s{0,3}#{1,6}\s+")          # leading ### -> remove


def _strip_inline_markdown(content: str) -> str:
    """Neutralize inline markdown so the plain-text UI shows clean prose.

    Unwraps **bold**, *italic*, `code`, [label](url) -> label, and drops leading
    `#` headings. Only paired/anchored asterisk/backtick patterns are touched, so
    "PART_101" or a literal "a * b" is left intact. Defensive backstop to the
    system prompt (which forbids markdown); runs after table flattening.
    """
    content = _MD_LINK.sub(r"\1", content)
    content = _MD_BOLD.sub(r"\1", content)
    content = _MD_ITALIC.sub(r"\1", content)
    content = _MD_CODE.sub(r"\1", content)
    content = _MD_HEADING.sub("", content)
    return content.strip()


# ---- is this an answer at all? ----------------------------------------------

# OUR OWN MACHINE STRINGS. Whatever else they are, they are not English a shop
# owner can act on, so a final turn carrying one verbatim is a non-answer no
# matter which tool produced it.
_MACHINE_STRINGS = ("SQL_ERROR:", "NOT_PERMITTED:")

# THE SHAPE OF A DATABASE ERROR, NOT THE WORD "ERROR". Anchoring matters in both
# directions: "three jobs came back with an error code" is shop data and must
# pass, and "Jigged has no table for payroll, so that data does not exist" is the
# right answer to the payroll question and must pass too. What does not pass is
# an object name sitting exactly where Postgres puts one.
_ERROR_ECHO = (
    re.compile(r"\bsyntax error\b", re.I),
    re.compile(r"\bSQL[ _]error\b", re.I),
    re.compile(r"\b(column|relation|table|view|function)\s+[\"'`]?[\w.$]+[\"'`]?\s+"
               r"does\s*n[o']?t\s+exist", re.I),
    re.compile(r"\bundefined\s+(column|table|relation|function)\b", re.I),
    re.compile(r"\bquery\s+(execution\s+)?(failed|timed out)\b", re.I),
    re.compile(r"\b(execution|executing) (of )?(the )?(SQL|query)\b[^.\n]{0,40}\bfailed\b", re.I),
    re.compile(r"\bpermission denied\b", re.I),
    re.compile(r"\b(I|the query|the SQL)\b[^.\n]{0,30}\bencountered an error\b", re.I),
)


def looks_like_error_echo(answer: str) -> bool:
    """True when the text is the tool's failure read back, or nothing at all.

    WHAT THIS IS FOR. In the insights A/B every local arm's last turn was the
    error from a query that had failed -- "The column total_price does not
    exist...", "The SQL query encountered a syntax error, please review..." --
    and it was returned as the answer with the job marked succeeded. A shop owner
    cannot tell that from a real answer, which is exactly the silent degradation
    services/llm/errors.py refuses one layer down.

    Two callers, and they weigh it differently ON PURPOSE. The handler gates on
    it only when NO query succeeded, so a grounded answer is never rejected. The
    A/B applies it alone, because scoring has no such duty and cannot see which
    tool results succeeded. Sharing the predicate is what stops the two drifting
    into disagreeing about what an answer is.
    """
    text = (answer or "").strip()
    if not text:
        return True
    if any(marker in text for marker in _MACHINE_STRINGS):
        return True
    return any(pattern.search(text) for pattern in _ERROR_ECHO)


# ---- chart_config validation + deterministic chart-type selection -----------

_ALLOWED_CHART_TYPES = frozenset({"area", "pie", "bar", "bar_horizontal", "sparkline"})
# A chart needs enough points to beat a one-line sentence; below this we downgrade
# to the prose answer (single fact / 1-2 values -> text).
_MIN_CHART_POINTS = 3
# For an exactly-2-point chart, keep it only when the two values are a genuine
# comparison — the smaller is at least this fraction of the larger. A dominant
# top-1 (e.g. 7749 vs 36 -> 0.5%) is a single-fact answer, not a comparison.
_COMPARABLE_RATIO = 0.05


def _coerce_number(value) -> float | None:
    """Best-effort parse of a numeric value; handles '1,234.5' / '$1234'."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            return float(value.replace(",", "").replace("$", "").strip())
        except ValueError:
            return None
    return None


def _comparable(values: list[float]) -> bool:
    """True when two values are close enough in magnitude to be a real comparison."""
    a, b = abs(values[0]), abs(values[1])
    hi = max(a, b)
    if hi == 0:
        return False
    return (min(a, b) / hi) >= _COMPARABLE_RATIO


def _validate_chart_config(config: dict | None) -> dict | None:
    """Return the chart_config only if it will render an intelligible chart.

    Otherwise return None so the chat answers in prose. The prose answer is
    always kept — a dropped chart is an explicit downgrade, never a blank card
    (honors the repo's "no silent fallbacks" rule). Validated against the
    config's own embedded data:
      - chart_type is supported; data is a non-empty list of objects
      - every row contains x_key AND y_key; y parses as a finite number
      - non-degenerate: >=2 distinct categories, not all-equal/all-zero, and
        enough points (>=3, or exactly 2 only when the values are comparable)
    """
    if not isinstance(config, dict):
        return None

    chart_type = config.get("chart_type")
    x_key = config.get("x_key")
    y_key = config.get("y_key")
    data = config.get("data")

    if chart_type not in _ALLOWED_CHART_TYPES:
        return None
    if not isinstance(data, list) or not data:
        return None
    if not isinstance(x_key, str) or not isinstance(y_key, str):
        return None

    categories: list[str] = []
    y_values: list[float] = []
    for row in data:
        if not isinstance(row, dict) or x_key not in row or y_key not in row:
            return None  # key mismatch — the empty-render class
        y = _coerce_number(row.get(y_key))
        if y is None:
            return None  # non-numeric y
        categories.append(str(row.get(x_key)))
        y_values.append(y)

    if len(set(categories)) < 2:
        return None  # single category — nothing to compare
    if len(set(y_values)) == 1:
        return None  # all-equal (covers all-zero) — flat, uninformative
    if len(y_values) < _MIN_CHART_POINTS:
        # 1 point -> text; 2 points only if a genuine comparison.
        if len(y_values) != 2 or not _comparable(y_values):
            return None

    return config


_DATE_RE = re.compile(r"^\d{4}-\d{2}")  # ISO-ish date detection for temporal x
_CHART_TYPE_KEYWORDS = (
    ("horizontal", "bar_horizontal"),
    ("donut", "pie"),
    ("doughnut", "pie"),
    ("pie", "pie"),
    ("column", "bar"),
    ("bar", "bar"),
    ("line", "area"),
    ("area", "area"),
    ("trend", "area"),
)


def _select_chart_type(config: dict | None, question: str = "") -> dict | None:
    """Pick chart_type deterministically from the data shape, overriding the
    model's choice — unless the user explicitly named a type in the question.

    temporal x + numeric y          -> area
    nominal x (few categories)      -> bar (bar_horizontal when labels are long
                                       or there are many categories)
    model-chosen pie with few slices -> kept as pie (part-of-whole)
    """
    if config is None:
        return None

    q = (question or "").lower()
    for kw, ctype in _CHART_TYPE_KEYWORDS:
        # Word-boundary match so "pipeline" doesn't trigger "line", etc.
        if re.search(rf"\b{kw}\b", q):
            return {**config, "chart_type": ctype}

    data = config.get("data") or []
    x_key = config.get("x_key")
    cats = [str(r.get(x_key, "")) for r in data if isinstance(r, dict)]
    n = len(cats)
    is_temporal = bool(cats) and all(_DATE_RE.match(c) for c in cats)

    if is_temporal:
        chosen = "area"
    elif config.get("chart_type") == "pie" and n <= 6:
        chosen = "pie"  # plausible part-of-whole
    else:
        longest = max((len(c) for c in cats), default=0)
        chosen = "bar_horizontal" if (longest > 14 or n > 8) else "bar"

    return {**config, "chart_type": chosen}
