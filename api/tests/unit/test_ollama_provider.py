"""The native Ollama adapter: what goes on the wire, and what comes back typed.

THE ONE PROPERTY THAT JUSTIFIES A SECOND ADAPTER FOR THE SAME SERVER: with
`truncate: false` a prompt past the window is a 400 this layer can name. On the
OpenAI-compatible path the same prompt came back 200 with the schema silently cut
from the front, and a schema-less answer looks exactly like an answer.

Same seam as openai_compat: an injected httpx.MockTransport, so every assertion is
against the real request that would have gone out.
"""
from __future__ import annotations

import json

import httpx
import pytest
from pydantic import BaseModel

from services.llm.base import LLMProvider, LLMResult, Message, ToolCall
from services.llm.errors import (
    LLMChainExhausted,
    LLMContextOverflow,
    LLMProtocolError,
    LLMProviderError,
    LLMTimeout,
    LLMTransportError,
    LLMTruncated,
)
from services.llm.ollama_provider import OLLAMA_NUM_CTX, OllamaProvider

pytestmark = pytest.mark.unit


def _native_body(content="Answer", *, tool_calls=None, done_reason="stop", model="qwen3:32b",
                 prompt_eval=700, evals=120, thinking=None):
    msg = {"role": "assistant", "content": content}
    if tool_calls is not None:
        msg["tool_calls"] = tool_calls
    if thinking is not None:
        msg["thinking"] = thinking
    return {
        "model": model, "message": msg, "done": True, "done_reason": done_reason,
        "prompt_eval_count": prompt_eval, "eval_count": evals,
    }


# What Ollama 0.33 actually returns for an over-long prompt with truncate off --
# llama-server's JSON error, serialised as a STRING inside Ollama's own envelope.
OVERFLOW_400 = {
    "error": json.dumps({"error": {
        "code": 400,
        "message": "request (609 tokens) exceeds the available context size (256 tokens), try increasing it",
        "type": "exceed_context_size_error", "n_prompt_tokens": 609, "n_ctx": 256,
    }})
}


def _ollama(handler=None, **over):
    seen: list[httpx.Request] = []

    def default(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_native_body())

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    kwargs = dict(
        base_url="http://localhost:11434/v1",
        model="qwen3:32b",
        transport=httpx.MockTransport(recording if handler else default),
    )
    kwargs.update(over)
    return OllamaProvider(**kwargs), seen


def _sent(seen) -> dict:
    return json.loads(seen[0].content)


class Insight(BaseModel):
    headline: str
    confidence: float


# ------------------------------------------------------------------- the seam


def test_it_is_a_provider_like_the_others():
    provider, _ = _ollama()
    assert isinstance(provider, LLMProvider)
    assert (provider.name, provider.model, provider.timeout_s) == ("ollama", "qwen3:32b", 120.0)
    # Priced at exactly zero and not configurable; the registry test reads these.
    assert (provider._price_in, provider._price_out) == (0, 0)


# ---------------------------------------------------------------- the request


async def test_the_request_pins_the_window_and_refuses_silent_truncation():
    """THE REASON THIS FILE EXISTS. num_ctx per request, truncate off, thinking off,
    the model kept resident, and the output cap under its native name."""
    provider, seen = _ollama()
    await provider.complete([Message(role="user", content="q")], max_tokens=4000)

    body = _sent(seen)
    assert body["options"]["num_ctx"] == OLLAMA_NUM_CTX == 32_768
    assert body["options"]["num_predict"] == 4000
    assert body["truncate"] is False
    assert body["think"] is False
    assert body["keep_alive"] == -1
    assert body["stream"] is False


async def test_a_caller_may_pin_decoding_but_never_shrink_the_window():
    """The eval passes temperature 0 and a seed. It may not pass a smaller num_ctx by
    accident and quietly bring the truncation back."""
    provider, seen = _ollama(options={"temperature": 0, "seed": 0, "num_ctx": 512})
    await provider.complete([Message(role="user", content="q")])

    options = _sent(seen)["options"]
    assert (options["temperature"], options["seed"]) == (0, 0)
    assert options["num_ctx"] == OLLAMA_NUM_CTX


