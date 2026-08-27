"""public.is_job_late() and the TypeScript isJobOverdue() answer the same question.

WHY THIS FILE EXISTS. "Late" had three implementations -- an inline branch in
search_jobs_by_identifier, a PostgREST clause list in applyOverdueJobsFilter, and a
predicate in types/job.ts -- plus a fourth statement of it in prose in semantics.md,
and nothing compared any of them. Two disagreed about whether a finished-but-unshipped
job is late, which is how the chat reported 7 overdue where the dashboard showed 6.

The SQL function is now the definition, and the two SQL callers are the function. The
TypeScript predicate cannot be: a per-row badge has no database round trip to spend,
and a PostgREST computed column cannot take today as an argument. So one mirror
remains, and this is what pins it.

BOTH SIDES READ THE SAME FILE. __tests__/fixtures/lateJobCases.json is the single case
list; __tests__/types/job.test.ts runs it against isJobOverdue() and this runs it
against the function. Neither can be edited into agreement on its own.

Run:
    cd api && pytest -m integration tests/integration/test_late_job_parity.py
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest
from supabase import Client

pytestmark = pytest.mark.integration

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "__tests__"
    / "fixtures"
    / "lateJobCases.json"
)


def _load() -> dict:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def test_the_fixture_is_where_both_sides_look():
    """A path check, because the failure mode is silent.

    If this file moved, the TypeScript suite would keep passing against it and this
    one would error -- but a future edit could equally 'fix' the error by inlining a
    copy of the cases here, which is the drift the whole file exists to prevent.
    """
    assert _FIXTURE.is_file(), (
        f"{_FIXTURE} is missing. Both this test and __tests__/types/job.test.ts read "
        "it; do not inline a copy of the cases into either one."
    )
    data = _load()
    assert data["cases"], "no golden cases"
    assert date.fromisoformat(data["today"])


def test_is_job_late_matches_every_golden_case(supabase_admin: Client):
    """Each case, straight through the SQL function.

    Called with literal arguments rather than against seeded rows on purpose: the
    question here is what the DEFINITION says, not what today's seed happens to
    contain, and a definition test that depends on fixture data goes green when the
    fixture drifts.
    """
    data = _load()
    today = data["today"]

    wrong: list[str] = []
    for case in data["cases"]:
        got = supabase_admin.rpc(
            "is_job_late",
            {
                "p_due_date": case["due_date"],
                "p_production_status": case["production_status"],
                "p_fulfillment_status": case["fulfillment_status"],
                "p_today": today,
            },
        ).execute()
        if got.data is not case["late"]:
            wrong.append(
                f"{case['name']}: SQL said {got.data}, fixture says {case['late']}"
            )

    assert not wrong, (
        "public.is_job_late() disagrees with the golden cases that "
        "types/job.ts is also held to:\n  " + "\n  ".join(wrong)
    )


def test_the_boundary_is_strict_so_a_job_due_today_is_not_late(supabase_admin: Client):
    """< and <= are one character apart and a whole day of jobs apart.

    Pinned separately from the case list because it is the assertion most likely to
    be lost by someone tidying the fixture: with only a -2/+2 pair (which is what
    the TypeScript suite had before this change) both operators pass.
    """
    args = {
        "p_production_status": "not_started",
        "p_fulfillment_status": "unshipped",
        "p_today": "2026-08-27",
    }
    yesterday = supabase_admin.rpc(
        "is_job_late", {**args, "p_due_date": "2026-08-26"}
    ).execute()
    today = supabase_admin.rpc(
        "is_job_late", {**args, "p_due_date": "2026-08-27"}
    ).execute()

    assert yesterday.data is True, "due yesterday must be late"
    assert today.data is False, (
        "a job due TODAY must not be late -- the shop has until midnight, and the "
        "comparison is strict"
    )


def test_a_null_due_date_is_false_not_null(supabase_admin: Client):
    """Never promised, so never late -- and FALSE, not NULL.

    This is why the function is not STRICT. A NULL return would make
    `WHERE NOT is_job_late(...)` drop the row too, so a job with no due date would
    vanish from both a count of late jobs AND a count of jobs that are not late.
    """
    got = supabase_admin.rpc(
        "is_job_late",
        {
            "p_due_date": None,
            "p_production_status": "not_started",
            "p_fulfillment_status": "unshipped",
            "p_today": "2026-08-27",
        },
    ).execute()
    assert got.data is False, f"expected False for a NULL due_date, got {got.data!r}"
