"""Who can EXECUTE the SECURITY DEFINER functions in `public` — issue #640.

THE BUG THESE GUARD AGAINST. Two things granted EXECUTE on every newly created
function: Postgres' own `PUBLIC` default, and this schema's
`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon, authenticated`.
`REVOKE EXECUTE ... FROM PUBLIC` removes only the first, so the idiom used by
eight migrations — and the comments above them promising "service-role only" —
did not close anything.

WHY THIS NEEDS A TEST AT ALL, rather than careful review: over-granting is
completely silent. It raises no error, breaks no page, and shows no symptom of
any kind. `part_playbook_notes` sat anon-executable for three days after a
DROP FUNCTION destroyed its ACL and nothing anywhere noticed. The only way this
class of defect is ever caught is by asserting it.

Two of these tests are behavioural rather than privilege assertions, and they are
the ones that make the revokes SAFE rather than merely tidy: they prove that a
trigger function and a SECURITY-DEFINER-called helper keep working once the
browser can no longer execute them. If either assumption were wrong, the migration
would have broken note capture and inventory writes in production.

Requires a local Supabase with all migrations applied. Skipped without it.
"""
from __future__ import annotations

import os

import pytest
from supabase import create_client

pytestmark = pytest.mark.integration


def _publishable_key() -> str:
    return os.environ.get("TEST_SUPABASE_PUBLISHABLE_KEY") or os.environ["TEST_SUPABASE_ANON_KEY"]


@pytest.fixture
def shop(supabase_admin):
    """A writable company with one signed-in operator, and a job to hang a note on."""
    admin = supabase_admin
    company_id = (
        admin.table("companies")
        .insert({"name": f"fx-{os.urandom(3).hex()}"})
        .execute()
        .data[0]["id"]
    )
    # Unblock the billing write gate so it cannot mask a result we are trying to assert.
    #
    # This used to set `is_demo = TRUE`, which company_can_write() also short-circuits on and
    # which needs no extra row. That was a convenience with no connection to what these tests
    # are about, and it stopped being free: log_operator_event now writes nothing for a demo
    # company, deliberately, so that demo-mode activity cannot enter the capture funnel
    # every adoption ratio is measured against. The reachability test below then failed for a
    # reason that had nothing to do with EXECUTE grants — exactly the kind of false signal a
    # guard test must not produce.
    #
    # `billing_exempt` is the honest lever: it is the other branch of the same function, it
    # says what the fixture actually wants, and it carries no other semantics.
    admin.table("company_billing").insert(
        {"company_id": company_id, "billing_exempt": True}
    ).execute()

    email = f"fx-{os.urandom(4).hex()}@test.jigged.local"
    password = "test-password-function-grants"
    created = admin.auth.admin.create_user(
        {"email": email, "password": password, "email_confirm": True}
    )
    access_id = (
        admin.table("user_company_access")
        .insert(
            {
                "user_id": created.user.id,
                "company_id": company_id,
                "role": "operator",
                "name": "Fx",
            }
        )
        .execute()
        .data[0]["id"]
    )
    client = create_client(os.environ["TEST_SUPABASE_URL"], _publishable_key())
    client.auth.sign_in_with_password({"email": email, "password": password})

    job_id = (
        admin.table("jobs")
        .insert(
            {
                "company_id": company_id,
                "job_number": f"J-FX-{os.urandom(2).hex()}",
                "production_status": "not_started",
                "fulfillment_status": "unshipped",
            }
        )
        .execute()
        .data[0]["id"]
    )

    yield {
        "admin": admin,
        "client": client,
        "company_id": company_id,
        "access_id": access_id,
        "job_id": job_id,
        "user_id": created.user.id,
    }

    for table in ("notes", "jobs"):
        try:
            admin.table(table).delete().eq("company_id", company_id).execute()
        except Exception:
            pass
    admin.table("companies").delete().eq("id", company_id).execute()
    try:
        admin.auth.admin.delete_user(created.user.id)
    except Exception:
        pass


def test_no_security_definer_function_is_browser_executable_off_allowlist(supabase_admin):
    """The whole point of #640, and the durable half of the fix.

    Every SECURITY DEFINER function a browser role can execute must be on the
    reviewed allowlist inside function_execute_leaks(). A new one arriving
    un-revoked fails here rather than shipping silently — which is exactly how the
    original eight got in.
    """
    leaks = supabase_admin.rpc("function_execute_leaks", {}).execute().data
    assert leaks == [], f"SECURITY DEFINER functions reachable by a browser role: {leaks}"


