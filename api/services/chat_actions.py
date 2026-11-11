"""Jigged chat's actions: the MCP server's tools, for one person's question.

The chat's model runs here, in the backend; the tools are TypeScript, in the Next.js app
(lib/mcp/tools). This module is the bridge. It fetches the tool manifest from
app/chat-tools/route.ts and calls tools through the same route, AS THE PERSON WHO ASKED -- their
own session token, never the service role -- so every action runs through the exact call path
/mcp uses: company and role, the rate limit, RLS and the billing gate, one mcp_tool_calls row
logged as "Jigged chat".

APPROVAL LIVES HERE, not in the route. A tool that changes data runs only when the person has
approved that call, or has chosen "Always allow" for that action before (public.chat_action_grants,
per person, per action, per company -- the user's call, 2026-11-09). Reads never ask.

THE TOKEN GOES TO ONE PLACE: this deployment's own origin, from env. Previews use VERCEL_URL
so a shared alias cannot send tools to another PR; elsewhere APP_BASE_URL names the origin.
Never use a URL the request supplied -- an Origin header pointed at another host would hand the
person's session to it. Protected preview calls also carry Vercel's automation bypass header.

THE TOOLS ARE DEFERRED. Sixty-odd definitions are ~30K tokens, as much again as the whole
insights prompt, so each is sent with `defer_loading: true` behind the server-side tool search
tool: the model loads the few it needs, and the cached prefix stays the size it was.
"""
from __future__ import annotations

import copy
import logging
import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)

# The field the model fills on every change it proposes, shown on the approval card. Added to each
# write tool's schema here and stripped before the call, so the tool itself never sees it.
APPROVAL_SUMMARY_FIELD = "summary_for_approval"

TOOL_SEARCH = {"type": "tool_search_tool_bm25_20251119", "name": "tool_search_tool_bm25"}

# Under the route's own 60 s maxDuration, so the person hears why rather than a cut connection.
_TIMEOUT_S = 55.0

SESSION_EXPIRED = (
    "Your Jigged sign-in expired before this could run, so nothing was changed. Ask again."
)
UNREACHABLE = (
    "Jigged couldn't run that just now, so it isn't known whether it finished. Check the record "
    "in Jigged before asking again."
)
DECLINED = (
    "The person declined this change, so nothing was changed. Do not try it again unless they "
    "ask; say plainly that it was not done."
)

# The section appended to the insights system prompt when actions are on. After the semantics
# tail, so every byte ahead of it is the prompt the read-only path already caches.
ACTIONS_PROMPT = (
    "ACTIONS. Besides answering questions, you can make changes in Jigged for this person: create "
    "and update customers, vendors, parts, quotes, jobs, inventory, shipments and work centres, "
    "archive records, push invoices to QuickBooks, and import records. Those tools are not listed "
    "up front: find one with tool_search_tool_bm25, searching a few plain words (\"create quote\", "
    "\"archive part\", \"add stock\"), then call it. The lookup tools it finds (get_job, "
    "list_customers, search, ...) are for the ids and current values a change needs; for "
    "questions, keep using execute_sql.\n"
    "Only make a change the person asked for, and never guess an id -- look it up first. Every "
    f"change waits for the person to approve it: fill {APPROVAL_SUMMARY_FIELD} with one plain "
    "sentence saying exactly what will change (which record, which values), because that sentence "
    "is what they approve. Once a change has run, say what changed in a sentence or two. Never say "
    "a change happened unless its tool result says so; if a tool refuses, say why in plain words."
)


@dataclass(frozen=True)
class ToolSpec:
    name: str
    title: str
    description: str
    access: str
    destructive: bool
    input_schema: dict[str, Any]

    @property
    def is_write(self) -> bool:
        return self.access == "write"


@dataclass(frozen=True)
class ActionOutcome:
    """A tool's answer as the model will read it. A refusal is data, not an exception."""

    text: str
    is_error: bool
    data: dict[str, Any] | None = None


def app_base_url() -> str | None:
    """This deployment's own origin, from env only. See the module docstring."""
    if os.getenv("VERCEL_ENV") == "preview":
        host = (os.getenv("VERCEL_URL") or "").strip()
        parsed = urlsplit(f"https://{host}")
        if (
            host
            and parsed.netloc == host
            and parsed.hostname
            and parsed.hostname.endswith(".vercel.app")
            and not parsed.username
            and not parsed.password
            and not parsed.path
            and not parsed.query
            and not parsed.fragment
        ):
            return f"https://{host}"
        return None
    value = (os.getenv("APP_BASE_URL") or "").strip().rstrip("/")
    return value or None


def _request_headers(token: str, base_url: str) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}"}
    bypass = (os.getenv("VERCEL_AUTOMATION_BYPASS_SECRET") or "").strip()
    if bypass and os.getenv("VERCEL_ENV") == "preview" and base_url.rstrip("/") == app_base_url():
        headers["x-vercel-protection-bypass"] = bypass
    return headers


