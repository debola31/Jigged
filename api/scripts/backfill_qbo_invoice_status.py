"""One-time launch backfill of the QuickBooks Online invoice payment mirror.

    cd api
    conda run -n jigged python scripts/backfill_qbo_invoice_status.py --dry-run
    conda run -n jigged python scripts/backfill_qbo_invoice_status.py

Export the PRODUCTION Supabase and Intuit credentials into that ONE shell before
running it -- SUPABASE_URL, SUPABASE_SECRET_KEY, QUICK_BOOKS_CLIENT_ID,
QUICK_BOOKS_CLIENT_SECRET and QUICKBOOKS_ENVIRONMENT=production. The script prints
which database and which Intuit environment it resolved before it touches either,
because .env.local is loaded underneath (exported values win) and a run against the
local stack looks exactly like a run against production until you read that line.

RUN ONCE, AFTER THE MIGRATION LANDS IN PRODUCTION, THEN DELETE IT in a follow-up
chore PR. It is not a scheduled job and there is no second thing it does.

WHY IT EXISTS. Nothing else makes an EXISTING invoice current: a link row starts
with qb_status NULL ("never checked"), and the only two things that ever fill it in
are an Intuit webhook marking a row stale and a person opening that job's Invoices
menu. So on day one every job nobody has visited shows no payment information at
all, and the feature reads as broken rather than as new. This walks every connected
company once and gives them all an answer.

CORRECTNESS DOES NOT DEPEND ON IT. A never-checked row is stale by definition, so
the first menu-open backfills it anyway; skipping this script costs a first
impression, not accuracy. That is also why a company whose read fails is simply
reported and skipped -- it will fix itself the moment someone opens the job.

NO STATUS LOGIC LIVES HERE. Every status word comes from
services.quickbooks.derive_invoice_status, every read from fetch_invoice_facts, and
every write from refresh_invoice_statuses -> apply_qbo_invoice_mirror. A second
definition of "paid" in a script that runs once against production is precisely the
kind of drift that would be discovered by a shop owner rather than by us.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from supabase import Client, create_client

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Same .env.local as api/index.py and evals/insights_ab.py, for the same reason:
# neither the FastAPI app nor pytest's conftest is in the import path here, so
# nothing else would have populated os.environ. override=False so an exported
# value still wins -- that is the whole mechanism by which "export the production
# credentials for this one shell" works.
load_dotenv(Path(__file__).resolve().parents[2] / ".env.local", override=False)

import services.quickbooks as qb  # noqa: E402

# The stored vocabulary, in the order a person reads it: settled first, then the two
# that need a human. Matches the CHECK on quickbooks_invoice_links.qb_status.
STATUS_ORDER = ("paid", "partial", "open", "voided", "missing")
# A row that came back from the write still carrying qb_status NULL. Named rather
# than dropped: it is the interesting case (see _run_company).
UNCHECKED = "(not checked)"


def _status_counts(statuses: list[str | None]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for status in statuses:
        counts[status or UNCHECKED] = counts.get(status or UNCHECKED, 0) + 1
    return counts


def _format_counts(counts: dict[str, int]) -> str:
    """Non-zero buckets only, in STATUS_ORDER, with anything unexpected kept last.

    An unknown word cannot reach the database (the CHECK constraint forbids it) but
    it can reach a --dry-run print, which never writes -- so it is shown rather than
    silently dropped."""
    known = [f"{name} {counts[name]}" for name in STATUS_ORDER if counts.get(name)]
    extra = [
        f"{name} {count}"
        for name, count in sorted(counts.items())
        if name not in STATUS_ORDER
    ]
    return "  ".join(known + extra) or "-"


def _company_names(db: Client, company_ids: list[str]) -> dict[str, str]:
    """id -> name for the report. One query, and no soft-delete filter because
    companies carries no deleted_at -- a company is not archivable."""
    if not company_ids:
        return {}
    rows = (
        db.table("companies").select("id, name").in_("id", company_ids).execute().data or []
    )
    return {row["id"]: row.get("name") or "(unnamed)" for row in rows}


def _links_for(db: Client, company_id: str) -> list[dict]:
    """Every invoice this company actually pushed to QuickBooks Online.

    Same predicate the Invoices menu uses: a 'created' QBO link with an id to ask
    about. Rows the mirror itself voided are KEPT -- if the invoice reappeared in
    QuickBooks, apply_qbo_invoice_mirror clears the mirror-owned voided_at, and it
    can only do that for a row we sent.

    Deliberately NOT filtered to the connection's realm, even though only that
    realm's rows can be refreshed: the count of rows left over from a previous
    QuickBooks company is part of the report, and filtering here would make it
    invisible. quickbooks_invoice_links has no deleted_at (invoices are voided, not
    archived), so there is no soft-delete filter."""
    return (
        db.table("quickbooks_invoice_links")
        .select("id, qb_invoice_id, realm_id")
        .eq("company_id", company_id)
        .eq("provider", "qbo")
        .eq("status", "created")
        .not_.is_("qb_invoice_id", "null")
        .execute()
        .data
        or []
    )


def _derive_only(db: Client, company_id: str, links: list[dict]) -> list[str]:
    """--dry-run: ask Intuit, derive, write nothing.

    The Jigged line total the void test needs comes from the service's own
    single-query helper rather than a SUM written here. Summing the line items again
    in this file would give the backfill a second definition of a number the app
    already computes -- the exact drift the module docstring refuses.

    Its counts can differ slightly from the real run's, and that is not a bug: this
    reports what QuickBooks SAYS about every row, while a real run reports what was
    STORED, and apply_qbo_invoice_mirror declines rows a human voided (voided_by NOT
    NULL) or that a newer check already claimed."""
    facts = qb.fetch_invoice_facts(db, company_id, [link["qb_invoice_id"] for link in links])
    jigged_totals = qb._jigged_line_totals(db, [link["id"] for link in links])
    statuses: list[str] = []
    for link in links:
        # Indexed, not .get(): fetch_invoice_facts answers for every id it was given,
        # so a missing key is our bug and belongs in the failure list, not silently
        # counted as an absent invoice.
        fact = facts[link["qb_invoice_id"]]
        statuses.append(
            qb.derive_invoice_status(
                found=fact is not None,
                total_amt=fact["total_amt"] if fact else None,
                balance=fact["balance"] if fact else None,
                jigged_total=jigged_totals.get(link["id"]),
            )
        )
    return statuses


def _run_company(db: Client, conn: dict, *, dry_run: bool) -> tuple[int, dict[str, int], int]:
    """One company: (invoices answered for, counts per status, rows in another realm).

    Raises on any failure. The caller reports and moves on -- refresh_invoice_statuses
    is all-or-nothing per company, so a raise here means nothing was written for this
    company rather than a half-applied answer."""
    company_id = conn["company_id"]
    realm_id = conn["realm_id"]
    links = _links_for(db, company_id)
    in_realm = [link for link in links if link["realm_id"] == realm_id]
    skipped_other_realm = len(links) - len(in_realm)
    if not in_realm:
        return 0, {}, skipped_other_realm

    if dry_run:
        return len(in_realm), _status_counts(_derive_only(db, company_id, in_realm)), skipped_other_realm

    # ONE clock read, taken BEFORE Intuit is asked, serving as both the stamp and
    # apply_qbo_invoice_mirror's monotonic guard. A person opening this job's menu
    # while the backfill is mid-flight is an ordinary race here, and the guard is
    # what makes it settle on the later READ rather than on whichever HTTP response
    # happened to land last.
    checked_at = datetime.now(timezone.utc)

    # Every link, unconditionally -- links_need_check is NOT consulted. It answers
    # "should this menu-open ask?", and a backfill re-run after a partial failure
    # would then ask nothing for the companies that already succeeded, which is the
    # opposite of what a human re-running it wants.
    stored = qb.refresh_invoice_statuses(db, company_id, conn, in_realm, checked_at=checked_at)
    # Counted from the rows AS STORED, not from what we derived: a row the RPC
    # declined shows up here as its previous word (or "(not checked)"), which is the
    # honest report. Counting our own derivations would claim a write that the
    # database refused.
    return len(stored), _status_counts([row.get("qb_status") for row in stored]), skipped_other_realm


def main() -> int:
    # Raw, so --help reproduces the usage block and the "run once, then delete it"
    # paragraph verbatim; the default formatter reflows the whole docstring into one
    # paragraph and loses both.
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="ask QuickBooks and print what would be stored, without writing anything",
    )
    ap.add_argument("--company", help="limit the run to one company_id")
    args = ap.parse_args()

    # Same pair, same precedence as api/index.py. Refused rather than defaulted: the
    # mirror write is service-role only (apply_qbo_invoice_mirror is REVOKE'd from
    # anon/authenticated), so an anon key would fail per company and look like an
    # Intuit outage instead of a missing credential.
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        print(
            "Refusing to run: this backfill writes with the service-role key and has "
            "no anon fallback.\n"
            "  export SUPABASE_URL=https://<project-ref>.supabase.co\n"
            "  export SUPABASE_SECRET_KEY=<service role / secret key>\n"
            "(SUPABASE_SERVICE_ROLE_KEY is accepted as well -- api/index.py takes the "
            "same pair.)"
        )
        return 2

    # Pre-flight rather than per-company, so a missing Intuit credential reads as one
    # refusal instead of a wall of identical failures that looks like Intuit is down.
    try:
        qb._client_credentials()
    except qb.QuickBooksServiceUnavailable as exc:
        print(
            f"Refusing to run: {exc}\n"
            "  export QUICK_BOOKS_CLIENT_ID=... QUICK_BOOKS_CLIENT_SECRET=...\n"
            "  export QUICKBOOKS_ENVIRONMENT=production"
        )
        return 2

    environment = qb._environment()
    db: Client = create_client(supabase_url, supabase_key)

    # WHICH DATABASE AND WHICH INTUIT THIS RAN AGAINST IS PART OF THE RESULT. A run
    # against the local stack with sandbox credentials produces a clean-looking table
    # and changes nothing in production, and there is no other way to tell the two
    # apart from the output.
    print("QuickBooks invoice mirror backfill")
    print(f"  supabase:               {supabase_url}")
    print(f"  quickbooks environment: {environment}")
    print(f"  mode:                   {'DRY RUN (nothing is written)' if args.dry_run else 'WRITE'}")
    print()

    # The environment filter is the guard, not a tidiness measure: it is what keeps a
    # sandbox-credentialed shell from taking a production connection's refresh token
    # to the sandbox API. reconnect_required rows are skipped because their refresh
    # token is already dead -- asking would burn a call to learn what the flag says.
    q = (
        db.table("quickbooks_connections")
        .select("*")
        .eq("environment", environment)
        .eq("reconnect_required", False)
    )
    if args.company:
        q = q.eq("company_id", args.company)
    connections = q.order("company_id").execute().data or []

    if not connections:
        if args.company:
            print(
                f"No usable QuickBooks Online connection for {args.company} in the "
                f"{environment} environment. It may be connected to QuickBooks Desktop, "
                f"be on the other environment, or need a reconnect."
            )
            return 2
        print(f"No QuickBooks Online connections in the {environment} environment -- nothing to do.")
        return 0

    names = _company_names(db, [conn["company_id"] for conn in connections])
    total_checked = 0
    failures: list[tuple[str, str, str]] = []

    for conn in connections:
        company_id = conn["company_id"]
        name = names.get(company_id, "(unknown company)")
        try:
            checked, counts, skipped_other_realm = _run_company(db, conn, dry_run=args.dry_run)
        except Exception as exc:  # noqa: BLE001 - one shop's outage must not end the run
            # Broad on purpose. Intuit downtime, an expired refresh token and a bug in
            # our own row handling all have the same consequence here -- this company
            # keeps whatever it already had, and the exit code makes sure a human sees
            # it. refresh_invoice_statuses writes nothing unless every row derived, so
            # there is no partial answer to unwind.
            failures.append((company_id, name, f"{type(exc).__name__}: {exc}"))
            print(f"{company_id}  {name}")
            print(f"  FAILED  {type(exc).__name__}: {exc}")
            print()
            continue

        total_checked += checked
        print(f"{company_id}  {name}")
        print(f"  invoices checked        {checked}")
        print(f"  status                  {_format_counts(counts)}")
        print(f"  skipped (other realm)   {skipped_other_realm}")
        print()

    verb = "would be checked" if args.dry_run else "checked"
    print(
        f"{len(connections)} companies · {total_checked} invoices {verb} · "
        f"{len(failures)} failed"
    )
    if failures:
        # Listed again at the bottom because the per-company lines scroll away, and a
        # re-run is the whole remedy: nothing was written for these.
        print()
        print("FAILED (nothing was written for these -- re-running is safe and is the fix)")
        for company_id, name, message in failures:
            print(f"  {company_id}  {name}  {message}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
