"""Routing probe: does the local model call compose_report only when asked for a document?

    cd api && LLM_CHAIN_EVAL_OLLAMA=ollama:qwen3:32b conda run -n jigged python -m evals.route_probe

WHY THIS EXISTS. The composer has one box and no Ask/Report picker (2026-09-08),
so whether an answer is prose, a chart or a one-page PDF is the model's call: it
answers a request for a document by calling compose_report, and the chat loop
hands the brief it wrote to the report path (services/ai_features/insights.py).
Nothing in CI can measure that judgement -- an over-trigger costs a shop owner a
multi-minute report job for a question they wanted in a sentence, an under-trigger
a rephrase -- so this runs the REAL handler against the seeded local stack with the
real model, with report.run stubbed so a report costs one chat call rather than
minutes, and prints the route each case took.

Expected routes are stated before the run, the way insights_ab.py states its flip
condition: the eval's own questions and the near-misses must stay `chat`; the
document asks must become `report`; `either` is a judgement call only observed.
The first run (2026-09-08, qwen3:32b on the 48 GB M4 Max): 24 of 24 as intended.
Twenty-four cases is a smoke test, not a distribution -- `report generated`
against `ai job enqueued` in production is the number to keep watching.

Output: one line per case, and route_probe.json in the working directory.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("LLM_CHAIN_EVAL_OLLAMA", "ollama:qwen3:32b")

import evals.insights_ab as ab  # noqa: E402  (loads .env.local, the way the harness does)
from services.ai_features import insights, report  # noqa: E402
from services.ai_features.base import JobContext  # noqa: E402
from services.llm.registry import chain_for  # noqa: E402

# Vanguard Precision Works, the company supabase/seed.sql creates.
COMPANY = "22222222-2222-2222-2222-222222222222"
OUT = Path("route_probe.json")

# (question, expected route, conversation so far or None)
CASES: list[tuple[str, str, list[dict] | None]] = [
    *[(q, "chat", None) for q in ab.DEFAULT_QUESTIONS],
    # Document asks, plain and casual.
    ("One-page report on this quarter", "report", None),
    ("PDF of the backlog and late jobs", "report", None),
    ("Can you put together a one-pager on how our top customer is doing this year?", "report", None),
    ("I need something printable for the Monday meeting covering late jobs and open quotes.", "report", None),
    ("Give me an executive summary of last month as a PDF", "report", None),
    ("Make a report of revenue by customer for the last 90 days", "report", None),
    # Near misses: a summary in a sentence is not a page; a question about a report is not a request for one.
    ("Give me an overview of late jobs", "chat", None),
    ("What did the last report say?", "chat", None),
    ("Summarize how the shop did this month", "either", None),
    # In a conversation: "that" must resolve into a brief that stands alone.
    ("Put that in a PDF", "report", [
        {"seq": 1, "role": "user", "content": "Who is my top customer by revenue?"},
        {"seq": 2, "role": "assistant",
         "content": "Your top customer by revenue is Ironclad Fabrication at $41,200 this year, followed by "
                    "Cascade Marine at $28,900 and Summit Aerospace at $19,400."},
    ]),
    ("And July?", "chat", [
        {"seq": 1, "role": "user", "content": "How many jobs shipped in June?"},
        {"seq": 2, "role": "assistant", "content": "12 jobs shipped in June."},
    ]),
]


async def _fake_report_run(ctx, *, request=None):
    """The report path, stubbed: the route and the brief are the measurement, not the page."""
    return {"kind": "report", "brief": request, "report": {"title": "stub"}, "dropped": [], "tool_calls": []}


async def _capture(row):
    """The ledger is not the point here."""
    return None


async def main() -> int:
    dsn, source = ab.resolve_dsn("local", ab._EXPORTED_AI_DSN, os.environ)
    if not dsn:
        print("AI_READONLY_DATABASE_URL is not set, so there is no local database to ask.")
        return 2
    os.environ["AI_READONLY_DATABASE_URL"] = dsn
    print(f"db: {ab.describe_dsn(dsn)} ({source}); chain: {os.environ['LLM_CHAIN_EVAL_OLLAMA']}", flush=True)
    chain = chain_for("eval_ollama")
    today = dt.date.today().isoformat()

    rows: list[dict] = []
    for n, (question, expected, history) in enumerate(CASES, 1):
        payload: dict = {"question": question, "today": today}
        if history:
            payload["history"] = history
        started = time.perf_counter()
        try:
            with patch.object(report, "run", _fake_report_run):
                result = await insights.run(JobContext(
                    feature="insights", company_id=COMPANY, request_id=f"probe-{n}",
                    payload=payload, chain=chain, audit_writer=_capture,
                ))
            route = "report" if result.get("kind") == "report" else "chat"
            detail = (result.get("brief") if route == "report"
                      else (result.get("answer") or "").replace("\n", " ")[:160])
        except Exception as exc:  # noqa: BLE001 - a failure is a row, not the end of the run
            route, detail = "error", f"{type(exc).__name__}: {str(exc)[:160]}"
        latency = time.perf_counter() - started
        if expected in (route, "either"):
            verdict = "ok"
        else:
            verdict = {"report": "OVER", "chat": "UNDER"}.get(route, "ERR")
        rows.append({"question": question, "expected": expected, "route": route, "verdict": verdict,
                     "latency_s": round(latency, 1), "detail": detail, "in_conversation": bool(history)})
        print(f"[{n:02d}] {verdict:5s} {route:6s} {latency:6.1f}s  {question}\n      -> {detail}", flush=True)
        OUT.write_text(json.dumps(rows, indent=2))

    over = sum(1 for r in rows if r["verdict"] == "OVER")
    under = sum(1 for r in rows if r["verdict"] == "UNDER")
    errors = sum(1 for r in rows if r["route"] == "error")
    print(f"\nover-triggered (question -> report): {over}; under-triggered (document -> prose): {under}; "
          f"errors: {errors}; total {len(rows)}", flush=True)
    return 1 if over or under or errors else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
