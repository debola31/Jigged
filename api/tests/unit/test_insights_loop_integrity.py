"""The loop may not hand a database error to a shop owner as an answer.

WHAT THE EVAL SAW. Every local arm reached its final turn holding nothing but a
failed query, and said so: "The column total_price does not exist...". The
handler wrapped that in the success shape and the job settled `succeeded`. A
shop owner cannot tell that from an answer, which is the exact failure mode the
fail-visible rule in services/llm/errors.py exists to refuse -- it was just
happening one layer above where that rule was enforced.

TWO LAYERS, AND THE ORDER MATTERS.

  1. ONE corrective turn. If the model tries to answer while every query it ran
     failed and none succeeded, it is told to fix the SQL and run it once more.
     Once per conversation: a second injection would push the real work past the
     iteration cap, and the cap is what stops a non-converging loop.

  2. A gate on the final answer. No successful query behind it AND the text is
     empty or is the tool's error read back -> a typed failure, never an answer.

DELIBERATELY CONSERVATIVE, and pinned as such below: if ANY query succeeded the
answer passes through untouched. Judging the quality of a grounded answer is the
eval's job and a human's, not this loop's.

A REFUSED OBJECT IS NEITHER. NOT_PERMITTED is terminal by design, so it can
neither trigger the corrective turn (that is the retry loop we deleted) nor make
a legitimate "Jigged does not track that" into a failure.
"""
from __future__ import annotations

import itertools
import json
import uuid
from decimal import Decimal
from unittest.mock import patch

import pytest

from services.ai_features import insights
from services.ai_features.base import JobContext
from services.llm.base import LLMResult, Message, ToolCall
from services.llm.errors import LLMErrorEcho, LLMToolLoopExhausted
from tools.sql_executor import NOT_PERMITTED_KIND, SQL_ERROR_KIND

pytestmark = pytest.mark.unit

_ids = itertools.count()

# The two strings the eval actually came back with, plus the shapes around them.
ECHOES = [
    pytest.param("The column total_price does not exist in the shipments table.", id="undefined-column"),
    pytest.param("The SQL query encountered a syntax error, please review and try again.", id="syntax"),
    pytest.param("Query execution failed: relation \"payroll\" does not exist", id="undefined-relation"),
    pytest.param("I encountered an error while running the query.", id="i-encountered-an-error"),
    pytest.param("SQL_ERROR: column jobs.total does not exist. Rewrite the query.", id="our-own-tool-string"),
    pytest.param("permission denied for table note_views", id="permission-denied"),
    pytest.param("   ", id="whitespace-only"),
    pytest.param("", id="empty"),
]

SQL_FAILED = {"error": "SQL_ERROR: column x does not exist. Rewrite the query using this "
                       "error and execute again. Never describe this error to the user.",
              "error_kind": SQL_ERROR_KIND, "rows": []}
SQL_REFUSED = {"error": "NOT_PERMITTED: note_views. This object is unavailable. Do not retry "
                        "this query; answer from the permitted objects or state the data is "
                        "unavailable.",
               "error_kind": NOT_PERMITTED_KIND, "rows": []}
SQL_OK = {"columns": ["late"], "rows": [{"late": 4}], "row_count": 1, "description": "late jobs"}
SQL_EMPTY_OK = {"columns": [], "rows": [], "row_count": 0, "description": "nothing matched"}


def _answer(text: str) -> LLMResult:
    return LLMResult(text=text, model="m", provider="p", tokens_in=10, tokens_out=5)


def _asks_for_sql(sql: str = "SELECT 1 FROM jobs WHERE company_id = $1") -> LLMResult:
    return LLMResult(
        text="",
        tool_calls=[ToolCall(id=f"call_{next(_ids)}", name="execute_sql",
                             arguments={"sql": sql, "description": "d"})],
        model="m", provider="p", tokens_in=10, tokens_out=5,
    )


class Conversation:
    """One scripted model and one scripted tool, recording what reached each."""

    def __init__(self, turns: list[LLMResult], tool_results: list[dict] | None = None) -> None:
        self.turns = list(turns)
        self.tool_results = list(tool_results or [])
        self.seen: list[list[Message]] = []

    async def complete(self, feature, messages, **kwargs):
        self.seen.append(list(messages))
        if not self.turns:
            raise AssertionError(
                f"the loop asked for turn {len(self.seen)}; the script has "
                f"{len(self.seen) - 1}"
            )
        return self.turns.pop(0)

    async def run_tool(self, company_id, call):
        assert self.tool_results, "the loop ran a tool the script has no result for"
        return self.tool_results.pop(0)

    # ------------------------------------------------------------- assertions

    @property
    def calls(self) -> int:
        return len(self.seen)

    @property
    def corrections(self) -> int:
        """How many corrective turns are in the conversation the model last saw."""
        return sum(
            1 for m in (self.seen[-1] if self.seen else [])
            if m.role == "user" and "execute_sql once more" in m.text()
        )


