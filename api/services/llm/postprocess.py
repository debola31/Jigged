"""Text and schema handling that sits between a provider and its caller.

Everything here is a pure function on strings and dicts. That is deliberate: the
provider classes are dialect adapters and nothing else, so the steps that must
happen identically for every provider -- stripping reasoning, tightening a
schema, validating a response -- live here, where one test covers all of them.
"""
from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ValidationError

# A depth-aware scanner rather than one regex, because the two things a regex can
# do here are each wrong for a case that actually occurs:
#   * non-greedy stops at the FIRST </think>, so a NESTED block leaves the outer
#     tail ("outer</think>") sitting in the answer;
#   * greedy runs to the LAST </think>, so two SEQUENTIAL blocks swallow the real
#     text between them.
# Both shapes come out of reasoning models, so the matching has to count depth.
_OPEN = re.compile(r"<think\b[^>]*>", re.IGNORECASE)
_CLOSE = re.compile(r"</think\s*>", re.IGNORECASE)


def _matching_close(text: str, pos: int) -> int | None:
    """Index just past the `</think>` closing the block opened before `pos`."""
    depth = 1
    while depth:
        nxt_open = _OPEN.search(text, pos)
        nxt_close = _CLOSE.search(text, pos)
        if nxt_close is None:
            return None
        if nxt_open is not None and nxt_open.start() < nxt_close.start():
            depth += 1
            pos = nxt_open.end()
        else:
            depth -= 1
            pos = nxt_close.end()
    return pos


def _strip_balanced(text: str) -> str:
    """Remove every balanced block. An unclosed tag is left for the caller."""
    out: list[str] = []
    i = 0
    while True:
        opened = _OPEN.search(text, i)
        if opened is None:
            out.append(text[i:])
            return "".join(out)
        closed = _matching_close(text, opened.end())
        if closed is None:
            out.append(text[i:])
            return "".join(out)
        out.append(text[i : opened.start()])
        i = closed


def _looks_like_json(text: str) -> bool:
    """Whether the response is a JSON payload rather than prose.

    This is what separates the two unclosed-tag cases, and they genuinely want
    opposite treatment: text following a stray `<think>` in PROSE is reasoning and
    must go, while a `<think>` inside a JSON string value is the model quoting the
    literal tag, and truncating there would turn a valid answer into unparseable
    garbage. A structural check, not a content sniff.
    """
    return text.lstrip()[:1] in ("{", "[")


def strip_think(text: str) -> str:
    """Remove `<think>` reasoning from a provider response and normalise whitespace.

    Applied unconditionally to every response, before schema validation and before
    return. The per-provider suppression flags are best-effort at most -- Ollama's
    `think: false` is a NATIVE-API parameter that does nothing on the `/v1` path
    this layer uses, and DeepInfra does not document `enable_thinking` at all --
    so this function is the guarantee, not those.

    Returns '' when the whole response was reasoning. It does NOT raise: the
    gateway turns an empty result into LLMEmptyResponse, so that decision stays in
    one place rather than being duplicated per provider.
    """
    if not text:
        return ""

    text = _strip_balanced(text)

    unclosed = _OPEN.search(text)
    if unclosed is not None and not _looks_like_json(text):
        # A model that hit max_tokens mid-thought. Everything after the tag is
        # reasoning by construction.
        text = text[: unclosed.start()]

    if "<think" not in text.lower():
        # An orphan close with no open anywhere is a token-emission artefact: drop
        # the tag, keep the text. The opposite call from the unclosed-open case
        # above, deliberately -- a stray close does not mean everything before it
        # was reasoning.
        text = _CLOSE.sub("", text)

    return text.strip()


def strictify(schema: dict[str, Any]) -> dict[str, Any]:
    """Tighten a Pydantic-generated JSON Schema for strict structured output.

    Pydantic does not emit `additionalProperties: false`, and both Anthropic's
    `output_config` and DeepInfra's `response_format` strict mode want it on every
    object node, with every property listed in `required`.

    RAISES on `$defs` / `$ref`. Strict-mode `$ref` support is uneven across
    vendors, and refusing at build time beats emitting a schema DeepInfra will 400
    on -- that 400 is a provider failure that advances the chain and costs a real
    call to discover. Keep these schemas flat.
    """
    if "$defs" in schema or "definitions" in schema:
        raise ValueError(
            "strictify: nested $defs/definitions are not supported. Strict-mode $ref "
            "handling differs across providers; flatten the model instead."
        )
    return _strictify_node(schema)


def _strictify_node(node: Any) -> Any:
    if isinstance(node, list):
        return [_strictify_node(n) for n in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        raise ValueError("strictify: $ref is not supported; flatten the model instead.")

    out = {k: _strictify_node(v) for k, v in node.items()}
    if out.get("type") == "object" or "properties" in out:
        out["additionalProperties"] = False
        out["required"] = list((out.get("properties") or {}).keys())
    return out


def validate_against(model: type[BaseModel], text: str) -> BaseModel:
    """Validate a response body against the caller's Pydantic model.

    Runs for EVERY provider, including ones that accepted a structured-output
    request. `response_format` is a request, not a guarantee: a model can wrap
    valid JSON in prose, and a provider can ignore the parameter outright. Asking
    nicely and checking are different things, and only the second is load-bearing.

    Raises pydantic.ValidationError; the gateway turns the first into an informed
    retry and the second into a provider failure.
    """
    return model.model_validate_json(text)


__all__ = ["ValidationError", "strictify", "strip_think", "validate_against"]
