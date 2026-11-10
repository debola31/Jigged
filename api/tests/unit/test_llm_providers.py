"""Provider conformance and the dialect matrix.

WHY STRUCTURAL TESTS AT ALL. A `complete()` signature that drifts on one provider
is invisible until the fallback chain actually reaches it -- which is, by
definition, the moment the other provider has already failed. These are cheap
tests guarding an expensive silence, the same argument test_accounting_provider.py
makes for the accounting seam.

HOW HTTP IS MOCKED, AND WHY IT IS ASYMMETRIC. OpenAICompatProvider goes through
raw httpx, so it takes an injected httpx.MockTransport: the handler receives a
real, fully-built Request, which is the only way to assert the URL shape, the
absence of an Authorization header for keyless Ollama, and that a retry's second
body differs from its first. AnthropicProvider goes through the SDK, so it takes
an injected fake client. The asymmetry is stated here so nobody "tidies it up"
into one mechanism that can assert half as much.

No new dependency: httpx is already a first-class dep, and `responses` sitting
unused in requirements-test.txt is the argument against adding respx as a second.
"""
from __future__ import annotations

import inspect
import json
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest
from pydantic import BaseModel

from services.llm.anthropic_provider import AnthropicProvider
from services.llm.base import (
    ImagePart,
    LLMProvider,
    LLMResult,
    Message,
    NativeTurn,
    TextPart,
    ToolCall,
)
from services.llm.errors import (
    LLMAuthError,
    LLMProtocolError,
    LLMProviderError,
    LLMRateLimited,
    LLMRequestError,
    LLMTimeout,
    LLMTransportError,
    LLMTruncated,
)

pytestmark = pytest.mark.unit

PNG_1PX = "iVBORw0KGgoAAAANSUhEUg=="


class Insight(BaseModel):
    headline: str
    confidence: float


# ------------------------------------------------------------------ helpers


def _openai_body(content="Answer", *, tool_calls=None, finish="stop", usage=True, model=None):
    msg = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    body = {"choices": [{"message": msg, "finish_reason": finish}]}
    if usage:
        body["usage"] = {"prompt_tokens": 700, "completion_tokens": 120}
    if model:
        body["model"] = model
    return body


def _compat(handler=None, **over):
    seen: list[httpx.Request] = []

    def default(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_openai_body())

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    from services.llm.openai_compat import OpenAICompatProvider

    kwargs = dict(
        base_url="https://api.deepinfra.com/v1/openai/",
        api_key="k",
        model="Qwen/Qwen3-32B",
        price_in_per_mtok=Decimal("0.08"),
        price_out_per_mtok=Decimal("0.28"),
        name="deepinfra",
        transport=httpx.MockTransport(recording if handler else default),
    )
    kwargs.update(over)
    provider = OpenAICompatProvider(**kwargs)
    return provider, seen


class _FakeAnthropic:
    """Stands in for AsyncAnthropic. Records kwargs, returns or raises.

    Both namespaces record into one list, tagged by `namespaces`, so a test can
    assert WHICH endpoint a model's profile sent it through.
    """

    def __init__(self, response=None, error=None):
        self._response = response
        self._error = error
        self.calls: list[dict] = []
        self.namespaces: list[str] = []
        self.messages = SimpleNamespace(create=self._recorder("messages"))
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._recorder("beta")))

    def _recorder(self, namespace):
        async def create(**kwargs):
            self.calls.append(kwargs)
            self.namespaces.append(namespace)
            if self._error is not None:
                raise self._error
            return self._response

        return create


def _anthropic_msg(text="Answer", *, tool_use=None, stop="end_turn", model="claude-sonnet-4-6"):
    content = []
    if text:
        content.append(SimpleNamespace(type="text", text=text))
    for tu in tool_use or []:
        content.append(SimpleNamespace(type="tool_use", id=tu["id"], name=tu["name"], input=tu["input"]))
    return SimpleNamespace(
        content=content,
        stop_reason=stop,
        model=model,
        usage=SimpleNamespace(input_tokens=1000, output_tokens=500),
    )


