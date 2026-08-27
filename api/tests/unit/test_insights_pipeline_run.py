"""The five stages end to end: no database, no Ollama, no network.

WHAT THE SCRIPTED PROVIDERS ARE FOR. The same argument test_llm_gateway.py makes
for hand-written fakes over mocked HTTP: what is under test here is stage
sequencing -- when the retry fires, what the second prompt carries, whether an
empty `sql` skips execution -- and none of that is transport logic. Mocking at the
wire would test the wrong seam and would not survive a provider change.

THE DECLINE CHANNEL IS THE LOAD-BEARING PIECE. postprocess.strictify puts every
property of a Pydantic model into `required`, so a generator constrained to
{reasoning, sql} MUST emit a sql string -- it has no way to say "not answerable
from these tables". Without a channel, the payroll question generates a
true_cost_per_unit query, stage 4 succeeds, stage 5 narrates real rows, the
arithmetic guard passes because every digit is in those rows, and the pipeline
reproduces the Gate 1 hallucination ("net profit margin after payroll: 67.9%")
that it was built to prevent. An empty string is that channel.
"""
from __future__ import annotations

import hashlib
import json
from unittest.mock import patch

import pytest

from services.ai_features.base import JobContext
from services.llm.base import LLMResult

pytestmark = pytest.mark.unit

COMPANY = "45a29b26-317e-483a-8cc4-10fb676f1273"
LATE_SQL = "SELECT COUNT(*) AS late_jobs FROM jobs WHERE company_id = $1 AND due_date < $2::date"
BAD_SQL = "SELECT COUNT(*) AS late_jobs FROM jobs WHERE company_id = $1 AND due_at < $2::date"
FIRST_SQL = "SELECT COUNT(*) AS n FROM jobs WHERE company_id = $1 AND started_at IS NULL"

SQL_OK = {"columns": ["late_jobs"], "rows": [{"late_jobs": 4}], "row_count": 1, "description": ""}
SQL_EMPTY = {"columns": [], "rows": [], "row_count": 0, "description": ""}
SQL_FAILED = {"error": "SQL_ERROR: syntax error at or near FROM. Rewrite the query using this "
                       "error and execute again.", "error_kind": "sql_error", "rows": []}
SQL_REFUSED = {"error": "NOT_PERMITTED: orders. This object is unavailable.",
               "error_kind": "not_permitted", "rows": []}
SQL_INFRA = {"error": "Database connection not available.", "rows": []}


class ScriptedProvider:
    """A Protocol-satisfying provider driven by a script, recording what it saw."""

    def __init__(self, name, script):
        self.name = name
        self.model = f"{name}-model"
        self.timeout_s = 30.0
        self.seen: list[list] = []
        self.schemas: list = []
        self._script = list(script)

    async def complete(self, messages, json_schema=None, max_tokens=1024, tools=None):
        self.seen.append([m.model_copy(deep=True) for m in messages])
        self.schemas.append(json_schema)
        if not self._script:
            raise AssertionError(
                f"{self.name} was called {len(self.seen)} times; the script has "
                f"{len(self.seen) - 1}"
            )
        outcome = self._script.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return LLMResult(text=outcome, model=self.model, provider=self.name,
                         tokens_in=10, tokens_out=5)

    @property
    def prompts(self) -> list[str]:
        return ["\n".join(m.text() for m in turn) for turn in self.seen]


def _gen(sql: str, reasoning: str = "counting late jobs") -> str:
    return json.dumps({"reasoning": reasoning, "sql": sql})


def _vec(text: str) -> list[float]:
    """A stable pseudo-random unit-ish vector per distinct string.

    sha512 rather than hash(): Python's string hashing is salted per process, and a
    fixture that changes between runs is not a fixture. Two different strings land
    ~orthogonal in 64 dimensions (well under the 0.70 floor) and the same string
    always lands on itself, which is exactly the two behaviours these tests need.
    """
    digest = hashlib.sha512(text.encode()).digest()
    return [(b - 127.5) / 127.5 for b in digest]


async def _fake_embed(texts):
    return [_vec(t) for t in texts]


def _embed_aliasing(question: str, target: str):
    """An embedder that puts `question` exactly where `target` sits.

    How a test says "pretend retrieval matched this pair" without asserting
    anything about what nomic-embed-text actually believes.
    """
    from services.insights_pipeline.embeddings import QUERY_PREFIX

    async def embed(texts):
        return [
            _vec(f"{QUERY_PREFIX}{target}") if t == f"{QUERY_PREFIX}{question}" else _vec(t)
            for t in texts
        ]

    return embed


