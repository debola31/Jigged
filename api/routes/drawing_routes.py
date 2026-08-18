"""Title-block field assignment for the drawings import.

WHAT CROSSES THE WIRE, AND WHY IT IS SO SMALL. The browser has already done the
deterministic work: it parsed the DXF (or the PDF's text layer), located the
title-block region, and holds every string with its coordinates. All this endpoint
receives is that list of strings. It never sees a file.

That is the same contract `data_import_routes.py` keeps — deterministic parsing
stays on the machine, and only the step that needs the secret key crosses — and it
has a second benefit here: a few KB of text has no chance of meeting Vercel's
~4.5 MB body ceiling, which a base64 drawing would.

ASSIGNMENT, NOT TRANSCRIPTION. The model is asked which of the supplied strings
plays which role. It is never asked to read pixels, and it never invents a name for
a field — the roles are fixed here. Every value it returns is checked back against
the strings that were sent, and anything absent from them is DROPPED before the
response is built. Measured across 96 drawings and four models, that check has
never had to fire; it stays because it is what makes the arm safe rather than
merely lucky.

NO WRITES. This module reads Supabase to authorize and nothing else.
"""

from __future__ import annotations

import json
import logging
import os
import unicodedata

import anthropic
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from supabase import Client, create_client

from services.ai.model_config import DEFAULT_ANTHROPIC_MODEL
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/drawings", tags=["drawings"])

FEATURE_FLAG = "drawing_import"

# A folder of drawings is one user action, and the shared data-import limiter
# (20 per 10 minutes) would 429 partway through a 31-part package — at drawing 21,
# with no way to finish. This one is sized so a large package completes and a
# second attempt still fits.
_limiter = RateLimiter(max_requests=200, window_seconds=600)

# One request per drawing, so the caps bound a single sheet rather than a package.
# The client sends the title-block region capped at 200; this is the backstop
# against a client that does not, sized well above that and still far below the
# body limit — the largest real drawing's FULL string list is 80 KB, 1.7% of it.
MAX_STRINGS = 1000
MAX_STRING_LENGTH = 500

# The SDK default is 10 minutes with two retries, against a 60s Vercel wall — that
# combination surfaces as an opaque 504 with nothing in the logs. Fail inside the
# wall instead, and let the caller retry the one drawing.
ANTHROPIC_TIMEOUT_SECONDS = 25.0

ROLES = (
    "part_number",
    "drawing_number",
    "description",
    "material",
    "finish",
    "revision",
    "weight",
)

_FIELD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["value", "caption"],
    "properties": {
        "value": {"type": ["string", "null"]},
        "caption": {"type": ["string", "null"]},
    },
}

OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["fields"],
    "properties": {
        "fields": {
            "type": "object",
            "additionalProperties": False,
            "required": list(ROLES),
            "properties": {role: _FIELD_SCHEMA for role in ROLES},
        }
    },
}

PROMPT = """You are reading the title block of an engineering drawing.

You are given the COMPLETE list of text strings that appear on it, taken directly from the CAD file, each with its position and text height.

Your job is ASSIGNMENT, not transcription. For each field below, choose which of the supplied strings is its value — or null if the drawing genuinely does not state it.

RULES, in order of importance:
1. A value MUST be copied character-for-character from the supplied list. Never re-type, correct, complete or normalise it. If the right value is not in the list, return null.
2. Return null freely. Most drawings leave most fields blank, and a blank is correct. A wrong value is far worse than a missing one.
3. Do not infer a value from the filename, from the geometry, or from what would be reasonable. Only from what is printed.
4. A caption alone is not a value. If "MATERIAL:" is printed but no material follows it, that field is null.
5. Some strings fuse a caption to its value ("SCALE:20:1"). In that case return the whole string as the value.
6. A revision is a short letter or code from a revision block. Sheet-border grid labels (single digits or letters around the frame edge) are never field values.
7. A number printed in an unfilled template cell is not data. A weight cell reading "0" on every sheet of a package is a CAD default, not a mass.

Also report the printed caption you read each value against, or null if the drawing has no caption for it — some drawings print a value with no label at all, and that is worth recording.

Fields: part_number, drawing_number, description, material, finish, revision, weight."""


