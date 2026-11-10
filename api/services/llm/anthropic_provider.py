"""Anthropic, through the official SDK.

Uses AsyncAnthropic, not the sync client the rest of services/ai/ still uses: a
sync call inside `async def` blocks the event loop for the whole request, and a
fallback chain makes that worse -- a 30-second timeout on the first provider
would block everything else on the box before the second one is even tried.

WHAT DIFFERS BY MODEL lives in _PROFILES, keyed by model id, so the pinned
claude-sonnet-4-6 requests are byte-for-byte what they were and only a model
named there gets effort, thinking headroom and server-side fallback. Insights
runs on claude-opus-5-5 (registry._DEFAULT_CHAINS); see its profile.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from types import SimpleNamespace
from decimal import Decimal
from typing import Any

import anthropic
from pydantic import BaseModel

from services.ai.model_config import DEFAULT_ANTHROPIC_MODEL
from services.llm.base import (
    ImagePart,
    LLMResult,
    Message,
    NativeTurn,
    TextPart,
    ToolCall,
    split_system,
)
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
from services.llm.pricing import (
    ANTHROPIC_CACHE_PRICES,
    ANTHROPIC_PRICES,
    anthropic_cache_prices,
    anthropic_prices,
    estimate_cost_usd,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _ModelProfile:
    """What a model needs sent that the pinned default does not.

    effort            output_config.effort, or None to send nothing.
    thinking_headroom added to the caller's max_tokens. Thinking tokens count
                      against max_tokens, and on a model that always thinks the
                      caller's number (sized for the answer -- insights' 4,000 is
                      also arithmetic against Ollama's 32K window) would otherwise
                      truncate a turn that spent it reasoning.
    fallbacks         server-side refusal fallback: a classifier decline is
                      re-run on a model the API picks, inside the same call,
                      instead of failing the person's question.
    """

    effort: str | None = None
    thinking_headroom: int = 0
    fallbacks: bool = False


_PROFILES: dict[str, _ModelProfile] = {
    # Thinking cannot be disabled on this model ({"type": "disabled"} is a 400), so
    # `thinking` is omitted (adaptive) and depth is set by effort alone. "medium"
    # is the model's own default, stated rather than inherited so a default change
    # upstream cannot move it silently.
    "claude-opus-5-5": _ModelProfile(effort="medium", thinking_headroom=12_000, fallbacks=True),
}
_DEFAULT_PROFILE = _ModelProfile()
_FALLBACK_BETA = "server-side-fallback-2026-07-01"

# The blocks the canonical fields can rebuild exactly. A turn holding any OTHER type -- thinking,
# or the server-side tool search's server_tool_use / tool_search_tool_result -- is replayed as
# the blocks it came in, because the API expects those back unchanged.
_CANONICAL_BLOCKS = frozenset({"text", "tool_use"})

# A server-side tool loop (tool search) that reaches its iteration limit stops with
# `pause_turn`; re-sending the turn resumes it. Bounded, because a turn that keeps pausing is not
# converging and the chain's own timeout is per call.
_MAX_PAUSE_RESUMES = 3


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
        self._profile = _PROFILES.get(self.model, _DEFAULT_PROFILE)
        # Raises if the model has no price on file, at construction rather than at
        # call time -- shipping a model whose cost is unknown would log every call
        # it serves as free, forever. Cache prices too: every call is cached.
        self._price_in, self._price_out = anthropic_prices(self.model)
        self._cache_write, self._cache_read = anthropic_cache_prices(self.model)

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
        # timeouts ARE retried, so the default makes wall-clock timeout x 3 -- a
        # whole Vercel invocation spent on one hung call. Retry belongs to the
        # chain, which can pick a different provider instead of hammering the one
        # that just failed.
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

    @staticmethod
    def _replay_blocks(msg: Message) -> list[dict[str, Any]] | None:
        """This adapter's own blocks for an assistant turn, or None to rebuild it.

        Sent back VERBATIM -- a thinking block's signature is checked against the
        conversation that produced it, so it is never re-serialised from parts.
        The one edit: tool_use blocks the caller did not keep in `tool_calls` are
        dropped, because the caller sends no tool_result for them and an
        unanswered tool_use is a 400. That edit is safe for the signatures, which
        cover what came BEFORE each block, not what follows it in its own turn.
        """
        native = msg.native
        if native is None or native.provider != AnthropicProvider.name:
            return None
        kept_ids = {tc.id for tc in msg.tool_calls}
        blocks = [
            dict(b) for b in native.blocks
            if b.get("type") != "tool_use" or b.get("id") in kept_ids
        ]
        # Nothing a person or a tool can read -- reasoning and search only -- is not a valid
        # assistant message; rebuild from the canonical fields instead.
        if not any(b.get("type") in _CANONICAL_BLOCKS for b in blocks):
            return None
        return blocks

    @classmethod
    def _wire_messages(cls, messages: list[Message]) -> list[dict[str, Any]]:
        """Translate canonical turns into Anthropic's block format.

        The one non-obvious rule: consecutive `tool` turns MERGE into a single user
        message carrying every tool_result block. Anthropic requires all results for
        one assistant turn together, and splitting them across messages silently
        trains the model out of making parallel tool calls.

        An assistant turn this adapter produced goes back as the blocks it came in
        (_replay_blocks); anything else is rebuilt from the canonical fields.
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
            replay = cls._replay_blocks(msg) if msg.role == "assistant" else None
            if replay is not None:
                wire.append({"role": "assistant", "content": replay})
            elif msg.role == "assistant" and msg.tool_calls:
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

    def _prices_for(self, model: str) -> tuple[Decimal, Decimal, Decimal, Decimal]:
        """(in, out, cache write, cache read) for the model that ANSWERED.

        Usually self.model. A server-side fallback can serve the call from another
        model; it is priced at its own rates when they are on file, and at ours
        otherwise -- a slightly wrong number on a rare row, logged, rather than a
        constructor-time raise for every model the API might choose.
        """
        if model == self.model:
            return self._price_in, self._price_out, self._cache_write, self._cache_read
        if model in ANTHROPIC_PRICES and model in ANTHROPIC_CACHE_PRICES:
            return (*ANTHROPIC_PRICES[model], *ANTHROPIC_CACHE_PRICES[model])
        logger.info("anthropic: %s answered for %s and has no price on file; using %s's",
                    model, self.model, self.model)
        return self._price_in, self._price_out, self._cache_write, self._cache_read

    @staticmethod
    def _dump(block: Any) -> dict[str, Any]:
        """One SDK content block as the dict the API takes back."""
        dump = getattr(block, "model_dump", None)
        return dump(mode="json", exclude_none=True) if callable(dump) else dict(vars(block))

    @classmethod
    def _native(cls, blocks: list[Any]) -> NativeTurn | None:
        """The response's blocks as replayable dicts, when replay is needed.

        None when every block is text or tool_use: the canonical fields then rebuild
        the turn exactly, and a model that never thinks (claude-sonnet-4-6) with no
        server tools sends the same requests it always has.

        THE SERVER-SIDE FALLBACK ECHO RULE. A `fallback` block marks where a
        declining model handed over. Before the last one, only text is echoed back
        -- the declining model's thinking and tool_use must not be -- and the
        marker itself is an audit note, dropped.
        """
        dumped = [cls._dump(b) for b in blocks]

        boundary = max((i for i, b in enumerate(dumped) if b.get("type") == "fallback"), default=-1)
        if boundary >= 0:
            dumped = [b for b in dumped[:boundary] if b.get("type") == "text"] + dumped[boundary + 1:]

        if all(b.get("type") in _CANONICAL_BLOCKS for b in dumped):
            return None
        return NativeTurn(provider=AnthropicProvider.name, blocks=dumped)

    def _parse(self, msg: Any, latency_ms: int) -> LLMResult:
        usage = getattr(msg, "usage", None)
        # A cached call reports its prompt in three DISJOINT parts. tokens_in is
        # their sum -- the whole prompt, comparable with what Ollama reports -- and
        # the cost prices each part at its own rate.
        uncached = int(getattr(usage, "input_tokens", 0) or 0)
        cache_write = int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
        cache_read = int(getattr(usage, "cache_read_input_tokens", 0) or 0)
        tokens_in = uncached + cache_write + cache_read
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

        price_in, price_out, price_write, price_read = self._prices_for(model)
        return LLMResult(
            text=text,
            tool_calls=tool_calls,
            model=model,
            provider=self.name,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            latency_ms=latency_ms,
            est_cost_usd=estimate_cost_usd(
                uncached, tokens_out, price_in, price_out,
                cache_write_tokens=cache_write, cache_read_tokens=cache_read,
                cache_write_per_mtok=price_write, cache_read_per_mtok=price_read,
            ),
            native=self._native(blocks),
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
        profile = self._profile

        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens + profile.thinking_headroom,
            "messages": self._wire_messages(rest),
            # Automatic prompt caching: the breakpoint lands on the last cacheable
            # block, so each call in a tool loop reads everything the previous one
            # wrote and writes only what this turn appended. The insights prefix
            # (tools + ~13K-token system prompt) is byte-identical across jobs, so
            # a question asked within five minutes of another reads it too. A
            # prompt below the model's minimum simply does not cache -- no error.
            "cache_control": {"type": "ephemeral"},
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = tools
        output_config: dict[str, Any] = {}
        if json_schema is not None:
            # output_config, the current first-party structured-output mechanism and
            # the one already proven in this repo at drawing_routes.py. Requires
            # anthropic >= 0.86.0, which requirements.txt now floors.
            #
            # transform_schema, the SDK's own (messages.parse uses it): the API
            # rejects constraints it cannot enforce in the grammar -- ReportSpec's
            # list caps are `maxItems`, a 400 that kept reports from ever running
            # on a hosted model -- so it moves them into the field's description.
            # Nothing is lost: call.py validates every response against the real
            # Pydantic model, caps included, and owns the informed retry.
            output_config["format"] = {
                "type": "json_schema",
                "schema": anthropic.transform_schema(strictify(json_schema.model_json_schema())),
            }
        if profile.effort:
            output_config["effort"] = profile.effort
        if output_config:
            kwargs["output_config"] = output_config
        # Nothing is sent for `thinking`, on any model. Sonnet 4.6 does not think
        # unless asked, and {"type": "disabled"} has its own documented failure
        # modes (tool calls written into visible text, leaked tags). Opus 5.5
        # always thinks -- omitting the field IS adaptive thinking there, and
        # "disabled" is a 400 -- so its depth is set by effort in its profile.

        started = time.perf_counter()
        msg = await self._send(kwargs, started)

        # A server-side tool loop that hit its iteration limit. Re-send with what it produced so
        # far as the assistant turn and the API resumes; the turn is everything, in order.
        resumes = 0
        if getattr(msg, "stop_reason", None) == "pause_turn":
            so_far = list(getattr(msg, "content", None) or [])
            usage_parts = [getattr(msg, "usage", None)]
            while getattr(msg, "stop_reason", None) == "pause_turn" and resumes < _MAX_PAUSE_RESUMES:
                resumes += 1
                kwargs["messages"] = self._wire_messages(rest) + [
                    {"role": "assistant", "content": [self._dump(b) for b in so_far]}
                ]
                msg = await self._send(kwargs, started)
                so_far += list(getattr(msg, "content", None) or [])
                usage_parts.append(getattr(msg, "usage", None))
            msg = SimpleNamespace(
                content=so_far,
                stop_reason=getattr(msg, "stop_reason", None),
                model=getattr(msg, "model", None),
                usage=SimpleNamespace(**{
                    field: sum(int(getattr(u, field, 0) or 0) for u in usage_parts)
                    for field in ("input_tokens", "output_tokens",
                                  "cache_creation_input_tokens", "cache_read_input_tokens")
                }),
            )
            if msg.stop_reason == "pause_turn":
                raise LLMProtocolError(
                    f"anthropic paused the turn {resumes + 1} times without finishing",
                    provider=self.name, model=self.model,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                )

        return self._parse(msg, int((time.perf_counter() - started) * 1000))

    async def _send(self, kwargs: dict[str, Any], started: float) -> Any:
        """One request, with the SDK's errors mapped onto this layer's."""
        try:
            if self._profile.fallbacks:
                # "default" lets the API route a classifier decline by category, so
                # there is no fallback model list here to keep current.
                return await self._client.beta.messages.create(
                    **kwargs, betas=[_FALLBACK_BETA], fallbacks="default"
                )
            return await self._client.messages.create(**kwargs)
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


__all__ = ["AnthropicProvider"]