async def _index(embed=_fake_embed):
    from services.insights_pipeline.retrieval import build_index

    return await build_index(embed)


async def _run(generator, narrator, *, question="How many jobs are late right now?",
               sql_results=None, retrieval="full", embed=_fake_embed, question_embed=None):
    from services.insights_pipeline import pipeline

    results = list(sql_results if sql_results is not None else [SQL_OK])
    calls: list[tuple[str, str]] = []
    ledger: list[dict] = []

    async def writer(row):
        ledger.append(row)

    async def fake_execute(company_id, sql, description="", today=None):
        calls.append((company_id, sql, today))
        return results.pop(0) if results else SQL_OK

    ctx = JobContext(
        feature="insights",
        company_id=COMPANY,
        request_id="rid-1",
        payload={
            "question": question,
            "today": "2026-08-27",
            "narrator_chain": [narrator],
            "embed_fn": question_embed or embed,
            "index": await _index(embed),
            "retrieval": retrieval,
        },
        chain=[generator],
        audit_writer=writer,
    )
    with patch.object(pipeline, "_execute_sql", fake_execute):
        return await pipeline.run(ctx), calls


# ============================================================== generation


def test_the_generation_schema_is_flat_and_puts_reasoning_first():
    """Flat because postprocess.strictify RAISES on $defs/$ref. reasoning first
    because property order drives constrained-decode order, and Arctic-Text2SQL is
    RL-trained to reason before it emits SQL -- forcing `{` then `"sql"` suppresses
    exactly what its reward shaped."""
    from services.llm.postprocess import strictify
    from services.insights_pipeline.pipeline import GeneratedSql

    schema = GeneratedSql.model_json_schema()
    assert list(schema["properties"]) == ["reasoning", "sql"]

    strict = strictify(schema)  # raises on $defs/$ref
    assert strict["additionalProperties"] is False
    assert set(strict["required"]) == {"reasoning", "sql"}


async def test_the_generator_is_asked_for_the_structured_shape():
    from services.insights_pipeline.pipeline import GeneratedSql

    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])
    await _run(generator, narrator)

    assert generator.schemas == [GeneratedSql]


async def test_a_generation_that_is_not_the_shape_fails_typed():
    """Typed, and typed as what the EVAL will actually catch.

    call.py validates every response against the schema, spends its own single
    informed repair, then raises LLMSchemaError -- which the chain collects and
    re-raises as LLMChainExhausted, because a one-provider chain that fails has
    nowhere else to go. run_arm records that as ok=False with the class name in
    `error`, so the failure is attributable to generation without the transcript.

    Note the two retries are different and the dump keeps them apart: this one is
    the gateway repairing a SHAPE, and it shows up as an extra ai_calls row in the
    `attempts` column. The pipeline's own retry is for a SQL error.
    """
    from services.llm.errors import LLMChainExhausted, LLMSchemaError

    generator = ScriptedProvider("ollama", ["SELECT 1", "still not json"])
    narrator = ScriptedProvider("narrator", [])

    with pytest.raises(LLMChainExhausted) as caught:
        await _run(generator, narrator)

    assert [type(f) for f in caught.value.failures] == [LLMSchemaError]
    assert len(generator.seen) == 2, "the gateway should have spent exactly one repair"
    assert narrator.seen == [], "a failed generation must never reach the narrator"


async def test_the_narrator_is_never_asked_for_a_schema():
    """It writes prose. Constraining it to JSON would be a second constrained
    decode for no gain and one more way for a small model to fail."""
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])
    await _run(generator, narrator)

    assert narrator.schemas == [None]


# ================================================================ decline


async def test_an_empty_sql_declines_without_touching_the_database():
    generator = ScriptedProvider("ollama", [_gen("", reasoning="no payroll table exists")])
    narrator = ScriptedProvider("narrator", ["Jigged does not track payroll, so that cannot be calculated here."])

    result, calls = await _run(
        generator, narrator, question="What is our net profit margin after payroll?",
    )

    assert calls == []
    assert result["tool_calls"] == []
    assert result["pipeline"]["declined"] is True