async def run(convo: Conversation):
    with patch.object(insights.llm, "complete", convo.complete), \
         patch.object(insights, "_run_tool", convo.run_tool), \
         patch("services.insights_service._build_chat_system_prompt", return_value="SYSTEM"):
        return await insights.run(JobContext(
            feature="insights", company_id="c0", request_id="rid",
            payload={"question": "how many jobs are late?"},
        ))


# ------------------------------------------------------- 1b: one corrective turn


async def test_a_failed_query_earns_one_more_go_before_the_answer():
    """The whole point: the model gave up after one bad query, and one bad query
    is the case self-correction was built for."""
    convo = Conversation(
        turns=[_asks_for_sql(), _answer("The column total_price does not exist."),
               _asks_for_sql(), _answer("You have 4 late jobs.")],
        tool_results=[SQL_FAILED, SQL_OK],
    )

    result = await run(convo)

    assert result["answer"] == "You have 4 late jobs."
    assert convo.calls == 4, "the correction has to buy a real retry, not just a re-ask"
    assert convo.corrections == 1


async def test_the_correction_fires_at_most_once():
    """A second injection would push the model's remaining budget past the cap,
    and the cap is the only thing that ends a loop that is not converging."""
    convo = Conversation(
        turns=[_asks_for_sql(), _answer("column x does not exist"),
               _asks_for_sql(), _answer("column x does not exist")],
        tool_results=[SQL_FAILED, SQL_FAILED],
    )

    with pytest.raises(LLMErrorEcho):
        await run(convo)

    assert convo.calls == 4
    assert convo.corrections == 1, "the second attempt to answer must not be corrected again"


async def test_the_correction_costs_an_iteration_so_the_cap_still_binds():
    convo = Conversation(
        turns=[_asks_for_sql(), _answer("syntax error near FORM"),
               _asks_for_sql(), _asks_for_sql(), _asks_for_sql()],
        tool_results=[SQL_FAILED, SQL_FAILED, SQL_FAILED, SQL_FAILED],
    )

    with pytest.raises(LLMToolLoopExhausted):
        await run(convo)

    assert convo.calls == insights.MAX_TOOL_ITERATIONS


@pytest.mark.parametrize("ok_result", [SQL_OK, SQL_EMPTY_OK],
                         ids=["rows-returned", "zero-rows"])
async def test_a_query_that_ran_needs_no_correction(ok_result):
    """Zero rows is a SUCCESS: the query ran and the answer is "none". Treating
    it as a failure would correct a model that did everything right."""
    convo = Conversation(
        turns=[_asks_for_sql(), _answer("No jobs are late right now.")],
        tool_results=[ok_result],
    )

    result = await run(convo)

    assert result["answer"] == "No jobs are late right now."
    assert convo.calls == 2
    assert convo.corrections == 0


async def test_a_refused_object_never_earns_a_retry():
    """NOT_PERMITTED is terminal. Correcting it would rebuild the exact loop that
    burned four of Claude's five turns in the Gate 1 eval."""
    convo = Conversation(
        turns=[_asks_for_sql(), _answer("Jigged does not track who reads notes.")],
        tool_results=[SQL_REFUSED],
    )

    result = await run(convo)

    assert result["answer"] == "Jigged does not track who reads notes."
    assert convo.corrections == 0
    assert result["not_permitted"] == 1


async def test_an_empty_answer_never_appends_an_empty_assistant_turn():
    """Anthropic rejects a message with empty content, and an empty final answer
    is one of the exact shapes that reaches the injection site. Appending it
    verbatim would turn a recoverable turn into a 400 from the vendor."""
    convo = Conversation(
        turns=[_asks_for_sql(), _answer(""), _asks_for_sql(), _answer("You have 4 late jobs.")],
        tool_results=[SQL_FAILED, SQL_OK],
    )

    await run(convo)

    for turn in convo.seen[-1]:
        if turn.role == "assistant" and not turn.tool_calls:
            assert turn.text().strip(), "an empty assistant turn reached the provider"


# --------------------------------------------------------- 1c: the answer gate


@pytest.mark.parametrize("text", ECHOES)
async def test_an_answer_with_no_query_behind_it_and_a_database_error_in_it_fails(text):
    convo = Conversation(turns=[_answer(text)])

    with pytest.raises(LLMErrorEcho) as exc:
        await run(convo)

    assert exc.value.feature == "insights"
    assert exc.value.request_id == "rid"