def _anthropic(response=None, error=None, **over):
    fake = _FakeAnthropic(response if response is not None else _anthropic_msg(), error)
    return AnthropicProvider(client=fake, **over), fake


# ------------------------------------------------------------- conformance

PROVIDERS = ["anthropic", "deepinfra", "ollama"]


def _ollama():
    from services.llm.ollama_provider import OllamaProvider

    def default(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "model": "qwen3:32b", "message": {"role": "assistant", "content": "Answer"},
            "done": True, "done_reason": "stop", "prompt_eval_count": 700, "eval_count": 120,
        })

    return OllamaProvider(base_url="http://localhost:11434", model="qwen3:32b",
                          transport=httpx.MockTransport(default))


def _instance(kind):
    if kind == "anthropic":
        return _anthropic()[0]
    if kind == "ollama":
        return _ollama()
    return _compat()[0]


@pytest.mark.parametrize("kind", PROVIDERS)
def test_the_provider_satisfies_the_protocol(kind):
    assert isinstance(_instance(kind), LLMProvider)


@pytest.mark.parametrize("kind", PROVIDERS)
def test_the_protocol_covers_every_public_method_the_provider_implements(kind):
    """Set difference, both directions. isinstance() against a runtime_checkable
    Protocol only checks method PRESENCE, so a method added to an implementation
    and forgotten on the seam would otherwise never be noticed."""
    impl = {n for n in dir(type(_instance(kind))) if not n.startswith("_") and callable(
        getattr(type(_instance(kind)), n, None))}
    proto = {n for n in dir(LLMProvider) if not n.startswith("_")}
    assert impl - proto == set(), f"{kind} has public methods absent from LLMProvider: {impl - proto}"


def test_complete_has_an_identical_signature_on_every_provider():
    """The gap isinstance() leaves. A provider whose complete() took `model=` or
    returned a coroutine-of-a-coroutine would satisfy the Protocol and blow up only
    when the chain fell through to it."""
    sigs = {}
    for kind in PROVIDERS:
        fn = type(_instance(kind)).complete
        assert inspect.iscoroutinefunction(fn), f"{kind}.complete is not async"
        sigs[kind] = [
            (p.name, p.default) for p in inspect.signature(fn).parameters.values() if p.name != "self"
        ]
    assert sigs["anthropic"] == sigs["deepinfra"] == sigs["ollama"], sigs
    assert [n for n, _ in sigs["anthropic"]] == ["messages", "json_schema", "max_tokens", "tools"]


@pytest.mark.parametrize("kind", PROVIDERS)
async def test_every_result_field_is_populated(kind):
    result = await _instance(kind).complete([Message(role="user", content="hi")])
    assert isinstance(result, LLMResult)
    assert set(result.model_dump()) == {
        "text", "tool_calls", "model", "provider", "tokens_in", "tokens_out",
        "latency_ms", "est_cost_usd", "native",
    }
    assert result.provider == kind
    assert result.model and result.text
    assert result.latency_ms >= 0


def test_the_anthropic_provider_never_pins_a_base_url(monkeypatch):
    """CI'S ENTIRE E2E STRATEGY DEPENDS ON THIS ONE ABSENCE.

    e2e/run-stack.mjs starts a mock Anthropic server and points the backend at it
    through ANTHROPIC_BASE_URL, which the SDK honours only while no base_url kwarg
    is passed. Adding `base_url=... or "https://api.anthropic.com"` here would read
    as a tidy-up and would silently redirect every E2E run to the real API on a
    real key -- and the tests would still pass, which is what makes it dangerous.
    """
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9876")
    provider = AnthropicProvider()
    assert str(provider._client.base_url).rstrip("/") == "http://127.0.0.1:9876"


def test_the_anthropic_client_does_not_retry_on_its_own():
    """The SDK default is 2, and timeouts ARE retried -- so one hung call would
    spend three timeouts of the function's wall. Retry belongs to the chain, which
    can pick a different provider instead of hammering the one that just failed."""
    provider = AnthropicProvider(api_key="k")
    assert provider._client.max_retries == 0


# ------------------------------------------------- openai-compat: the request