class DrawingString(BaseModel):
    text: str
    x: float = 0
    y: float = 0
    height: float = 1


class DrawingFieldsRequest(BaseModel):
    company_id: str
    strings: list[DrawingString] = Field(default_factory=list)


class AssignedField(BaseModel):
    value: str | None = None
    caption: str | None = None


class DrawingFieldsResponse(BaseModel):
    fields: dict[str, AssignedField]
    # The `*_available` companion the other AI routes use: the arm can be absent
    # and the feature still works, because the deterministic pass already ran.
    fields_available: bool
    # Values the model returned that were NOT in the strings we sent. Dropped, and
    # reported so a silent zero here is distinguishable from a silent failure.
    dropped: list[str]
    ai_provider: str
    ai_model: str


def _service_client() -> Client:
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Database not configured")
    return create_client(url, key)


async def _verify_company_access(request: Request, company_id: str, client: Client) -> str:
    """Bearer-token caller must hold a user_company_access row for company_id.

    Read-only. Mirrors data_import_routes._verify_company_access exactly.
    """
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        user_response = client.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Invalid token")
        user_id = user_response.user.id
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("Token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    access = (
        client.table("user_company_access")
        .select("id")
        .eq("user_id", user_id)
        .eq("company_id", company_id)
        .limit(1)
        .execute()
    )
    if not access.data:
        raise HTTPException(status_code=403, detail="No access to this company")
    return user_id


def _feature_enabled(company_id: str, client: Client) -> bool:
    """Opt-IN gate. Fails CLOSED on a read error.

    This flag gates SPEND, not just a surface: every call bills Anthropic credits
    per drawing, so a DB blip must not dark-launch it.
    """
    try:
        resp = (
            client.table("companies")
            .select("settings")
            .eq("id", company_id)
            .single()
            .execute()
        )
        settings = (resp.data or {}).get("settings") or {}
    except Exception as e:  # noqa: BLE001
        logger.warning("Failed to read company feature flags: %s", e)
        return False
    features = settings.get("features") or {}
    raw = features.get(FEATURE_FLAG)
    return raw is True or raw == "true"


async def _authorize(request: Request, company_id: str) -> Client:
    """Service client, then caller auth, then the opt-in flag, then the limiter."""
    client = _service_client()
    await _verify_company_access(request, company_id, client)
    if not _feature_enabled(company_id, client):
        raise HTTPException(
            status_code=403,
            detail="Adding parts from drawings is not enabled for this company.",
        )
    if not _limiter.check(company_id):
        raise HTTPException(
            status_code=429,
            detail="Too many drawings read just now. Please wait a few minutes and try again.",
            headers={"Retry-After": "600"},
        )
    return client


def _fold(value: str) -> str:
    """Compare-form for the fidelity check.

    A CAD file writes the diameter symbol three ways (%%c, then whatever the decoder
    emits, then whatever a model retypes), so fold those together, collapse
    whitespace, and case-fold. Anything looser would start accepting invention.
    """
    folded = unicodedata.normalize("NFKC", value)
    for glyph in ("⌀", "Ø", "∅"):
        folded = folded.replace(glyph, "D")
    return " ".join(folded.split()).lower()


