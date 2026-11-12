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
from datetime import datetime, timezone

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


def test_no_ai_readable_table_still_shows_archived_rows(supabase_admin):
    """Soft-delete is enforced in RLS, not asked for in the prompt.

    The reason this is a guard and not a sentence: it WAS a sentence. SCHEMA_CONTEXT
    and most of semantics.md said to filter deleted_at, the model omitted it once,
    and a shop owner was shown six archived jobs as overdue -- J-0071, J-0095,
    J-0069, J-0061, J-0113, J-0110, none of which exist on any screen. Nothing
    failed; a plausible number came back from a query that ran.

    apply_ai_read_access() now appends the clause for any table with a deleted_at
    column, so the supported path cannot reintroduce this. A hand-written
    parent-scoped policy still can, which is what this catches.
    """
    res = supabase_admin.rpc("ai_policies_missing_soft_delete_filter", {}).execute()
    assert res.data == [], (
        f"AI-readable tables whose policy does not filter deleted_at: {res.data}. "
        "Archived rows are visible to the model there, and it will eventually "
        "report them as live. Re-run public.apply_ai_read_access() on the table, "
        "or add the clause by hand if it is parent-scoped."
    )


@_needs_ro
async def test_the_sandbox_cannot_see_an_archived_job():
    """The end-to-end version of the guard above: archive a row, fail to read it.

    Catalogue assertions prove the policy SAYS the right thing. This proves the
    database DOES it, which is the claim the six phantom jobs disproved.
    """
    import asyncpg

    admin_dsn = os.getenv("AI_READONLY_DATABASE_URL", "").replace(
        "jigged_ai_readonly", "postgres"
    )
    admin = await asyncpg.connect(admin_dsn)
    ro = await _connect_as_the_ai_role()
    job_id = None
    try:
        row = await admin.fetchrow(
            "SELECT id, company_id FROM public.jobs WHERE deleted_at IS NULL LIMIT 1"
        )
        if row is None:
            pytest.skip("seeded database has no live jobs")
        job_id, company_id = row["id"], row["company_id"]

        await ro.execute(f"SET jigged.company_id = '{company_id}'")
        before = await ro.fetchval(
            "SELECT count(*) FROM public.jobs WHERE id = $1", job_id
        )
        assert before == 1, "the sandbox should see a live job in its own company"

        await admin.execute(
            "UPDATE public.jobs SET deleted_at = now() WHERE id = $1", job_id
        )
        after = await ro.fetchval(
            "SELECT count(*) FROM public.jobs WHERE id = $1", job_id
        )
        assert after == 0, (
            "the sandbox can still see an archived job -- the ai_readonly_select "
            "policy on public.jobs is not filtering deleted_at"
        )

        # And not merely by id: no archived job of any kind is reachable.
        assert (
            await ro.fetchval(
                "SELECT count(*) FROM public.jobs WHERE deleted_at IS NOT NULL"
            )
            == 0
        )
    finally:
        if job_id is not None:
            await admin.execute(
                "UPDATE public.jobs SET deleted_at = NULL WHERE id = $1", job_id
            )
        await admin.close()
        await ro.close()


@_needs_ro
async def test_an_archived_vendors_contacts_and_addresses_are_invisible():
    """The children of an archived parent are archived too, as far as the model can tell.

    vendor_contacts and vendor_addresses have no deleted_at of their own, and until
    20261112193919 their policies scoped the vendor's company and nothing else -- so "who do we
    call at Thermal One?" answered for a vendor no screen shows. A live vendor's rows are the
    control: without them this passes when the policy hides everything.
    """
    import uuid

    import asyncpg

    admin_dsn = os.getenv("AI_READONLY_DATABASE_URL", "").replace(
        "jigged_ai_readonly", "postgres"
    )
    admin = await asyncpg.connect(admin_dsn)
    ro = await _connect_as_the_ai_role()
    company_id = None
    try:
        company_id = await admin.fetchval(
            "INSERT INTO public.companies (name) VALUES ($1) RETURNING id",
            f"ai-archived-vendor-{uuid.uuid4().hex[:8]}",
        )
        vendors = {}
        for label, archived in (("live", False), ("archived", True)):
            vendor_id = await admin.fetchval(
                "INSERT INTO public.vendors (company_id, name, deleted_at) "
                "VALUES ($1, $2, CASE WHEN $3 THEN now() END) RETURNING id",
                company_id, f"{label} plating", archived,
            )
            await admin.execute(
                "INSERT INTO public.vendor_contacts (vendor_id, name, role) "
                "VALUES ($1, 'Pat Dock', 'shipping_receiving')", vendor_id)
            await admin.execute(
                "INSERT INTO public.vendor_addresses (vendor_id, address_line1, city, is_default) "
                "VALUES ($1, '1 Dock St', 'Akron', true)", vendor_id)
            vendors[label] = vendor_id

        await ro.execute(f"SET jigged.company_id = '{company_id}'")
        for table in ("vendor_contacts", "vendor_addresses"):
            seen = {r["vendor_id"] for r in await ro.fetch(f"SELECT vendor_id FROM public.{table}")}
            assert vendors["archived"] not in seen, (
                f"the sandbox can see an archived vendor's {table}")
            assert vendors["live"] in seen, (
                f"the sandbox cannot see a live vendor's {table} -- the policy hides too much")
    finally:
        if company_id is not None:
            # vendors cascade from the company, and contacts and addresses from the vendor.
            await admin.execute("DELETE FROM public.companies WHERE id = $1", company_id)
        await admin.close()
        await ro.close()


