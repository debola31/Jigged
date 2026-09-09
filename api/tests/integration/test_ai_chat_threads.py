"""ai_chat_threads / ai_chat_messages: who sees a conversation, and how a turn is made.

THE SHAPE UNDER TEST. A thread is PER USER: the browser creates it under RLS with
created_by = auth.uid(), and only that user reads it or its messages -- a shop
admin does not get a colleague's questions, matching saved_insights. Messages are
append-only, and nobody writes them by hand: a SECURITY DEFINER trigger on ai_jobs
materialises the user turn, the assistant turn and any summary when the worker
reports a job succeeded, so jigged_ai_worker keeps its contract of touching one
table. The AI SQL role reads none of it.

Runs the worker half as the real jigged_ai_worker role over libpq (LOGIN from
supabase/seed.sql, local and preview only) and the browser half as user-JWT
clients, so grants, RLS and the trigger are exercised the way production does.

Needs a live local Supabase (see docs/testing/README.md).
"""
from __future__ import annotations

import json
import os
import uuid
from contextlib import contextmanager

import psycopg2
import psycopg2.errors
import pytest

pytestmark = pytest.mark.integration

DB_URL = os.getenv(
    "TEST_SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)
WORKER_URL = DB_URL.replace("postgres:postgres@", "jigged_ai_worker:postgres@", 1)
READONLY_URL = DB_URL.replace("postgres:postgres@", "jigged_ai_readonly:postgres@", 1)


def _connect(dsn: str):
    try:
        conn = psycopg2.connect(dsn)
    except psycopg2.OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"No Postgres at {dsn.split('@')[-1]}: {exc}")
    conn.autocommit = True
    return conn


@contextmanager
def throwaway_company():
    """A committed company the worker connection can see, removed on exit (cascade)."""
    conn = _connect(DB_URL)
    with conn.cursor() as cur:
        cur.execute("INSERT INTO public.companies (name) VALUES (%s) RETURNING id",
                    (f"ai-chat-{uuid.uuid4().hex[:8]}",))
        company_id = cur.fetchone()[0]
    try:
        yield conn, company_id
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM public.companies WHERE id = %s", (company_id,))
        conn.close()


@pytest.fixture
def billing_open(supabase_admin, seeded_user_a):
    """The seeded company has no company_billing row, which the write gate reads as
    not paid up. Opened for the browser-write tests, closed again on the way out so
    the session-scoped company does not satisfy the gate for someone else's test."""
    company_id = seeded_user_a["company_id"]
    supabase_admin.table("company_billing").upsert(
        {"company_id": company_id, "billing_exempt": True}, on_conflict="company_id"
    ).execute()
    yield
    supabase_admin.table("company_billing").delete().eq("company_id", company_id).execute()


def _thread(admin, seeded, title="How many jobs are late?") -> str:
    return admin.table("ai_chat_threads").insert({
        "company_id": seeded["company_id"], "created_by": seeded["user_id"], "title": title,
    }).execute().data[0]["id"]


# ------------------------------------------------------------ the browser side


def test_a_user_creates_their_own_thread_and_the_row_names_them(seeded_user_a, billing_open):
    """created_by defaults from auth.uid(): the browser never states who it is."""
    row = seeded_user_a["client"].table("ai_chat_threads").insert({
        "company_id": seeded_user_a["company_id"], "title": "How many jobs are late?",
    }).execute().data[0]
    assert row["created_by"] == seeded_user_a["user_id"]
    assert row["deleted_at"] is None


def test_a_user_sees_only_their_own_threads(supabase_admin, seeded_user_a, seeded_user_b):
    mine = _thread(supabase_admin, seeded_user_a)
    theirs = _thread(supabase_admin, seeded_user_b)
    ids = {r["id"] for r in seeded_user_a["client"].table("ai_chat_threads").select("id").execute().data}
    assert mine in ids
    assert theirs not in ids, "one user could list another user's conversation"


