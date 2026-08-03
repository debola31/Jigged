"""
API routes for AI Insights & Charts feature.

Endpoints:
- POST /{company_id}/chat        - Submit natural language question

Note: Saved insights CRUD (get/save/delete) is handled client-side
via direct Supabase queries with RLS policies. Low-stock surfacing is
client-side too — it's the shortage lens on the parts page, not an alert feed.
"""

import json
import logging
import math
import os
import re
import time

import sentry_sdk
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from supabase import Client, create_client

from models.insights_models import (
    ChatRequest,
    ChatResponse,
)
from services.insights_service import _build_chat_system_prompt
from tools.metric_tools import CHAT_TOOLS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/insights", tags=["insights"])


def _get_supabase_service_role() -> Client:
    """Get a Supabase client with service role key."""
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Database not available")
    return create_client(url, key)


# Default per-company hourly cap, used when a company has no explicit override
# in settings.ai_limits.chat_per_hour. A system admin can raise/lower it per
# company from /admin.
DEFAULT_CHAT_LIMIT_PER_HOUR = 20


def _get_company_ai_settings(company_id: str) -> tuple[bool, int]:
    """Read (ai_insights_enabled, chat_per_hour) from companies.settings.

    ai_insights is opt-OUT — a GA feature with a per-tenant kill-switch: enabled
    unless the company row explicitly stores settings.features.ai_insights =
    false. The rate limit falls back to DEFAULT_CHAT_LIMIT_PER_HOUR when unset
    or invalid.

    Fails open — (True, default) — on a read error, matching the rate limiter's
    allow-through-on-error stance so a transient DB blip never dark-launches the
    GA feature off.
    """
    try:
        supabase = _get_supabase_service_role()
        resp = (
            supabase.table("companies")
            .select("settings")
            .eq("id", company_id)
            .single()
            .execute()
        )
        settings = (resp.data or {}).get("settings") or {}
    except Exception as e:
        logger.warning(f"Failed to read company AI settings: {e}")
        return True, DEFAULT_CHAT_LIMIT_PER_HOUR

    features = settings.get("features") or {}
    raw_enabled = features.get("ai_insights")
    # Missing key → default on; explicit false (bool or legacy "false") → off.
    enabled = raw_enabled is None or raw_enabled is True or raw_enabled == "true"

    limits = settings.get("ai_limits") or {}
    raw_limit = limits.get("chat_per_hour")
    limit = (
        int(raw_limit)
        if isinstance(raw_limit, (int, float)) and int(raw_limit) > 0
        else DEFAULT_CHAT_LIMIT_PER_HOUR
    )
    return enabled, limit


def _seconds_until_window_frees(oldest_created_at, now: datetime) -> int:
    """Seconds until the oldest in-window query ages past the 1-hour window.

    Clamped to [1, 3600]; falls back to 3600 if the timestamp can't be parsed.
    """
    try:
        # PostgREST returns ISO 8601; tolerate a trailing 'Z'.
        oldest = datetime.fromisoformat(str(oldest_created_at).replace("Z", "+00:00"))
        remaining = int((oldest + timedelta(hours=1) - now).total_seconds())
    except (ValueError, TypeError):
        return 3600
    return max(1, min(remaining, 3600))


def _check_chat_rate_limit(company_id: str, limit: int) -> None:
    """
    Enforce the company's chat rate limit (queries in the last hour).

    On breach, raises 429 with a message reflecting the company's actual limit
    and a Retry-After header set to the seconds until the oldest in-window query
    ages out. A read error is non-fatal (allow the request through).
    """
    supabase = _get_supabase_service_role()
    now = datetime.now(timezone.utc)
    one_hour_ago = now - timedelta(hours=1)

    try:
        response = (
            supabase.table("ai_chat_queries")
            .select("created_at")
            .eq("company_id", company_id)
            .gte("created_at", one_hour_ago.isoformat())
            .order("created_at", desc=False)
            .execute()
        )

        rows = response.data or []
        if len(rows) >= limit:
            retry_after = _seconds_until_window_frees(rows[0].get("created_at"), now)
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Rate limit exceeded. Maximum {limit} AI chat queries "
                    f"per hour per company."
                ),
                headers={"Retry-After": str(retry_after)},
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Rate limit check failed: {e}")
        # If rate limit check fails, allow the request through


# ============================================================
# Chat
# ============================================================


@router.post("/{company_id}/chat", response_model=ChatResponse)
async def chat(company_id: str, request: ChatRequest):
    """
    Submit a natural language question about company data.
    Uses AI tool-use to query metrics and generate a response.

    Gated on the per-company ai_insights flag (403 when disabled) and rate
    limited to the company's configured hourly cap.
    """
    ai_enabled, chat_limit = _get_company_ai_settings(company_id)
    if not ai_enabled:
        raise HTTPException(
            status_code=403,
            detail="AI Insights is disabled for this company.",
        )
    _check_chat_rate_limit(company_id, chat_limit)

    start_time = time.time()

    try:
        from services.ai.claude_provider import ClaudeProvider

        provider = ClaudeProvider()

        # Build messages with company context embedded
        messages = [
            {
                "role": "user",
                "content": (
                    f"company_id: {company_id}\n\n"
                    f"Question: {request.question}"
                ),
            },
        ]

        # Execute the AI chat with tools
        result = await provider.chat_with_tools(
            messages=messages,
            tools=CHAT_TOOLS,
            system_prompt=_build_chat_system_prompt(),
            max_tokens=4000,
        )

        duration_ms = int((time.time() - start_time) * 1000)

        # Extract the chart_config the model proposed, then let deterministic
        # code decide whether it's worth charting (validate + downgrade to text
        # for degenerate/invalid data) and pick the chart type from the data
        # shape. The prose answer is always kept; a dropped chart is never a
        # blank card.
        raw_content = result["content"]
        chart_config = _select_chart_type(
            _validate_chart_config(_extract_chart_config(raw_content)),
            request.question,
        )

        # Clean the answer for the plain-text UI: drop fenced JSON, flatten any
        # markdown tables, and neutralize inline markdown (**bold**, etc.).
        clean_answer = _strip_inline_markdown(
            _flatten_markdown_tables(_strip_code_blocks(raw_content))
        )

        # Log to ai_chat_queries
        try:
            supabase = _get_supabase_service_role()
            supabase.table("ai_chat_queries").insert({
                "company_id": company_id,
                "question": request.question,
                "tool_calls": result.get("tool_calls", []),
                "response": result["content"],
                "chart_config": chart_config,
                "provider": "anthropic",
                "model": result.get("model"),
                "tokens_used": result.get("tokens_used"),
                "duration_ms": duration_ms,
            }).execute()
        except Exception as e:
            logger.warning(f"Failed to log chat query: {e}")

        return ChatResponse(
            answer=clean_answer,
            chart_config=chart_config,
            tool_calls=result.get("tool_calls", []),
            provider="anthropic",
            tokens_used=result.get("tokens_used"),
        )

    except HTTPException:
        raise
    except NotImplementedError as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=501, detail="Not implemented")
    except Exception as e:
        logger.error(f"Chat error: {e}", exc_info=True)
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=500,
            detail="Internal server error",
        )


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
