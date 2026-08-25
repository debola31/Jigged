"""The gateway: fallback order, the single informed retry, and the ledger.

WHAT THIS FILE IS REALLY ABOUT IS ROW COUNTS. Every assertion about ai_calls here
is an assertion about a bill. Both attempts of a retried call were charged, and
both legs of a fallback were charged, so a ledger recording one row per LOGICAL
call under-reports what was spent and destroys the only evidence that a model is
drifting off-schema. The counterpart matters as much: a provider that was SKIPPED
must write nothing, because a row with 0 tokens and 0 latency for a call that
never left the process is a fabricated fact in a cost ledger -- the same doctrine
as terms_acceptances.ip_address being NULL rather than 0.0.0.0.

The providers here are hand-written fakes rather than mocked HTTP: fallback order
is registry logic, not transport logic, and mocking at the wire would test the
wrong seam.
"""
from __future__ import annotations

import json
from decimal import Decimal

import pytest
from pydantic import BaseModel

from services.llm import call as gateway
from services.llm.base import LLMResult, Message, ToolCall
from services.llm.errors import (
    LLMChainExhausted,
    LLMNotConfigured,
    LLMProviderError,
    LLMSchemaError,
    LLMTimeout,
)

pytestmark = pytest.mark.unit


class Insight(BaseModel):
    headline: str
    confidence: float


class FakeProvider:
    """A Protocol-satisfying provider driven by a script of outcomes."""

    def __init__(self, name, *, script=None, text="ok", tool_calls=None, model=None):
        self.name = name
        self.model = model or f"{name}-model"
        self.timeout_s = 30.0
        self.calls: list[list[Message]] = []
        self._script = list(script or [])
        self._text = text
        self._tool_calls = tool_calls or []

    async def complete(self, messages, json_schema=None, max_tokens=1024, tools=None):
        # Snapshot: a later mutation of the caller's list must not rewrite history.
        self.calls.append([m.model_copy(deep=True) for m in messages])
        outcome = self._script.pop(0) if self._script else self._text
        if isinstance(outcome, Exception):
            raise outcome
        return LLMResult(
            text=outcome, tool_calls=self._tool_calls, model=self.model,
            provider=self.name, tokens_in=10, tokens_out=5, latency_ms=7,
            est_cost_usd=Decimal("0.00000100"),
        )


@pytest.fixture
def ledger():
    """Collects the rows audit.record would have written."""
    rows: list[dict] = []

    async def writer(row: dict) -> None:
        rows.append(row)

    return rows, writer


async def run(chain, ledger, **kw):
    rows, writer = ledger
    return await gateway.complete(
        kw.pop("feature", "insights"),
        kw.pop("messages", [Message(role="user", content="q")]),
        chain=chain, audit_writer=writer, **kw,
    )


# ------------------------------------------------------------ fallback order


async def test_the_first_provider_in_the_chain_is_tried_first(ledger):
    a, b = FakeProvider("deepinfra"), FakeProvider("anthropic")
    result = await run([a, b], ledger)
    assert result.provider == "deepinfra"
    assert len(a.calls) == 1 and b.calls == []
    assert len(ledger[0]) == 1


async def test_the_second_provider_answers_when_the_first_fails(ledger):
    a = FakeProvider("deepinfra", script=[LLMProviderError("429", provider="deepinfra")])
    b = FakeProvider("anthropic")
    result = await run([a, b], ledger)
    assert result.provider == "anthropic"

    rows = ledger[0]
    assert len(rows) == 2, "both attempts were billed and both must be recorded"
    assert [r["provider"] for r in rows] == ["deepinfra", "anthropic"]
    assert [r["success"] for r in rows] == [False, True]
    assert rows[0]["error"] and "LLMProviderError" in rows[0]["error"]


async def test_the_chain_order_is_the_registry_order(ledger):
    """Two features declared in opposite orders, so this cannot pass by accident --
    an alphabetical or cheapest-first implementation fails the second case."""
    for order in (["deepinfra", "anthropic"], ["anthropic", "deepinfra"]):
        chain = [FakeProvider(n) for n in order]
        result = await run(chain, ledger)
        assert result.provider == order[0]


