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
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.ai_features import JobContext, handler_for  # noqa: E402
from services.insights_presentation import _validate_chart_config  # noqa: E402
from services.llm.errors import LLMError  # noqa: E402

# Stated BEFORE the run. Written here rather than in a report so it cannot drift
# into whatever the numbers happened to be.
FLIP_CONDITION = """
FLIP CONDITION (agreed before the run):
  * SQL validity   >= 90% of the Claude arm's
  * groundedness   >= 90% of the Claude arm's
  * human verdict  <= 20% "worse" on the blind side-by-side
Anything short of all three and the chain stays on anthropic. Latency and cost are
recorded but are NOT part of the condition: a cheaper wrong answer is not cheaper.
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

ARMS: dict[str, str] = {
    "anthropic": "anthropic",
    "deepinfra": "deepinfra:Qwen/Qwen3-32B",
    "ollama": "ollama:qwen3:8b",
}


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

    @property
    def used_sql(self) -> bool:
        return self.tool_calls > 0

    @property
    def grounded(self) -> bool:
        """Did the answer avoid asserting a number with no query behind it?

        A crude proxy, and honestly labelled as one: an answer containing digits but
        no tool call means the model produced a figure from nowhere. It cannot catch
        a wrong number that DID come from a query -- that is what the human column is
        for -- but hallucinated totals are the failure that matters most here,
        because a shop owner has no way to tell one from a real one.
        """
        if not self.ok:
            return False
        has_digits = any(ch.isdigit() for ch in self.answer)
        return self.used_sql or not has_digits


async def run_arm(arm: str, company_id: str, question: str) -> Outcome:
    from services.llm.registry import chain_for

    os.environ[f"LLM_CHAIN_EVAL_{arm.upper()}"] = ARMS[arm]
    chain = chain_for(f"eval_{arm}")

    ledger: list[dict[str, Any]] = []

    async def capture(row: dict[str, Any]) -> None:
        ledger.append(row)

    started = time.perf_counter()
    try:
        result = await handler_for("insights")(
            JobContext(
                feature="insights",
                company_id=company_id,
                request_id=f"eval-{arm}-{abs(hash(question)) % 10**8}",
                payload={"question": question},
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
    )


def summarise(outcomes: list[Outcome]) -> str:
    by_arm: dict[str, list[Outcome]] = {}
    for o in outcomes:
        by_arm.setdefault(o.arm, []).append(o)

    lines = [
        "",
        f"{'arm':<12}{'answered':>10}{'used sql':>10}{'grounded':>10}{'charts':>9}"
        f"{'p50 ms':>9}{'p95 ms':>9}{'total $':>12}{'attempts':>10}",
        "-" * 91,
    ]
    for arm, rows in by_arm.items():
        n = len(rows)
        lat = sorted(o.latency_ms for o in rows)
        p95 = lat[min(int(len(lat) * 0.95), len(lat) - 1)] if lat else 0
        lines.append(
            f"{arm:<12}"
            f"{sum(o.ok for o in rows):>7}/{n:<2}"
            f"{sum(o.used_sql for o in rows):>7}/{n:<2}"
            f"{sum(o.grounded for o in rows):>7}/{n:<2}"
            f"{sum(o.chart_valid for o in rows):>6}/{n:<2}"
            f"{int(statistics.median(lat)) if lat else 0:>9}"
            f"{p95:>9}"
            f"{float(sum((o.cost_usd for o in rows), Decimal('0'))):>12.6f}"
            f"{sum(len(o.ledger) for o in rows):>10}"
        )

    lines += ["", "FAILURES", "-" * 91]
    failures = [o for o in outcomes if not o.ok]
    lines += [f"  {o.arm:<10} {o.question[:48]:<50} {o.error[:70]}" for o in failures] or ["  none"]

    lines += [
        "",
        "`attempts` counts ai_calls rows, not questions: a fallback or a schema retry",
        "writes more than one, and a number well above the question count is an arm",
        "quietly costing double.",
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

    outcomes: list[Outcome] = []
    for question in questions:
        for arm in args.arms:
            print(f"  {arm:<10} {question[:60]}", flush=True)
            outcomes.append(await run_arm(arm, args.company, question))

    # Grouped by QUESTION so the side-by-side read is blind-ish and actually
    # comparable -- reading one arm end to end anchors you to it.
    dump = [
        {
            "question": q,
            "arms": {
                o.arm: {"ok": o.ok, "answer": o.answer, "error": o.error,
                        "latency_ms": o.latency_ms, "cost_usd": str(o.cost_usd),
                        "tool_calls": o.tool_calls, "chart_valid": o.chart_valid}
                for o in outcomes if o.question == q
            },
        }
        for q in questions
    ]
    args.out.write_text(json.dumps(dump, indent=2))

    print(summarise(outcomes))
    print(f"\nside-by-side answers: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
