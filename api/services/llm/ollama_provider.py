"""Ollama's native /api/chat, for the things the OpenAI-compatible path cannot say.

WHY A SECOND ADAPTER FOR THE SAME SERVER. OpenAICompatProvider served Ollama for
its first months over /v1, and /v1 has no way to set the context window: Ollama
ignores `options` there, so the window was whatever OLLAMA_CONTEXT_LENGTH said
on the box -- 4,096 by default, against a system prompt of ~13K tokens. When a
prompt exceeds the window Ollama keeps the first four tokens, DISCARDS what
follows (the schema, then the business definitions), keeps the tail, writes one
line to its own log and returns 200. A schema-less answer looks exactly like an
answer. The native path takes `num_ctx` per request and, with `truncate: false`,
turns an over-long prompt into a 400 this layer can name.

Three more things ride along: `think: false` is the real off-switch for Qwen3
reasoning (reasoning_effort on /v1 was a workaround, and strip_think stays the
guarantee either way); `format` takes a JSON schema for structured output; and
the response carries prompt_eval_count, so ai_calls.tokens_in is the server's own
count rather than an estimate.

WHAT IS DELIBERATELY SHARED. Tool definitions go out through
OpenAICompatProvider._wire_tools -- Ollama's native tool shape IS the OpenAI
shape -- so the translation that once silently broke every local eval arm has one
implementation, not two. Same raw httpx, same reasons as openai_compat.py: no
SDK retry layer to disarm, and the chain in call.py owns fallback.

One host root serves both dialects. OLLAMA_BASE_URL has always carried /v1 (the
embeddings module appends /embeddings to it); this adapter strips a trailing /v1
so an existing environment keeps working unchanged.
"""
from __future__ import annotations

import json
import logging
import time
from decimal import Decimal
from typing import Any

import httpx
from pydantic import BaseModel

from services.llm.base import ImagePart, LLMResult, Message, ToolCall
from services.llm.errors import (
    LLMAuthError,
    LLMContextOverflow,
    LLMProtocolError,
    LLMProviderError,
    LLMRateLimited,
    LLMTimeout,
    LLMTransportError,
    LLMTruncated,
)
from services.llm.openai_compat import OpenAICompatProvider
from services.llm.postprocess import strictify

logger = logging.getLogger(__name__)

# The window every insights prompt is sized against. ONE definition: the handler
# imports it to derive its history budget, so the two cannot disagree. It must
# also be what the box can hold -- qwen3:32b at q4 needs ~8.5 GB of KV cache for
# this window on top of ~20 GB of weights. A different value per request would
# reload the model, so it is a module constant, never a per-call knob.
OLLAMA_NUM_CTX = 32_768

# Fail fast when nothing is listening. A box that is off should cost 5 seconds,
# not the two minutes its read timeout allows for a slow generation.
_CONNECT_TIMEOUT_S = 5.0

# What Ollama (llama-server underneath) says when the prompt does not fit and
# truncate is off. Matched on the structural type first, on the sentence second,
# because the wrapper around it has changed shape between versions.
_OVERFLOW_MARKERS = ("exceed_context_size", "exceeds the available context", "context length")


def _host(base_url: str) -> str:
    """The server root, whichever dialect the configured URL was written for."""
    host = base_url.rstrip("/")
    if host.endswith("/v1"):
        host = host[: -len("/v1")]
    return host


def _overflow_tokens(detail: str) -> int:
    """n_prompt_tokens out of the error body when it carries one, else 0."""
    try:
        inner = json.loads(detail)
        err = inner.get("error") if isinstance(inner, dict) else None
        if isinstance(err, dict):
            return int(err.get("n_prompt_tokens") or 0)
    except (ValueError, TypeError):
        pass
    return 0