@_needs_ro
async def test_the_soft_delete_guard_reads_the_parent_a_policy_scopes_through():
    """The guard has to catch this class, not just this instance.

    Until 20261112193919 ai_policies_missing_soft_delete_filter() looked only at a table's OWN
    deleted_at, so vendor_contacts -- which has none -- passed while its vendor was archived.
    Put back the old policy, inside a transaction that is rolled back, and the guard must name it.
    """
    import asyncpg

    admin_dsn = os.getenv("AI_READONLY_DATABASE_URL", "").replace(
        "jigged_ai_readonly", "postgres"
    )
    admin = await asyncpg.connect(admin_dsn)
    try:
        tr = admin.transaction()
        await tr.start()
        try:
            await admin.execute("DROP POLICY ai_readonly_select ON public.vendor_contacts")
            await admin.execute(
                "CREATE POLICY ai_readonly_select ON public.vendor_contacts "
                "FOR SELECT TO jigged_ai_readonly USING (vendor_id IN ("
                "SELECT v.id FROM public.vendors v "
                "WHERE v.company_id = (current_setting('jigged.company_id', true))::uuid))"
            )
            flagged = {
                r["table_name"] for r in await admin.fetch(
                    "SELECT table_name FROM public.ai_policies_missing_soft_delete_filter()")
            }
            assert "vendor_contacts" in flagged, (
                "a child policy that ignores its parent's deleted_at is invisible to the guard")
        finally:
            await tr.rollback()
    finally:
        await admin.close()


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
            # Per COLUMN, not only per table: shipments and the outside-processing slips are
            # granted by column list with the actor columns withheld, so a table the role can
            # read may still hold a described column it cannot.
            withheld = [
                col for col in sorted(described[table] & real)
                if not await conn.fetchval(
                    "SELECT has_column_privilege('jigged_ai_readonly', $1, $2, 'SELECT')",
                    f"public.{table}", col)
            ]
            if withheld:
                problems.append(f"{table}: described column(s) withheld from the AI role: {', '.join(withheld)}")
    finally:
        await conn.close()

    if problems:
        pytest.fail("SCHEMA_CONTEXT does not match the database: " + "; ".join(problems))


# Any valid uuid works. These tests assert the queries EXECUTE, not that they
# return rows -- a company with no data is a fine answer, a syntax or privilege
# error is not. Setting jigged.company_id is mandatory, not tidiness: the
# ai_readonly_select policies cast current_setting(...)::uuid, which raises
# `invalid input syntax for type uuid: ""` when it is unset, and that error looks
# nothing like the permission problem it would be mistaken for.
_PROBE_COMPANY = "00000000-0000-0000-0000-000000000000"


