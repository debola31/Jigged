"""The five stages, each doing one job, in a fixed order.

    link schema -> retrieve exemplars -> generate SQL -> execute -> narrate

WHAT THE FIXED ORDER BUYS, stated narrowly because only one claim survives
scrutiny. There is no tool-calling protocol anywhere in this path, so the failure
insights_presentation._TOOL_TAG was added for -- a model TYPING `<execute_sql>`
and its JSON instead of calling it, and scoring `answered` because the text
carried no error language -- cannot happen. There is no tool to narrate.

WHAT IT DOES NOT BUY. Narrator displacement moves rather than disappearing: hand
back the started/shipped exemplar for "what is my revenue trend" and the SQL runs,
the rows are real, every number in the narration is in those rows, and the answer
is still about the wrong question. That is why every retrieved pair carries its
source_question into the dump. It is measured, not prevented.

WHAT GOES IN THE GENERATION PROMPT, and why semantics.md does not. The other arms
render the whole of semantics.md into the system prompt -- ten reference queries,
every one of them, on every question. This arm ships the linked tables' schema and
the retrieved exemplars instead. That IS the experiment: the Gate 2 run had the
late-job reference query in front of it, with `due_date` written out, and wrote
`due_at` anyway, so "the answer was not available" is not why it failed. The
hypothesis under test is that a 7B model attends better to two exemplars than to
ten. The `none` mode turns both stages off and is the control.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date
from decimal import Decimal
from difflib import SequenceMatcher
from typing import Any

from pydantic import BaseModel, ConfigDict

from services import llm
from services.ai_features.base import JobContext
from services.insights_presentation import (
    _flatten_markdown_tables,
    _strip_code_blocks,
    _strip_inline_markdown,
)
from services.llm.base import Message
from services.llm.errors import LLMErrorEcho

logger = logging.getLogger(__name__)

# Room for Arctic-Text2SQL to reason inside the JSON string before it writes SQL.
# Too low and thinking trips finish_reason=length, which openai_compat turns into
# LLMTruncated -- a real failure that would read as "the pipeline broke it".
MAX_TOKENS = 2000
NARRATOR_MAX_TOKENS = 400

# How many rows the narrator is shown. The aggregates it needs are in the facts,
# so a full 200-row page would be prompt weight buying nothing -- and this is a 4B
# model on a laptop.
NARRATOR_ROW_CAP = 25


def _drop_description(schema: dict) -> None:
    """Keep this module's docstrings out of the wire schema.

    Pydantic copies a model's __doc__ into the JSON Schema `description`, and
    openai_compat sends that schema verbatim as the grammar. Left alone, ~900
    characters of internal rationale -- Gate 1, "hallucination", what Arctic's
    reward shaped -- would be prompt on every single generation: paid for each
    time, and addressed to a reader who is not there. The house style of long
    explanatory docstrings is worth keeping; shipping them to the model is not.
    """
    schema.pop("description", None)
    for prop in schema.get("properties", {}).values():
        prop.pop("description", None)


class GeneratedSql(BaseModel):
    """The only shape a generation may take.

    FLAT, because postprocess.strictify raises on $defs/$ref -- vendors disagree
    about strict-mode $ref and the refusal is deliberate.

    `reasoning` IS DECLARED FIRST, and that is not cosmetic: property order drives
    the order a constrained decoder must emit, and Arctic-Text2SQL-R1-7B is
    RL-trained to reason before it writes SQL. Forcing `{` then `"sql"` suppresses
    exactly what its reward shaped, and the quality drop would be attributed to
    the pipeline rather than to the constraint.

    AN EMPTY `sql` IS THE DECLINE CHANNEL, and the schema cannot express it any
    other way: strictify puts every property into `required`, so the model must
    emit a string. Without the empty-string contract the payroll question yields a
    true_cost_per_unit query, stage 4 succeeds, stage 5 narrates real rows, the
    guard passes because every digit is in them, and this pipeline reproduces the
    Gate 1 hallucination it exists to prevent.
    """

    model_config = ConfigDict(json_schema_extra=_drop_description)

    reasoning: str
    sql: str


_SQL_NOISE = re.compile(r"\s+")


def _normalise_sql(sql: str) -> str:
    return _SQL_NOISE.sub(" ", (sql or "").strip().rstrip(";")).lower()


async def _execute_sql(
    company_id: str, sql: str, description: str = "", today=None
) -> dict:
    """The one door to the database, and the same door the tool loop uses.

    A named module-level function rather than an inline import so a test can
    replace it without a running Postgres -- the sandbox itself (SET LOCAL
    tenancy, statement timeout, MAX_ROWS, the validator) is already covered by
    tests/integration/test_sql_executor.py and is not re-litigated here.
    """
    from tools.sql_executor import execute_sql_query

    return await execute_sql_query(
        company_id=company_id, sql=sql, description=description, today=today
    )


def _generation_messages(question: str, schema_text: str, hits) -> list[Message]:
    exemplars = ""
    if hits:
        blocks = "\n\n".join(
            f"-- {hit.pair.source_question}\n{hit.pair.sql}" for hit in hits
        )
        exemplars = (
            "\n\nWorked examples of correct queries against this schema. They answer "
            "DIFFERENT questions -- follow their shape and their grain, do not answer "
            "the question they answer:\n\n" + blocks
        )

    return [
        Message(
            role="system",
            content=(
                "You write one PostgreSQL SELECT for a small manufacturing shop's "
                "database, and nothing else.\n\n"
                "Rules:\n"
                "- Exactly one statement. SELECT or WITH. Never a mutation.\n"
                "- Use $1 wherever the company id is needed. Never write a literal id.\n"
                "- $2 is today's date and the ONLY clock you have. CURRENT_DATE, now() "
                "and CURRENT_TIMESTAMP are refused before execution. Write $2::date "
                "anywhere the surrounding expression does not already fix the type: "
                "DATE_TRUNC('quarter', $2::date), $2::date - INTERVAL '6 months'.\n"
                "- Archived rows are already invisible on this connection. NEVER write "
                "deleted_at IS NULL; it is redundant.\n"
                "- Rows are already scoped to one company; add no other company filter.\n"
                "- Use only the tables and columns below. Do not invent a column.\n"
                "- Every value you return must be COMPUTED FROM A COLUMN. Never select "
                "a constant as the answer: `SELECT '100%' AS margin` reports a number "
                "you typed, not one the data supports.\n"
                "- If the question CANNOT be answered from these tables, return an "
                "empty string for sql. Do not substitute a proxy figure, and do not "
                "invent a value to fill the shape.\n\n"
                f"{schema_text}{exemplars}"
            ),
        ),
        Message(role="user", content=question),
    ]


def _rows_for_prompt(rows: list[dict]) -> str:
    from tools.tool_json import to_json_safe

    shown = [{k: to_json_safe(v) for k, v in row.items()} for row in rows[:NARRATOR_ROW_CAP]]
    return json.dumps(shown, indent=None)


def _narration_messages(
    question: str,
    rows: list[dict],
    facts: dict[str, Any],
    *,
    declined: bool,
    refused: bool,
    failed: bool,
) -> list[Message]:
    """The four states stage 5 can be in, kept apart because two of them look alike.

    A FAILED QUERY AND AN EMPTY RESULT BOTH ARRIVE WITH ZERO ROWS, and collapsing
    them is how a broken query becomes "no jobs are late" -- a confident, specific,
    checkable-sounding answer that nothing computed. A false negative is the worst
    thing this pipeline can emit, because it is the one a shop owner acts on.
    """
    if declined:
        situation = (
            "No query was run: the data this question needs is not in the tables this "
            "system can read."
        )
    elif refused:
        situation = (
            "The query named something this system cannot read, so the figure is "
            "unavailable. Say so plainly and name nothing technical."
        )
    elif failed:
        situation = (
            "The query could not be run, so there is NO data behind this question. Say "
            "plainly that the figure is unavailable. Do not say the answer is zero, do "
            "not say nothing was found, and never repeat an error."
        )
    elif not rows:
        situation = "The query ran and returned no rows. That is real data: nothing matched."
    else:
        situation = f"The query returned these rows:\n{_rows_for_prompt(rows)}"

    stated = "\n".join(
        f"- {key} = {value}" for key, value in facts.items() if not isinstance(value, bool)
    )
    truncation = (
        "\nThe result was cut off at the row limit, so say 'at least' rather than an "
        "exact count.\n" if facts.get("truncated") else ""
    )

    return [
        Message(
            role="system",
            content=(
                "You state what the data shows, for a busy shop owner. 1-3 sentences, "
                "plain prose, no markdown, no tables.\n\n"
                "Rules, and the first is absolute:\n"
                "- NEVER do arithmetic. Do not add, subtract, divide, average or convert "
                "anything. Every figure you need has already been computed for you.\n"
                "- NEVER write a number that is not in the rows or the computed figures "
                "below. Not an estimate, not a rounding, not a total you worked out.\n"
                "- If there is no data, say plainly that this system does not track it. "
                "Do not offer a substitute figure and do not write a placeholder.\n"
                "- Do not give advice or recommendations."
            ),
        ),
        Message(
            role="user",
            content=(
                f"Question: {question}\n\n{situation}\n\n"
                f"Computed figures you may state:\n{stated or '- none'}\n{truncation}"
            ),
        ),
    ]


async def run(ctx: JobContext) -> dict[str, Any]:
    """Answer one question through the fixed path. Same return shape as the tool loop.

    Returns what services/ai_features/insights.py returns -- answer, chart_config,
    tool_calls, provider, model, tokens_used, not_permitted -- plus a `pipeline`
    record for the sidecar. Matching the shape is what would let this become a
    handler later without rework; it is deliberately NOT registered as one now.
    """
    from services.insights_pipeline.facts import check_narration, derive_facts
    from services.insights_pipeline.retrieval import (
        embed_question,
        link_tables,
        load_pairs,
        retrieve_pairs,
        schema_for,
    )
    from services.insights_pipeline.sqlcheck import offending_column, precheck_columns
    from tools.sql_executor import NOT_PERMITTED_KIND, SQL_ERROR_KIND

    question = (ctx.payload.get("question") or "").strip()
    if not question:
        raise ValueError("insights pipeline payload has no question")

    mode = ctx.payload.get("retrieval", "full")
    if mode not in ("full", "loo", "none"):
        raise ValueError(f"unknown retrieval mode {mode!r}; expected full, loo or none")

    index = ctx.payload.get("index")
    embed_fn = ctx.payload.get("embed_fn")
    narrator_chain = ctx.payload.get("narrator_chain")

    # The caller's local date, bound as $2. Same ISO-string contract the tool loop
    # takes, so a payload built for one handler works for the other.
    raw_today = ctx.payload.get("today")
    today = date.fromisoformat(raw_today) if raw_today else None

    # Refuse rather than degrade. A missing index or embedder would silently turn a
    # retrieval arm into the no-retrieval arm, and it would still answer every
    # question and still fill in a score -- so the run would look like a measurement
    # of retrieval and be a measurement of nothing.
    if index is None:
        raise ValueError("insights pipeline needs a prebuilt retrieval index")
    if mode != "none" and embed_fn is None:
        raise ValueError(f"retrieval mode {mode!r} needs an embedder to score the question")
    if not narrator_chain:
        raise ValueError("insights pipeline needs a narrator chain")

    # ---------------------------------------------- stages 1 and 2, or neither
    if mode == "none":
        linked = [card.name for card in index.cards]
        hits = []
    else:
        question_vector = await embed_question(embed_fn, question)
        linked = link_tables(question_vector, index)
        hits = retrieve_pairs(
            question_vector,
            index,
            # Held out on the source_question field, never on similarity, and with
            # no fall-through to the runner-up. See retrieve_pairs.
            exclude_source_question=question if mode == "loo" else None,
        )

    record: dict[str, Any] = {
        "retrieval_mode": mode,
        "linked_tables": linked,
        "pairs": [
            {"id": h.pair.id, "source_question": h.pair.source_question,
             "score": round(h.score, 4), "matched": h.matched}
            for h in hits
        ],
        # Per QUESTION. The index's own single batch is paid once for the whole run
        # and would read as per-question cost if it were added in here.
        "embed_calls": 0 if mode == "none" else 1,
        "declined": False,
        "reasoning": "", "generated_sql": "", "copied_from": None,
        "precheck_rejected": None, "retry_used": False, "error_kind": None,
        "row_count": 0, "truncated": False, "facts": {}, "narration_flag": None,
        "sql_ran": False, "closest_exemplar": None, "closest_similarity": 0.0,
        # WHAT THE RETRY WAS GIVEN AND WHAT IT DID WITH IT. Without these,
        # retry_used=True says only that something failed twice -- and the first
        # real run turned on exactly this: the model copied the average-job-value
        # exemplar at 0.988 similarity, dropped one ::date cast, was handed
        # Postgres's complaint, and made the same mistake again. That is a finding
        # about the model. It is invisible if the record keeps only the last draft.
        "first_sql": None, "retry_error": None,
    }

    # ------------------------------------------------------ stage 3: generate
    messages = _generation_messages(question, schema_for(linked), hits)
    generation = await llm.complete(
        ctx.feature, messages, json_schema=GeneratedSql, max_tokens=MAX_TOKENS,
        request_id=ctx.request_id, chain=ctx.chain, audit_writer=ctx.audit_writer,
    )
    draft = GeneratedSql.model_validate_json(generation.text)
    tokens_used = generation.tokens_in + generation.tokens_out

    # ------------------------------------------- stage 4: execute, retry once
    tool_calls: list[str] = []
    result: dict[str, Any] = {"rows": [], "columns": []}
    refused = 0

    for attempt in (1, 2):
        record["reasoning"] = draft.reasoning
        record["generated_sql"] = draft.sql

        if not draft.sql.strip():
            record["declined"] = True
            result = {"rows": [], "columns": []}
            break

        rejected = precheck_columns(draft.sql)
        if rejected is not None:
            record["precheck_rejected"] = offending_column(rejected)
            result = rejected
        else:
            result = await _execute_sql(
                ctx.company_id, draft.sql, draft.reasoning[:200], today
            )
            tool_calls.append("execute_sql")

        record["error_kind"] = result.get("error_kind")
        if "error" not in result:
            break
        if result.get("error_kind") == NOT_PERMITTED_KIND:
            refused = 1
            break
        # Only a model-fixable failure earns the one retry. An absent error_kind is
        # infrastructure -- a dead pool, a malformed company_id -- and no rewrite
        # reaches it, which is why the dump keeps error_kind verbatim, None included.
        if result.get("error_kind") != SQL_ERROR_KIND or attempt == 2:
            break

        record["retry_used"] = True
        record["first_sql"] = draft.sql
        record["retry_error"] = result["error"]
        repair = messages + [
            Message(role="assistant", content=draft.model_dump_json()),
            Message(
                role="user",
                content=(
                    f"That query failed: {result['error']}\n"
                    "Rewrite it and return the same JSON shape. Do not explain the error."
                ),
            ),
        ]
        generation = await llm.complete(
            ctx.feature, repair, json_schema=GeneratedSql, max_tokens=MAX_TOKENS,
            request_id=ctx.request_id, chain=ctx.chain, audit_writer=ctx.audit_writer,
        )
        draft = GeneratedSql.model_validate_json(generation.text)
        tokens_used += generation.tokens_in + generation.tokens_out

    # The column FLIP_CONDITION's "SQL validity" leg needs and has never had. Not
    # derivable from error_kind alone: an infrastructure failure carries no kind
    # either, and "the pool was dead" must not read as "the model wrote bad SQL".
    record["sql_ran"] = bool(tool_calls) and "error" not in result

    rows = result.get("rows") or []
    columns = result.get("columns") or []
    facts = derive_facts(columns, rows)
    record["row_count"] = facts["row_count"]
    record["truncated"] = facts["truncated"]
    record["facts"] = {k: str(v) if isinstance(v, Decimal) else v for k, v in facts.items()}

    # Did the model transcribe an exemplar or write its own query? Compared against
    # EVERY pair, not just the retrieved ones, so a query reproduced from the
    # model's memory in `none` mode is visible too.
    # HOW CLOSELY DID IT FOLLOW THE EXEMPLAR, not merely "was it identical".
    # The first real run generated the revenue query having retrieved the revenue
    # exemplar, differing only by a ::date cast and a dropped WHERE clause -- and
    # exact-match recorded copied_from=None, which reads as "wrote its own" and is
    # the opposite of what happened. The whole exemplar experiment is unreadable
    # without the degree.
    normalised = _normalise_sql(draft.sql)
    if normalised:
        ranked = sorted(
            (
                (SequenceMatcher(None, _normalise_sql(p.sql), normalised).ratio(), p.id)
                for p in load_pairs()
            ),
            reverse=True,
        )
        best_ratio, best_id = ranked[0]
        record["copied_from"] = best_id if best_ratio >= 0.90 else None
        record["closest_exemplar"] = best_id
        record["closest_similarity"] = round(best_ratio, 3)

    # ----------------------------------------------------- stage 5: summarize
    narration = await llm.complete(
        ctx.feature,
        _narration_messages(
            question, rows, facts,
            declined=record["declined"], refused=bool(refused),
            # Distinct from "no rows", deliberately. See _narration_messages.
            failed="error" in result and not refused and not record["declined"],
        ),
        max_tokens=NARRATOR_MAX_TOKENS, request_id=ctx.request_id,
        chain=narrator_chain, audit_writer=ctx.audit_writer,
    )
    tokens_used += narration.tokens_in + narration.tokens_out

    answer = _strip_inline_markdown(_flatten_markdown_tables(_strip_code_blocks(narration.text)))

    flag = check_narration(answer, rows=rows, facts=facts, question=question)
    record["narration_flag"] = flag
    if flag:
        # HARD FAIL, and a stricter bar than any other arm is held to. See facts.py:
        # the agentic and Claude arms let a grounded answer through however it
        # reads, so this arm's `answered` column means "substantive AND every number
        # traceable" where theirs means only "substantive". The asymmetry biases
        # against this arm, which is the safe direction for a gate, and
        # evals/insights_ab.py's docstring says so where a reader will see it.
        raise LLMErrorEcho(
            f"narrator_invented_number [{flag}]: the narration states a figure that is "
            f"in neither the rows nor the computed facts: {answer[:300]!r}",
            feature=ctx.feature, request_id=ctx.request_id,
            provider=narration.provider, model=narration.model, tokens_out=tokens_used,
        )

    return {
        "answer": answer,
        # No charts in this arm, by scope. Stated rather than omitted: the eval reads
        # this key and a missing one would read as a validation failure.
        "chart_config": None,
        "tool_calls": tool_calls,
        "provider": generation.provider,
        "model": generation.model,
        "tokens_used": tokens_used,
        "not_permitted": refused,
        "pipeline": record,
    }


__all__ = ["GeneratedSql", "MAX_TOKENS", "run"]