async def test_when_every_provider_fails_a_typed_error_is_raised(ledger):
    """Not None, not an empty LLMResult, not a canned apology string."""
    chain = [
        FakeProvider("deepinfra", script=[LLMTimeout("slow", provider="deepinfra")]),
        FakeProvider("anthropic", script=[LLMProviderError("500", provider="anthropic")]),
    ]
    with pytest.raises(LLMChainExhausted) as exc:
        await run(chain, ledger)

    assert [type(f).__name__ for f in exc.value.failures] == ["LLMTimeout", "LLMProviderError"]
    assert [f.provider for f in exc.value.failures] == ["deepinfra", "anthropic"]
    assert len(ledger[0]) == 2
    assert all(r["success"] is False for r in ledger[0])


async def test_the_exhausted_error_shares_one_request_id_with_its_ledger_rows(ledger):
    """So a Sentry report can be joined to the spend it produced."""
    chain = [FakeProvider("anthropic", script=[LLMProviderError("boom", provider="anthropic")])]
    with pytest.raises(LLMChainExhausted) as exc:
        await run(chain, ledger, request_id="11111111-1111-1111-1111-111111111111")
    assert exc.value.request_id == "11111111-1111-1111-1111-111111111111"
    assert ledger[0][0]["request_id"] == exc.value.request_id


async def test_an_empty_chain_raises_rather_than_returning_nothing(ledger):
    with pytest.raises(LLMNotConfigured):
        await run([], ledger)
    assert ledger[0] == [], "a chain that never ran must not fabricate a ledger row"


async def test_a_local_only_chain_reports_itself_as_offline(ledger):
    """An ollama-only chain that fails is a desktop being asleep, not an incident.
    The distinction drives error_kind on the job AND whether Sentry is told."""
    chain = [FakeProvider("ollama", script=[LLMTimeout("no answer", provider="ollama")])]
    with pytest.raises(LLMChainExhausted) as exc:
        await run(chain, ledger)
    assert exc.value.is_offline is True


async def test_a_vendor_rejection_is_not_offline(ledger):
    chain = [FakeProvider("anthropic", script=[LLMProviderError("400", provider="anthropic")])]
    with pytest.raises(LLMChainExhausted) as exc:
        await run(chain, ledger)
    assert exc.value.is_offline is False


# --------------------------------------------------- the single informed retry


async def test_a_valid_first_response_is_returned_without_a_second_call(ledger):
    p = FakeProvider("anthropic", script=['{"headline":"h","confidence":0.9}'])
    result = await run([p], ledger, json_schema=Insight)
    assert len(p.calls) == 1
    assert json.loads(result.text)["headline"] == "h"
    assert len(ledger[0]) == 1


async def test_an_invalid_response_is_retried_exactly_once(ledger):
    p = FakeProvider("anthropic", script=["not json at all", '{"headline":"h","confidence":0.9}'])
    result = await run([p], ledger, json_schema=Insight)
    assert len(p.calls) == 2
    assert result.text.startswith("{")
    assert len(ledger[0]) == 2, "the failed attempt was billed and must be recorded"
    assert [r["success"] for r in ledger[0]] == [False, True]


async def test_the_retry_tells_the_model_what_was_wrong(ledger):
    """A bare re-send to a near-deterministic model returns the identical bad
    output, so the retry has to be informed to be worth its cost."""
    p = FakeProvider("anthropic", script=['{"headline":"h"}', '{"headline":"h","confidence":0.5}'])
    await run([p], ledger, json_schema=Insight)
    first, second = p.calls[0], p.calls[1]
    assert len(second) > len(first)
    trailing = " ".join(m.text() for m in second[len(first):])
    assert "confidence" in trailing, "the retry did not name the failing field"


async def test_two_validation_failures_become_a_provider_failure(ledger):
    """Exactly two attempts, never three. The retry is single by design."""
    p = FakeProvider("anthropic", script=["nope", "still nope"])
    with pytest.raises(LLMChainExhausted) as exc:
        await run([p], ledger, json_schema=Insight)
    assert len(p.calls) == 2
    assert isinstance(exc.value.failures[0], LLMSchemaError)
    assert len(ledger[0]) == 2


async def test_a_schema_failure_falls_through_to_the_next_provider(ledger):
    """Three rows: two failed attempts on the first provider, one success on the
    second. A cost report showing one would be wrong by two thirds."""
    a = FakeProvider("deepinfra", script=["nope", "still nope"])
    b = FakeProvider("anthropic", script=['{"headline":"h","confidence":0.1}'])
    result = await run([a, b], ledger, json_schema=Insight)
    assert result.provider == "anthropic"
    assert len(ledger[0]) == 3
    assert [r["provider"] for r in ledger[0]] == ["deepinfra", "deepinfra", "anthropic"]