async def test_the_request_goes_to_chat_completions_without_a_double_slash():
    provider, seen = _compat()
    await provider.complete([Message(role="user", content="hi")])
    assert str(seen[0].url) == "https://api.deepinfra.com/v1/openai/chat/completions"


async def test_a_keyless_provider_sends_no_authorization_header():
    """Ollama has no key by design. Sending "Bearer " is worse than sending
    nothing, and some gateways reject it outright."""
    provider, seen = _compat(api_key=None, name="ollama",
                             base_url="http://localhost:11434/v1")
    await provider.complete([Message(role="user", content="hi")])
    assert "authorization" not in {k.lower() for k in seen[0].headers}


async def test_a_keyed_provider_sends_a_bearer_token():
    provider, seen = _compat()
    await provider.complete([Message(role="user", content="hi")])
    assert seen[0].headers["authorization"] == "Bearer k"


async def test_registry_supplied_extra_body_keys_reach_the_wire():
    """The reason there is not one `if self.name == "ollama"` in the provider.

    Ollama's /v1 path ignores `think: false` -- that is the NATIVE api's knob --
    and takes reasoning_effort instead; DeepInfra takes an undocumented
    chat_template_kwargs. Both are registry data, so a vendor rejecting one is a
    config edit rather than a deploy.
    """
    provider, seen = _compat(extra_body={"reasoning_effort": "none"})
    await provider.complete([Message(role="user", content="hi")])
    body = json.loads(seen[0].content)
    assert body["reasoning_effort"] == "none"
    assert body["stream"] is False


