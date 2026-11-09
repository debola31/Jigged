"""
mcp_tool_calls: the AI-assistant call log, asserted from the database's side.

The log is only worth anything if an assistant's own token can neither read what
it did nor write a row of what it did not do. Both are claims about grants and
policies, and an over-grant is silent, so they are asserted here.

Needs a live local Supabase (see docs/testing/README.md). On a PR it runs
against the Supabase preview branch.
"""

import pytest

pytestmark = pytest.mark.integration


def _row(user_id: str, company_id: str | None, **over) -> dict:
    row = {
        "company_id": company_id,
        "user_id": user_id,
        "client_id": "test-client",
        "client_name": "Claude",
        "tool": "list_my_companies",
        "is_write": False,
        "outcome": "ok",
        "duration_ms": 12,
    }
    row.update(over)
    return row


def _denied(exc: Exception) -> bool:
    text = str(exc).lower()
    return "42501" in text or "permission" in text


def test_service_role_logs_a_call_in_a_company_and_one_in_none(supabase_admin, seeded_user_a):
    user_id, company_id = seeded_user_a["user_id"], seeded_user_a["company_id"]
    res = supabase_admin.table("mcp_tool_calls").insert(
        [_row(user_id, company_id, tool="list_jobs"), _row(user_id, None)]
    ).execute()
    assert len(res.data) == 2
    # Rows go with the user (ON DELETE CASCADE) when the session fixture tears down.


def test_a_users_own_token_cannot_read_the_log(supabase_admin, seeded_user_a):
    user_id, company_id = seeded_user_a["user_id"], seeded_user_a["company_id"]
    supabase_admin.table("mcp_tool_calls").insert(_row(user_id, company_id)).execute()
    try:
        res = seeded_user_a["client"].table("mcp_tool_calls").select("id").execute()
        assert res.data == [], "authenticated can read the assistant call log"
    except Exception as exc:
        assert _denied(exc), str(exc)


def test_a_users_own_token_cannot_forge_a_row(seeded_user_a):
    try:
        res = (
            seeded_user_a["client"]
            .table("mcp_tool_calls")
            .insert(_row(seeded_user_a["user_id"], seeded_user_a["company_id"]))
            .execute()
        )
        assert res.data == [], "authenticated was able to write the assistant call log"
    except Exception as exc:
        assert _denied(exc), str(exc)


def test_the_log_is_append_only_for_service_role(supabase_admin, seeded_user_a):
    row = (
        supabase_admin.table("mcp_tool_calls")
        .insert(_row(seeded_user_a["user_id"], seeded_user_a["company_id"]))
        .execute()
    ).data[0]
    for op in ("update", "delete"):
        with pytest.raises(Exception) as exc:
            q = supabase_admin.table("mcp_tool_calls")
            (
                q.update({"outcome": "error"}).eq("id", row["id"]).execute()
                if op == "update"
                else q.delete().eq("id", row["id"]).execute()
            )
        assert _denied(exc.value), str(exc.value)


@pytest.mark.parametrize(
    "bad",
    [
        {"outcome": "maybe"},
        {"tool": "List Jobs"},
        {"client_name": ""},
        {"duration_ms": -1},
    ],
)
def test_the_table_refuses_malformed_rows(supabase_admin, seeded_user_a, bad):
    with pytest.raises(Exception):
        supabase_admin.table("mcp_tool_calls").insert(
            _row(seeded_user_a["user_id"], seeded_user_a["company_id"], **bad)
        ).execute()


def test_both_tenant_guards_have_decided_about_it(supabase_admin):
    for guard in ("tenant_tables_missing_write_gate", "tenant_tables_missing_ai_decision"):
        names = [r["table_name"] for r in supabase_admin.rpc(guard, {}).execute().data]
        assert "mcp_tool_calls" not in names, f"{guard} still lists mcp_tool_calls"