def test_the_probe_the_notes_design_forbids_is_finally_closed(shop):
    """viewer_excluded_from_metrics is the function this issue was found through.

    Its comment has claimed since 20260728040701 that it is not granted to
    authenticated, because a per-member "is this account excluded from metrics"
    probe is the shape of thing the note_views privacy design refuses. The claim
    was false for three months. Assert the specific function, not just the
    aggregate above, so the reason survives even if the allowlist is refactored.
    """
    with pytest.raises(Exception) as exc:
        shop["client"].rpc(
            "viewer_excluded_from_metrics", {"p_access_id": shop["access_id"]}
        ).execute()
    assert "permission denied" in str(exc.value).lower() or "42501" in str(exc.value)


@pytest.mark.parametrize(
    "fn,args",
    [
        ("seed_demo_data", {"p_company_id": "00000000-0000-0000-0000-000000000000",
                            "p_user_id": "00000000-0000-0000-0000-000000000000",
                            "p_template_name": "x"}),
        ("inv_get_or_create_unassigned", {"p_company_id": "00000000-0000-0000-0000-000000000000"}),
        ("inv_location_path_label", {"p_location_id": "00000000-0000-0000-0000-000000000000"}),
    ],
)
def test_internal_helpers_are_not_callable_from_the_browser(shop, fn, args):
    """These are reachable only through SECURITY DEFINER parents, which run as the
    function owner — so the browser never needed EXECUTE on them. seed_demo_data in
    particular writes a whole company's worth of rows."""
    with pytest.raises(Exception):
        shop["client"].rpc(fn, args).execute()


# ── the behavioural half: the revokes must not have broken anything ──────────


def test_a_trigger_function_still_fires_after_its_execute_was_revoked(shop):
    """ASSUMPTION A, tested rather than asserted.

    Inserting a note fires notes_validate_subject (BEFORE INSERT), whose EXECUTE
    the browser no longer holds. Postgres checks permission when a trigger is
    CREATED, not when it fires — but that is exactly the kind of belief that should
    not be load-bearing without a test, because if it were wrong the symptom is
    "operators cannot write notes at all".
    """
    row = (
        shop["client"]
        .table("notes")
        .insert(
            {
                "company_id": shop["company_id"],
                "subject_kind": "job",
                "job_id": shop["job_id"],
                "author_id": shop["access_id"],
                "body": "written while the trigger function is un-executable",
                "note_type": "user",
            }
        )
        .execute()
        .data
    )
    assert len(row) == 1


def test_a_definer_parent_still_calls_its_revoked_callee(shop):
    """ASSUMPTION B, tested rather than asserted.

    log_note_views (granted, SECURITY DEFINER) calls viewer_excluded_from_metrics
    (now revoked) in its body. The parent runs as the owner, so the caller's lost
    privilege is irrelevant. If that were wrong, view logging would throw on every
    note read — and the counters would silently stop moving.
    """
    admin = shop["admin"]
    note_id = (
        admin.table("notes")
        .insert(
            {
                "company_id": shop["company_id"],
                "subject_kind": "job",
                "job_id": shop["job_id"],
                # Authored by nobody, so the caller is not the author and the view
                # actually counts.
                "author_id": None,
                "body": "read me",
                "note_type": "user",
            }
        )
        .execute()
        .data[0]["id"]
    )

    shop["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_id"]}
    ).execute()

    counts = (
        admin.table("notes")
        .select("viewer_count")
        .eq("id", note_id)
        .single()
        .execute()
        .data
    )
    assert counts["viewer_count"] == 1


def test_the_functions_the_app_actually_calls_are_still_reachable(shop):
    """The other half of safety: a revoke that went too far would break a feature.

    Spot-checks one granted SECURITY DEFINER RPC end to end. The aggregate
    allowlist test above says what is REACHABLE; this says something still WORKS.
    """
    shop["client"].rpc(
        "log_operator_event",
        {"p_company_id": shop["company_id"], "p_kind": "app_opened", "p_context": {}},
    ).execute()

    # Written through a SECURITY DEFINER function into a table with no client read
    # path, so it is verified with the service role.
    events = (
        shop["admin"]
        .table("operator_events")
        .select("kind")
        .eq("company_id", shop["company_id"])
        .execute()
        .data
    )
    assert any(e["kind"] == "app_opened" for e in events)