async def test_the_payroll_decline_is_not_read_as_a_non_answer():
    """`the payroll table does not exist` would match insights_presentation's
    _ERROR_ECHO pattern for `<object> does not exist`, and the eval scores every
    arm's answer through that predicate. The decline has to survive it."""
    from services.insights_presentation import looks_like_error_echo

    generator = ScriptedProvider("ollama", [_gen("")])
    narrator = ScriptedProvider("narrator", [
        "Jigged does not track payroll, wage or hours-paid data, so net profit margin "
        "after payroll cannot be calculated here."
    ])

    result, _ = await _run(generator, narrator, question="What is our net profit margin after payroll?")

    assert not looks_like_error_echo(result["answer"])


# ================================================================== retry


async def test_the_retry_fires_once_on_a_model_fixable_error():
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL), _gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    result, calls = await _run(generator, narrator, sql_results=[SQL_FAILED, SQL_OK])

    assert len(calls) == 2
    assert len(generator.seen) == 2
    assert result["pipeline"]["retry_used"] is True
    assert result["tool_calls"] == ["execute_sql", "execute_sql"]


async def test_the_retry_fires_only_once_and_then_gives_up():
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL), _gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["That figure is unavailable."])

    result, calls = await _run(generator, narrator, sql_results=[SQL_FAILED, SQL_FAILED])

    assert len(calls) == 2, "a second retry means the cap does not bind"
    assert result["pipeline"]["error_kind"] == "sql_error"


async def test_a_refused_object_is_terminal_and_never_retried():
    """classify_not_permitted exists to delete exactly this loop: no rewrite grants
    a privilege, and the Gate 1 run spent five iterations discovering that."""
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["That data is unavailable."])

    result, calls = await _run(generator, narrator, sql_results=[SQL_REFUSED])

    assert len(calls) == 1
    assert result["pipeline"]["retry_used"] is False
    assert result["pipeline"]["error_kind"] == "not_permitted"
    assert result["not_permitted"] == 1


async def test_an_infrastructure_failure_is_never_retried():
    """A dead pool and a malformed company_id carry NO error_kind -- they are ours,
    and no rewrite reaches either. The dump keeps error_kind verbatim, None
    included, so this cannot later be read as a bad model."""
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["That figure is unavailable."])

    result, calls = await _run(generator, narrator, sql_results=[SQL_INFRA])

    assert len(calls) == 1
    assert result["pipeline"]["retry_used"] is False
    assert result["pipeline"]["error_kind"] is None


