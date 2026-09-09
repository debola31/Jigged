"""public.is_quote_open() and the TypeScript isQuoteOpen() answer the same question.

WHY THIS FILE EXISTS, and it is is_job_late() all over again. "Open quote" had four
implementations -- a PostgREST clause pair in applyQuoteStatusFilter, another in the
dashboard tile's getOpenQuotes, whatever the model wrote that turn, and a money
metric in semantics.md that used a different filter set again -- and nothing compared
any of them.

Asked "how many open quotes do we have?" on 2026-09-09 the assistant answered 16, then
6, then 11 in another thread. ai_chat_messages.tool_trace holds all three queries, so
none of it was invented: 16 counted `status = 'active'` alone (a won quote keeps that
status forever), 11 counted rows of a join to quote_line_items, and 6 used the full
filter set. The dashboard tile said 6 as well -- by a THIRD route, with no expiry test
-- so the two agreed by coincidence on data where the readings happen to coincide.

The SQL function is now the definition. The TypeScript predicate cannot be: the quotes
list and the tile filter through PostgREST, where the rule has to be a query-builder
chain, and a per-row badge has no round trip to spend. So one mirror remains, and this
is what pins it.

BOTH SIDES READ THE SAME FILE. __tests__/fixtures/openQuoteCases.json is the single
case list; __tests__/types/quote.test.ts runs it against isQuoteOpen() and this runs
it against the function. Neither can be edited into agreement on its own.

Run:
    cd api && pytest -m integration tests/integration/test_open_quote_parity.py
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
    / "openQuoteCases.json"
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
        f"{_FIXTURE} is missing. Both this test and __tests__/types/quote.test.ts "
        "read it; do not inline a copy of the cases into either one."
    )
    data = _load()
    assert data["cases"], "no golden cases"
    assert date.fromisoformat(data["today"])


def test_is_quote_open_matches_every_golden_case(supabase_admin: Client):
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
            "is_quote_open",
            {
                "p_status": case["status"],
                "p_converted_at": case["converted_at"],
                "p_expiration_date": case["expiration_date"],
                "p_today": today,
            },
        ).execute()
        if got.data is not case["open"]:
            wrong.append(
                f"{case['name']}: SQL said {got.data}, fixture says {case['open']}"
            )

    assert not wrong, (
        "public.is_quote_open() disagrees with the golden cases that "
        "types/quote.ts is also held to:\n  " + "\n  ".join(wrong)
    )


def test_the_boundary_is_inclusive_so_a_quote_expiring_today_is_still_open(
    supabase_admin: Client,
):
    """>= and > are one character apart and a whole day of pipeline apart.

    Pinned separately from the case list because it is the assertion most likely to
    be lost by someone tidying the fixture, and because the TypeScript mirror got
    this wrong for months: isExpirationDatePast parsed 'YYYY-MM-DD' as UTC midnight,
    which is the previous calendar day everywhere west of Greenwich, so a quote
    expiring today read as lapsed for every shop in the Americas.
    """
    args = {"p_status": "active", "p_converted_at": None, "p_today": "2026-09-09"}
    today = supabase_admin.rpc(
        "is_quote_open", {**args, "p_expiration_date": "2026-09-09"}
    ).execute()
    yesterday = supabase_admin.rpc(
        "is_quote_open", {**args, "p_expiration_date": "2026-09-08"}
    ).execute()

    assert today.data is True, (
        "a quote expiring TODAY is still open -- the shop has until midnight to win it"
    )
    assert yesterday.data is False, "a quote that lapsed yesterday is not in play"


def test_a_won_quote_is_closed_though_its_status_still_reads_active(
    supabase_admin: Client,
):
    """The 16-vs-6 case, pinned on its own.

    Winning a quote stamps converted_at and leaves `status` alone, so every filter
    that keys on status alone counts work already won as work still to win.
    """
    got = supabase_admin.rpc(
        "is_quote_open",
        {
            "p_status": "active",
            "p_converted_at": "2026-09-01T12:00:00+00:00",
            "p_expiration_date": "2026-10-01",
            "p_today": "2026-09-09",
        },
    ).execute()
    assert got.data is False


def test_a_null_expiration_date_is_open_not_null(supabase_admin: Client):
    """Undated, so it never lapses -- and TRUE, not NULL.

    This is why the function is not STRICT. A NULL return would make both
    `WHERE is_quote_open(...)` and `WHERE NOT is_quote_open(...)` drop the row, so a
    shop that does not date its quotes would have them vanish from every count.
    """
    got = supabase_admin.rpc(
        "is_quote_open",
        {
            "p_status": "active",
            "p_converted_at": None,
            "p_expiration_date": None,
            "p_today": "2026-09-09",
        },
    ).execute()
    assert got.data is True
