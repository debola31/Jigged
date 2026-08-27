"""Golden A/B for the insights surface: Claude vs DeepInfra Qwen3-32B vs local qwen3:8b.

    conda run -n jigged python -m evals.insights_ab --company <uuid> [--arms ...]

WHY THIS EXISTS RATHER THAN A JUDGEMENT CALL. Flipping insights to a local model
changes the answer a shop owner gets. "It seemed fine when I tried it" is not a
basis for that, and neither is a benchmark score for a model nobody ran against
THIS schema with THESE questions. The flip condition is stated before the run, in
FLIP_CONDITION below, so the result cannot be rationalised after the fact.

THREE ARMS, BECAUSE TWO WOULD CONFOUND TWO VARIABLES. Comparing Claude to local
qwen3:8b mixes "smaller model" with "our hardware". The DeepInfra arm runs the
larger Qwen on someone else's GPUs and separates them: if Qwen3-32B matches Claude
and qwen3:8b does not, the answer is a bigger local model or a bigger card, not a
different vendor. That is also the ONLY thing DeepInfra is for here -- it never
enters a production chain.

NOT RUN IN CI. It bills Anthropic and DeepInfra, and needs the desktop worker's
Ollama reachable. Run it deliberately, read the table, then decide.

SCORING CHANGED ON 2026-08-26, AND RUNS EITHER SIDE OF IT ARE NOT COMPARABLE.
The `answered` column used to count `ok` -- "the handler returned without
raising" -- so an arm whose final turn was "The column total_price does not
exist..." scored as answered. It now counts a SUBSTANTIVE answer, via the same
predicate the handler gates on (Outcome.answered). Every local arm's number will
drop, and that drop is the measurement being corrected, not a regression. Do not
read an older run's table against a newer one.

THE ARM SPEC WAS CLOBBERED UNTIL 2026-08-27, AND EVERY EARLIER LOCAL RUN NAMES
THE WRONG MODEL. run_arm assigned LLM_CHAIN_EVAL_<ARM> from the ARMS table
immediately before chain_for() read it back, so an exported value never survived
-- defeating, for the one variable that decides WHICH MODEL RAN, the
load_dotenv(override=False) above that exists so "an exported var still wins".
insights.txt line 4 exports ollama:a-kore/Arctic-Text2SQL-R1-7B and line 33 of the
same transcript logs `llm ollama/qwen3:8b failed`. ARMS["ollama"] has never held
anything but qwen3:8b, so findings attributed to Arctic were qwen3:8b's. An
exported chain now wins (spec_for), which is what makes a real re-baseline
possible.

THE PIPELINE ARMS ARE HELD TO A STRICTER BAR THAN THE OTHERS, DELIBERATELY, AND
THE `answered` COLUMN IS NOT LIKE-FOR-LIKE BECAUSE OF IT. For every other arm
`answered` means "the final turn was substantive". For ollama_pipeline* it means
that AND "every number in the answer is traceable to a returned row or a
Python-computed fact" -- services/insights_pipeline/facts.py refuses a narration
that states a figure from nowhere, where services/ai_features/insights.py
deliberately lets a grounded answer through however it reads. The asymmetry biases
AGAINST the pipeline arms, which is the safe direction for a gate; read a lower
number as a stricter test, not a worse model.

WIDENED AGAIN ON 2026-08-27, same warning. `answered` now also excludes a final
turn that is an UNEXECUTED tool call -- Arctic answered "which parts have no
routing yet" with the literal text `<execute_sql>` and the call's JSON, tools=0,
and scored answered because the text contained no error language. Runs before
this are not comparable on that case either. The predicate is shared with the
handler (services/insights_presentation.classify_non_answer), so it will keep
widening as evals find new ways for a turn to not be an answer; each widening
re-bases the column.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime
import hashlib
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Same reason api/index.py:29 does it, for the same .env.local. This module is a
# THIRD entry point: neither the FastAPI app nor pytest's conftest is in the import
# path under `python -m evals.insights_ab`, so nothing had populated os.environ and
# the anthropic arm was skipped for a missing key -- chain_for() raising on a box
# whose .env.local holds the key. override=False so an exported var still wins.
load_dotenv(Path(__file__).resolve().parents[2] / ".env.local", override=False)

from services.ai_features import JobContext, handler_for  # noqa: E402
from services.insights_presentation import (  # noqa: E402
    _validate_chart_config,
    looks_like_error_echo,
)
from services.llm.errors import LLMError  # noqa: E402
from tools.sql_executor import describe_dsn  # noqa: E402

# Stated BEFORE the run. Written here rather than in a report so it cannot drift
# into whatever the numbers happened to be.
FLIP_CONDITION = """
FLIP CONDITION (agreed before the run):
  * SQL validity   >= 90% of the Claude arm's
  * groundedness   >= 90% of the Claude arm's      <-- WITHDRAWN, see below
  * human verdict  <= 20% "worse" on the blind side-by-side