async def test_the_second_generation_is_told_what_went_wrong():
    """An uninformed retry against a greedy model returns the identical bad output,
    costing a full call and buying nothing -- the argument call.py's _repair_turns
    already makes.

    FIRST_SQL is deliberately valid-looking: it has to clear the pre-check so the
    failure arrives from the executor, which is the path this test is about.
    """
    generator = ScriptedProvider("ollama", [_gen(FIRST_SQL), _gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    await _run(generator, narrator, sql_results=[SQL_FAILED, SQL_OK])

    second = generator.prompts[1]
    assert "SQL_ERROR" in second or "syntax error" in second
    assert FIRST_SQL in second, "the retry has to show the model what it wrote"


async def test_an_invented_column_is_caught_before_the_database():
    generator = ScriptedProvider("ollama", [_gen(BAD_SQL), _gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    result, calls = await _run(generator, narrator, sql_results=[SQL_OK])

    assert len(calls) == 1, "the invented column should not have reached the executor"
    assert calls[0][1] == LATE_SQL
    assert result["pipeline"]["precheck_rejected"] == "due_at"


# ============================================================== the guard


async def test_a_narration_with_an_untraceable_number_fails_the_answer():
    from services.llm.errors import LLMErrorEcho

    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["There are 97 late jobs."])

    with pytest.raises(LLMErrorEcho, match="narrator_invented_number"):
        await _run(generator, narrator)


async def test_a_narration_that_reads_the_rows_back_passes():
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late right now."])

    result, _ = await _run(generator, narrator)

    assert result["answer"] == "4 jobs are late right now."
    assert result["pipeline"]["narration_flag"] is None


async def test_an_empty_result_set_is_stated_rather_than_filled_in():
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["No jobs are late right now."])

    result, _ = await _run(generator, narrator, sql_results=[SQL_EMPTY])

    assert result["pipeline"]["row_count"] == 0
    assert result["pipeline"]["narration_flag"] is None


# =========================================================== the dump record


async def test_the_stage_record_attributes_a_failure_without_the_transcript():
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    result, _ = await _run(generator, narrator)
    record = result["pipeline"]

    for key in ("retrieval_mode", "linked_tables", "pairs", "reasoning", "generated_sql",
                "precheck_rejected", "retry_used", "error_kind", "row_count", "truncated",
                "facts", "narration_flag", "copied_from", "embed_calls", "declined",
                "sql_ran"):
        assert key in record, f"the dump cannot attribute a failure without {key}"

    assert record["generated_sql"] == LATE_SQL
    assert record["reasoning"] == "counting late jobs"
    assert "jobs" in record["linked_tables"]


async def test_tool_calls_is_a_list_of_names_not_a_count():
    """ai_chat_queries.tool_calls is jsonb and _log_chat_query writes it straight
    through, so an int is a shape someone would have to unpick later."""
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    result, _ = await _run(generator, narrator)

    assert result["tool_calls"] == ["execute_sql"]


async def test_this_arm_never_produces_a_chart():
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    result, _ = await _run(generator, narrator)

    assert result["chart_config"] is None


async def test_a_copied_exemplar_is_recorded_as_copied():
    """Retrieval hands the model the canonical query for seven of the eleven
    questions, so a pass cannot distinguish 'exemplars fixed the grain' from 'the
    model can transcribe'. Recording the copy makes that readable instead of
    invisible."""
    from services.insights_pipeline.retrieval import load_pairs

    late = next(p for p in load_pairs() if p.id == "late_jobs")

    generator = ScriptedProvider("ollama", [_gen(late.sql)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    result, _ = await _run(generator, narrator, sql_results=[SQL_OK])

    assert result["pipeline"]["pairs"], "the canonical pair should have been retrieved"
    assert result["pipeline"]["copied_from"] == "late_jobs"


async def test_the_bare_mode_links_every_table_and_retrieves_nothing():
    """The no-retrieval arm. Same model, same stages, same guard -- the only
    difference is that stages 1 and 2 are off, which is what makes it the control
    for what retrieval buys."""
    from services.insights_pipeline.retrieval import load_cards

    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    result, _ = await _run(generator, narrator, retrieval="none")
    record = result["pipeline"]

    assert record["retrieval_mode"] == "none"
    assert record["pairs"] == []
    assert len(record["linked_tables"]) == len(load_cards())


async def test_the_pairs_record_carries_the_source_question_that_names_displacement():
    from services.insights_pipeline.retrieval import load_pairs

    top = next(p for p in load_pairs() if p.id == "top_customer_by_revenue")
    asked = "How many jobs are late right now?"

    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    result, _ = await _run(
        generator, narrator, question=asked,
        question_embed=_embed_aliasing(asked, top.source_question),
    )
    [pair] = result["pipeline"]["pairs"]

    assert pair["source_question"] == "Who is my top customer by revenue?"
    assert pair["id"] == "top_customer_by_revenue"
    assert 0.0 <= pair["score"] <= 1.0


async def test_a_failed_query_is_never_narrated_as_an_empty_result():
    """A FALSE NEGATIVE IS THE WORST OUTPUT THIS PIPELINE CAN PRODUCE. A failed
    query and a query that legitimately matched nothing both arrive with zero rows,
    and telling the narrator "the query returned no rows" in the first case invites
    "no jobs are late" -- a confident, specific, checkable-sounding answer to a
    question nothing answered. The two states have to reach stage 5 apart."""
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL), _gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["That figure is unavailable right now."])

    await _run(generator, narrator, sql_results=[SQL_FAILED, SQL_FAILED])

    prompt = narrator.prompts[0].lower()
    assert "returned no rows" not in prompt
    assert "could not be run" in prompt


async def test_an_empty_result_is_narrated_as_an_empty_result():
    """The other half: zero rows from a query that RAN is real data, and must not
    be dressed up as a failure either."""
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["No jobs are late right now."])

    await _run(generator, narrator, sql_results=[SQL_EMPTY])

    assert "returned no rows" in narrator.prompts[0].lower()


async def test_a_refused_object_is_narrated_as_unavailable_not_as_unrun():
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["That data is unavailable."])

    await _run(generator, narrator, sql_results=[SQL_REFUSED])

    prompt = narrator.prompts[0].lower()
    assert "unavailable" in prompt
    assert "returned no rows" not in prompt


