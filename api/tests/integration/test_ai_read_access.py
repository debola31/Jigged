"""What the insights SQL sandbox may read, asserted against a real database.

ONE BOUNDARY, CHECKED WHERE IT LIVES. Until 20260826010319 four mechanisms
decided this -- the GRANT, the ai_readonly_select policy, ALLOWED_TABLES and
SENSITIVE_TABLES -- and nothing compared them. They drifted: production carried
the policy on `shipments` with no grant behind it, so every query reaching that
table through public.job_last_ship_date() failed with `permission denied` while
schema_context.py went on naming that helper as THE way to get a ship date. No
unit test could have caught it; only a database can answer "may this role read
this table".

The first two tests need a service-role client (local Supabase with migrations
applied). The last two connect AS jigged_ai_readonly, which is the only way to
assert the answer the sandbox will actually get.
"""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.integration

_RO_DSN = os.getenv("AI_READONLY_DATABASE_URL")
_needs_ro = pytest.mark.skipif(not _RO_DSN, reason="AI_READONLY_DATABASE_URL not configured")


async def _connect_as_the_ai_role():
    """Connect, and refuse to run if the DSN is not actually the AI role.

    This matters more than it looks. `.env.local` used to point this variable at
    the `postgres` SUPERUSER, which is BYPASSRLS and can read every column of
    every table -- so both tests below would have passed without exercising a
    single grant, which is worse than not having them. supabase/seed.sql now
    gives jigged_ai_readonly a local login precisely so they can be real.
    """
    import asyncpg

    conn = await asyncpg.connect(_RO_DSN, timeout=20)
    who = await conn.fetchval("SELECT current_user")
    if who != "jigged_ai_readonly":
        await conn.close()
        pytest.skip(
            f"AI_READONLY_DATABASE_URL connects as {who!r}, not jigged_ai_readonly; "
            "these assertions would be vacuous"
        )
    return conn


def test_no_tenant_table_left_undecided(supabase_admin):
    """A new company_id table ships only once somebody has decided about it.

    This is the guard that replaces "remember to update the allowlist". A tenant
    table with neither `SELECT public.apply_ai_read_access(...)` nor an entry on
    the exempt list inside tenant_tables_missing_ai_decision() fails the build.
    Either answer is one line; not answering is not an option.
    """
    res = supabase_admin.rpc("tenant_tables_missing_ai_decision", {}).execute()
    assert res.data == [], (
        f"tenant tables with no AI read decision: {res.data}. Either call "
        "SELECT public.apply_ai_read_access('public.<table>') in the migration, or "
        "add it to the exempt list in tenant_tables_missing_ai_decision() with a "
        "line saying why the insights AI must not read it."
    )


def test_no_ai_policy_without_a_grant_behind_it(supabase_admin):
    """The exact shape of the shipments bug, as an invariant.

    RLS decides which rows; the grant decides whether the role may touch the
    table at all. A policy with no grant is unreachable -- it reads as access and
    refuses every query -- and it is invisible to anyone who checks only that a
    policy exists. apply_ai_read_access() applies both together, so the supported
    path cannot reintroduce this.
    """
    res = supabase_admin.rpc("ai_policies_without_grant", {}).execute()
    assert res.data == [], (
        f"tables with ai_readonly_select but no SELECT grant: {res.data}. "
        "RLS with no grant is unreachable; apply both with "
        "public.apply_ai_read_access(), or drop the policy."
    )


@_needs_ro
async def test_the_ship_date_helper_runs_as_the_ai_role():
    """schema_context.py names public.job_last_ship_date() as THE way to get a
    ship date now that jobs.shipped_at is gone. It is SECURITY INVOKER, so its
    body reads `shipments` and `shipment_line_items` AS THE CALLER -- and the
    caller is jigged_ai_readonly.

    Calling it is what proves the grants are really there. Asserting the grant on
    `shipments` alone would miss the helper being changed to touch some third
    table nobody granted, which is the same bug wearing a different table name.
    """
    import asyncpg

    conn = await _connect_as_the_ai_role()
    try:
        async with conn.transaction(readonly=True):
            await conn.execute(
                "SET LOCAL jigged.company_id = '00000000-0000-0000-0000-000000000000'"
            )
            # NULL is the right answer for a company with no shipments. The point
            # is that it RETURNS rather than raising insufficient_privilege.
            await conn.fetchval(
                "SELECT public.job_last_ship_date($1::uuid)",
                "00000000-0000-0000-0000-000000000000",
            )
    except asyncpg.exceptions.InsufficientPrivilegeError as exc:
        pytest.fail(
            "jigged_ai_readonly cannot execute public.job_last_ship_date(): "
            f"{exc}. The schema context recommends it, so every ship-date "
            "question fails with exactly this."
        )
    finally:
        await conn.close()