async def test_a_schema_is_requested_in_the_openai_dialect():
    provider, seen = _compat()
    await provider.complete([Message(role="user", content="hi")], json_schema=Insight)
    fmt = json.loads(seen[0].content)["response_format"]
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["name"] == "Insight"
    assert fmt["json_schema"]["strict"] is True
    schema = fmt["json_schema"]["schema"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {"headline", "confidence"}


async def test_a_system_turn_stays_in_the_message_list():
    """The other half of split_system: OpenAI-compat wants it as messages[0],
    Anthropic wants it hoisted. One canonical format, two placements."""
    provider, seen = _compat()
    await provider.complete([
        Message(role="system", content="be terse"),
        Message(role="user", content="hi"),
    ])
    msgs = json.loads(seen[0].content)["messages"]
    assert msgs[0] == {"role": "system", "content": "be terse"}


async def test_a_tool_result_turn_carries_its_call_id():
    provider, seen = _compat()
    await provider.complete([
        Message(role="user", content="q"),
        Message(role="assistant", tool_calls=[ToolCall(id="call_1", name="execute_sql",
                                                       arguments={"sql": "select 1"})]),
        Message(role="tool", tool_call_id="call_1", content='{"rows":[]}'),
    ])
    msgs = json.loads(seen[0].content)["messages"]
    assert msgs[1]["tool_calls"][0]["function"]["name"] == "execute_sql"
    # arguments is a JSON string on the wire, not an object.
    assert json.loads(msgs[1]["tool_calls"][0]["function"]["arguments"]) == {"sql": "select 1"}
    assert msgs[2] == {"role": "tool", "tool_call_id": "call_1", "content": '{"rows":[]}'}


async def test_an_anthropic_shaped_tool_is_translated_for_the_wire():
    """CHAT_TOOLS is Anthropic-native. Handing it over unchanged is what broke both
    non-anthropic arms of evals/insights_ab.py: DeepInfra answered 422 "Field
    required" (no `function` key) and Ollama returned a nameless tool call, neither
    of which reads as "the tool schema was wrong"."""
    provider, seen = _compat()
    await provider.complete(
        [Message(role="user", content="q")],
        tools=[{
            "name": "execute_sql",
            "description": "Run a read-only SELECT.",
            "input_schema": {"type": "object", "properties": {"sql": {"type": "string"}}},
        }],
    )
    tool = json.loads(seen[0].content)["tools"][0]
    assert tool["type"] == "function"
    assert tool["function"]["name"] == "execute_sql"
    assert tool["function"]["description"] == "Run a read-only SELECT."
    assert tool["function"]["parameters"]["properties"] == {"sql": {"type": "string"}}
    assert "input_schema" not in tool


async def test_the_real_chat_tools_reach_the_wire_openai_shaped():
    """The object actually sent in production, not a stand-in. A tool added to
    CHAT_TOOLS in Anthropic shape -- which is the shape that file is written in --
    must keep arriving translated."""
    from tools.chat_tools import CHAT_TOOLS

    provider, seen = _compat()
    await provider.complete([Message(role="user", content="q")], tools=CHAT_TOOLS)
    tools = json.loads(seen[0].content)["tools"]
    assert len(tools) == len(CHAT_TOOLS)
    assert all(t["type"] == "function" and t["function"]["name"] for t in tools)
    assert all(t["function"]["parameters"].get("properties") for t in tools)


async def test_an_already_openai_shaped_tool_passes_through():
    """Callers may hand over either dialect; only the Anthropic one is converted."""
    already = {
        "type": "function",
        "function": {"name": "noop", "description": "", "parameters": {"type": "object"}},
    }
    provider, seen = _compat()
    await provider.complete([Message(role="user", content="q")], tools=[already])
    assert json.loads(seen[0].content)["tools"] == [already]


# ------------------------------------------------ openai-compat: the response


async def test_tokens_and_cost_come_off_the_usage_block():
    provider, _ = _compat()
    r = await provider.complete([Message(role="user", content="hi")])
    assert (r.tokens_in, r.tokens_out) == (700, 120)
    # 700 in @ $0.08/Mtok = 0.000056; 120 out @ $0.28/Mtok = 0.0000336
    assert r.est_cost_usd == Decimal("0.00008960")


async def test_the_model_the_server_echoed_is_what_gets_recorded():
    """So a gateway that silently reroutes to a different model is visible in the
    ledger rather than being reported as the model we asked for."""
    provider, _ = _compat(handler=lambda r: httpx.Response(
        200, json=_openai_body(model="Qwen/Qwen3-32B-AWQ")))
    r = await provider.complete([Message(role="user", content="hi")])
    assert r.model == "Qwen/Qwen3-32B-AWQ"


async def test_a_missing_usage_block_logs_zero_rather_than_guessing(caplog):
    provider, _ = _compat(handler=lambda r: httpx.Response(200, json=_openai_body(usage=False)))
    r = await provider.complete([Message(role="user", content="hi")])
    assert (r.tokens_in, r.tokens_out, r.est_cost_usd) == (0, 0, Decimal("0"))


async def test_tool_calls_are_normalised_and_their_arguments_parsed():
    provider, _ = _compat(handler=lambda r: httpx.Response(200, json=_openai_body(
        content="", tool_calls=[{"id": "call_9", "type": "function", "function": {
            "name": "execute_sql", "arguments": '{"sql":"select 1"}'}}])))
    r = await provider.complete([Message(role="user", content="hi")])
    assert r.tool_calls == [ToolCall(id="call_9", name="execute_sql", arguments={"sql": "select 1"})]


@pytest.mark.parametrize("status, expected", [
    (401, LLMAuthError), (403, LLMAuthError), (429, LLMRateLimited),
    (400, LLMProviderError), (500, LLMProviderError), (503, LLMProviderError),
])
async def test_http_failures_map_to_typed_errors(status, expected):
    provider, _ = _compat(handler=lambda r: httpx.Response(
        status, json={"error": {"message": "nope"}}, headers={"Retry-After": "30"}))
    with pytest.raises(expected) as exc:
        await provider.complete([Message(role="user", content="hi")])
    assert exc.value.provider == "deepinfra"
    assert exc.value.status == status


async def test_a_rate_limit_captures_retry_after_and_does_not_sleep():
    """Sleeping inside a 60s wall turns a 429 into a gateway timeout, and the chain
    has somewhere else to go anyway."""
    provider, _ = _compat(handler=lambda r: httpx.Response(
        429, json={}, headers={"Retry-After": "30"}))
    with pytest.raises(LLMRateLimited) as exc:
        await provider.complete([Message(role="user", content="hi")])
    assert exc.value.retry_after == "30"


async def test_a_four_hundred_carries_the_vendors_own_wording():
    """This is how an unsupported chat_template_kwargs surfaces, and reading the
    vendor's sentence is the whole diagnostic."""
    provider, _ = _compat(handler=lambda r: httpx.Response(
        400, json={"error": {"message": "unknown parameter enable_thinking"}}))
    with pytest.raises(LLMProviderError) as exc:
        await provider.complete([Message(role="user", content="hi")])
    assert "enable_thinking" in str(exc.value)


@pytest.mark.parametrize("raises, expected", [
    (httpx.ReadTimeout("slow"), LLMTimeout),
    (httpx.ConnectTimeout("slow"), LLMTimeout),
    (httpx.ConnectError("refused"), LLMTransportError),
])
async def test_transport_failures_map_to_typed_errors(raises, expected):
    def boom(request):
        raise raises
    provider, _ = _compat(handler=boom)
    with pytest.raises(expected):
        await provider.complete([Message(role="user", content="hi")])


@pytest.mark.parametrize("response", [
    httpx.Response(200, text="<html>gateway</html>"),
    httpx.Response(200, json={"choices": []}),
    httpx.Response(200, json=_openai_body(content="")),
])
async def test_a_malformed_body_is_a_protocol_error_not_a_key_error(response):
    """No bare KeyError or IndexError may escape a provider. The route's mapper
    would turn one into a 500 and Sentry would file a vendor problem as our bug."""
    provider, _ = _compat(handler=lambda r: response)
    with pytest.raises(LLMProtocolError):
        await provider.complete([Message(role="user", content="hi")])


async def test_reasoning_only_content_is_refused_rather_than_returned_empty():
    """A real Qwen-on-vLLM shape: everything lands in reasoning_content and content
    comes back empty. Returning "" is the silent degradation this layer refuses."""
    body = {"choices": [{"message": {"content": "", "reasoning_content": "thinking..."},
                         "finish_reason": "stop"}], "usage": {}}
    provider, _ = _compat(handler=lambda r: httpx.Response(200, json=body))
    with pytest.raises(LLMProtocolError) as exc:
        await provider.complete([Message(role="user", content="hi")])
    assert "only reasoning" in str(exc.value)


async def test_a_truncated_response_says_so_instead_of_failing_validation():
    provider, _ = _compat(handler=lambda r: httpx.Response(
        200, json=_openai_body(content='{"headline":"cut of', finish="length")))
    with pytest.raises(LLMTruncated):
        await provider.complete([Message(role="user", content="hi")], json_schema=Insight)


# --------------------------------------------------------- anthropic dialect


async def test_a_system_turn_is_hoisted_out_of_the_message_list():
    """claude-sonnet-4-6 REJECTS a system role inside messages. This is the half of
    split_system that would fail loudly in production and silently in a mock."""
    provider, fake = _anthropic()
    await provider.complete([
        Message(role="system", content="be terse"),
        Message(role="user", content="hi"),
    ])
    assert fake.calls[0]["system"] == "be terse"
    assert [m["role"] for m in fake.calls[0]["messages"]] == ["user"]


async def test_a_system_turn_after_a_user_turn_is_our_bug_not_the_vendors():
    provider, _ = _anthropic()
    with pytest.raises(LLMRequestError):
        await provider.complete([
            Message(role="user", content="hi"),
            Message(role="system", content="late"),
        ])


async def test_consecutive_tool_results_merge_into_one_user_message():
    """Anthropic requires every tool_result for one assistant turn in a SINGLE user
    message. Splitting them is accepted by the API and silently trains the model out
    of making parallel tool calls -- a performance regression with no error."""
    provider, fake = _anthropic()
    await provider.complete([
        Message(role="user", content="q"),
        Message(role="assistant", tool_calls=[
            ToolCall(id="t1", name="execute_sql", arguments={"sql": "a"}),
            ToolCall(id="t2", name="execute_sql", arguments={"sql": "b"}),
        ]),
        Message(role="tool", tool_call_id="t1", content="[]"),
        Message(role="tool", tool_call_id="t2", content="[]"),
    ])
    msgs = fake.calls[0]["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user"]
    assert [b["type"] for b in msgs[2]["content"]] == ["tool_result", "tool_result"]
    assert [b["tool_use_id"] for b in msgs[2]["content"]] == ["t1", "t2"]


async def test_a_schema_is_requested_through_output_config():
    provider, fake = _anthropic()
    await provider.complete([Message(role="user", content="hi")], json_schema=Insight)
    fmt = fake.calls[0]["output_config"]["format"]
    assert fmt["type"] == "json_schema"
    assert fmt["schema"]["additionalProperties"] is False


async def test_no_thinking_parameter_is_sent():
    """{"type": "disabled"} has its own documented failure modes -- tool calls
    written into visible text, leaked tags -- and Sonnet 4.6 does not think unless
    asked. strip_think still runs; it is a no-op here and insurance if the pinned
    model changes."""
    provider, fake = _anthropic()
    await provider.complete([Message(role="user", content="hi")])
    assert "thinking" not in fake.calls[0]


@pytest.mark.parametrize("stop, expected", [("max_tokens", LLMTruncated), ("refusal", None)])
async def test_stop_reason_is_checked_before_the_content(stop, expected):
    from services.llm.errors import LLMRefused
    provider, _ = _anthropic(_anthropic_msg(text="partial", stop=stop))
    with pytest.raises(expected or LLMRefused):
        await provider.complete([Message(role="user", content="hi")])


async def test_text_blocks_are_joined_not_truncated_to_the_first():
    provider, _ = _anthropic(SimpleNamespace(
        content=[SimpleNamespace(type="text", text="one "), SimpleNamespace(type="text", text="two")],
        stop_reason="end_turn", model="claude-sonnet-4-6",
        usage=SimpleNamespace(input_tokens=10, output_tokens=5)))
    r = await provider.complete([Message(role="user", content="hi")])
    assert r.text == "one two"


async def test_anthropic_cost_uses_the_pinned_models_list_price():
    provider, _ = _anthropic()
    r = await provider.complete([Message(role="user", content="hi")])
    # 1000 in @ $3/Mtok + 500 out @ $15/Mtok
    assert r.est_cost_usd == Decimal("0.0105")


def test_an_anthropic_model_with_no_price_refuses_to_construct():
    """Better than logging every call it serves as free, forever."""
    with pytest.raises(KeyError) as exc:
        AnthropicProvider(client=_FakeAnthropic(), model="claude-not-real-9")
    assert "No price on file" in str(exc.value)


# --------------------------------------------- anthropic: per-model profiles


def _opus_msg(content, *, usage=None, model="claude-opus-5-5", stop="end_turn"):
    return SimpleNamespace(
        content=content, stop_reason=stop, model=model,
        usage=usage or SimpleNamespace(input_tokens=1000, output_tokens=500),
    )


def _thinking(signature="sig-1"):
    # display "omitted" is the default on Opus 5.5: the text is empty, the
    # signature is what the API checks on replay.
    return SimpleNamespace(type="thinking", thinking="", signature=signature)


def _text(text):
    return SimpleNamespace(type="text", text=text)


def _tool_use(id_, name, input_):
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=input_)