@pytest.mark.parametrize("drop,expect", [
    ("index", "index"),
    ("embed_fn", "embedder"),
    ("narrator_chain", "narrator"),
])
async def test_a_missing_stage_input_refuses_rather_than_degrading(drop, expect):
    """A retrieval arm missing its embedder would answer every question anyway, with
    no exemplars and no linking -- i.e. it would silently BECOME the control arm and
    still fill in a column. The run would read as a measurement of retrieval and be
    a measurement of nothing."""
    from services.insights_pipeline import pipeline

    payload = {
        "question": "How many jobs are late right now?",
        "narrator_chain": [ScriptedProvider("narrator", [])],
        "embed_fn": _fake_embed,
        "index": await _index(),
        "retrieval": "full",
    }
    payload.pop(drop)
    ctx = JobContext(feature="insights", company_id=COMPANY, request_id="r",
                     payload=payload, chain=[ScriptedProvider("ollama", [])],
                     audit_writer=lambda row: None)

    with pytest.raises(ValueError, match=expect):
        await pipeline.run(ctx)


async def test_an_unknown_retrieval_mode_is_refused():
    from services.insights_pipeline import pipeline

    ctx = JobContext(feature="insights", company_id=COMPANY, request_id="r",
                     payload={"question": "q", "retrieval": "sometimes"},
                     chain=[ScriptedProvider("ollama", [])])

    with pytest.raises(ValueError, match="retrieval mode"):
        await pipeline.run(ctx)


async def test_todays_date_reaches_the_executor_as_the_bound_parameter():
    """$2 IS THE ONLY CLOCK. The validator refuses CURRENT_DATE, so a date-bounded
    question has to arrive as a bound parameter -- and sql_executor turns a missing
    date into SQL NULL rather than an error, which makes `due_date < $2::date` NULL
    and the answer a silent zero. Four of the eleven questions are date-bounded."""
    from datetime import date

    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    _, calls = await _run(generator, narrator)

    assert calls[0][2] == date(2026, 8, 27)


async def test_the_generation_prompt_states_the_two_rules_the_schema_blocks_omit():
    """schema_for() ships `### table` slices only, so the Important Notes prose that
    carries the $2 rule and the archived-rows rule never reaches this arm. The other
    arms get both from the full SCHEMA_CONTEXT and semantics.md; this prompt has to
    carry them itself or every date question fails validation on the first try."""
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    await _run(generator, narrator)

    prompt = generator.prompts[0]
    assert "$2" in prompt and "CURRENT_DATE" in prompt
    assert "deleted_at IS NULL" in prompt


def test_the_wire_schema_carries_no_prose():
    """Pydantic copies __doc__ into the JSON Schema `description`, and
    openai_compat sends the schema verbatim as the decoding grammar. This module's
    docstrings run to hundreds of words about Gate 1 and what Arctic's reward
    shaped -- prompt on every generation, paid for every time, addressed to nobody.
    """
    from services.llm.postprocess import strictify
    from services.insights_pipeline.pipeline import GeneratedSql

    schema = strictify(GeneratedSql.model_json_schema())

    assert "description" not in schema
    assert all("description" not in p for p in schema["properties"].values())
    assert list(schema["properties"]) == ["reasoning", "sql"]


async def test_the_dump_shows_what_the_retry_was_given_and_what_it_changed():
    """retry_used=True on its own says only that something failed twice. The first
    real run against Arctic turned on precisely this distinction: it copied the
    average-job-value exemplar at 0.988 similarity, dropped a single ::date cast,
    was handed Postgres's complaint, and made the same mistake again. Whether a
    retry ignored its error or tried something new is a fact about the model, and
    it is unrecoverable if the record keeps only the last draft."""
    first = "SELECT COUNT(*) AS n FROM jobs WHERE company_id = $1 AND started_at IS NULL"

    generator = ScriptedProvider("ollama", [_gen(first), _gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    result, _ = await _run(generator, narrator, sql_results=[SQL_FAILED, SQL_OK])
    record = result["pipeline"]

    assert record["first_sql"] == first
    assert record["generated_sql"] == LATE_SQL
    assert "SQL_ERROR" in record["retry_error"]


async def test_no_retry_leaves_the_retry_fields_empty():
    generator = ScriptedProvider("ollama", [_gen(LATE_SQL)])
    narrator = ScriptedProvider("narrator", ["4 jobs are late."])

    result, _ = await _run(generator, narrator)

    assert result["pipeline"]["first_sql"] is None
    assert result["pipeline"]["retry_error"] is None
