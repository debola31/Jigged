"""
terms_acceptances: the clickwrap record, asserted from the database's side.

The whole evidentiary value of this table is that the party it is evidence
against could not have produced it. That is a claim about grants and policies,
and over-granting is completely silent -- it raises no error and breaks no page.
The only way this class of defect is ever caught is by asserting it, which is
what this file does.

Needs a live local Supabase (see docs/testing/README.md). On a PR it runs
against the Supabase preview branch, which is the real gate for a migration
authored in a worktree.
"""

import uuid

import pytest

pytestmark = pytest.mark.integration

SHA = "a" * 64


def _row(user_id: str, **over) -> dict:
    row = {
        "user_id": user_id,
        "document_type": "tos",
        "version": 1,
        "document_sha256": SHA,
        "accepted_via": "invite_accept",
    }
    row.update(over)
    return row


@pytest.fixture
def acceptance(supabase_admin, seeded_user_a):
    """One acceptance row for user A, written the only way anything may write:
    as service_role."""
    res = (
        supabase_admin.table("terms_acceptances")
        .insert(_row(seeded_user_a["user_id"], ip_address="203.0.113.7", ip_source="x-real-ip"))
        .execute()
    )
    row = res.data[0]
    yield row
    # No DELETE grant and an append-only trigger, so this cannot be cleaned up
    # through the API -- which is the property under test. Rows are scoped to a
    # session-scoped user that _teardown_seeded_user removes, and the FK is
    # ON DELETE CASCADE, so they go with it.


def test_service_role_inserts_and_the_owner_reads_it_back(acceptance, seeded_user_a):
    got = (
        seeded_user_a["client"]
        .table("terms_acceptances")
        .select("id, document_type, version, document_sha256")
        .eq("id", acceptance["id"])
        .execute()
    )
    assert len(got.data) == 1, "a user cannot see their own acceptance"
    assert got.data[0]["document_sha256"] == SHA
    assert got.data[0]["version"] == 1


def test_the_browser_cannot_write_its_own_acceptance(seeded_user_a):
    """
    The point of the whole table. A row the browser can INSERT is a row the
    browser can forge -- a fabricated acceptance, or a real one with a null IP
    and a version the user never saw.
    """
    try:
        res = (
            seeded_user_a["client"]
            .table("terms_acceptances")
            .insert(_row(seeded_user_a["user_id"]))
            .execute()
        )
        assert res.data == [], "authenticated was able to insert an acceptance"
    except Exception as exc:
        assert "42501" in str(exc).lower() or "permission" in str(exc).lower(), str(exc)


def test_the_record_cannot_be_edited_or_erased_by_the_browser(acceptance, seeded_user_a):
    for op in ("update", "delete"):
        try:
            q = seeded_user_a["client"].table("terms_acceptances")
            res = (
                q.update({"version": 99}).eq("id", acceptance["id"]).execute()
                if op == "update"
                else q.delete().eq("id", acceptance["id"]).execute()
            )
            assert res.data == [], f"authenticated was able to {op} an acceptance"
        except Exception as exc:
            assert "42501" in str(exc).lower() or "permission" in str(exc).lower(), str(exc)


def test_the_record_is_append_only_even_for_service_role(supabase_admin, acceptance):
    """
    Grants stop the browser; they do not stop service_role, which every backend
    path runs as. Without the trigger, "append-only" would be a convention
    rather than a property.
    """
    for op in ("update", "delete"):
        with pytest.raises(Exception) as exc:
            q = supabase_admin.table("terms_acceptances")
            (
                q.update({"version": 99}).eq("id", acceptance["id"]).execute()
                if op == "update"
                else q.delete().eq("id", acceptance["id"]).execute()
            )
        assert "append-only" in str(exc.value).lower(), f"{op} was not refused: {exc.value}"


def test_one_user_cannot_read_another_users_acceptance(acceptance, seeded_user_b):
    """
    The SELECT policy keys on user_id = auth.uid(), NOT on company membership --
    the only non-company-scoped policy in this schema. A colleague, even an
    admin of the same shop, has no business reading someone's IP address and
    browser string.
    """
    got = (
        seeded_user_b["client"]
        .table("terms_acceptances")
        .select("id")
        .eq("id", acceptance["id"])
        .execute()
    )
    assert got.data == [], "a different user could read this acceptance"


def test_a_user_sees_their_own_row_even_before_they_join_a_company(
    supabase_admin, seeded_user_a
):
    """company_id is nullable and no policy reads it: a self-serve signup has no
    company yet, and its acceptance must still be visible to the person."""
    supabase_admin.table("terms_acceptances").insert(
        _row(seeded_user_a["user_id"], document_type="privacy", company_id=None)
    ).execute()

    got = (
        seeded_user_a["client"]
        .table("terms_acceptances")
        .select("id, company_id")
        .eq("document_type", "privacy")
        .execute()
    )
    assert got.data, "a company-less acceptance was invisible to its own user"
    assert got.data[0]["company_id"] is None


def test_a_version_bump_leaves_the_old_row_and_adds_a_new_one(
    supabase_admin, acceptance, seeded_user_a
):
    """There is deliberately no UNIQUE (user_id, document_type, version): every
    tick of the box is a separate act of assent with its own time and address."""
    supabase_admin.table("terms_acceptances").insert(
        _row(seeded_user_a["user_id"], version=2, document_sha256="b" * 64)
    ).execute()

    rows = (
        seeded_user_a["client"]
        .table("terms_acceptances")
        .select("version, document_sha256")
        .eq("document_type", "tos")
        .order("version")
        .execute()
    ).data
    versions = [r["version"] for r in rows]
    assert 1 in versions and 2 in versions, f"expected both versions, got {versions}"
    v1 = next(r for r in rows if r["version"] == 1)
    assert v1["document_sha256"] == SHA, "the superseded row was mutated"


def test_the_acceptance_log_is_not_granted_to_the_ai_sql_role(supabase_admin):
    """
    baseline.sql sets ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES TO
    jigged_ai_readonly, so every new public table is granted to the AI SQL role
    on creation. This test exists because reading the migration will not reveal
    that grant -- only the database will.
    """
    leaks = supabase_admin.rpc("terms_acceptance_write_leaks", {}).execute().data
    assert leaks == [], f"terms_acceptances is reachable: {leaks}"


def test_the_write_gate_guard_still_passes_with_the_new_table(supabase_admin):
    missing = supabase_admin.rpc("tenant_tables_missing_write_gate", {}).execute().data
    assert missing == [], f"tenant tables left un-gated: {missing}"


def test_a_forged_sha256_shape_is_refused(supabase_admin, seeded_user_a):
    """Lowercase hex is load-bearing: digest('hex') is lowercase on both sides,
    so a row can always be matched against public/legal/manifest.json."""
    for bad in ("A" * 64, "z" * 64, "abc"):
        with pytest.raises(Exception):
            supabase_admin.table("terms_acceptances").insert(
                _row(seeded_user_a["user_id"], document_sha256=bad)
            ).execute()


def test_an_unknown_document_type_or_surface_is_refused(supabase_admin, seeded_user_a):
    with pytest.raises(Exception):
        supabase_admin.table("terms_acceptances").insert(
            _row(seeded_user_a["user_id"], document_type="cookies")
        ).execute()
    with pytest.raises(Exception):
        supabase_admin.table("terms_acceptances").insert(
            _row(seeded_user_a["user_id"], accepted_via="carrier_pigeon")
        ).execute()