async def test_the_pinned_model_keeps_its_request_shape_plus_caching():
    """claude-sonnet-4-6 requests are what they were, plus the cache breakpoint:
    the plain endpoint, the caller's max_tokens, no effort, no fallback."""
    provider, fake = _anthropic()
    await provider.complete([Message(role="user", content="hi")], max_tokens=4000)
    call = fake.calls[0]
    assert fake.namespaces == ["messages"]
    assert call["max_tokens"] == 4000
    assert call["cache_control"] == {"type": "ephemeral"}
    assert not {"output_config", "betas", "fallbacks"} & set(call)


async def test_opus_5_5_gets_effort_thinking_headroom_and_server_side_fallback():
    provider, fake = _anthropic(_opus_msg([_text("ok")]), model="claude-opus-5-5")
    await provider.complete([Message(role="user", content="hi")], max_tokens=4000)
    call = fake.calls[0]
    assert fake.namespaces == ["beta"]
    assert call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["fallbacks"] == "default"
    assert call["output_config"] == {"effort": "medium"}
    # Thinking counts against max_tokens; the caller sized 4,000 for the answer.
    assert call["max_tokens"] == 4000 + 12_000
    # Omitted, never "disabled" -- that is a 400 on this model.
    assert "thinking" not in call
    assert call["cache_control"] == {"type": "ephemeral"}