class OllamaProvider:
    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        num_ctx: int = OLLAMA_NUM_CTX,
        timeout_s: float = 120.0,
        options: dict[str, Any] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        # The same three attributes the seam requires and the ledger reads on a
        # failure. `name` is the foreign key into ai_calls.provider and stays
        # "ollama" -- the ledger records which SERVER answered, not which path.
        self.name = "ollama"
        self.model = model
        self.timeout_s = timeout_s
        self.num_ctx = num_ctx
        self._url = f"{_host(base_url)}/api/chat"
        # Decoding knobs the caller wants pinned (the eval passes temperature 0
        # and a seed). num_ctx and num_predict are applied OVER these: the window
        # is not something a caller may shrink by accident.
        self._options = dict(options or {})
        # Local inference is priced at exactly zero and that is not configurable:
        # electricity is not billed per token, so any other value could only be
        # wrong. Attributes rather than constructor arguments for that reason.
        self._price_in = Decimal("0")
        self._price_out = Decimal("0")
        self._transport = transport

    # ---------------------------------------------------------------- request

    @staticmethod
    def _headers() -> dict[str, str]:
        # Keyless by design. Nothing else, ever: sending "Bearer " to a keyless
        # server is worse than sending nothing.
        return {"Content-Type": "application/json"}

    @classmethod
    def _wire_messages(cls, messages: list[Message]) -> list[dict[str, Any]]:
        """Our canonical turns in Ollama's native shape.

        Native tool results are keyed by the tool's NAME (`tool_name`), not by
        the call id the OpenAI dialect uses, so the name is looked up from the
        assistant turn that made the call. The id is sent too; current servers
        echo ids and older ones ignore unknown fields.
        """
        wire: list[dict[str, Any]] = []
        names_by_id: dict[str, str] = {}
        for msg in messages:
            if msg.role == "tool":
                entry: dict[str, Any] = {"role": "tool", "content": msg.text()}
                name = names_by_id.get(msg.tool_call_id or "")
                if name:
                    entry["tool_name"] = name
                if msg.tool_call_id:
                    entry["tool_call_id"] = msg.tool_call_id
                wire.append(entry)
                continue
            entry = {"role": msg.role, "content": msg.text()}
            images = [p.data for p in msg.parts() if isinstance(p, ImagePart)]
            if images:
                # Bare base64, which is what the native API wants -- the reason
                # ImagePart stores it that way rather than as a data: URL.
                entry["images"] = images
            if msg.tool_calls:
                entry["tool_calls"] = [
                    # arguments is an OBJECT on the native wire, not the JSON
                    # string the OpenAI dialect uses.
                    {"id": tc.id, "function": {"name": tc.name, "arguments": tc.arguments}}
                    for tc in msg.tool_calls
                ]
                for tc in msg.tool_calls:
                    names_by_id[tc.id] = tc.name
            wire.append(entry)
        return wire

    def _body(
        self,
        messages: list[Message],
        json_schema: type[BaseModel] | None,
        max_tokens: int,
        tools: list[dict] | None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": self._wire_messages(messages),
            "stream": False,
            # The native off-switch for Qwen3 reasoning. strip_think in call.py
            # remains the guarantee for a model that ignores it.
            "think": False,
            # THE REASON THIS ADAPTER EXISTS. Off, an over-long prompt is a 400
            # naming the counts; on (the default), it is a 200 with the schema
            # silently cut from the front of the prompt.
            "truncate": False,
            # Resident until told otherwise. A swap costs 43-63 s, and the box's
            # OLLAMA_KEEP_ALIVE may not survive a reboot; this does.
            "keep_alive": -1,
            "options": {**self._options, "num_ctx": self.num_ctx, "num_predict": max_tokens},
        }
        if tools:
            body["tools"] = OpenAICompatProvider._wire_tools(tools)
        if json_schema is not None:
            body["format"] = strictify(json_schema.model_json_schema())
        return body

    # --------------------------------------------------------------- response

    def _raise_for_status(self, resp: httpx.Response) -> None:
        try:
            payload = resp.json()
        except Exception:  # noqa: BLE001 - an error body that is not JSON is common
            payload = {}
        err = payload.get("error") if isinstance(payload, dict) else None
        # Ollama wraps llama-server's own JSON error as a STRING inside "error";
        # keep it whole so the type marker and the token counts survive.
        detail = (err.get("message") if isinstance(err, dict) else str(err or "")) or ""
        message = f"{self.name} returned {resp.status_code}: {detail or resp.text[:300]}"
        common = dict(provider=self.name, model=self.model, status=resp.status_code)

        if resp.status_code == 400 and any(m in detail.lower() for m in _OVERFLOW_MARKERS):
            raise LLMContextOverflow(
                f"{message} (num_ctx={self.num_ctx})",
                tokens_in=_overflow_tokens(detail), **common,
            )
        if resp.status_code in (401, 403):
            raise LLMAuthError(message, **common)
        if resp.status_code == 429:
            raise LLMRateLimited(message, retry_after=resp.headers.get("Retry-After"), **common)
        raise LLMProviderError(message, **common)

    def _parse(self, resp: httpx.Response, latency_ms: int) -> LLMResult:
        try:
            body = resp.json()
        except Exception as exc:  # noqa: BLE001
            raise LLMProtocolError(
                f"{self.name} returned a non-JSON body ({resp.status_code})",
                provider=self.name, model=self.model, latency_ms=latency_ms,
            ) from exc

        message = body.get("message") if isinstance(body, dict) else None
        if not isinstance(message, dict):
            raise LLMProtocolError(
                f"{self.name} returned no message",
                provider=self.name, model=self.model, latency_ms=latency_ms,
            )

        text = message.get("content") or ""
        tool_calls: list[ToolCall] = []
        for i, call in enumerate(message.get("tool_calls") or []):
            fn = (call or {}).get("function") or {}
            raw_args = fn.get("arguments")
            if isinstance(raw_args, str):
                try:
                    raw_args = json.loads(raw_args) if raw_args else {}
                except json.JSONDecodeError as exc:
                    raise LLMProtocolError(
                        f"{self.name} returned unparseable tool arguments for {fn.get('name')!r}",
                        provider=self.name, model=self.model, latency_ms=latency_ms,
                    ) from exc
            tool_calls.append(ToolCall(
                # Current servers mint an id; older ones do not. A minted one is
                # accepted back by every dialect because none interprets it.
                id=call.get("id") or f"call_{i}",
                name=fn.get("name") or "",
                arguments=raw_args or {},
            ))

        tokens_in = int(body.get("prompt_eval_count") or 0)
        tokens_out = int(body.get("eval_count") or 0)
        model = body.get("model") or self.model

        if body.get("done_reason") == "length":
            raise LLMTruncated(
                f"{self.name} hit num_predict before finishing",
                provider=self.name, model=model, latency_ms=latency_ms,
                tokens_in=tokens_in, tokens_out=tokens_out,
            )

        if not text and not tool_calls:
            hint = " (the model returned only reasoning)" if message.get("thinking") else ""
            raise LLMProtocolError(
                f"{self.name} returned an empty response{hint}",
                provider=self.name, model=model, latency_ms=latency_ms,
                tokens_in=tokens_in, tokens_out=tokens_out,
            )

        return LLMResult(
            text=text,
            tool_calls=tool_calls,
            model=model,
            provider=self.name,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            latency_ms=latency_ms,
            est_cost_usd=Decimal("0"),
        )

    # ------------------------------------------------------------------ call

    async def complete(
        self,
        messages: list[Message],
        json_schema: type[BaseModel] | None = None,
        max_tokens: int = 1024,
        tools: list[dict] | None = None,
    ) -> LLMResult:
        body = self._body(messages, json_schema, max_tokens, tools)
        started = time.perf_counter()

        # Per call, never module-level: the worker's event loop is long-lived but
        # the backend's is not, and one adapter serves both hosts.
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout_s, connect=_CONNECT_TIMEOUT_S),
                transport=self._transport,
            ) as client:
                resp = await client.post(self._url, headers=self._headers(), json=body)
        except httpx.TimeoutException as exc:
            raise LLMTimeout(
                f"{self.name} did not answer within {self.timeout_s}s",
                provider=self.name, model=self.model,
                latency_ms=int((time.perf_counter() - started) * 1000),
            ) from exc
        except httpx.HTTPError as exc:
            raise LLMTransportError(
                f"could not reach {self.name}: {type(exc).__name__}",
                provider=self.name, model=self.model,
                latency_ms=int((time.perf_counter() - started) * 1000),
            ) from exc

        latency_ms = int((time.perf_counter() - started) * 1000)
        if resp.status_code >= 400:
            self._raise_for_status(resp)
        return self._parse(resp, latency_ms)


__all__ = ["OLLAMA_NUM_CTX", "OllamaProvider"]
