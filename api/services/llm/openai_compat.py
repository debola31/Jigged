"""One class for every OpenAI-chat-completions-compatible endpoint.

Serves BOTH DeepInfra and Ollama. The two differ only in base_url, credentials,
price and one extra body key, and all four are constructor arguments -- so there
is not a single `if self.name == "ollama"` branch in this file. The quirks are
data supplied by the registry, which is what makes a vendor change a config edit
rather than a deploy.

WHY RAW httpx AND NOT THE openai SDK. The same reason quickbooks_desktop.py gives
for its own client: "Raw httpx has no retry layer to disarm." The SDK's built-in
retries would silently multiply a 30-second timeout by three, blowing every wall
this system has, and retry belongs to the chain in call.py where it can choose a
DIFFERENT provider rather than hammering the one that just failed.
"""
from __future__ import annotations

import json
import logging
import time
from decimal import Decimal
from typing import Any

import httpx
from pydantic import BaseModel

from services.llm.base import ImagePart, LLMResult, Message, TextPart, ToolCall
from services.llm.errors import (
    LLMAuthError,
    LLMProtocolError,
    LLMProviderError,
    LLMRateLimited,
    LLMTimeout,
    LLMTransportError,
    LLMTruncated,
)
from services.llm.postprocess import strictify
from services.llm.pricing import estimate_cost_usd

logger = logging.getLogger(__name__)

# Fail fast when nothing is listening. An Ollama box that is off should cost 5
# seconds, not the 120 its read timeout allows for a slow generation.
_CONNECT_TIMEOUT_S = 5.0