@pytest.mark.parametrize("base", [
    "http://localhost:11434/v1", "http://localhost:11434/v1/", "http://localhost:11434",
    "http://box.local:11434/",
])
async def test_it_speaks_native_whatever_dialect_the_url_was_written_for(base):
    """OLLAMA_BASE_URL has always carried /v1 (the embeddings module appends
    /embeddings to it). Stripping it here is what keeps every existing environment
    working without an edit."""
    provider, seen = _ollama(base_url=base)
    await provider.complete([Message(role="user", content="q")])
    assert str(seen[0].url).endswith("/api/chat")
    assert "/v1/" not in str(seen[0].url)


async def test_it_sends_no_credential_at_all():
    provider, seen = _ollama()
    await provider.complete([Message(role="user", content="q")])
    assert "authorization" not in {k.lower() for k in seen[0].headers}
    assert "authorization" not in {k.lower() for k in provider._headers()}


async def test_the_system_turn_stays_a_leading_message():
    """One canonical format; the native dialect wants system as messages[0]."""
    provider, seen = _ollama()
    await provider.complete([
        Message(role="system", content="You are an analyst."),
        Message(role="user", content="q"),
    ])
    msgs = _sent(seen)["messages"]
    assert msgs[0] == {"role": "system", "content": "You are an analyst."}
    assert msgs[1] == {"role": "user", "content": "q"}


async def test_tools_go_out_in_the_shared_openai_shape():
    """Ollama's native tool shape IS the OpenAI shape, so the translation that once
    broke both local eval arms has one implementation, reused here."""
    from tools.chat_tools import CHAT_TOOLS

    provider, seen = _ollama()
    await provider.complete([Message(role="user", content="q")], tools=CHAT_TOOLS)
    tools = _sent(seen)["tools"]
    assert len(tools) == len(CHAT_TOOLS)
    assert all(t["type"] == "function" and t["function"]["name"] for t in tools)
    assert all(t["function"]["parameters"].get("properties") for t in tools)
    assert all("input_schema" not in t for t in tools)


async def test_a_tool_exchange_is_keyed_by_name_on_the_native_wire():
    """Native tool results carry the tool's NAME, not the call id the OpenAI dialect
    uses, so the name is looked up from the assistant turn that made the call --
    and arguments travel as an object, not a JSON string."""
    provider, seen = _ollama()
    await provider.complete([
        Message(role="user", content="q"),
        Message(role="assistant", tool_calls=[ToolCall(id="call_1", name="execute_sql",
                                                       arguments={"sql": "select 1"})]),
        Message(role="tool", tool_call_id="call_1", content='{"rows":[]}'),
    ])
    msgs = _sent(seen)["messages"]
    assert msgs[1]["tool_calls"] == [
        {"id": "call_1", "function": {"name": "execute_sql", "arguments": {"sql": "select 1"}}}
    ]
    assert msgs[2]["role"] == "tool"
    assert msgs[2]["tool_name"] == "execute_sql"
    assert msgs[2]["tool_call_id"] == "call_1"
    assert msgs[2]["content"] == '{"rows":[]}'


async def test_structured_output_rides_on_format_with_a_strict_schema():
    provider, seen = _ollama(handler=lambda r: httpx.Response(
        200, json=_native_body('{"headline": "h", "confidence": 0.9}')))
    await provider.complete([Message(role="user", content="q")], json_schema=Insight)

    fmt = _sent(seen)["format"]
    assert fmt["type"] == "object"
    assert fmt["additionalProperties"] is False
    assert set(fmt["required"]) == {"headline", "confidence"}


async def test_no_schema_means_no_format_key():
    provider, seen = _ollama()
    await provider.complete([Message(role="user", content="q")])
    assert "format" not in _sent(seen)


# --------------------------------------------------------------- the response


async def test_a_plain_answer_comes_back_with_the_servers_own_token_counts():
    provider, _ = _ollama()
    result = await provider.complete([Message(role="user", content="q")])
    assert isinstance(result, LLMResult)
    assert result.text == "Answer"
    assert (result.provider, result.model) == ("ollama", "qwen3:32b")
    # prompt_eval_count IS the calibration point for the handler's chars/4 estimate.
    assert (result.tokens_in, result.tokens_out) == (700, 120)
    assert result.est_cost_usd == 0