def test_messages_are_readable_only_through_a_thread_the_reader_owns(
    supabase_admin, seeded_user_a, seeded_user_b
):
    """ai_chat_messages carries the question a person asked. Cross-user readability
    here would be other people's words, which is worse than a normal leak."""
    theirs = _thread(supabase_admin, seeded_user_b)
    supabase_admin.table("ai_chat_messages").insert({
        "thread_id": theirs, "company_id": seeded_user_b["company_id"],
        "seq": 1, "role": "user", "content": "what did we quote Acme last month?",
    }).execute()

    as_a = seeded_user_a["client"].table("ai_chat_messages").select("id").eq("thread_id", theirs).execute().data
    as_b = seeded_user_b["client"].table("ai_chat_messages").select("id").eq("thread_id", theirs).execute().data
    assert as_a == []
    assert len(as_b) == 1


def test_the_browser_cannot_write_a_message(supabase_admin, seeded_user_a, billing_open):
    """No browser write path at all: the trigger is the only writer."""
    mine = _thread(supabase_admin, seeded_user_a)
    with pytest.raises(Exception) as exc:
        seeded_user_a["client"].table("ai_chat_messages").insert({
            "thread_id": mine, "company_id": seeded_user_a["company_id"],
            "seq": 1, "role": "user", "content": "forged",
        }).execute()
    assert "42501" in str(exc.value) or "permission denied" in str(exc.value).lower()


def test_a_user_archives_their_own_thread(seeded_user_a, billing_open):
    client = seeded_user_a["client"]
    thread = client.table("ai_chat_threads").insert({
        "company_id": seeded_user_a["company_id"], "title": "archive me",
    }).execute().data[0]["id"]

    client.table("ai_chat_threads").update({"deleted_at": "2026-09-07T00:00:00Z"}).eq("id", thread).execute()

    live = client.table("ai_chat_threads").select("id").is_("deleted_at", "null").eq("id", thread).execute().data
    assert live == []


def test_no_role_holds_update_or_delete_on_messages():
    """Append-only as a property of the grants, not a convention. The service role
    included: every backend path runs as it."""
    conn = _connect(DB_URL)
    with conn.cursor() as cur:
        for role in ("authenticated", "service_role", "anon", "jigged_ai_worker", "jigged_ai_readonly"):
            for priv in ("UPDATE", "DELETE", "TRUNCATE"):
                cur.execute("SELECT has_table_privilege(%s, 'public.ai_chat_messages', %s)", (role, priv))
                assert cur.fetchone()[0] is False, f"{role} holds {priv} on ai_chat_messages"
    conn.close()


# ------------------------------------------------------------- the worker side