async def test_a_provider_that_ignores_the_schema_request_still_gets_validated(ledger):
    """response_format is a request, not a guarantee. This is the whole reason
    validation lives in our code rather than being delegated to the vendor."""
    p = FakeProvider("anthropic", script=[
        'Sure! Here you go:\n```json\n{"headline":"h","confidence":0.9}\n```',
        'Sure! Here you go again.',
    ])
    with pytest.raises(LLMChainExhausted):
        await run([p], ledger, json_schema=Insight)


async def test_a_think_block_is_stripped_before_the_schema_sees_the_text(ledger):
    """Pins the ORDERING: strip, then validate. Reversed, the model's draft object
    inside its reasoning would validate and the real answer would be discarded."""
    p = FakeProvider("anthropic", script=[
        '<think>{"headline":"draft","confidence":0.1}</think>{"headline":"final","confidence":0.9}'
    ])
    result = await run([p], ledger, json_schema=Insight)
    assert len(p.calls) == 1
    assert json.loads(result.text)["headline"] == "final"


async def test_a_response_that_is_all_reasoning_never_comes_back_as_an_empty_string(ledger):
    p = FakeProvider("anthropic", script=["<think>all of it</think>", "<think>again</think>"])
    with pytest.raises(LLMChainExhausted) as exc:
        await run([p], ledger)
    assert type(exc.value.failures[0]).__name__ == "LLMEmptyResponse"


async def test_a_tool_call_with_no_text_is_not_treated_as_empty(ledger):
    """The tool-use turn legitimately has no prose. Rejecting it would break the
    insights loop on its very first turn."""
    p = FakeProvider("anthropic", text="",
                     tool_calls=[ToolCall(id="t1", name="execute_sql", arguments={"sql": "x"})])
    result = await run([p], ledger)
    assert result.text == ""
    assert result.tool_calls[0].name == "execute_sql"


async def test_the_retry_never_mutates_the_callers_message_list(ledger):
    """The insights tool loop reuses one list across turns. A retry that appended to
    it in place would leave a repair prompt embedded in the conversation for every
    subsequent turn -- invisible, and permanent."""
    messages = [Message(role="user", content="q")]
    p = FakeProvider("anthropic", script=["nope", '{"headline":"h","confidence":0.1}'])
    await run([p], ledger, messages=messages, json_schema=Insight)
    assert len(messages) == 1
    assert messages[0].text() == "q"


# ---------------------------------------------------------- the ledger itself


async def test_a_success_row_records_the_cost_and_the_model_that_served_it(ledger):
    await run([FakeProvider("deepinfra")], ledger)
    row = ledger[0][0]
    assert row["feature"] == "insights"
    assert row["provider"] == "deepinfra"
    assert row["model"] == "deepinfra-model"
    assert (row["tokens_in"], row["tokens_out"]) == (10, 5)
    assert row["success"] is True and row["error"] is None
    # Decimal is not JSON-serialisable through PostgREST; it must go as a string.
    assert isinstance(row["est_cost_usd"], str)
    assert Decimal(row["est_cost_usd"]) == Decimal("0.00000100")


async def test_a_failure_row_still_records_the_latency_it_spent(ledger):
    """A 30-second timeout logged with latency_ms NULL erases the single most useful
    fact about the failure."""
    err = LLMTimeout("slow", provider="ollama", model="qwen3:8b", latency_ms=29_998)
    with pytest.raises(LLMChainExhausted):
        await run([FakeProvider("ollama", script=[err])], ledger)
    row = ledger[0][0]
    assert row["latency_ms"] == 29_998
    assert (row["tokens_in"], row["tokens_out"]) == (0, 0)
    assert row["success"] is False and row["error"]


async def test_a_ledger_failure_never_swallows_the_model_result():
    """Telemetry that can fail the user's request is worse than telemetry."""
    async def broken(row):
        raise RuntimeError("postgrest is down")

    result = await gateway.complete(
        "insights", [Message(role="user", content="q")],
        chain=[FakeProvider("anthropic")], audit_writer=broken,
    )
    assert result.text == "ok"


async def test_a_ledger_failure_never_masks_a_provider_failure():
    """The most fragile point of the no-swallowed-exceptions rule: the caller must
    see the PROVIDER's error, not the logger's."""
    async def broken(row):
        raise RuntimeError("postgrest is down")

    with pytest.raises(LLMChainExhausted):
        await gateway.complete(
            "insights", [Message(role="user", content="q")],
            chain=[FakeProvider("anthropic", script=[LLMProviderError("boom", provider="anthropic")])],
            audit_writer=broken,
        )
