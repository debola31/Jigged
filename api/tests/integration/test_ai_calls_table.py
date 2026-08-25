"""ai_calls: the AI spend ledger, asserted from the database's side.

WHAT THIS GUARDS. This table is the only record of what the AI layer cost and
which provider answered. Every property that makes it trustworthy -- append-only,
unreachable by the browser, invisible to the role that runs LLM-generated SQL --
is a fact about grants, policies and triggers, and every one of them fails
SILENTLY. Over-granting raises no error and breaks no page. A missing trigger
looks exactly like a working one until someone runs an UPDATE.

WHY A GUARD FUNCTION AND A TEST THAT BREAKS IT. `ai_call_write_leaks()` returning
no rows only means something if the function can return rows. Its ancestor,
terms_acceptance_write_leaks(), is asserted by a test named for the append-only
triggers that never inspects pg_trigger -- green whether or not they exist. So
this file both asserts the guard is clean AND proves it fires, by violating each
posture inside a rolled-back transaction.

Needs a live local Supabase (see docs/testing/README.md). On a PR it runs against
the Supabase preview branch, which is the real gate for a migration.
"""
from __future__ import annotations

import os
import uuid
from contextlib import contextmanager
from decimal import Decimal

import psycopg2
import pytest

pytestmark = pytest.mark.integration

DB_URL = os.getenv(
    "TEST_SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)


def _connect(dsn: str = DB_URL):
    try:
        return psycopg2.connect(dsn)
    except psycopg2.OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"No local Postgres at {dsn}: {exc}")


@contextmanager
def rolled_back():
    """A transaction that is always discarded.

    Every destructive probe in this file runs in one: violating a grant to prove
    the guard notices it must not leave the database violated for the next test.
    """
    conn = _connect()
    try:
        conn.autocommit = False
        with conn.cursor() as cur:
            yield cur
    finally:
        conn.rollback()
        conn.close()


def _call_row(**over) -> dict:
    row = {
        "feature": "insights",
        "provider": "ollama",
        "model": "qwen3:8b",
        "tokens_in": 700,
        "tokens_out": 120,
        "latency_ms": 1200,
        "est_cost_usd": "0.00000000",
        "request_id": str(uuid.uuid4()),
        "success": True,
    }
    row.update(over)
    return row


# ---------------------------------------------------------------- the ledger


def test_the_backend_can_append_a_call_and_read_it_back(supabase_admin):
    request_id = str(uuid.uuid4())
    supabase_admin.table("ai_calls").insert(
        _call_row(request_id=request_id, provider="deepinfra", model="Qwen/Qwen3-32B",
                  est_cost_usd="0.00027200")
    ).execute()

    got = (
        supabase_admin.table("ai_calls")
        .select("provider, model, tokens_in, est_cost_usd, success, error")
        .eq("request_id", request_id)
        .single()
        .execute()
    ).data
    assert got["provider"] == "deepinfra"
    assert got["success"] is True
    assert got["error"] is None


def test_the_cheapest_possible_call_survives_the_round_trip(supabase_admin):
    """One DeepInfra input token is $0.00000008 -- exactly the resolution of
    numeric(12,8), and rounded away to nothing at the conventional scale 6.

    If this assertion ever needs relaxing, the column's scale is wrong, not the
    test: the cheap rows are the majority, and a ledger whose cheap rows all read
    zero cannot be summed into a figure anyone would put next to an invoice.
    """
    request_id = str(uuid.uuid4())
    supabase_admin.table("ai_calls").insert(
        _call_row(request_id=request_id, tokens_in=1, tokens_out=0,
                  provider="deepinfra", est_cost_usd="0.00000008")
    ).execute()

    got = (
        supabase_admin.table("ai_calls").select("est_cost_usd")
        .eq("request_id", request_id).single().execute()
    ).data
    assert Decimal(str(got["est_cost_usd"])) == Decimal("0.00000008")


def test_every_attempt_of_one_call_shares_a_request_id_without_colliding(supabase_admin):
    """A fallback chain writes one row per ATTEMPT. There is deliberately no
    UNIQUE on request_id: that shared value is the column's whole justification,
    and a UNIQUE would turn the second leg of a fallback into a 23505 at exactly
    the moment the first provider has already failed.
    """
    request_id = str(uuid.uuid4())
    supabase_admin.table("ai_calls").insert([
        _call_row(request_id=request_id, provider="deepinfra", success=False,
                  error="429 rate limited"),
        _call_row(request_id=request_id, provider="anthropic", model="claude-sonnet-4-6",
                  est_cost_usd="0.00450000"),
    ]).execute()

    rows = (
        supabase_admin.table("ai_calls").select("provider, success")
        .eq("request_id", request_id).execute()
    ).data
    assert len(rows) == 2
    assert {r["provider"] for r in rows} == {"deepinfra", "anthropic"}


def test_a_failure_row_must_say_why_it_failed(supabase_admin):
    """A failure that does not name its reason is a swallowed exception in table
    form -- the exact thing the provider layer forbids in Python. Enforced here so
    a future caller that "just logs the failure" cannot log a blank one.
    """
    with pytest.raises(Exception) as exc:
        supabase_admin.table("ai_calls").insert(
            _call_row(success=False, error=None)
        ).execute()
    assert "failure_states_its_reason" in str(exc.value)


def test_a_success_row_may_not_carry_an_error(supabase_admin):
    """The other direction of the same constraint: a success carrying an error
    string is equally a lie about what happened."""
    with pytest.raises(Exception) as exc:
        supabase_admin.table("ai_calls").insert(
            _call_row(success=True, error="something went wrong")
        ).execute()
    assert "failure_states_its_reason" in str(exc.value)


