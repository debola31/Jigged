"""
Regression guard for the operator dispatch RPC ``get_ready_operations_for_station``.

The RPC's ``eligible_jobs`` CTE once filtered ``jobs.status`` — a column that
does not exist (the real column is ``production_status``). Postgres raises
``column j.status does not exist`` when it plans the function, and the app-side
caller (``utils/operatorAccess.ts::getReadyOperationsForStation``) swallowed
that error into an empty list — so operators saw *no* jobs with no visible
error, even though the same work showed in admin views. This is the "May 2026
jobs.status regression" CLAUDE.md warns about: an untyped Supabase call plus a
SQL function body, both of which bypass TypeScript checking.

Because a missing-column reference is a **plan-time** failure, it fires for any
arguments — even UUIDs that match no rows. So this guard needs no data setup: if
the function references a nonexistent column again, ``.execute()`` raises instead
of returning an empty set, and the test fails loudly. That property is exactly
what makes the guard robust — it depends on the schema/function contract, not on
seeded rows (which differ across the local stack, preview branches, and CI).

The positive path (the fixed RPC returns ready operations for a station that has
work) is verified against ``supabase/seed.sql`` — the Vanguard Precision Works
seed yields 5 ready operations across its stations after ``supabase db reset``.

Runs against the local Supabase stack via the service-role ``supabase_admin``
fixture (see ``api/tests/conftest.py`` — it refuses to fall back to prod).
"""
from __future__ import annotations

import uuid

import pytest
from supabase import Client

pytestmark = pytest.mark.integration


def test_get_ready_operations_for_station_plans_against_real_columns(
    supabase_admin: Client,
) -> None:
    """Calling the RPC must not raise a plan-time missing-column error.

    Arbitrary UUIDs match no company/work-center, so the correct answer is zero
    rows. The guarantee under test is that the call *returns* (cleanly) rather
    than raising the ``column ... does not exist`` error the old ``j.status``
    filter caused. An empty list confirms the function planned and executed
    against columns that actually exist.
    """
    resp = supabase_admin.rpc(
        "get_ready_operations_for_station",
        {
            "p_company_id": str(uuid.uuid4()),
            "p_work_center_id": str(uuid.uuid4()),
        },
    ).execute()

    assert resp.data == []