def test_the_workers_report_materialises_the_turn():
    """The worker UPDATEs ai_jobs and nothing else; the trigger writes the thread.
    Seq continues from what the thread already holds, and the summary the handler
    produced becomes its own row saying how far it covers."""
    with throwaway_company() as (conn, company_id):
        with conn.cursor() as cur:
            cur.execute("INSERT INTO public.ai_chat_threads (company_id, title) VALUES (%s, 'late jobs') RETURNING id",
                        (company_id,))
            thread = cur.fetchone()[0]
            cur.execute("INSERT INTO public.ai_chat_messages (thread_id, company_id, seq, role, content)"
                        " VALUES (%s,%s,1,'user','earlier question'),(%s,%s,2,'assistant','earlier answer')",
                        (thread, company_id, thread, company_id))
            cur.execute(
                "INSERT INTO public.ai_jobs (company_id, feature, executor, model, status, request_id,"
                " thread_id, kind, payload, claimed_by, claimed_at, lease_expires_at)"
                " VALUES (%s,'insights','worker','qwen3:32b','running', gen_random_uuid(), %s, 'chat', %s,"
                "         'desktop-1', now(), now() + interval '5 minutes') RETURNING id",
                (company_id, thread, json.dumps({"question": "How many jobs are late?", "today": "2026-09-07"})),
            )
            job = cur.fetchone()[0]

        worker = _connect(WORKER_URL)
        result = {
            "answer": "Four jobs are late.", "chart_config": None,
            "tool_trace": [{"sql": "select 1", "description": "late", "row_count": 1}],
            "summary": "Earlier: the shop asked about late jobs.", "summary_covers_through_seq": 2,
        }
        with worker.cursor() as wc:
            wc.execute("UPDATE public.ai_jobs SET status = 'succeeded', result = %s, finished_at = now()"
                       " WHERE id = %s AND status IN ('claimed', 'running')", (json.dumps(result), job))
            assert wc.rowcount == 1
        worker.close()

        with conn.cursor() as cur:
            cur.execute("SELECT seq, role, content, covers_through_seq, job_id, tool_trace, token_estimate"
                        " FROM public.ai_chat_messages WHERE thread_id = %s ORDER BY seq", (thread,))
            rows = cur.fetchall()
        assert [(r[0], r[1]) for r in rows] == [
            (1, "user"), (2, "assistant"), (3, "user"), (4, "assistant"), (5, "summary"),
        ]
        user_row, assistant_row, summary_row = rows[2], rows[3], rows[4]
        assert user_row[2] == "How many jobs are late?" and str(user_row[4]) == str(job)
        assert assistant_row[2] == "Four jobs are late." and assistant_row[5] == result["tool_trace"]
        assert assistant_row[6] == -(-len("Four jobs are late.") // 4)
        assert summary_row[3] == 2 and summary_row[2].startswith("Earlier:")


def test_the_workers_report_of_a_report_job_materialises_a_report_turn():
    """Since 2026-09-08 a report is a turn. The request becomes the user row, the
    headline the assistant row, and the spec rides in `report` so the browser can
    open the page from the thread without the job row. No summary row: a report
    does not fold history."""
    with throwaway_company() as (conn, company_id):
        with conn.cursor() as cur:
            cur.execute("INSERT INTO public.ai_chat_threads (company_id, title) VALUES (%s, 'quarter') RETURNING id",
                        (company_id,))
            thread = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO public.ai_jobs (company_id, feature, executor, model, status, request_id,"
                " thread_id, kind, payload, claimed_by, claimed_at, lease_expires_at)"
                " VALUES (%s,'insights','worker','qwen3:32b','running', gen_random_uuid(), %s, 'report', %s,"
                "         'desktop-1', now(), now() + interval '5 minutes') RETURNING id",
                (company_id, thread, json.dumps({"kind": "report", "request": "Summary of the quarter", "today": "2026-09-08"})),
            )
            job = cur.fetchone()[0]

        spec = {"title": "Operations summary", "period_start": "2026-07-01", "period_end": "2026-09-30",
                "period_label": "Q3", "headline": "26 jobs started, 16 shipped.", "kpis": [], "blocks": []}
        result = {"report": spec, "dropped": ["Flat chart"], "tool_calls": ["execute_sql", "execute_sql"],
                  "tool_trace": [], "provider": "ollama", "model": "qwen3:32b", "tokens_used": 1, "not_permitted": 0}
        worker = _connect(WORKER_URL)
        with worker.cursor() as wc:
            wc.execute("UPDATE public.ai_jobs SET status = 'succeeded', result = %s, finished_at = now()"
                       " WHERE id = %s AND status IN ('claimed', 'running')", (json.dumps(result), job))
            assert wc.rowcount == 1
        worker.close()

        with conn.cursor() as cur:
            cur.execute("SELECT seq, role, content, report, chart_config, job_id FROM public.ai_chat_messages"
                        " WHERE thread_id = %s ORDER BY seq", (thread,))
            rows = cur.fetchall()
        assert [(r[0], r[1]) for r in rows] == [(1, "user"), (2, "assistant")]
        assert rows[0][2] == "Summary of the quarter" and rows[0][3] is None
        assert rows[1][2] == "26 jobs started, 16 shipped."
        assert rows[1][3] == {"report": spec, "dropped": ["Flat chart"], "tool_call_count": 2}
        assert rows[1][4] is None and str(rows[1][5]) == str(job)


def test_a_report_may_only_ride_on_an_assistant_row():
    with throwaway_company() as (conn, company_id):
        with conn.cursor() as cur:
            cur.execute("INSERT INTO public.ai_chat_threads (company_id, title) VALUES (%s, 't') RETURNING id", (company_id,))
            thread = cur.fetchone()[0]
            with pytest.raises(psycopg2.errors.CheckViolation):
                cur.execute("INSERT INTO public.ai_chat_messages (thread_id, company_id, seq, role, content, report)"
                            " VALUES (%s,%s,1,'user','q','{}'::jsonb)", (thread, company_id))
        conn.rollback()


def test_a_job_without_a_thread_materialises_nothing():
    with throwaway_company() as (conn, company_id):
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO public.ai_jobs (company_id, feature, executor, model, status, request_id,"
                " payload, claimed_by, claimed_at, lease_expires_at)"
                " VALUES (%s,'insights','worker','qwen3:32b','running', gen_random_uuid(),"
                "         %s, 'desktop-1', now(), now() + interval '5 minutes') RETURNING id",
                (company_id, json.dumps({"question": "one-off"})),
            )
            job = cur.fetchone()[0]
            cur.execute("UPDATE public.ai_jobs SET status = 'succeeded', result = %s, finished_at = now() WHERE id = %s",
                        (json.dumps({"answer": "Four."}), job))
            cur.execute("SELECT count(*) FROM public.ai_chat_messages WHERE company_id = %s", (company_id,))
            assert cur.fetchone()[0] == 0


def test_one_question_at_a_time_per_thread():
    """Two tabs, or a double click. The route turns this into a 409; a settled job
    does not block the next question."""
    with throwaway_company() as (conn, company_id):
        with conn.cursor() as cur:
            cur.execute("INSERT INTO public.ai_chat_threads (company_id, title) VALUES (%s, 't') RETURNING id",
                        (company_id,))
            thread = cur.fetchone()[0]
            insert = ("INSERT INTO public.ai_jobs (company_id, feature, executor, model, request_id, thread_id)"
                      " VALUES (%s,'insights','worker','qwen3:32b', gen_random_uuid(), %s) RETURNING id")
            cur.execute(insert, (company_id, thread))
            first = cur.fetchone()[0]
            with pytest.raises(psycopg2.errors.UniqueViolation) as exc:
                cur.execute(insert, (company_id, thread))
            assert "ai_jobs_one_in_flight_per_thread" in str(exc.value)

            cur.execute("UPDATE public.ai_jobs SET status = 'failed', error = 'x', error_kind = 'provider',"
                        " finished_at = now() WHERE id = %s", (first,))
            cur.execute(insert, (company_id, thread))  # a settled job no longer blocks


def test_the_ai_sql_role_and_the_worker_cannot_read_conversations():
    """The model must not read conversations through execute_sql, and the worker
    writes the thread only through the trigger -- never with a grant of its own."""
    for dsn in (READONLY_URL, WORKER_URL):
        conn = _connect(dsn)
        for table in ("ai_chat_threads", "ai_chat_messages"):
            with conn.cursor() as cur, pytest.raises(psycopg2.errors.InsufficientPrivilege):
                cur.execute(f"SELECT count(*) FROM public.{table}")
        conn.close()


def test_every_guard_still_returns_nothing(supabase_admin):
    for guard in ("tenant_tables_missing_write_gate", "function_execute_leaks",
                  "definer_writers_missing_write_gate", "tenant_tables_missing_ai_decision",
                  "ai_job_write_leaks"):
        assert supabase_admin.rpc(guard, {}).execute().data == [], guard