async def test_the_failure_quotes_the_rejected_text_without_pasting_all_of_it():
    """ai_jobs.error is capped at 2048 by a CHECK, and the row is read by whoever
    is asking why a question came back empty."""
    convo = Conversation(turns=[_answer("column " + "x" * 4000 + " does not exist")])

    with pytest.raises(LLMErrorEcho) as exc:
        await run(convo)

    assert len(str(exc.value)) < 600
    assert "column xxx" in str(exc.value)


@pytest.mark.parametrize("text", [
    pytest.param("Three jobs came back with an error code this week.", id="error-as-shop-data"),
    pytest.param("Your scrap rate has an error margin of about 2%.", id="error-margin"),
    pytest.param("Jigged has no table for payroll, so that data does not exist here.",
                 id="a-plain-decline"),
    pytest.param("Nothing is late right now.", id="a-flat-answer"),
])
async def test_a_real_answer_that_happens_to_say_error_is_still_an_answer(text):
    """The gate keys on the SHAPE of a database error -- an object name sitting
    where Postgres puts one -- not on the word. A decline that says "does not
    exist" about the business is the answer the payroll trap is asking for."""
    convo = Conversation(turns=[_answer(text)])

    result = await run(convo)

    assert result["answer"] == text


@pytest.mark.parametrize("ok_result", [SQL_OK, SQL_EMPTY_OK],
                         ids=["rows-returned", "zero-rows"])
@pytest.mark.parametrize("text", [
    pytest.param("The column total_price does not exist.", id="undefined-column"),
    pytest.param("SQL_ERROR: column jobs.total does not exist.", id="our-own-tool-string"),
])
async def test_a_successful_query_lets_even_an_echo_through(text, ok_result):
    """DELIBERATE, not an oversight. The gate is a floor under "no data at all",
    not a judge of answers -- and a rule that could reject a grounded answer is
    one that will eventually reject a good one.

    Parametrised over zero rows too, because that is where "succeeded" is easy to
    get wrong: a query that ran and matched nothing has data behind it -- the
    data is "none" -- and counting it as a failure would put a correct answer in
    front of the gate.
    """
    convo = Conversation(turns=[_asks_for_sql(), _answer(text)], tool_results=[ok_result])

    result = await run(convo)

    assert result["answer"] == text.strip()


@pytest.mark.parametrize("text", [
    pytest.param('<execute_sql>\n{"description": "Parts with no routing", '
                 '"sql": "SELECT p.part_number FROM parts p WHERE p.company_id = $1"}',
                 id="arctic-verbatim"),
    pytest.param('{"sql": "SELECT 1", "description": "d"}', id="payload-without-the-tag"),
])
async def test_a_tool_call_the_model_only_described_is_not_an_answer(text):
    """ARCTIC, ON "Which parts have no routing yet?". The final turn was the text
    of a tool call it never made -- no tool_calls on the turn, so no query ran and
    nothing was refused. It contained no error language, so the gate passed it and
    the eval scored it answered.

    No new wiring was needed for this: with zero successful queries it flows
    through the same `sql_ok == 0` gate the echo does. Only the predicate grew.
    """
    convo = Conversation(turns=[_answer(text)])

    with pytest.raises(LLMErrorEcho) as exc:
        await run(convo)

    assert "tool_call_tag" in str(exc.value) or "sql_payload" in str(exc.value), str(exc.value)


async def test_a_uuid_in_a_result_row_does_not_kill_the_turn():
    """"Who is my top customer by revenue?" groups by c.id, so a UUID lands in the
    tool result -- and the loop wires each result in with a dumps. That dumps
    crashed the whole job, twice, because the type mapping lived somewhere this
    path never called.

    Driven through insights.run rather than the serializer, deliberately: the
    previous fix passed its own test and still shipped the crash.
    """
    convo = Conversation(
        turns=[_asks_for_sql(), _answer("Acme, at $50,120.")],
        tool_results=[{"columns": ["id", "revenue"],
                       "rows": [{"id": uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
                                 "revenue": Decimal("50120.00")}],
                       "row_count": 1, "description": "top customer"}],
    )

    result = await run(convo)

    assert result["answer"] == "Acme, at $50,120."
    tool_turn = next(m for m in convo.seen[-1] if m.role == "tool")
    wired = json.loads(tool_turn.text())
    assert wired["rows"][0]["id"] == "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
    assert wired["rows"][0]["revenue"] == 50120


async def test_a_refused_object_alone_does_not_condemn_a_good_answer():
    convo = Conversation(
        turns=[_asks_for_sql(), _answer("That figure is not something Jigged tracks.")],
        tool_results=[SQL_REFUSED],
    )

    assert (await run(convo))["answer"] == "That figure is not something Jigged tracks."