@_needs_ro
async def test_every_object_the_assembled_context_names_is_usable():
    """The assembled prompt, not just SCHEMA_CONTEXT.

    This is the guarantee behind Gate 1 defect 1. The context advertised
    job_operation_intervals and pointed at user_company_access through an FK note,
    and jigged_ai_readonly could read neither -- so every arm spent tool turns on
    permission errors and four answers died at the iteration cap instead of being
    answered. Naming an object the sandbox cannot use is now a build failure.
    """
    import re

    from services.insights_service import _build_chat_system_prompt

    prompt = _build_chat_system_prompt()
    tables = re.findall(r"^###\s+([a-z_][a-z0-9_]*)", prompt, re.MULTILINE)
    functions = sorted(set(re.findall(r"public\.([a-z_][a-z0-9_]*)\s*\(", prompt)))
    assert tables, "parsed no tables out of the assembled prompt -- the format changed"

    conn = await _connect_as_the_ai_role()
    problems: list[str] = []
    try:
        await conn.execute(f"SET jigged.company_id = '{_PROBE_COMPANY}'")

        for table in sorted(set(tables)):
            try:
                # SELECT 1, not SELECT * -- the question is whether the relation is
                # reachable at all. `shipments` is granted by column (the carrier
                # account snapshot is withheld), and demanding every column would
                # fail a table the model can legitimately use.
                async with conn.transaction():
                    await conn.fetch(f'SELECT 1 FROM public."{table}" LIMIT 1')
            except Exception as exc:  # noqa: BLE001
                problems.append(f"{table}: {type(exc).__name__}: {str(exc).splitlines()[0]}")

        for fn in functions:
            row = await conn.fetchrow(
                """SELECT p.oid,
                          has_function_privilege('jigged_ai_readonly', p.oid, 'EXECUTE') AS ok
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = $1
                    LIMIT 1""",
                fn)
            if row is None:
                problems.append(f"public.{fn}(): named in the context, does not exist")
            elif not row["ok"]:
                problems.append(f"public.{fn}(): not executable by jigged_ai_readonly")
    finally:
        await conn.close()

    if problems:
        pytest.fail(
            "the insights context names objects the sandbox cannot use: "
            + "; ".join(problems))


@_needs_ro
async def test_every_reference_query_in_semantics_runs():
    """api/services/ai/semantics.md is rendered into the prompt verbatim, so a definition
    that cites a column the sandbox cannot read is a wrong answer waiting to be
    given. Each block runs under the real role with LIMIT 1.
    """
    import re

    from services.insights_service import SEMANTICS_PATH

    text = SEMANTICS_PATH.read_text(encoding="utf-8")
    blocks = re.findall(r"```sql\n(.*?)```", text, re.DOTALL)
    assert blocks, "no ```sql blocks found in semantics.md"

    # $2 is today, bound by the executor. Only pass it to blocks that use it --
    # asyncpg checks the argument count against the prepared statement, so a
    # spare argument is an error rather than something harmlessly ignored.
    today = datetime.now(timezone.utc).date()

    conn = await _connect_as_the_ai_role()
    problems: list[str] = []
    try:
        await conn.execute(f"SET jigged.company_id = '{_PROBE_COMPANY}'")
        for block in blocks:
            sql = block.strip().rstrip(";")
            args = [_PROBE_COMPANY]
            if re.search(r"\$2(?!\d)", sql):
                args.append(today)
            try:
                async with conn.transaction():
                    await conn.fetch(f"{sql}\nLIMIT 1", *args)
            except Exception as exc:  # noqa: BLE001
                first_line = sql.splitlines()[0][:60]
                problems.append(
                    f"[{first_line}...] {type(exc).__name__}: {str(exc).splitlines()[0]}")
    finally:
        await conn.close()

    if problems:
        pytest.fail(
            f"{len(problems)} of {len(blocks)} reference queries in semantics.md failed: "
            + "; ".join(problems))


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


# ===========================================================================
# Purchasing (plan §3.12 "AI readability", §5.1; M5)
#
# The two tests above that check SCHEMA_CONTEXT against the database and run every semantics.md
# reference query are what make these sections TRUE; the three below make sure the sections
# EXIST — otherwise the model would answer "what's on order?" by re-deriving a status the views
# already compute, the is_quote_open lesson (20260909115308) all over again.
# ===========================================================================

PURCHASING_CONTEXT_OBJECTS = {
    "vendor_purchase_orders", "vendor_purchase_order_lines", "vendor_purchase_order_receipts",
    "vendor_purchase_order_status", "vendor_purchase_order_line_status", "part_on_order",
    "part_vendor_last_purchase", "part_vendors", "part_vendor_price_breaks", "vendor_rfq_status",
}
# Exempt from the AI: superseded prices would read as current, numbering is plumbing, and the
# QuickBooks tables hold third-party ids.
PURCHASING_AI_EXEMPT = {
    "vendor_purchase_order_revisions", "purchasing_document_series", "quickbooks_vendor_map",
    "quickbooks_purchasing_setup", "quickbooks_purchase_order_links", "quickbooks_purchase_order_line_links",
}


def _context_sections() -> dict[str, str]:
    import re

    from tools.schema_context import SCHEMA_CONTEXT

    sections: dict[str, str] = {}
    current = None
    for line in SCHEMA_CONTEXT.splitlines():
        heading = re.match(r"^###\s+([a-z_][a-z0-9_]*)", line)
        if heading:
            current = heading.group(1)
            sections[current] = ""
        elif current:
            sections[current] += line + "\n"
    return sections