class ChatActions:
    """The tools, and the person's standing grants, for one question.

    Built per job by the route that runs it inline, never from a payload: the session token is
    held in memory for the life of one request and is never written to ai_jobs.
    """

    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        company_id: str,
        user_id: str,
        db: Any,
        specs: list[ToolSpec],
        granted: set[str],
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url
        self.company_id = company_id
        self.user_id = user_id
        self._token = token
        self._db = db
        self._specs = {spec.name: spec for spec in specs}
        self._order = [spec.name for spec in specs]
        self._granted = set(granted)
        self._transport = transport

    # ------------------------------------------------------------------ setup

    @classmethod
    async def open(
        cls,
        *,
        token: str,
        company_id: str,
        user_id: str,
        db: Any,
        base_url: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> "ChatActions":
        """Fetch the manifest and the person's grants. Raises on any failure.

        The caller decides what a failure means: a fresh question goes on read-only and says so
        in the log; an approval cannot run without the tools and fails visibly.
        """
        base = base_url or app_base_url()
        if not base:
            raise RuntimeError("This deployment's tool origin is not set, so Jigged chat has no tools to call")
        async with httpx.AsyncClient(timeout=_TIMEOUT_S, transport=transport) as client:
            response = await client.get(
                f"{base}/chat-tools", headers=_request_headers(token, base)
            )
        response.raise_for_status()
        specs = [
            ToolSpec(
                name=str(entry["name"]),
                title=str(entry.get("title") or entry["name"]),
                description=str(entry.get("description") or ""),
                access=str(entry.get("access") or "read"),
                destructive=bool(entry.get("destructive")),
                input_schema=dict(entry.get("input_schema") or {"type": "object"}),
            )
            for entry in (response.json().get("tools") or [])
        ]
        return cls(
            base_url=base, token=token, company_id=company_id, user_id=user_id, db=db,
            specs=specs, granted=load_grants(db, company_id, user_id), transport=transport,
        )

    # --------------------------------------------------------------- the tools

    def knows(self, name: str) -> bool:
        return name in self._specs

    def spec(self, name: str) -> ToolSpec | None:
        return self._specs.get(name)

    def needs_approval(self, name: str) -> bool:
        """A write the person has not chosen to always allow. Reads never ask."""
        spec = self._specs.get(name)
        return bool(spec and spec.is_write and name not in self._granted)

    def anthropic_tools(self) -> list[dict[str, Any]]:
        """The search tool, then every tool deferred, in manifest order (a stable prefix)."""
        return [dict(TOOL_SEARCH)] + [self._definition(self._specs[n]) for n in self._order]

    @staticmethod
    def _definition(spec: ToolSpec) -> dict[str, Any]:
        schema = copy.deepcopy(spec.input_schema)
        description = f"{spec.title}. {spec.description}".strip()
        if spec.is_write:
            properties = schema.setdefault("properties", {})
            properties[APPROVAL_SUMMARY_FIELD] = {
                "type": "string",
                "description": (
                    "One plain sentence, for the person who must approve this, saying exactly "
                    "what will change: which record, and which values."
                ),
            }
            required = list(schema.get("required") or [])
            schema["required"] = required + [APPROVAL_SUMMARY_FIELD]
            description += " Changes data in Jigged: the person approves each call first."
        return {
            "name": spec.name,
            "description": description,
            "input_schema": schema,
            "defer_loading": True,
        }

    # --------------------------------------------------------------- calling

    async def call(self, name: str, arguments: dict[str, Any]) -> ActionOutcome:
        """Run one tool as the person. Every failure comes back as an outcome to read."""
        args = {k: v for k, v in (arguments or {}).items() if k != APPROVAL_SUMMARY_FIELD}
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S, transport=self._transport) as client:
                response = await client.post(
                    f"{self.base_url}/chat-tools",
                    headers=_request_headers(self._token, self.base_url),
                    json={"company_id": self.company_id, "tool": name, "arguments": args},
                )
        except httpx.HTTPError as exc:
            logger.warning("chat action %s could not reach /chat-tools: %s", name, type(exc).__name__)
            return ActionOutcome(UNREACHABLE, True)

        if response.status_code == 401:
            return ActionOutcome(SESSION_EXPIRED, True)
        if response.status_code != 200:
            logger.warning("chat action %s: /chat-tools answered %s", name, response.status_code)
            return ActionOutcome(UNREACHABLE, True)

        body = response.json()
        text = "\n".join(
            str(part.get("text") or "")
            for part in (body.get("content") or [])
            if isinstance(part, dict) and part.get("type") == "text"
        ).strip()
        data = body.get("structuredContent")
        return ActionOutcome(
            text=text or ("Done." if not body.get("isError") else UNREACHABLE),
            is_error=bool(body.get("isError")),
            data=data if isinstance(data, dict) else None,
        )


# ----------------------------------------------------------------- grants


def load_grants(db: Any, company_id: str, user_id: str) -> set[str]:
    """The actions this person always allows in this company. Live rows only."""
    rows = (
        db.table("chat_action_grants")
        .select("tool_name")
        .eq("company_id", company_id)
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .execute()
    ).data or []
    return {str(row["tool_name"]) for row in rows}


def grant(db: Any, company_id: str, user_id: str, tool_names: list[str]) -> None:
    """"Always allow": one row per action, reviving any the person revoked before."""
    rows = [
        {"company_id": company_id, "user_id": user_id, "tool_name": name, "deleted_at": None}
        for name in sorted(set(tool_names))
    ]
    if rows:
        db.table("chat_action_grants").upsert(
            rows, on_conflict="company_id,user_id,tool_name"
        ).execute()


__all__ = [
    "ACTIONS_PROMPT",
    "APPROVAL_SUMMARY_FIELD",
    "ActionOutcome",
    "ChatActions",
    "DECLINED",
    "TOOL_SEARCH",
    "ToolSpec",
    "app_base_url",
    "grant",
    "load_grants",
]