Anything short of all three and the chain stays on anthropic. Latency and cost are
recorded but are NOT part of the condition: a cheaper wrong answer is not cheaper.

WITHDRAWN 2026-08-27 -- groundedness: the metric behind it could not separate any
two arms, so the leg was passing on every run regardless of what the arm did.
Annotated rather than deleted, per docs/writing-docs.md: the original condition is
what was agreed, and rewriting it silently is the drift stating it here was meant
to prevent.

The measurement said 11/11 for all five arms of the 2026-08-27 run -- including
one that got 3 of 11 queries to execute, and one that answered "what is the
average value of a job this quarter?" with the company's gross profit. It asked
"does this answer contain digits without a tool call?", and since every arm calls
the tool, it asked nothing. `sql ran` is the column that separated the arms.

A HONEST REPLACEMENT IS NOT AVAILABLE AT THIS SEAM, which is why there is no new
leg here rather than a renamed one. For the pipeline arms an untraceable number is
already impossible -- services/insights_pipeline/facts.py refuses the narration --
so any version of the metric reads 11/11 by construction. For the tool-loop and
Claude arms the handler returns tool NAMES and no per-query outcome, so it cannot
be computed at all. Two of three legs now rest on the human read, and that is the
true state of the gate rather than a worse one.
"""

# Real questions beat clever ones. Seed with what shops actually type -- pull more
# from `select distinct question from ai_chat_queries order by created_at desc`.
DEFAULT_QUESTIONS = [
    "What is my revenue trend over time?",
    "Who is my top customer by revenue?",
    "What is my quote pipeline worth?",
    "How many jobs are late right now?",
    "Which work centre has the most operations queued?",
    "What did we quote last month versus the month before?",
    "Which parts have no routing yet?",
    "What is the average value of a job this quarter?",
    "How many quotes turned into jobs in the last 90 days?",
    "Which customers have not ordered in six months?",
    # Deliberately unanswerable from the allowlisted tables. A good arm says so;
    # a bad one invents a number, and inventing is worse than declining.
    "What is our net profit margin after payroll?",
]

# The SQL specialist the pipeline arms exist to test, and the small narrator that
# reads its rows back. Both are defaults: an exported LLM_CHAIN_EVAL_<ARM> wins.
ARCTIC = "ollama:a-kore/Arctic-Text2SQL-R1-7B"

ARMS: dict[str, str] = {
    "anthropic": "anthropic",
    "deepinfra": "deepinfra:Qwen/Qwen3-32B",
    "ollama": "ollama:qwen3:8b",
    "ollama_pipeline": ARCTIC,
    "ollama_pipeline_loo": ARCTIC,
    "ollama_pipeline_bare": ARCTIC,
}

# THE THREE COLUMNS ARE THE MEASUREMENT, not three ways of running one thing.
# `bare` turns retrieval off entirely and isolates what it buys at all; `full` and
# `loo` differ only in whether a question may see its OWN exemplar, which is the
# difference between transcribing one and generalising past one. Three of the
# eleven questions carry no exemplar in any mode -- see data/pairs.json -- and they
# are the within-run control that needs no column.
PIPELINE_ARMS: dict[str, str] = {
    "ollama_pipeline": "full",
    "ollama_pipeline_loo": "loo",
    "ollama_pipeline_bare": "none",
}

# Resolved through the same LLM_CHAIN_EVAL_* mechanism as an arm, so there is one
# way to point this harness at a model rather than two.
_SPECS: dict[str, str] = {**ARMS, "narrator": "ollama:qwen3:4b-instruct-2507-q4_K_M"}


def spec_for(arm: str) -> str:
    """The chain spec for an arm: an exported value first, the table as default.

    This function is the fix for the clobber described in the module docstring, and
    the reason it exists at all rather than being inlined.
    """
    return os.getenv(f"LLM_CHAIN_EVAL_{arm.upper()}") or _SPECS[arm]


def request_id_for(arm: str, question: str) -> str:
    """A request id that means the same thing in two different runs.

    Was abs(hash(question)). Python salts string hashing per process, so the id for
    one question changed on every invocation and no ai_calls row could be traced
    back to what caused it.
    """
    digest = hashlib.sha256(f"{arm}|{question}".encode()).hexdigest()[:8]
    return f"eval-{arm}-{digest}"


def greedy_ollama(spec: str):
    """A local provider with decoding pinned, built directly rather than resolved.

    NO OLLAMA CALL IN THIS REPO HAS EVER BEEN GREEDY. OpenAICompatProvider._body
    sends model, messages, max_tokens and stream; the registry's ollama branch adds
    only reasoning_effort. Everything has therefore run at the Modelfile default
    temperature, which for an R1-style model is 0.6-0.8 -- and a non-deterministic
    generator makes two runs incomparable and a pinned expectation meaningless.

    Built here, the way worker/__main__.py builds its own chain and for the same
    reason: it keeps the blast radius at zero. Adding temperature to the registry
    would silently change insights_dev and drawings_dev too.
    """
    from decimal import Decimal as _Decimal

    from services.llm.openai_compat import OpenAICompatProvider

    # partition, not split: an Ollama tag contains a colon and a naive split
    # truncates `qwen3:8b` to `qwen3`, which is a different model that answers.
    slug, _, model = spec.partition(":")
    if slug != "ollama":
        raise ValueError(
            f"the pipeline arms run a local ollama model; got {spec!r}. They exist to "
            f"measure a SQL specialist on our own hardware, and pointing one at a "
            f"hosted model would answer a different question."
        )
    return OpenAICompatProvider(
        base_url=os.getenv("OLLAMA_BASE_URL") or "http://localhost:11434/v1",
        api_key=None,
        model=model or "qwen3:8b",
        price_in_per_mtok=_Decimal("0"),
        price_out_per_mtok=_Decimal("0"),
        name="ollama",
        timeout_s=120.0,
        extra_body={"reasoning_effort": "none", "temperature": 0, "seed": 0},
    )


def stages_path(out: Path) -> Path:
    """Where the per-stage record goes: beside the dump, not behind a new flag.

    A SEPARATE FILE BECAUSE THE MAIN DUMP HAS TO STAY BLIND. The human verdict is
    read by comparing answers side by side with nothing to identify the arm; a
    `generated_sql` key present for one arm and absent for the others gives the game
    away on the first question.
    """
    return out.with_name(f"{out.stem}_stages{out.suffix}")


@dataclass
class Outcome:
    arm: str
    question: str
    ok: bool
    answer: str = ""
    error: str = ""
    latency_ms: int = 0
    tool_calls: int = 0
    has_chart: bool = False
    chart_valid: bool = False
    cost_usd: Decimal = Decimal("0")
    ledger: list[dict[str, Any]] = field(default_factory=list)
    # The pipeline arms' per-stage record. Never written to the main dump.
    stages: dict[str, Any] | None = None

    @property
    def used_sql(self) -> bool:
        return self.tool_calls > 0

    @property
    def answered(self) -> bool:
        """Did a shop owner get an answer? NOT the same question as `ok`.

        `ok` means the handler returned without raising, and for most of this
        eval's life the table counted that as answered -- so an arm whose final
        turn was "The column total_price does not exist..." scored 11/11. The
        table said the local arms were doing better than they were, which is the
        one thing a gate-deciding eval must not do.

        Uses the same predicate the handler gates on, but applies it ALONE. The
        handler needs the second condition (no query succeeded) because it is
        deciding whether a real user gets a real failure, and a rule that could
        reject a grounded answer will eventually reject a good one. Scoring has
        no such duty -- and could not check it anyway, holding only the answer
        text and a count of tool calls.
        """
        return self.ok and not looks_like_error_echo(self.answer)

    # `grounded` was here. Retired 2026-08-27; see the WITHDRAWN note in
    # FLIP_CONDITION for the measurement that retired it. Do not reinstate it
    # without a definition that can separate two arms.


async def run_arm(arm: str, company_id: str, question: str, index: Any = None) -> Outcome:
    """One arm, one question. Both handlers return the same dict, so scoring is shared.

    EVERY CHAIN IS RESOLVED HERE AND PASSED DOWN, never left to be looked up later
    from an environment this function has just written to. The pipeline arms need
    two models -- a generator and a narrator -- and a lazily-resolved second chain
    is exactly how one arm's environment ends up deciding the next one's model.

    `today` IS ALWAYS SENT, AND OMITTING IT WOULD HAVE INVALIDATED THE RUN SILENTLY.
    The validator now refuses CURRENT_DATE, so every date-bounded question -- late,
    this quarter, last 90 days, six months, four of the eleven -- must reach the
    executor as $2. sql_executor binds whatever it is given, and `None` becomes SQL
    NULL rather than nothing: `due_date < $2::date` is then NULL, the WHERE keeps no
    row, and the arm answers "zero" with no error anywhere. A wrong answer that
    looks like a finding is the one failure this harness exists to prevent.
    """
    ledger: list[dict[str, Any]] = []
    today = datetime.date.today().isoformat()

    async def capture(row: dict[str, Any]) -> None:
        ledger.append(row)

    if arm in PIPELINE_ARMS:
        from services.insights_pipeline import run as pipeline_run
        from services.insights_pipeline.embeddings import embed_texts

        handler = pipeline_run
        chain = [greedy_ollama(spec_for(arm))]
        payload: dict[str, Any] = {
            "question": question,
            "today": today,
            "narrator_chain": [greedy_ollama(spec_for("narrator"))],
            "embed_fn": embed_texts,
            "index": index,
            "retrieval": PIPELINE_ARMS[arm],
        }
    else:
        from services.llm.registry import chain_for

        handler = handler_for("insights")
        # Idempotent: spec_for has already preferred whatever was exported, so this
        # writes back the same value rather than overwriting the operator's.
        os.environ[f"LLM_CHAIN_EVAL_{arm.upper()}"] = spec_for(arm)
        chain = chain_for(f"eval_{arm}")
        payload = {"question": question, "today": today}

    started = time.perf_counter()
    try:
        result = await handler(
            JobContext(
                feature="insights",
                company_id=company_id,
                request_id=request_id_for(arm, question),
                payload=payload,
                chain=chain,
                audit_writer=capture,
            )
        )
    except LLMError as exc:
        return Outcome(arm=arm, question=question, ok=False, error=f"{type(exc).__name__}: {exc}",
                       latency_ms=int((time.perf_counter() - started) * 1000), ledger=ledger)
    except Exception as exc:  # noqa: BLE001
        return Outcome(arm=arm, question=question, ok=False, error=f"{type(exc).__name__}: {exc}",
                       latency_ms=int((time.perf_counter() - started) * 1000), ledger=ledger)

    chart = result.get("chart_config")
    return Outcome(
        arm=arm,
        question=question,
        ok=True,
        answer=result.get("answer", ""),
        latency_ms=int((time.perf_counter() - started) * 1000),
        tool_calls=len(result.get("tool_calls") or []),
        has_chart=chart is not None,
        chart_valid=_validate_chart_config(chart) is not None,
        cost_usd=sum((Decimal(r["est_cost_usd"]) for r in ledger), Decimal("0")),
        ledger=ledger,
        stages=result.get("pipeline"),
    )


def dump_entry(outcome: Outcome) -> dict[str, Any]:
    """The eight keys the side-by-side dump has always carried, and only those.

    Stage detail goes to the sidecar instead. A `generated_sql` key present for one
    arm and absent for the rest would identify it on the first question, and the
    human verdict leg of FLIP_CONDITION depends on that read being blind.
    """
    return {
        "ok": outcome.ok,
        "answered": outcome.answered,
        "answer": outcome.answer,
        "error": outcome.error,
        "latency_ms": outcome.latency_ms,
        "cost_usd": str(outcome.cost_usd),
        "tool_calls": outcome.tool_calls,
        "chart_valid": outcome.chart_valid,
    }


def summarise(outcomes: list[Outcome]) -> str:
    by_arm: dict[str, list[Outcome]] = {}
    for o in outcomes:
        by_arm.setdefault(o.arm, []).append(o)

    lines = [
        "",
        f"{'arm':<22}{'answered':>10}{'used sql':>10}{'sql ran':>10}"
        f"{'charts':>9}{'p50 ms':>9}{'p95 ms':>9}{'total $':>12}{'attempts':>10}",
        "-" * 101,
    ]
    for arm, rows in by_arm.items():
        n = len(rows)
        lat = sorted(o.latency_ms for o in rows)
        p95 = lat[min(int(len(lat) * 0.95), len(lat) - 1)] if lat else 0
        # The one FLIP_CONDITION leg that has never had a column. Reported only
        # where it can be: the tool loop returns no per-query outcome, so filling
        # this in for the other arms would mean guessing.
        sql_ran = (
            f"{sum(1 for o in rows if (o.stages or {}).get('sql_ran')):>7}/{n:<2}"
            if arm in PIPELINE_ARMS else f"{'-':>10}"
        )
        lines.append(
            f"{arm:<22}"
            f"{sum(o.answered for o in rows):>7}/{n:<2}"
            f"{sum(o.used_sql for o in rows):>7}/{n:<2}"
            f"{sql_ran}"
            f"{sum(o.chart_valid for o in rows):>6}/{n:<2}"
            f"{int(statistics.median(lat)) if lat else 0:>9}"
            f"{p95:>9}"
            f"{float(sum((o.cost_usd for o in rows), Decimal('0'))):>12.6f}"
            f"{sum(len(o.ledger) for o in rows):>10}"
        )

    # NOT-ANSWERED, not just raised. A run that returned the tool's error text as
    # the answer is the failure this eval was missing, and it has no `error` to
    # print -- so the answer stands in for one.
    lines += ["", "NOT ANSWERED", "-" * 101]
    lines += [
        f"  {o.arm:<21} {o.question[:48]:<50} "
        f"{(o.error or f'answered: {o.answer!r}')[:70]}"
        for o in outcomes if not o.answered
    ] or ["  none"]

    lines += [
        "",
        "`attempts` counts ai_calls rows, not questions: a fallback or a schema retry",
        "writes more than one, and a number well above the question count is an arm",
        "quietly costing double. A pipeline arm makes two calls per question by",
        "design -- generate and narrate -- at no cost, so read its count against 2N.",
        "",
        "`sql ran` is FLIP_CONDITION's SQL-validity leg, and it is blank for the arms",
        "that cannot report it: the tool loop returns tool names, not per-query",
        "outcomes, so there is nothing to count without changing it. That leg has",
        "never had a column behind it -- do not read its absence as a pass.",
        "",
        "`grounded` was retired on 2026-08-27: it read 11/11 for every arm, one of",
        "which executed 3 of 11 queries. See the WITHDRAWN note below.",
        "",
        "`answered` IS NOT LIKE FOR LIKE. The ollama_pipeline* arms additionally",
        "refuse a narration stating a figure that is in neither the returned rows nor",
        "a Python-computed fact; the other arms are held only to 'substantive'. The",
        "stricter bar biases against the pipeline arms. See the module docstring.",
        FLIP_CONDITION,
        "The human column is not in this table and cannot be. Read the side-by-side",
        "answers in the JSON dump, blind-ordered, and mark each better/same/worse.",
    ]
    return "\n".join(lines)


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--company", required=True, help="company_id to ask about")
    ap.add_argument("--arms", nargs="+", default=list(ARMS), choices=list(ARMS))
    ap.add_argument("--questions", type=Path, help="newline-delimited file; defaults to the built-in set")
    ap.add_argument("--out", type=Path, default=Path("insights_ab.json"))
    args = ap.parse_args()

    questions = (
        [q.strip() for q in args.questions.read_text().splitlines() if q.strip()]
        if args.questions
        else DEFAULT_QUESTIONS
    )

    # WHICH DATABASE PRODUCED THESE NUMBERS IS PART OF THE RESULT, so it is printed
    # rather than assumed. .env.local points AI_READONLY_DATABASE_URL at the LOCAL
    # stack while the shop's data lives elsewhere, and an arm that scored badly
    # because it queried an empty database looks exactly like an arm that scored
    # badly. FLIP_CONDITION is worth nothing if those two are confusable.
    dsn = os.getenv("AI_READONLY_DATABASE_URL")
    if not dsn:
        # Refuse rather than run: with no SQL tool every arm answers from nowhere,
        # and the run still bills.
        print("AI_READONLY_DATABASE_URL is not set -- every arm would answer without "
              "SQL and the comparison would be meaningless. Set it and re-run.")
        return 2

    # SET IS NOT REACHABLE, and the difference cost real money. A run against a
    # stopped local stack billed four questions of Claude before anyone read the
    # output: each one generated SQL, handed the connection error back to the model,
    # and let it try again, which is the self-correction loop working exactly as
    # designed on a database that was never going to open. One second here.
    import asyncpg

    try:
        conn = await asyncpg.connect(dsn, timeout=5)
        await conn.execute("select 1")
        await conn.close()
    except Exception as exc:  # noqa: BLE001 - any failure to reach it is fatal here
        print(f"cannot reach {describe_dsn(dsn)}: {type(exc).__name__}: {exc}")
        print("AI_READONLY_DATABASE_URL is the LOCAL stack in .env.local; "
              "WORKER_READONLY_DATABASE_URL is the remote one. Export whichever holds "
              "this company and re-run.")
        return 2
    print(f"company {args.company} via {describe_dsn(dsn)}\n")

    # THE INDEX IS BUILT ONCE, BEFORE ANYTHING BILLS, and its failure is a third
    # pre-flight refusal alongside the two above. A pipeline arm with no embeddings
    # would silently degrade to the no-retrieval arm and score as though retrieval
    # had been tested -- the one outcome this run must not produce.
    index = None
    if any(arm in PIPELINE_ARMS for arm in args.arms):
        from services.insights_pipeline.embeddings import EmbeddingUnavailable, embed_texts
        from services.insights_pipeline.retrieval import build_index, load_cards, load_pairs

        try:
            index = await build_index(embed_texts)
        except EmbeddingUnavailable as exc:
            print(f"cannot build the retrieval index: {exc}")
            print("The pipeline arms need embeddings. Drop them from --arms, or start "
                  "Ollama and pull the embedding model, and re-run.")
            return 2
        print(f"indexed {len(load_cards())} table cards and {len(load_pairs())} golden "
              f"pairs\n")

    outcomes: list[Outcome] = []
    for question in questions:
        for arm in args.arms:
            print(f"  {arm:<21} {question[:60]}", flush=True)
            outcomes.append(await run_arm(arm, args.company, question, index=index))

    # Grouped by QUESTION so the side-by-side read is blind-ish and actually
    # comparable -- reading one arm end to end anchors you to it.
    dump = [
        {
            "question": q,
            "arms": {o.arm: dump_entry(o) for o in outcomes if o.question == q},
        }
        for q in questions
    ]
    args.out.write_text(json.dumps(dump, indent=2))

    # THE SIDECAR IS WHERE A FAILURE BECOMES ATTRIBUTABLE TO A STAGE. Which tables
    # were linked, which exemplars came back and what question each of them
    # ANSWERS, the SQL that was generated and whether it was copied from an
    # exemplar, whether the pre-check or the database refused it, and whether the
    # narration stated a figure it was not given. Read it AFTER the blind verdict,
    # never before.
    stages = {
        q: {o.arm: o.stages for o in outcomes if o.question == q and o.stages}
        for q in questions
    }
    stages = {q: arms for q, arms in stages.items() if arms}
    if stages:
        stages_path(args.out).write_text(json.dumps(stages, indent=2, default=str))

    print(summarise(outcomes))
    print(f"\nside-by-side answers: {args.out}")
    if stages:
        print(f"per-stage attribution:  {stages_path(args.out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