async def test_tool_calls_keep_the_servers_id_and_object_arguments():
    provider, _ = _ollama(handler=lambda r: httpx.Response(200, json=_native_body(
        "", tool_calls=[{"id": "HMN4dmnV", "function": {"index": 0, "name": "execute_sql",
                                                        "arguments": {"sql": "select 1", "description": "d"}}}],
    )))
    result = await provider.complete([Message(role="user", content="q")])
    assert result.tool_calls == [
        ToolCall(id="HMN4dmnV", name="execute_sql", arguments={"sql": "select 1", "description": "d"})
    ]


async def test_a_tool_call_without_an_id_is_minted_one():
    """Older servers send none. A minted id is accepted back by every dialect,
    because none of them interprets it."""
    provider, _ = _ollama(handler=lambda r: httpx.Response(200, json=_native_body(
        "", tool_calls=[{"function": {"name": "execute_sql", "arguments": '{"sql": "select 1"}'}}],
    )))
    result = await provider.complete([Message(role="user", content="q")])
    assert result.tool_calls[0].id == "call_0"
    # And string-encoded arguments, which some builds emit, are parsed.
    assert result.tool_calls[0].arguments == {"sql": "select 1"}


async def test_hitting_num_predict_is_a_truncation_not_an_answer():
    provider, _ = _ollama(handler=lambda r: httpx.Response(
        200, json=_native_body("cut off mid", done_reason="length")))
    with pytest.raises(LLMTruncated):
        await provider.complete([Message(role="user", content="q")])


async def test_nothing_but_reasoning_is_refused_not_returned():
    provider, _ = _ollama(handler=lambda r: httpx.Response(
        200, json=_native_body("", thinking="let me think")))
    with pytest.raises(LLMProtocolError) as exc:
        await provider.complete([Message(role="user", content="q")])
    assert "only reasoning" in str(exc.value)


# ----------------------------------------------------------------- failures


async def test_an_over_long_prompt_is_a_context_overflow_with_the_servers_count():
    """The whole point, asserted against the exact body Ollama 0.33 returns."""
    provider, _ = _ollama(handler=lambda r: httpx.Response(400, json=OVERFLOW_400))
    with pytest.raises(LLMContextOverflow) as exc:
        await provider.complete([Message(role="user", content="q" * 5000)])
    assert exc.value.status == 400
    assert exc.value.tokens_in == 609
    assert "num_ctx=32768" in str(exc.value)


async def test_any_other_400_is_an_ordinary_provider_failure():
    provider, _ = _ollama(handler=lambda r: httpx.Response(
        400, json={"error": "invalid option provided: nonsense"}))
    with pytest.raises(LLMProviderError) as exc:
        await provider.complete([Message(role="user", content="q")])
    assert not isinstance(exc.value, LLMContextOverflow)
    assert "invalid option" in str(exc.value)


async def test_an_unpulled_model_names_itself_in_the_failure():
    provider, _ = _ollama(handler=lambda r: httpx.Response(
        404, json={"error": "model 'qwen3:32b' not found"}))
    with pytest.raises(LLMProviderError) as exc:
        await provider.complete([Message(role="user", content="q")])
    assert "not found" in str(exc.value) and exc.value.status == 404


async def test_a_timeout_and_a_refused_connection_read_as_the_box_being_off():
    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)

    def refused(request):
        raise httpx.ConnectError("refused", request=request)

    provider, _ = _ollama(handler=slow)
    with pytest.raises(LLMTimeout):
        await provider.complete([Message(role="user", content="q")])

    provider, _ = _ollama(handler=refused)
    with pytest.raises(LLMTransportError):
        await provider.complete([Message(role="user", content="q")])


def test_a_chain_that_only_overflowed_says_so():
    """What both hosts read to pick error_kind: offline first, then overflow."""
    only_overflow = LLMChainExhausted("insights", "rid", [LLMContextOverflow("too long", provider="ollama")])
    assert only_overflow.is_context_overflow and not only_overflow.is_offline

    mixed = LLMChainExhausted("insights", "rid", [
        LLMContextOverflow("too long", provider="ollama"), LLMTimeout("slow", provider="ollama"),
    ])
    assert not mixed.is_context_overflow and not mixed.is_offline

    assert not LLMChainExhausted("insights", "rid", []).is_context_overflow