async def test_a_list_cap_never_reaches_the_wire_schema():
    """The API 400s on `maxItems` ("For 'array' type, property 'maxItems' is not
    supported"), which is what kept ReportSpec from ever running on a hosted model.
    The cap moves into the description and is still enforced by call.py's
    validation against the real model."""
    from pydantic import Field

    class Capped(BaseModel):
        points: list[str] = Field(max_length=3)

    provider, fake = _anthropic(_anthropic_msg(text='{"points": ["a"]}'))
    await provider.complete([Message(role="user", content="hi")], json_schema=Capped)
    points = fake.calls[0]["output_config"]["format"]["schema"]["properties"]["points"]
    assert "maxItems" not in points
    assert "maxItems: 3" in points.get("description", "")


async def test_the_real_report_spec_schema_carries_no_unsupported_keyword():
    from models.report_spec import ReportSpec

    provider, fake = _anthropic()
    try:
        await provider.complete([Message(role="user", content="hi")], json_schema=ReportSpec)
    except Exception:  # noqa: BLE001 - the fake's text is not a ReportSpec; the request is what is under test
        pass
    wire = json.dumps(fake.calls[0]["output_config"]["format"]["schema"])
    for keyword in ('"maxItems"', '"maxLength"', '"minLength"', '"maximum"', '"minimum"'):
        assert keyword not in wire, keyword


