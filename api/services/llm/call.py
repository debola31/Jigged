"""The gateway: one call in, one LLMResult out, or a typed error. Never both.

WHY THIS IS A FUNCTION AND NOT A BASE CLASS. The ai_calls row needs `feature` and
`request_id`, and neither is an argument to LLMProvider.complete(). If logging
lived inside the providers, both would have to become parameters of the seam --
so keeping this wrapper outside is precisely what lets `complete()` stay the
one-method Protocol it is. Retry and fallback both re-enter the call, which a
`for` loop expresses and a mixin would need recursion and a depth counter for.

ORDERING, WHICH IS LOAD-BEARING:
    truncation (inside the provider) -> strip -> non-empty guard -> validate
    -> retry once -> fail
Truncation first and separately, so a response cut off at max_tokens fails with
an accurate cause rather than a misleading schema violation, and does not spend
the single retry on an input no re-ask can fix.
"""
from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ValidationError

from services.llm.audit import AuditWriter, build_row, record
from services.llm.base import LLMProvider, LLMResult, Message
from services.llm.errors import (
    LLMChainExhausted,
    LLMEmptyResponse,
    LLMNotConfigured,
    LLMProviderError,
    LLMSchemaError,
)
from services.llm.postprocess import strip_think, validate_against

logger = logging.getLogger(__name__)

# How much of an off-schema response to quote back to the model. Enough to see
# what it did, short enough not to double the next prompt.
_REPAIR_ECHO_CHARS = 2000


def _repair_turns(offending: str, exc: ValidationError) -> list[Message]:
    """The turns that make the retry INFORMED rather than a coin flip.

    A bare re-send to a near-deterministic model returns the identical bad output,
    so an uninformed retry costs a full call and buys nothing. Ordinary multi-turn
    -- a completed assistant turn followed by a user turn -- NOT an assistant
    prefill, which 4.6+ models reject outright.
    """
    problems = "; ".join(
        f"{'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['msg']}" for e in exc.errors()[:8]
    )
    return [
        Message(role="assistant", content=offending[:_REPAIR_ECHO_CHARS]),
        Message(
            role="user",
            content=(
                f"That response did not match the required JSON schema: {problems}. "
                f"Reply with ONLY the JSON object, no prose and no code fence."
            ),
        ),
    ]


async def _attempt(
    provider: LLMProvider,
    feature: str,
    messages: list[Message],
    *,
    json_schema: type[BaseModel] | None,
    max_tokens: int,
    tools: list[dict] | None,
    request_id: str,
    audit_writer: AuditWriter | None,
) -> LLMResult:
    """One provider, up to two calls. Writes one ai_calls row per call."""
    # A COPY. The insights tool loop reuses one list across turns, and appending
    # repair turns in place would leave them embedded in the conversation for every
    # subsequent turn -- invisible, permanent, and paid for on each one.
    turns = list(messages)

    for attempt in (1, 2):
        try:
            raw = await provider.complete(
                turns, json_schema=json_schema, max_tokens=max_tokens, tools=tools
            )
        except LLMProviderError as exc:
            exc.feature, exc.request_id = feature, request_id
            await record(audit_writer, build_row(
                feature=feature, provider=exc.provider or provider.name,
                model=exc.model or provider.model, request_id=request_id, success=False,
                tokens_in=exc.tokens_in, tokens_out=exc.tokens_out,
                latency_ms=exc.latency_ms, error=exc.as_error_text(),
            ))
            # Transport and vendor failures do not get the retry: it exists for a
            # model that produced the wrong SHAPE, and the chain is the right answer
            # to a provider that is down.
            raise

        text = strip_think(raw.text)

        def _row(success: bool, error: str | None = None) -> dict[str, Any]:
            return build_row(
                feature=feature, provider=raw.provider, model=raw.model,
                request_id=request_id, success=success, tokens_in=raw.tokens_in,
                tokens_out=raw.tokens_out, latency_ms=raw.latency_ms,
                est_cost_usd=raw.est_cost_usd, error=error,
            )

        if not text and not raw.tool_calls:
            # Everything the model produced was reasoning. An empty string returned
            # as an answer is the silent degradation this whole layer refuses.
            err = LLMEmptyResponse(
                f"{raw.provider} returned nothing but reasoning",
                feature=feature, provider=raw.provider, model=raw.model,
                request_id=request_id, latency_ms=raw.latency_ms,
                tokens_in=raw.tokens_in, tokens_out=raw.tokens_out,
            )
            await record(audit_writer, _row(False, err.as_error_text()))
            raise err

        if json_schema is None:
            await record(audit_writer, _row(True))
            return raw.model_copy(update={"text": text})

        try:
            validate_against(json_schema, text)
        except ValidationError as exc:
            await record(audit_writer, _row(False, f"LLMSchemaError: {exc.error_count()} error(s)"))
            if attempt == 1:
                turns = turns + _repair_turns(text, exc)
                continue
            raise LLMSchemaError(
                f"{raw.provider} failed {json_schema.__name__} validation twice",
                feature=feature, provider=raw.provider, model=raw.model,
                request_id=request_id, latency_ms=raw.latency_ms,
                tokens_in=raw.tokens_in, tokens_out=raw.tokens_out,
            ) from exc

        await record(audit_writer, _row(True))
        return raw.model_copy(update={"text": text})

    raise AssertionError("unreachable: the attempt loop always returns or raises")


async def complete(
    feature: str,
    messages: list[Message],
    *,
    json_schema: type[BaseModel] | None = None,
    max_tokens: int = 1024,
    tools: list[dict] | None = None,
    request_id: str | None = None,
    chain: list[LLMProvider] | None = None,
    audit_writer: AuditWriter | None = None,
) -> LLMResult:
    """Run `feature`'s provider chain until one answers, or raise.

    `chain` is injectable so the fallback logic can be tested without env vars and
    without HTTP; production passes None and the registry resolves it.

    Sequential, in list order. No hedging: running two providers concurrently
    doubles spend on the expensive one exactly when the cheap one is merely slow,
    and both would write ledger rows with no way to say which answer the user got.
    """
    request_id = request_id or str(uuid4())

    if chain is None:
        from services.llm.registry import chain_for, resolve_feature

        feature = resolve_feature(feature)
        chain = chain_for(feature)

    if not chain:
        raise LLMNotConfigured(
            f"no usable provider chain for {feature!r}", feature=feature, request_id=request_id
        )

    failures: list[LLMProviderError] = []
    for provider in chain:
        try:
            return await _attempt(
                provider, feature, messages,
                json_schema=json_schema, max_tokens=max_tokens, tools=tools,
                request_id=request_id, audit_writer=audit_writer,
            )
        except LLMProviderError as exc:
            failures.append(exc)
            logger.warning(
                "llm %s/%s failed for %s (request_id=%s): %s",
                provider.name, provider.model, feature, request_id, exc.as_error_text(),
            )
            continue

    raise LLMChainExhausted(feature, request_id, failures)


__all__ = ["complete"]