def _keep_only_what_was_sent(
    assigned: dict[str, dict], sent: list[str]
) -> tuple[dict[str, AssignedField], list[str]]:
    """Drop any value that is not in the strings we supplied.

    A returned value may legitimately be a SUBSTRING of one — the "STOCK: ..." line
    trimmed out of a multi-line note is the common case — so containment counts.
    Anything that matches nothing is invention and is dropped rather than shown.
    """
    haystack = [_fold(s) for s in sent]
    out: dict[str, AssignedField] = {}
    dropped: list[str] = []

    for role in ROLES:
        raw = (assigned or {}).get(role) or {}
        value = raw.get("value")
        caption = raw.get("caption")
        if value is None or not str(value).strip():
            out[role] = AssignedField(value=None, caption=caption)
            continue
        text = str(value).strip()
        if any(text and folded and _fold(text) in folded for folded in haystack):
            out[role] = AssignedField(value=text, caption=caption)
        else:
            dropped.append(f"{role}={text}")
            out[role] = AssignedField(value=None, caption=caption)

    return out, dropped


@router.post("/fields", response_model=DrawingFieldsResponse)
async def assign_title_block_fields(
    payload: DrawingFieldsRequest, request: Request
) -> DrawingFieldsResponse:
    """Assign one drawing's strings to title-block roles."""
    await _authorize(request, payload.company_id)

    if len(payload.strings) > MAX_STRINGS:
        raise HTTPException(
            status_code=413,
            detail=f"That drawing has too many text items (max {MAX_STRINGS}).",
        )

    sent = [
        s.text
        for s in payload.strings
        if s.text and s.text.strip() and len(s.text) <= MAX_STRING_LENGTH
    ]
    if not sent:
        # Nothing to assign is a legitimate outcome, not an error: plenty of sheets
        # carry no title block at all.
        return DrawingFieldsResponse(
            fields={role: AssignedField() for role in ROLES},
            fields_available=False,
            dropped=[],
            ai_provider="anthropic",
            ai_model=DEFAULT_ANTHROPIC_MODEL,
        )

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        # Degrade rather than 500: the deterministic pass already filled the grid.
        return DrawingFieldsResponse(
            fields={role: AssignedField() for role in ROLES},
            fields_available=False,
            dropped=[],
            ai_provider="anthropic",
            ai_model=DEFAULT_ANTHROPIC_MODEL,
        )

    bag = "\n".join(
        f"{json.dumps(s.text)} @({s.x:.0f},{s.y:.0f}) h={s.height:.1f}"
        for s in payload.strings
        if s.text and s.text.strip()
    )

    try:
        # AsyncAnthropic, not the sync client the rest of the backend still uses: a
        # sync call inside `async def` blocks the event loop for the whole request,
        # and a folder of drawings issues one of these per sheet.
        client = anthropic.AsyncAnthropic(
            api_key=api_key,
            timeout=ANTHROPIC_TIMEOUT_SECONDS,
            max_retries=1,
        )
        message = await client.messages.create(
            model=DEFAULT_ANTHROPIC_MODEL,
            # 8192, not 2048: at the lower limit a reasoning-heavy model truncates
            # mid-object and the response reads as "found nothing", which is
            # indistinguishable from a genuine blank sheet.
            max_tokens=8192,
            output_config={"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
            messages=[
                {
                    "role": "user",
                    "content": f"{PROMPT}\n\nSTRINGS ON THIS DRAWING:\n{bag}",
                }
            ],
        )
        text = next((b.text for b in message.content if getattr(b, "type", "") == "text"), "{}")
        parsed = json.loads(text)
    except Exception as e:  # noqa: BLE001 — type only, never the drawing's content
        logger.warning("Drawing field assignment failed: %s", type(e).__name__)
        raise HTTPException(status_code=502, detail="Couldn't read that title block.")

    fields, dropped = _keep_only_what_was_sent(parsed.get("fields") or {}, sent)
    if dropped:
        # Worth a log line: this has never fired in measurement, so if it starts,
        # something changed about the model or the prompt.
        logger.warning("Dropped %d value(s) absent from the drawing", len(dropped))

    return DrawingFieldsResponse(
        fields=fields,
        fields_available=any(f.value for f in fields.values()),
        dropped=dropped,
        ai_provider="anthropic",
        ai_model=DEFAULT_ANTHROPIC_MODEL,
    )