async def test_effort_and_a_schema_share_one_output_config():
    provider, fake = _anthropic(
        _opus_msg([_text('{"headline": "a", "confidence": 1}')]), model="claude-opus-5-5")
    await provider.complete([Message(role="user", content="hi")], json_schema=Insight)
    output_config = fake.calls[0]["output_config"]
    assert output_config["effort"] == "medium"
    assert output_config["format"]["type"] == "json_schema"


async def test_a_cached_call_counts_the_whole_prompt_and_prices_each_part():
    """The three input counts are disjoint. Summing them is the prompt size;
    pricing them all at the input rate would overstate a cached Opus 5.5 read
    twenty-fold."""
    usage = SimpleNamespace(input_tokens=200, output_tokens=500,
                            cache_creation_input_tokens=1_000, cache_read_input_tokens=10_000)
    provider, _ = _anthropic(_opus_msg([_text("ok")], usage=usage), model="claude-opus-5-5")
    r = await provider.complete([Message(role="user", content="hi")])
    assert r.tokens_in == 11_200
    # 200 @ $4 + 1,000 @ $5 (5-minute write) + 10,000 @ $0.20 (read) + 500 @ $20
    assert r.est_cost_usd == Decimal("0.0178")


async def test_a_turn_without_reasoning_carries_no_native_blocks():
    """So a model that never thinks is rebuilt from the canonical fields exactly as
    before, and nothing about its requests changes."""
    provider, _ = _anthropic()
    r = await provider.complete([Message(role="user", content="hi")])
    assert r.native is None


async def test_a_thinking_turn_goes_back_verbatim_in_the_tool_loop():
    """The signature is checked against the conversation that produced it, so the
    blocks are replayed as they came -- never rebuilt from text and tool_calls."""
    provider, fake = _anthropic(
        _opus_msg([_thinking("sig-a"), _tool_use("t1", "execute_sql", {"sql": "select 1"})],
                  stop="tool_use"),
        model="claude-opus-5-5")
    first = await provider.complete([Message(role="user", content="q")])
    assert first.native is not None
    await provider.complete([
        Message(role="user", content="q"),
        Message.assistant(first),
        Message(role="tool", tool_call_id="t1", content="[]"),
    ])
    assert fake.calls[1]["messages"][1] == {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "", "signature": "sig-a"},
        {"type": "tool_use", "id": "t1", "name": "execute_sql", "input": {"sql": "select 1"}},
    ]}


