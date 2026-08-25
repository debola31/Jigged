"""Anthropic, through the official SDK.

Uses AsyncAnthropic, not the sync client the rest of services/ai/ still uses: a
sync call inside `async def` blocks the event loop for the whole request, and a
fallback chain makes that worse -- a 30-second timeout on the first provider
would block everything else on the box before the second one is even tried.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import anthropic
from pydantic import BaseModel

from services.ai.model_config import DEFAULT_ANTHROPIC_MODEL
from services.llm.base import ImagePart, LLMResult, Message, TextPart, ToolCall, split_system
from services.llm.errors import (
    LLMAuthError,
    LLMProtocolError,
    LLMProviderError,
    LLMRateLimited,
    LLMRefused,
    LLMTimeout,
    LLMTransportError,
    LLMTruncated,
)
from services.llm.postprocess import strictify
from services.llm.pricing import anthropic_prices, estimate_cost_usd

logger = logging.getLogger(__name__)


class AnthropicProvider:
    name = "anthropic"

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        *,
        timeout_s: float = 30.0,
        client: Any | None = None,
    ) -> None:
        self.model = model or DEFAULT_ANTHROPIC_MODEL
        self.timeout_s = timeout_s
        # Raises if the model has no price on file, at construction rather than at
        # call time -- shipping a model whose cost is unknown would log every call
        # it serves as free, forever.
        self._price_in, self._price_out = anthropic_prices(self.model)

        if client is not None:
            self._client = client
            return

        key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise ValueError("ANTHROPIC_API_KEY is required")

        # NO base_url ARGUMENT, AND NEVER A COMPUTED DEFAULT.
        #
        # The SDK falls back to ANTHROPIC_BASE_URL when the kwarg is absent, and
        # that fallback is the entire mechanism behind e2e/mocks/anthropic-server.mjs
        # and the ANTHROPIC_BASE_URL export in .github/workflows/e2e-tests.yml.
        # Writing `base_url=base_url or "https://api.anthropic.com"` here would look
        # like a tidy-up and would silently kill CI's whole E2E strategy, because
        # the tests would still pass -- against the real API, on someone's key.
        #
        # max_retries=0, not the SDK default of 2 and not drawing_routes.py's 1:
        # timeouts ARE retried, so the default makes wall-clock timeout x 3 = 90s
        # against a 60s platform wall. Retry belongs to the chain, which can pick a
        # different provider instead of hammering the one that just failed.
        self._client = anthropic.AsyncAnthropic(
            api_key=key, timeout=timeout_s, max_retries=0
        )

    # --------------------------------------------------------------- request

    @staticmethod
    def _content(msg: Message) -> Any:
        if not msg.has_image():
            return msg.text()
        blocks: list[dict[str, Any]] = []
        for part in msg.parts():
            if isinstance(part, TextPart):
                blocks.append({"type": "text", "text": part.text})
            elif isinstance(part, ImagePart):
                blocks.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": part.media_type,
                        "data": part.data,
                    },
                })
        return blocks

    @classmethod
    def _wire_messages(cls, messages: list[Message]) -> list[dict[str, Any]]:
        """Translate canonical turns into Anthropic's block format.

        The one non-obvious rule: consecutive `tool` turns MERGE into a single user
        message carrying every tool_result block. Anthropic requires all results for
        one assistant turn together, and splitting them across messages silently
        trains the model out of making parallel tool calls.
        """
        wire: list[dict[str, Any]] = []
        pending_results: list[dict[str, Any]] = []

        def flush() -> None:
            if pending_results:
                wire.append({"role": "user", "content": list(pending_results)})
                pending_results.clear()

        for msg in messages:
            if msg.role == "tool":
                pending_results.append({
                    "type": "tool_result",
                    "tool_use_id": msg.tool_call_id or "",
                    "content": msg.text(),
                })
                continue

            flush()
            if msg.role == "assistant" and msg.tool_calls:
                blocks: list[dict[str, Any]] = []
                if msg.text():
                    blocks.append({"type": "text", "text": msg.text()})
                blocks.extend(
                    {"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments}
                    for tc in msg.tool_calls
                )
                wire.append({"role": "assistant", "content": blocks})
            else:
                wire.append({"role": msg.role, "content": cls._content(msg)})

        flush()
        return wire

    # -------------------------------------------------------------- response

    def _parse(self, msg: Any, latency_ms: int) -> LLMResult:
        usage = getattr(msg, "usage", None)
        tokens_in = int(getattr(usage, "input_tokens", 0) or 0)
        tokens_out = int(getattr(usage, "output_tokens", 0) or 0)
        model = getattr(msg, "model", None) or self.model
        common = dict(
            provider=self.name, model=model, latency_ms=latency_ms,
            tokens_in=tokens_in, tokens_out=tokens_out,
        )

        # Checked BEFORE touching content, so a cut-off object fails with an
        # accurate cause instead of a misleading schema violation -- and does not
        # burn the single retry on an input no re-ask can fix.
        stop_reason = getattr(msg, "stop_reason", None)
        if stop_reason == "max_tokens":
            raise LLMTruncated("anthropic hit max_tokens before finishing", **common)
        if stop_reason == "refusal":
            raise LLMRefused("anthropic declined this request", **common)

        blocks = list(getattr(msg, "content", None) or [])
        # join, not next(...): structured output can in principle split text blocks,
        # and taking only the first would silently truncate the answer.
        text = "".join(
            b.text for b in blocks if getattr(b, "type", "") == "text" and getattr(b, "text", None)
        )
        tool_calls = [
            ToolCall(
                id=getattr(b, "id", "") or "",
                name=getattr(b, "name", "") or "",
                arguments=dict(getattr(b, "input", None) or {}),
            )
            for b in blocks
            if getattr(b, "type", "") == "tool_use"
        ]

        if not text and not tool_calls:
            raise LLMProtocolError("anthropic returned no text and no tool use", **common)

        return LLMResult(
            text=text,
            tool_calls=tool_calls,
            model=model,
            provider=self.name,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            latency_ms=latency_ms,
            est_cost_usd=estimate_cost_usd(
                tokens_in, tokens_out, self._price_in, self._price_out
            ),
        )

    # ------------------------------------------------------------------ call

    async def complete(
        self,
        messages: list[Message],
        json_schema: type[BaseModel] | None = None,
        max_tokens: int = 1024,
        tools: list[dict] | None = None,
    ) -> LLMResult:
        system, rest = split_system(messages)

        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "messages": self._wire_messages(rest),
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = tools
        if json_schema is not None:
            # output_config, the current first-party structured-output mechanism and
            # the one already proven in this repo at drawing_routes.py. Requires
            # anthropic >= 0.86.0, which requirements.txt now floors.
            kwargs["output_config"] = {
                "format": {
                    "type": "json_schema",
                    "schema": strictify(json_schema.model_json_schema()),
                }
            }
        # Nothing is sent for `thinking`. Sonnet 4.6 does not think unless asked,
        # and {"type": "disabled"} has its own documented failure modes (tool calls
        # written into visible text, leaked tags). strip_think still runs over the
        # result -- a documented no-op here, and cheap insurance if the pinned model
        # ever changes.

        started = time.perf_counter()
        try:
            msg = await self._client.messages.create(**kwargs)
        except anthropic.APITimeoutError as exc:
            raise LLMTimeout(
                f"anthropic did not answer within {self.timeout_s}s",
                provider=self.name, model=self.model,
                latency_ms=int((time.perf_counter() - started) * 1000),
            ) from exc
        except anthropic.RateLimitError as exc:
            raise LLMRateLimited(
                "anthropic rate limited this request",
                provider=self.name, model=self.model, status=429,
                retry_after=(exc.response.headers.get("retry-after") if exc.response else None),
                latency_ms=int((time.perf_counter() - started) * 1000),
            ) from exc
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as exc:
            raise LLMAuthError(
                f"anthropic rejected our credentials: {exc}",
                provider=self.name, model=self.model, status=getattr(exc, "status_code", None),
                latency_ms=int((time.perf_counter() - started) * 1000),
            ) from exc
        except anthropic.APIConnectionError as exc:
            raise LLMTransportError(
                f"could not reach anthropic: {type(exc).__name__}",
                provider=self.name, model=self.model,
                latency_ms=int((time.perf_counter() - started) * 1000),
            ) from exc
        except anthropic.APIStatusError as exc:
            raise LLMProviderError(
                f"anthropic returned {getattr(exc, 'status_code', '?')}: {exc}",
                provider=self.name, model=self.model, status=getattr(exc, "status_code", None),
                latency_ms=int((time.perf_counter() - started) * 1000),
            ) from exc
        except anthropic.APIResponseValidationError as exc:
            raise LLMProtocolError(
                f"anthropic returned an unexpected body: {exc}",
                provider=self.name, model=self.model,
                latency_ms=int((time.perf_counter() - started) * 1000),
            ) from exc

        return self._parse(msg, int((time.perf_counter() - started) * 1000))


__all__ = ["AnthropicProvider"]