@_needs_ro
async def test_schema_context_describes_only_real_readable_columns():
    """The last hand-maintained copy of the schema, finally checked.

    SCHEMA_CONTEXT is pasted verbatim into the system prompt and the prompt says
    "Only query the tables documented in the schema above" -- so it is both the
    map the model navigates by and, in practice, the allowlist the model obeys.
    Nothing verified it. schemaEmbedCheck.ts covers PostgREST embeds in utils/,
    not this.

    It had drifted twice by the time this test was written: `customers.website`
    and `part_pricing_tiers.unit_price` were both described and neither exists.
    A described column that is missing costs a wasted round trip and a
    self-correction the owner waits through; a described table the role cannot
    read is the shipments bug pointing the other way.

    Checks description -> reality, deliberately not the reverse: a real column
    nobody documents is a choice (customers.credit_hold_note is not the AI's
    business), while a documented column that does not exist is always a bug.
    """
    import re

    from tools.schema_context import SCHEMA_CONTEXT

    heading = re.compile(r"^###\s+([a-z_][a-z0-9_]*)", re.MULTILINE)
    # `- id: UUID (PK)` and `- a: T, b: T`. Types are UPPERCASE so they never
    # match, and `- NOTE:` never matches either.
    column = re.compile(r"(?:^-\s*|,\s*)([a-z_][a-z0-9_]*)\s*:")

    described: dict[str, set[str]] = {}
    current = None
    for line in SCHEMA_CONTEXT.splitlines():
        h = heading.match(line)
        if h:
            current = h.group(1)
            described[current] = set()
        elif current and line.startswith("- ") and not line.startswith("- NOTE"):
            described[current].update(column.findall(line))

    assert described, "parsed no tables out of SCHEMA_CONTEXT -- the format changed"

    conn = await _connect_as_the_ai_role()
    problems: list[str] = []
    try:
        for table in sorted(described):
            real = {
                r[0] for r in await conn.fetch(
                    "SELECT a.attname FROM pg_attribute a "
                    "JOIN pg_class c ON c.oid = a.attrelid "
                    "JOIN pg_namespace n ON n.oid = c.relnamespace "
                    "WHERE n.nspname = 'public' AND c.relname = $1 "
                    "  AND a.attnum > 0 AND NOT a.attisdropped",
                    table)
            }
            if not real:
                problems.append(f"{table}: described but no such table")
                continue
            if not await conn.fetchval(
                "SELECT has_any_column_privilege('jigged_ai_readonly', $1, 'SELECT')",
                f"public.{table}"
            ):
                problems.append(f"{table}: described but not readable by the AI role")
            ghosts = sorted(described[table] - real)
            if ghosts:
                problems.append(f"{table}: described column(s) do not exist: {', '.join(ghosts)}")
    finally:
        await conn.close()

    if problems:
        pytest.fail("SCHEMA_CONTEXT does not match the database: " + "; ".join(problems))


@_needs_ro
async def test_an_ungranted_table_refuses_at_the_database():
    """The behaviour the deleted allowlist used to approximate in Python.

    A tenant table the AI has no grant on must refuse, not return rows. The
    target is chosen from the catalogue rather than hardcoded, so opening a table
    later changes what this covers instead of breaking it.
    """
    import asyncpg

    conn = await _connect_as_the_ai_role()
    try:
        target = await conn.fetchval(
            """
            SELECT c.relname
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.oid
                                 AND a.attname = 'company_id' AND NOT a.attisdropped
             WHERE n.nspname = 'public' AND c.relkind = 'r'
               AND NOT has_any_column_privilege('jigged_ai_readonly', c.oid, 'SELECT')
             ORDER BY c.relname
             LIMIT 1
            """
        )
        if target is None:
            pytest.skip("every tenant table is AI-readable; nothing to assert against")

        with pytest.raises(asyncpg.exceptions.InsufficientPrivilegeError):
            await conn.fetch(f'SELECT 1 FROM public."{target}" LIMIT 1')
    finally:
        await conn.close()
