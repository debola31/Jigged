"""The LLM provider layer: one seam, typed failures, and a per-attempt cost ledger.

WHICH FEATURES LIVE HERE, AND WHICH DO NOT. This package coexists with
services/ai/ rather than replacing it. Surfaces migrate one at a time, each behind
its own golden check, and services/ai/ retires when the last one leaves. Until
then two provider abstractions exist on purpose.

  * services/llm/  -- async, chain-based, logged to ai_calls, fail-visible.
  * services/ai/   -- the original AIProvider ABC. Still serves the data-import
                      arms and the drawings route.

DO NOT name anything here `AIProvider`: that is services/ai/base_provider.py, and
it is the thing this layer is explicitly not extending. The import direction is
one-way -- services/llm may import DEFAULT_ANTHROPIC_MODEL from services/ai, and
services/ai must never import services/llm.
"""
from services.llm.base import (
    ImagePart,
    LLMProvider,
    LLMResult,
    Message,
    TextPart,
    ToolCall,
    split_system,
)
from services.llm.call import complete
from services.llm.errors import (
    LLMAuthError,
    LLMChainExhausted,
    LLMEmptyResponse,
    LLMError,
    LLMErrorEcho,
    LLMNotConfigured,
    LLMProtocolError,
    LLMProviderError,
    LLMRateLimited,
    LLMRefused,
    LLMRequestError,
    LLMSchemaError,
    LLMTimeout,
    LLMToolLoopExhausted,
    LLMTransportError,
    LLMTruncated,
)

__all__ = [
    "ImagePart",
    "LLMAuthError",
    "LLMChainExhausted",
    "LLMEmptyResponse",
    "LLMError",
    "LLMNotConfigured",
    "LLMProtocolError",
    "LLMProvider",
    "LLMProviderError",
    "LLMRateLimited",
    "LLMRefused",
    "LLMRequestError",
    "LLMResult",
    "LLMSchemaError",
    "LLMTimeout",
    "LLMToolLoopExhausted",
    "LLMTransportError",
    "LLMTruncated",
    "Message",
    "TextPart",
    "ToolCall",
    "complete",
    "split_system",
]