async def test_a_call_the_loop_handled_itself_is_not_replayed():
    """report.py keeps compose_report out of the turn it records and sends no
    tool_result for it. Replaying its tool_use would be a 400."""
    provider, fake = _anthropic(
        _opus_msg([_thinking(), _tool_use("t1", "execute_sql", {"sql": "a"}),
                   _tool_use("t2", "compose_report", {"brief": "b"})], stop="tool_use"),
        model="claude-opus-5-5")
    first = await provider.complete([Message(role="user", content="q")])
    kept = [c for c in first.tool_calls if c.name != "compose_report"]
    await provider.complete([
        Message(role="user", content="q"),
        Message.assistant(first, tool_calls=kept),
        Message(role="tool", tool_call_id="t1", content="[]"),
    ])
    blocks = fake.calls[1]["messages"][1]["content"]
    assert [b["type"] for b in blocks] == ["thinking", "tool_use"]
    assert blocks[1]["id"] == "t1"


async def test_another_providers_native_turn_is_rebuilt_not_replayed():
    provider, fake = _anthropic()
    await provider.complete([
        Message(role="user", content="q"),
        Message(role="assistant", content="hello",
                native=NativeTurn(provider="ollama", blocks=[{"type": "thinking", "thinking": "x"}])),
        Message(role="user", content="and?"),
    ])
    assert fake.calls[0]["messages"][1] == {"role": "assistant", "content": "hello"}


async def test_after_a_server_side_fallback_only_text_before_the_boundary_is_kept():
    """The declining model's thinking must not be echoed; its text may be, and the
    fallback marker is an audit note."""
    marker = SimpleNamespace(type="fallback", **{"from": {"model": "claude-opus-5-5"},
                                                 "to": {"model": "claude-opus-5"}})
    provider, _ = _anthropic(
        _opus_msg([_thinking("declined"), _text("Partial. "), marker,
                   _thinking("served"), _text("Answer.")], model="claude-opus-5"),
        model="claude-opus-5-5")
    r = await provider.complete([Message(role="user", content="q")])
    assert r.native.blocks == [
        {"type": "text", "text": "Partial. "},
        {"type": "thinking", "thinking": "", "signature": "served"},
        {"type": "text", "text": "Answer."},
    ]
    # Served by a model with no price on file: priced at the requested model's
    # rates rather than logged as free.
    assert r.model == "claude-opus-5"
    assert r.est_cost_usd == Decimal("0.0140")


# ------------------------------------------------------------- multimodal


async def test_an_image_reaches_anthropic_as_a_base64_source_block():
    provider, fake = _anthropic()
    await provider.complete([Message(role="user", content=[
        TextPart(text="read this"), ImagePart(media_type="image/png", data=PNG_1PX)])])
    blocks = fake.calls[0]["messages"][0]["content"]
    assert blocks[0] == {"type": "text", "text": "read this"}
    assert blocks[1] == {"type": "image", "source": {
        "type": "base64", "media_type": "image/png", "data": PNG_1PX}}


async def test_an_image_reaches_an_openai_endpoint_as_a_data_url():
    provider, seen = _compat()
    await provider.complete([Message(role="user", content=[
        TextPart(text="read this"), ImagePart(media_type="image/png", data=PNG_1PX)])])
    parts = json.loads(seen[0].content)["messages"][0]["content"]
    assert parts[0] == {"type": "text", "text": "read this"}
    assert parts[1]["image_url"]["url"] == f"data:image/png;base64,{PNG_1PX}"


async def test_a_plain_string_turn_still_serialises_as_a_plain_string():
    """Text-only calls must not suddenly ship an array of parts to every vendor --
    the multimodal shape is for when there is an image, not a rewrite of the
    common case."""
    provider, seen = _compat()
    await provider.complete([Message(role="user", content="hi")])
    assert json.loads(seen[0].content)["messages"][0]["content"] == "hi"