def test_schema_context_describes_purchasing_through_its_views():
    """[M5] The tables, the five-way status views and on-order are described; the exempt
    tables are not; and the context says what a model would otherwise get wrong: statuses come
    from the views, "late" is the predicate, outside lines are received on slips, receipts are
    filtered on `voided_at IS NULL`, and `jobs.customer_po_number` is the CUSTOMER's PO."""
    import re

    from tools.schema_context import SCHEMA_CONTEXT

    sections = _context_sections()
    missing = sorted(PURCHASING_CONTEXT_OBJECTS - set(sections))
    assert not missing, f"SCHEMA_CONTEXT does not describe: {missing}"
    described_exempt = sorted(PURCHASING_AI_EXEMPT & set(sections))
    assert not described_exempt, f"SCHEMA_CONTEXT describes tables the AI cannot read: {described_exempt}"

    assert "public.is_vendor_purchase_order_late(" in SCHEMA_CONTEXT
    assert "vendor_purchase_order_status" in sections["vendor_purchase_orders"], (
        "the PO table does not send the model to the status view")
    assert "outside_shipments" in sections["vendor_purchase_order_lines"], (
        "the lines do not say outside work is received on its vendor packing slip")
    assert "voided_at IS NULL" in sections["vendor_purchase_order_receipts"]
    assert re.search(r"customer_po_number.*customer'?s\s+(po|purchase order)", sections["jobs"], re.I), (
        "jobs.customer_po_number is not described as the customer's PO")


def test_semantics_defines_the_purchasing_terms_with_reference_sql():
    """[M5] On order, Open PO, Late PO, Last PO price and Open value (at PO price) each have a
    definition, and their reference SQL reads the shared definitions — which
    test_every_reference_query_in_semantics_runs then executes as the AI role."""
    import re

    from services.insights_service import SEMANTICS_PATH

    text = SEMANTICS_PATH.read_text(encoding="utf-8")
    headings = [h.strip().lower() for h in re.findall(r"^##\s+(.+)$", text, re.MULTILINE)]
    for term in ("on order", "open po", "late po", "last po price", "open value"):
        assert any(h.startswith(term) for h in headings), f"semantics.md has no '## {term}' definition"

    sql = "\n".join(re.findall(r"```sql\n(.*?)```", text, re.DOTALL))
    for name in ("part_on_order", "vendor_purchase_order_status", "is_vendor_purchase_order_late",
                 "part_vendor_last_purchase"):
        assert name in sql, f"no reference query in semantics.md uses {name}"


# ===========================================================================
# Outside processing: the vendor packing slips, and what comes back on them
# ===========================================================================

OUTSIDE_SLIP_TABLES = {"outside_shipments", "outside_shipment_receipts"}
# 20260903203741 grants both by column list; these columns are never granted, so never described.
OUTSIDE_SLIP_WITHHELD = {
    "created_by", "received_by", "voided_by", "closed_by", "notes", "note",
    "ship_to_address", "ship_to_contact", "vendor_address_id", "vendor_contact_id",
}


def test_schema_context_describes_the_outside_slips():
    """Readable by the AI role since 20260903203741, and never described until 2026-11-12 -- so
    "what is out at the plater?" had no table to query. Both sections exist, say to drop voided
    rows, and name no withheld column; test_schema_context_describes_only_real_readable_columns
    then holds every column they do name to the grant itself."""
    import re

    sections = _context_sections()
    missing = sorted(OUTSIDE_SLIP_TABLES - set(sections))
    assert not missing, f"SCHEMA_CONTEXT does not describe: {missing}"

    column = re.compile(r"(?:^-\s*|,\s*)([a-z_][a-z0-9_]*)\s*:", re.MULTILINE)
    for table in sorted(OUTSIDE_SLIP_TABLES):
        assert "voided_at IS NULL" in sections[table], f"{table} does not say to drop voided rows"
        leaked = sorted(set(column.findall(sections[table])) & OUTSIDE_SLIP_WITHHELD)
        assert not leaked, f"{table} describes columns the AI role is not granted: {leaked}"

    for col in ("quantity", "due_back_on", "closed_at", "voided_at", "vendor_purchase_order_line_id"):
        assert re.search(rf"\b{col}:", sections["outside_shipments"]), f"outside_shipments omits {col}"
    assert re.search(r"\bquantity_good:", sections["outside_shipment_receipts"])


def test_the_quickbooks_purchasing_tables_are_sensitive():
    """[M5, QB11] Blocked at both layers: no grant, and a whole-word entry in SENSITIVE_TABLES."""
    from tools.schema_context import SENSITIVE_TABLES

    quickbooks = {t for t in PURCHASING_AI_EXEMPT if t.startswith("quickbooks_")}
    assert quickbooks <= SENSITIVE_TABLES, sorted(quickbooks - SENSITIVE_TABLES)