class OpenAICompatProvider:
    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        model: str,
        price_in_per_mtok: Decimal | float | str = 0,
        price_out_per_mtok: Decimal | float | str = 0,
        *,
        name: str,
        timeout_s: float = 30.0,
        extra_body: dict[str, Any] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        # `name` is required and NOT derived from the hostname. One class serves two
        # vendors, a heuristic would misfile a self-hosted vLLM or a tunnelled
        # Ollama, and this string is the foreign key into ai_calls.provider.
        self.name = name
        self.model = model
        self.timeout_s = timeout_s
        # base_url carries the vendor's version prefix and never the endpoint:
        # DeepInfra is /v1/openai, Ollama is /v1. No single rule derives both, so
        # the registry supplies each explicitly.
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._api_key = api_key
        self._price_in = price_in_per_mtok
        self._price_out = price_out_per_mtok
        self._extra_body = dict(extra_body or {})
        # The test seam. httpx.MockTransport gives the handler a real, fully-built
        # Request -- which is what lets a test assert the URL shape, the absence of
        # an Authorization header for keyless Ollama, and that the retry's SECOND
        # body differs from the first. Patching httpx.AsyncClient could only assert
        # the arguments we passed to it, which is a mirror of the implementation.
        self._transport = transport

    # ---------------------------------------------------------------- request

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        # Only when there is a key. Sending "Bearer " to a keyless Ollama is worse
        # than sending nothing.
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    @staticmethod
    def _content(msg: Message) -> Any:
        parts = msg.parts()
        if not msg.has_image():
            return msg.text()
        out: list[dict[str, Any]] = []
        for part in parts:
            if isinstance(part, TextPart):
                out.append({"type": "text", "text": part.text})
            elif isinstance(part, ImagePart):
                out.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{part.media_type};base64,{part.data}"},
                })
        return out

    @classmethod
    def _wire_messages(cls, messages: list[Message]) -> list[dict[str, Any]]:
        wire: list[dict[str, Any]] = []
        for msg in messages:
            if msg.role == "tool":
                wire.append({
                    "role": "tool",
                    "tool_call_id": msg.tool_call_id,
                    "content": msg.text(),
                })
                continue
            entry: dict[str, Any] = {"role": msg.role, "content": cls._content(msg)}
            if msg.tool_calls:
                entry["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        # arguments is a JSON *string* on the wire, not an object.
                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
                    }
                    for tc in msg.tool_calls
                ]
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
            "max_tokens": max_tokens,
            "stream": False,
        }
        body.update(self._extra_body)
        if tools:
            body["tools"] = tools
        if json_schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": json_schema.__name__,
                    "strict": True,
                    "schema": strictify(json_schema.model_json_schema()),
                },
            }
        return body

    # --------------------------------------------------------------- response

    def _raise_for_status(self, resp: httpx.Response) -> None:
        # NOT resp.raise_for_status(): it discards the body, and the body is where
        # the vendor says which parameter it rejected -- which is exactly how an
        # unsupported chat_template_kwargs surfaces.
        try:
            payload = resp.json()
        except Exception:  # noqa: BLE001 - an error body that is not JSON is common
            payload = {}
        detail = ""
        if isinstance(payload, dict):
            err = payload.get("error")
            detail = (err.get("message") if isinstance(err, dict) else str(err or "")) or ""
        message = f"{self.name} returned {resp.status_code}: {detail or resp.text[:300]}"

        common = dict(provider=self.name, model=self.model, status=resp.status_code)
        if resp.status_code in (401, 403):
            raise LLMAuthError(message, **common)
        if resp.status_code == 429:
            # Captured, never slept on: sleeping inside a 60s wall turns a rate
            # limit into a gateway timeout, and the chain has somewhere else to go.
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

        choices = body.get("choices") or []
        if not choices:
            raise LLMProtocolError(
                f"{self.name} returned no choices",
                provider=self.name, model=self.model, latency_ms=latency_ms,
            )

        choice = choices[0] or {}
        message = choice.get("message") or {}
        text = message.get("content") or ""

        raw_calls = message.get("tool_calls") or []
        tool_calls: list[ToolCall] = []
        for call in raw_calls:
            fn = (call or {}).get("function") or {}
            raw_args = fn.get("arguments")
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
            except json.JSONDecodeError as exc:
                raise LLMProtocolError(
                    f"{self.name} returned unparseable tool arguments for {fn.get('name')!r}",
                    provider=self.name, model=self.model, latency_ms=latency_ms,
                ) from exc
            tool_calls.append(
                ToolCall(id=call.get("id") or "", name=fn.get("name") or "", arguments=args or {})
            )

        usage = body.get("usage") or {}
        tokens_in = int(usage.get("prompt_tokens") or 0)
        tokens_out = int(usage.get("completion_tokens") or 0)
        if not usage:
            # A 0/0 row against a paid provider is a diagnosable signal that usage
            # parsing broke, rather than a silent free lunch in the ledger.
            logger.warning("%s returned no usage block; logging 0/0 tokens", self.name)

        if choice.get("finish_reason") == "length":
            raise LLMTruncated(
                f"{self.name} hit max_tokens before finishing",
                provider=self.name, model=body.get("model") or self.model,
                latency_ms=latency_ms, tokens_in=tokens_in, tokens_out=tokens_out,
            )

        if not text and not tool_calls:
            # A real Qwen-on-vLLM shape: everything lands in reasoning_content and
            # content comes back empty. Returning "" here is the exact silent
            # degradation this layer refuses.
            hint = " (the model returned only reasoning)" if message.get("reasoning_content") else ""
            raise LLMProtocolError(
                f"{self.name} returned an empty response{hint}",
                provider=self.name, model=body.get("model") or self.model,
                latency_ms=latency_ms, tokens_in=tokens_in, tokens_out=tokens_out,
            )

        return LLMResult(
            text=text,
            tool_calls=tool_calls,
            model=body.get("model") or self.model,
            provider=self.name,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            latency_ms=latency_ms,
            est_cost_usd=estimate_cost_usd(tokens_in, tokens_out, self._price_in, self._price_out),
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

        # Per call, not module-level: on Vercel a module-scoped async client
        # outlives the event loop it was built on and fails on the next invocation.
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


__all__ = ["OpenAICompatProvider"]
