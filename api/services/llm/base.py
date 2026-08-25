"""The provider seam: one Protocol, one result type, one message format.

WHAT IS DELIBERATELY NOT ON THIS SEAM, and why. An implementation of
`LLMProvider` is a dialect adapter and nothing else. It translates our message
format into one vendor's wire format, makes one HTTP call, and translates the
answer back. It does NOT:

  * strip <think> blocks          -- postprocess.strip_think, one implementation
  * validate against a schema     -- postprocess.validate_against
  * retry                         -- call.py owns the single informed retry
  * compute cost                  -- pricing.estimate_cost_usd
  * write the ai_calls row        -- audit.record
  * fall back to another provider -- call.py owns the chain

Every one of those has to happen identically for every provider, and a provider
that cannot forget to log is better than a convention saying it must not. It is
also what keeps `complete()` to one method: the ledger row needs `feature` and
`request_id`, and if logging lived in here those would have to be parameters.

A Protocol rather than an ABC, mirroring services/accounting/base.py: there are
two concrete classes and no shared state, and an ABC named anything provider-ish
would invite confusion with services/ai/base_provider.py's AIProvider -- the
thing this layer is explicitly NOT extending.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from services.llm.errors import LLMRequestError

Role = Literal["system", "user", "assistant", "tool"]


class TextPart(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ImagePart(BaseModel):
    """One image, base64 in memory.

    CANONICALLY BARE base64, not a data: URL, because Anthropic wants the raw
    string and OpenAI-compat wants it wrapped -- storing the wrapped form would
    mean parsing it back out for one of the two adapters.

    These never travel in ai_jobs.payload: a 2MB drawing page is ~2.7MB base64 and
    a 40-page package would be a 100MB jsonb row. The payload carries a Storage
    path and a signed URL; the worker renders and encodes at execution time, and
    discards. This type exists only between that render and the HTTP call.
    """

    type: Literal["image"] = "image"
    media_type: Literal["image/png", "image/jpeg", "image/webp"]
    data: str


ContentPart = TextPart | ImagePart


class ToolCall(BaseModel):
    """A tool invocation, normalised across dialects.

    `id` is opaque and round-trips verbatim, which is what lets a fallback switch
    providers MID-CONVERSATION: a `call_x` minted by DeepInfra is accepted back by
    Anthropic on the next turn because neither side interprets it.
    """

    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class Message(BaseModel):
    """One conversation turn, in an OpenAI-shaped canonical format.

    `content` accepts a plain string for ergonomics and normalises to parts, so
    the multimodal path is not a retrofit when the drawing surface starts sending
    images to a VLM -- which is exactly the migration this shape exists to avoid
    having to do under pressure.
    """

    role: Role
    content: str | list[ContentPart] = ""
    tool_calls: list[ToolCall] = Field(default_factory=list)
    tool_call_id: str | None = None

    def parts(self) -> list[ContentPart]:
        if isinstance(self.content, str):
            return [TextPart(text=self.content)] if self.content else []
        return list(self.content)

    def text(self) -> str:
        return "\n".join(p.text for p in self.parts() if isinstance(p, TextPart))

    def has_image(self) -> bool:
        return any(isinstance(p, ImagePart) for p in self.parts())


class LLMResult(BaseModel):
    """What one successful provider call produced.

    Frozen: the gateway returns a modified copy after stripping <think>, and an
    accidental in-place mutation of a result that has already been logged would
    make the ledger and the answer disagree.
    """

    model_config = ConfigDict(frozen=True)

    text: str
    tool_calls: list[ToolCall] = Field(default_factory=list)
    # What the SERVER echoed back, not what we asked for -- so a gateway that
    # silently reroutes to a different model is visible in the ledger.
    model: str
    provider: str
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: int = 0
    est_cost_usd: Decimal = Decimal("0")


@runtime_checkable
class LLMProvider(Protocol):
    """One vendor dialect. See the module docstring for what is NOT on here.

    `name`, `model` and `timeout_s` are attributes rather than being reachable
    only through a successful call, because a FAILURE produces no LLMResult and
    the ai_calls row still has to name the provider and model that failed.

    NOTE ON runtime_checkable: isinstance() against a Protocol checks method
    PRESENCE only -- not signatures, not async-ness. That is why the conformance
    tests pair it with a set-difference over public names and an inspect.signature
    comparison. On its own it would pass a provider whose complete() took
    different arguments.
    """

    name: str
    model: str
    timeout_s: float

    async def complete(
        self,
        messages: list[Message],
        json_schema: type[BaseModel] | None = None,
        max_tokens: int = 1024,
        tools: list[dict] | None = None,
    ) -> LLMResult: ...


def split_system(messages: list[Message]) -> tuple[str | None, list[Message]]:
    """Hoist leading system turns out of the message list.

    THERE IS NO `system=` PARAMETER ANYWHERE IN THIS LAYER. A system prompt is a
    turn like any other, and each adapter puts it where its vendor wants it:
    Anthropic takes it as a top-level field and REJECTS a `system` role inside
    `messages` on claude-sonnet-4-6, while OpenAI-compat wants it as messages[0].
    One canonical format, two placements, one function that knows the difference.

    A system turn appearing AFTER a user turn raises LLMRequestError -- that is
    our bug, not the vendor's, so it must not advance the chain or write a row.
    """
    system_chunks: list[str] = []
    rest: list[Message] = []
    for msg in messages:
        if msg.role != "system":
            rest.append(msg)
            continue
        if rest:
            raise LLMRequestError(
                "A system turn must come before the first user turn. Mid-conversation "
                "system messages are supported only on some models and never as "
                "messages[0]; put operator instructions in the leading system turn."
            )
        if msg.has_image():
            raise LLMRequestError("A system turn cannot carry an image.")
        system_chunks.append(msg.text())

    return ("\n\n".join(c for c in system_chunks if c) or None), rest


__all__ = [
    "ContentPart",
    "ImagePart",
    "LLMProvider",
    "LLMResult",
    "Message",
    "Role",
    "TextPart",
    "ToolCall",
    "split_system",
]
