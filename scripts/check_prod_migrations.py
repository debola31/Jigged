#!/usr/bin/env python3
"""
Assert that production has applied every migration in supabase/migrations/.

WHY THIS EXISTS
---------------
On 2026-08-03 every job and quote in production rendered "Job not found". The
cause was not a code bug: production's database was 13 migrations behind the
frontend deployed against it, and had been since 2026-08-01.

One statement in 20260801024552 referenced `public.rls_auto_enable()`, an EVENT
TRIGGER function that exists wherever the baseline actually RUNS (local stacks,
preview branches) but not in production, where the baseline was marked-as-applied
against the pre-existing database rather than executed. Creating an event trigger
requires SUPERUSER, which `postgres` is locally and is not on a hosted project.

Migrations are atomic and ordered, so that one statement aborted its file and
blocked the twelve behind it — including the three the shipped frontend needed.

The expensive part was not the bad statement. It was the SILENCE: merges kept
going green for two days because every gate we run executes somewhere the
function exists, and NOTHING reported on the production apply. This script is
that missing report.

WHAT IT CHECKS
--------------
`supabase_migrations.schema_migrations` on production vs the 14-digit version
prefixes of supabase/migrations/*.sql. Any local migration with no remote row is
pending, and pending after a merge means the branching pipeline failed.

It also flags REMOTE-ONLY versions — a row in prod with no matching file. That is
the reverse drift (a hand-applied migration, or a file deleted after it shipped),
and it is worth seeing even though it does not block a deploy.

Usage:
    python scripts/check_prod_migrations.py
    python scripts/check_prod_migrations.py --wait 600   # poll, for post-merge CI

Reads PROD_SUPABASE_DATABASE_URL (also honours .env.local for local runs).
Exit codes: 0 = in sync, 1 = pending migrations, 2 = could not check.
"""

import argparse
import os
import re
import sys
import time
from typing import List, Set, Tuple

from dotenv import load_dotenv

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_PROJECT_ROOT, ".env.local"))

try:
    import psycopg2
except ImportError:
    print(
        "Error: psycopg2 is required. Install with: pip install psycopg2-binary",
        file=sys.stderr,
    )
    sys.exit(2)

MIGRATIONS_DIR = os.path.join(_PROJECT_ROOT, "supabase", "migrations")

# The CLI names files <14-digit timestamp>_<slug>.sql and tracks them by that
# version. Legacy 8-digit date-only prefixes exist in this repo's history; they
# are matched too so the comparison never silently ignores one.
_VERSION_RE = re.compile(r"^(\d{14}|\d{8})_")


def local_versions() -> List[str]:
    """Every migration version present in supabase/migrations/, in apply order."""
    if not os.path.isdir(MIGRATIONS_DIR):
        print(f"Error: {MIGRATIONS_DIR} does not exist", file=sys.stderr)
        sys.exit(2)

    versions = []
    for name in sorted(os.listdir(MIGRATIONS_DIR)):
        if not name.endswith(".sql"):
            continue
        match = _VERSION_RE.match(name)
        if match:
            versions.append(match.group(1))
    return versions


def remote_versions(db_url: str) -> Set[str]:
    """Versions production records as applied."""
    conn = psycopg2.connect(db_url, connect_timeout=30)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT version FROM supabase_migrations.schema_migrations")
            return {row[0] for row in cur.fetchall()}
    finally:
        conn.close()


def compare(db_url: str) -> Tuple[List[str], List[str]]:
    """Return (pending, remote_only) versions."""
    local = local_versions()
    remote = remote_versions(db_url)
    pending = [v for v in local if v not in remote]
    remote_only = sorted(remote - set(local))
    return pending, remote_only


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Assert production has applied every local migration.",
    )
    parser.add_argument(
        "--wait",
        type=int,
        default=0,
        metavar="SECONDS",
        help=(
            "Poll until production catches up, then fail. Supabase Branching "
            "applies migrations asynchronously after a merge, so post-merge CI "
            "needs a window rather than a single instant check."
        ),
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=20,
        metavar="SECONDS",
        help="Seconds between polls while waiting (default: 20).",
    )
    args = parser.parse_args()

    db_url = os.environ.get("PROD_SUPABASE_DATABASE_URL")
    if not db_url:
        # Exit 2, not 1: "could not check" is not "found pending migrations".
        # A missing secret must never read as a clean bill of health.
        print(
            "Error: PROD_SUPABASE_DATABASE_URL is not set — cannot verify production.\n"
            "This is a configuration failure, not a passing check.",
            file=sys.stderr,
        )
        return 2

    deadline = time.monotonic() + args.wait
    attempt = 0

    while True:
        attempt += 1
        try:
            pending, remote_only = compare(db_url)
        except psycopg2.Error as exc:
            # A connection wobble mid-wait is not a verdict. Keep polling while
            # there is time left; only give up once the window closes.
            if time.monotonic() < deadline:
                print(f"  … connection failed ({exc.__class__.__name__}), retrying")
                time.sleep(args.interval)
                continue
            print(f"Error: could not reach production: {exc}", file=sys.stderr)
            return 2

        if remote_only:
            # Reported every pass, never fatal: this is drift worth seeing, but
            # it does not mean the deploy failed.
            print(
                "Note: production records migrations with no file in this repo: "
                + ", ".join(remote_only)
            )

        if not pending:
            print(f"✅ Production has applied all {len(local_versions())} migrations.")
            return 0

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print("", file=sys.stderr)
            print(
                f"❌ Production is missing {len(pending)} migration(s):",
                file=sys.stderr,
            )
            for version in pending:
                print(f"     {version}", file=sys.stderr)
            print("", file=sys.stderr)
            print(
                "The merge did NOT reach the database. Supabase Branching applies\n"
                "migrations to production on merge to main; if they are still\n"
                "pending, that apply failed or never ran.\n"
                "\n"
                "Migrations are atomic and ordered, so the FIRST version listed is\n"
                "the one to read — everything after it is blocked behind it, not\n"
                "independently broken.\n"
                "\n"
                "To see the actual error:\n"
                "    npx supabase@<pinned> db push --linked --dry-run\n"
                "\n"
                "Do not resolve this by marking the migration applied: that skips\n"
                "its contents on production for good.",
                file=sys.stderr,
            )
            return 1

        print(
            f"  … {len(pending)} migration(s) still pending after attempt {attempt}; "
            f"{int(remaining)}s left"
        )
        time.sleep(min(args.interval, max(1, int(remaining))))


if __name__ == "__main__":
    sys.exit(main())