def test_a_provider_name_cannot_arrive_in_mixed_case(supabase_admin):
    """'anthropic' and 'Anthropic' are two rows in every GROUP BY, and a cost
    report that silently splits one provider in half is worse than no report.
    A shape check rather than an enum, so adding a provider stays a Python change.
    """
    with pytest.raises(Exception) as exc:
        supabase_admin.table("ai_calls").insert(_call_row(provider="Anthropic")).execute()
    assert "provider_lowercase" in str(exc.value)


# ------------------------------------------------------------- append-only


def test_the_ledger_is_append_only_even_for_service_role(supabase_admin):
    """service_role is the most privileged role reachable over PostgREST and every
    backend path runs as it. It cannot edit or erase a call record.

    TWO INDEPENDENT LAYERS REFUSE THIS and the assertion deliberately does not care
    which fires. Over the API the GRANT bites first -- service_role holds SELECT and
    INSERT only. The trigger sits behind it for anything running as the table owner,
    where grants do not apply; that path is exercised separately below, because no
    API caller can reach it. Pinning one mechanism would make this fail the moment
    the other one saves us.
    """
    request_id = str(uuid.uuid4())
    supabase_admin.table("ai_calls").insert(_call_row(request_id=request_id)).execute()
    before = (
        supabase_admin.table("ai_calls").select("model, est_cost_usd")
        .eq("request_id", request_id).single().execute()
    ).data

    for op in ("update", "delete"):
        with pytest.raises(Exception) as exc:
            q = supabase_admin.table("ai_calls")
            (
                q.update({"model": "tampered"}).eq("request_id", request_id).execute()
                if op == "update"
                else q.delete().eq("request_id", request_id).execute()
            )
        refusal = str(exc.value).lower()
        assert "append-only" in refusal or "42501" in refusal or "permission denied" in refusal, (
            f"{op} was not refused at all: {exc.value}"
        )

    after = (
        supabase_admin.table("ai_calls").select("model, est_cost_usd")
        .eq("request_id", request_id).single().execute()
    ).data
    assert after == before, "the ledger row was mutated despite the refusals"


@pytest.mark.parametrize("statement", [
    "UPDATE public.ai_calls SET model = 'tampered'",
    "DELETE FROM public.ai_calls",
    "TRUNCATE public.ai_calls",
])
def test_the_triggers_refuse_the_table_owner_too(statement):
    """The grants refuse an API caller, so the triggers above are never reached from
    there -- and a backstop nobody can observe is a backstop nobody maintains. As the
    OWNER, grants do not apply and only the triggers stand.

    TRUNCATE is the one that matters most and needs its own statement-level trigger:
    it bypasses RLS and does NOT fire row-level triggers, so it is the single
    statement that would otherwise defeat every other control in the migration.
    """
    with rolled_back() as cur:
        cur.execute(
            "INSERT INTO public.ai_calls (feature, provider, model, tokens_in, tokens_out,"
            " latency_ms, est_cost_usd, request_id, success)"
            " VALUES ('insights','ollama','qwen3:8b',1,1,10,0,gen_random_uuid(),true)"
        )
        with pytest.raises(psycopg2.errors.RestrictViolation):
            cur.execute(statement)


# ----------------------------------------------------------------- the guard


def test_nothing_can_reach_the_spend_ledger_that_should_not(supabase_admin):
    rows = supabase_admin.rpc("ai_call_write_leaks", {}).execute().data
    assert rows == [], f"ai_calls is reachable: {rows}"


@pytest.mark.parametrize("violation, expected_kind", [
    ("GRANT SELECT ON public.ai_calls TO jigged_ai_readonly", "client_grant"),
    ("GRANT SELECT ON public.ai_calls TO authenticated", "client_grant"),
    ("GRANT UPDATE ON public.ai_calls TO service_role", "service_role_overgrant"),
    ("DROP TRIGGER ai_calls_no_truncate ON public.ai_calls", "missing_trigger"),
    ("ALTER TABLE public.ai_calls DISABLE ROW LEVEL SECURITY", "rls_disabled"),
    ("CREATE POLICY ai_readonly_select ON public.ai_calls FOR SELECT"
     " TO jigged_ai_readonly USING (true)", "permissive_policy"),
])
def test_the_guard_actually_fires_when_the_posture_is_broken(violation, expected_kind):
    """A guard that returns no rows is only reassuring if it CAN return rows.

    The last case is the live hazard, not a hypothetical: docs/modules/ai-insights.md
    told people to add exactly that policy when widening AI scope, which on this table
    would put the platform's own cost data inside LLM-generated SQL. The doc is fixed;
    this is the thing that stays fixed.
    """
    with rolled_back() as cur:
        cur.execute(violation)
        cur.execute("SELECT leak_kind FROM public.ai_call_write_leaks()")
        kinds = {r[0] for r in cur.fetchall()}
        assert expected_kind in kinds, (
            f"{violation!r} went unnoticed by ai_call_write_leaks(); saw {kinds or 'nothing'}"
        )


def test_the_browser_cannot_read_the_spend_ledger(seeded_user_a):
    """No read path for the browser, now or planned. An AI-spend admin screen, if one
    is ever built, is a service-role endpoint like every other /admin surface."""
    try:
        res = seeded_user_a["client"].table("ai_calls").select("id").limit(1).execute()
        assert res.data == [], "authenticated could read the AI spend ledger"
    except Exception as exc:
        assert "42501" in str(exc).lower() or "permission" in str(exc).lower(), str(exc)


def test_the_browser_cannot_forge_a_call_record(seeded_user_a):
    with pytest.raises(Exception) as exc:
        seeded_user_a["client"].table("ai_calls").insert(_call_row()).execute()
    assert "42501" in str(exc.value).lower() or "permission" in str(exc.value).lower()
