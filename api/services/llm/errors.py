"""The typed failure vocabulary for the LLM layer.

The rule this hierarchy exists to serve: FAILURE IS EXPLICIT, NEVER SILENT. No
provider may return an empty string, a None, or a plausible-looking degraded
answer. Every failure is one of these, every one carries enough to write a
complete ai_calls row, and the route maps them by class rather than by string.

Each class states its HTTP code in its docstring, following the convention in
services/quickbooks.py -- the route's mapper is the only place that turns one
into an HTTPException.
"""
from __future__ import annotations

from typing import Any


class LLMError(RuntimeError):
    """Base for every failure in this layer.

    Carries what a failure row needs. There is no LLMResult on a failure, so if
    this did not carry provider/model/latency/tokens, the failure row in ai_calls
    would be strictly less informative than the success row -- and the failures
    are the rows you actually go looking for.
    """

    def __init__(
        self,
        message: str,
        *,
        feature: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        request_id: str | None = None,
        latency_ms: int = 0,
        tokens_in: int = 0,
        tokens_out: int = 0,
        status: int | None = None,
        retry_after: str | None = None,
    ) -> None:
        super().__init__(message)
        self.feature = feature
        self.provider = provider
        self.model = model
        self.request_id = request_id
        self.latency_ms = latency_ms
        self.tokens_in = tokens_in
        self.tokens_out = tokens_out
        self.status = status
        self.retry_after = retry_after

    def as_error_text(self) -> str:
        """One line for ai_calls.error -- the class name plus the message.

        The class name leads because it is what a GROUP BY over the ledger keys
        on when asking "what is failing", and a bare vendor message is not stable
        enough to group by.
        """
        return f"{type(self).__name__}: {self}"[:2048]


class LLMNotConfigured(LLMError):
    """No usable provider chain for this feature -> HTTP 503.

    Config, not vendors. Raised when a feature names no chain, when every provider
    in it was skipped for a missing key, or when a chain names a model with no
    price on file.
    """


class LLMRequestError(ValueError):
    """OUR call into this layer was malformed -> HTTP 400.

    Deliberately NOT an LLMError: it never advances the chain and never writes an
    ai_calls row, because no provider call was attempted. Mirrors
    QuickBooksValidationError -- "our own guard", kept out of Sentry on purpose.
    """


class LLMProviderError(LLMError):
    """One attempt against one provider failed. The chain catches these.

    Never reaches a route on its own: it either advances to the next provider or
    is collected into LLMChainExhausted.
    """


class LLMTimeout(LLMProviderError):
    """The provider did not answer inside its timeout, or the chain budget ran out."""


class LLMTransportError(LLMProviderError):
    """Connection refused, DNS failure, TLS failure. Usually a box that is off."""


class LLMAuthError(LLMProviderError):
    """401/403 -- OUR key is wrong, expired or revoked. Not the user's problem."""


class LLMRateLimited(LLMProviderError):
    """429. Carries retry_after, and deliberately does NOT sleep on it: sleeping
    inside a 60s wall turns a rate limit into a gateway timeout."""


class LLMProtocolError(LLMProviderError):
    """The response did not have the shape the API promises.

    Non-JSON body, no choices, no text block, or content empty while
    reasoning_content is populated (a real Qwen-on-vLLM shape). Exists so no bare
    KeyError or IndexError can escape a provider -- the route would file a vendor
    problem as a Jigged 500 and Sentry would blame us for it.
    """


class LLMTruncated(LLMProviderError):
    """Output hit max_tokens. Checked BEFORE validation, so a cut-off object fails
    with an accurate cause instead of a misleading schema violation -- and does not
    waste the one retry on an input no re-ask can fix."""


class LLMRefused(LLMProviderError):
    """The model declined the request (Anthropic stop_reason 'refusal')."""


class LLMEmptyResponse(LLMProviderError):
    """Nothing left after the <think> strip, and no tool calls either.

    Its own class because an empty string returned as an answer is the precise
    silent-degradation shape this layer exists to refuse.
    """


class LLMSchemaError(LLMProviderError):
    """The response failed schema validation twice -- once, then once more after
    being told exactly what was wrong. Treated as a provider failure at that point."""


class LLMToolLoopExhausted(LLMError):
    """The tool-use loop hit its iteration cap -> HTTP 502.

    Replaces the old behaviour, which returned "I wasn't able to complete the
    analysis. Please try a simpler question." as an HTTP 200 -- a failure dressed
    as an answer, which the user cannot distinguish from a real one.
    """


class LLMChainExhausted(LLMError):
    """Every provider in the feature's chain failed -> HTTP 502, or 503 offline.

    `failures` holds the underlying LLMProviderErrors in the order they were tried.
    str() names the feature, the request id and each provider with its error class,
    which is what goes to logs and Sentry -- and never to the browser. A machinist
    should not read "DeepInfra 429".
    """

    def __init__(self, feature: str, request_id: str, failures: list[Any]) -> None:
        detail = ", ".join(
            f"{getattr(f, 'provider', None) or '?'}={type(f).__name__}" for f in failures
        ) or "no provider was reachable"
        super().__init__(
            f"every provider failed for {feature} (request_id={request_id}): {detail}",
            feature=feature,
            request_id=request_id,
        )
        self.failures = list(failures)

    @property
    def is_offline(self) -> bool:
        """True when this is a local box being unavailable rather than an incident.

        Drives two things: the job's error_kind ('ai_offline'), and whether Sentry
        hears about it. A desktop that is asleep is expected downtime, and paging
        on it trains the alert away.
        """
        return bool(self.failures) and all(
            isinstance(f, (LLMTimeout, LLMTransportError, LLMNotConfigured))
            for f in self.failures
        )


__all__ = [
    "LLMAuthError",
    "LLMChainExhausted",
    "LLMEmptyResponse",
    "LLMError",
    "LLMNotConfigured",
    "LLMProtocolError",
    "LLMProviderError",
    "LLMRateLimited",
    "LLMRefused",
    "LLMRequestError",
    "LLMSchemaError",
    "LLMTimeout",
    "LLMToolLoopExhausted",
    "LLMTransportError",
    "LLMTruncated",
]
