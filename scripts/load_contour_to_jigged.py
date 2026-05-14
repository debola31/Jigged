#!/usr/bin/env python3
"""
load_contour_to_jigged.py
=========================

Direct-SQL bulk loader for Contour Tool & Machine's data into Jigged.

Reads the cleaned CSVs we produced in this conversation:
  - vendors.csv                          (50 vendor display names)
  - resources.csv                        (27 internal work centers with rates)
  - parts_and_inventory_merged_v5.csv    (8,393 parts with costs)
  - routings_for_jigged.csv              (18,639 routing operations)
  - bom_for_jigged.csv                   (5,266 BOM lines)

Wipes the company's existing parts / routings / BOM / work_centers / vendors
in dependency order, then INSERTs all of the above in one transaction. If
anything fails, the entire load rolls back.

USAGE
-----
1. Install deps:        pip install psycopg2-binary
2. Edit CONFIG below:   set DATABASE_URL and COMPANY_ID
3. Run:                 python load_contour_to_jigged.py
4. Confirm the prompt before destructive operations execute.

This is a single-shot migration script. Once the AI-agent import is built,
this script gets retired.
"""

from __future__ import annotations

import csv
import os
import sys
import uuid
from pathlib import Path
from typing import Optional

try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:
    sys.exit("Install dependencies first:  pip install psycopg2-binary python-dotenv")

# Load .env.local from the script's directory if present.
# Falls back silently if python-dotenv isn't installed or no .env.local exists.
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent / ".env.local"
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass


# =============================================================================
# CONFIG (read from .env.local; can also be overridden via shell env)
# =============================================================================

DATABASE_URL = os.environ.get("DATABASE_URL", "")
COMPANY_ID = os.environ.get("CONTOUR_COMPANY_ID", "")

# Directory containing the cleaned CSV files
DATA_DIR = Path(__file__).parent

# Source files
VENDORS_CSV = DATA_DIR / "vendors.csv"
RESOURCES_CSV = DATA_DIR / "resources.csv"
PARTS_CSV = DATA_DIR / "parts_and_inventory_merged_v5.csv"
ROUTINGS_CSV = DATA_DIR / "routings_for_jigged.csv"
BOM_CSV = DATA_DIR / "bom_for_jigged.csv"

BATCH_SIZE = 1000  # rows per executemany call


# =============================================================================
# Helpers
# =============================================================================


def read_csv(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def blank_to_none(v):
    """Convert empty strings to None for nullable columns."""
    if v is None:
        return None
    if isinstance(v, str) and v.strip() == "":
        return None
    return v


def parse_numeric(v) -> Optional[float]:
    """Empty -> None, valid numeric -> float, anything else -> None."""
    v = blank_to_none(v)
    if v is None:
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def parse_int(v) -> Optional[int]:
    v = blank_to_none(v)
    if v is None:
        return None
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return None


def parse_bool(v) -> bool:
    if v is None:
        return False
    s = str(v).strip().lower()
    return s in ("true", "1", "yes", "y", "t")


def log(msg: str, indent: int = 0):
    print(f"{'  ' * indent}{msg}", flush=True)


# =============================================================================
# Load steps
# =============================================================================


def confirm_destructive(cur, company_id: str) -> None:
    """Show what will be deleted and ask for confirmation."""
    cur.execute("SELECT name FROM companies WHERE id = %s", (company_id,))
    row = cur.fetchone()
    if not row:
        sys.exit(f"Company {company_id} not found. Check COMPANY_ID config.")
    company_name = row[0]

    counts_q = """
        SELECT
            (SELECT count(*) FROM parts WHERE company_id = %(c)s)              AS parts,
            (SELECT count(*) FROM routings WHERE company_id = %(c)s)           AS routings,
            (SELECT count(*) FROM routing_operations ro JOIN routings r ON ro.routing_id = r.id WHERE r.company_id = %(c)s) AS routing_ops,
            (SELECT count(*) FROM parts_bom pb JOIN parts p ON pb.parent_part_id = p.id WHERE p.company_id = %(c)s) AS bom_lines,
            (SELECT count(*) FROM work_centers WHERE company_id = %(c)s)       AS work_centers,
            (SELECT count(*) FROM vendors WHERE company_id = %(c)s)            AS vendors,
            (SELECT count(*) FROM jobs WHERE company_id = %(c)s)               AS jobs,
            (SELECT count(*) FROM quotes WHERE company_id = %(c)s)             AS quotes,
            (SELECT count(*) FROM operator_sessions WHERE company_id = %(c)s)  AS operator_sessions;
    """
    cur.execute(counts_q, {"c": company_id})
    counts = cur.fetchone()

    log(f"\nTarget company:  {company_name}  ({company_id})")
    log(f"Current row counts that WILL BE DELETED:")
    labels = [
        "parts", "routings", "routing_operations", "parts_bom",
        "work_centers", "vendors", "jobs", "quotes", "operator_sessions",
    ]
    for label, n in zip(labels, counts):
        marker = "  <-- will cascade-delete child rows" if label in ("jobs", "quotes") and n else ""
        log(f"{label:25} {n:>8}{marker}", indent=1)

    jobs, quotes, sessions = counts[6], counts[7], counts[8]
    if jobs or quotes or sessions:
        log(f"\nNOTE: jobs/quotes/operator_sessions will be deleted to free up FK references.")
        log(f"Their child tables (job_parts, job_operations, job_materials,")
        log(f"quote_line_items, quote_materials, quote_operations) cascade automatically.")

    log("\nThis will then INSERT:")
    log(f"vendors                   ~50", indent=1)
    log(f"work_centers              ~50 (27 internal + ~23 external)", indent=1)
    log(f"parts                     ~8,393", indent=1)
    log(f"routings                  ~4,300 (one per part that has operations)", indent=1)
    log(f"routing_operations        ~18,639", indent=1)
    log(f"parts_bom                 ~5,266", indent=1)

    log("\nThe entire operation runs in a single transaction. Failure rolls back everything.")
    answer = input("\nProceed? Type 'yes' to continue: ").strip()
    if answer != "yes":
        sys.exit("Aborted by user.")


def clear_tables(cur, company_id: str) -> None:
    """Delete in FK dependency order. CASCADE handles most of this but we're explicit."""
    log("\nClearing existing data...")

    # First: clear tables that hold RESTRICT references to parts and work_centers.
    # If any of these have rows, deleting parts or work_centers will fail.
    # operator_sessions -> work_centers (RESTRICT). No CASCADE source; delete directly.
    cur.execute("DELETE FROM operator_sessions WHERE company_id = %s", (company_id,))
    log(f"deleted operator_sessions: {cur.rowcount}", indent=1)

    # jobs CASCADE to job_parts, job_operations, job_materials.
    # Those tables hold RESTRICT FKs into parts and work_centers.
    cur.execute("DELETE FROM jobs WHERE company_id = %s", (company_id,))
    log(f"deleted jobs (cascades to job_parts/job_operations/job_materials): {cur.rowcount}", indent=1)

    # quotes CASCADE to quote_line_items, quote_materials, quote_operations.
    cur.execute("DELETE FROM quotes WHERE company_id = %s", (company_id,))
    log(f"deleted quotes (cascades to quote_line_items/quote_materials/quote_operations): {cur.rowcount}", indent=1)

    # routing_operations -> work_centers (RESTRICT), so delete routings (cascades to routing_ops) first
    cur.execute("""
        DELETE FROM routing_operations
        WHERE routing_id IN (SELECT id FROM routings WHERE company_id = %s)
    """, (company_id,))
    log(f"deleted routing_operations: {cur.rowcount}", indent=1)

    cur.execute("DELETE FROM routings WHERE company_id = %s", (company_id,))
    log(f"deleted routings: {cur.rowcount}", indent=1)

    cur.execute("""
        DELETE FROM parts_bom
        WHERE parent_part_id IN (SELECT id FROM parts WHERE company_id = %s)
    """, (company_id,))
    log(f"deleted parts_bom: {cur.rowcount}", indent=1)

    # Other parts-dependent tables that cascade or restrict
    cur.execute("""
        DELETE FROM part_procurement_tiers
        WHERE part_id IN (SELECT id FROM parts WHERE company_id = %s)
    """, (company_id,))
    log(f"deleted part_procurement_tiers: {cur.rowcount}", indent=1)

    cur.execute("""
        DELETE FROM part_pricing_tiers WHERE company_id = %s
    """, (company_id,))
    log(f"deleted part_pricing_tiers: {cur.rowcount}", indent=1)

    cur.execute("""
        DELETE FROM parts_unit_conversions
        WHERE part_id IN (SELECT id FROM parts WHERE company_id = %s)
    """, (company_id,))
    log(f"deleted parts_unit_conversions: {cur.rowcount}", indent=1)

    cur.execute("""
        DELETE FROM inventory_transactions WHERE company_id = %s
    """, (company_id,))
    log(f"deleted inventory_transactions: {cur.rowcount}", indent=1)

    cur.execute("DELETE FROM parts WHERE company_id = %s", (company_id,))
    log(f"deleted parts: {cur.rowcount}", indent=1)

    # work_centers references vendors RESTRICT — delete first
    cur.execute("DELETE FROM work_centers WHERE company_id = %s", (company_id,))
    log(f"deleted work_centers: {cur.rowcount}", indent=1)

    # vendor_contacts cascades from vendors
    cur.execute("""
        DELETE FROM vendor_contacts
        WHERE vendor_id IN (SELECT id FROM vendors WHERE company_id = %s)
    """, (company_id,))
    log(f"deleted vendor_contacts: {cur.rowcount}", indent=1)

    cur.execute("DELETE FROM vendors WHERE company_id = %s", (company_id,))
    log(f"deleted vendors: {cur.rowcount}", indent=1)


def load_vendors(cur, company_id: str) -> dict[str, str]:
    """Insert vendors, return name -> id map."""
    log("\nLoading vendors...")
    rows = read_csv(VENDORS_CSV)

    vendor_records = []
    name_to_id: dict[str, str] = {}
    for r in rows:
        name = r["name"].strip()
        if not name:
            continue
        vid = str(uuid.uuid4())
        name_to_id[name] = vid
        vendor_records.append((
            vid,
            company_id,
            name,
            blank_to_none(r.get("address")),
            blank_to_none(r.get("city")),
            blank_to_none(r.get("state")),
            blank_to_none(r.get("zip")),
        ))

    execute_values(
        cur,
        """
        INSERT INTO vendors (id, company_id, name, address_line1, city, state, postal_code)
        VALUES %s
        """,
        vendor_records,
        page_size=BATCH_SIZE,
    )
    log(f"inserted vendors: {len(vendor_records)}", indent=1)
    return name_to_id


# Explicit aliases for known Tangle abbreviations -> internal WC names in resources.csv.
# Anything not listed here AND not a case-insensitive match AND not a vendor name
# becomes a new internal work center with no labor rate set (user fills in later).
WC_ALIASES: dict[str, str] = {
    "PGM": "PROGRAM",
    "GRIND": "GRINDING",
    "BMILL": "BRIDGEPORT MILL",
    "HMILL": "HORIZONTAL MILL",
    "MILL": "BRIDGEPORT MILL",
    "HURCO LTHE": "HURCO Lathe",
    "MISC": "MISCELLANEOUS",
    "KLND": "KLAND",
    "EDMB": "EDM",
    "SAND": "SAND BLAST",
    "LABLE": "Label",
}


def resolve_work_center_name(
    raw_name: str,
    internal_canonical: dict[str, str],   # lowercase -> canonical resources.csv name
    vendor_canonical: dict[str, str],     # lowercase -> canonical vendor name
) -> tuple[str, str]:
    """
    Resolve a routing's work_center_name to (canonical_name, kind).
    Returns kind in {'internal', 'external', 'new_internal'}.
    """
    name = raw_name.strip()
    aliased = WC_ALIASES.get(name, name)
    lower = aliased.lower()

    if lower in internal_canonical:
        return internal_canonical[lower], "internal"
    if lower in vendor_canonical:
        return vendor_canonical[lower], "external"
    return aliased, "new_internal"


def load_work_centers(
    cur,
    company_id: str,
    vendor_name_to_id: dict[str, str],
) -> tuple[dict[str, str], dict[str, str]]:
    """
    Build work centers from three sources:
      1. resources.csv -> internal WCs with labor rates
      2. routings CSV w/ vendor-name match -> external WCs linked to vendor
      3. routings CSV w/ no match -> auto-create as internal WC, no labor rate

    Returns (canonical_name -> wc_id, raw_routing_name -> canonical_name)
    so that load_routings can resolve raw names too.
    """
    log("\nLoading work centers...")

    internal_rows = read_csv(RESOURCES_CSV)
    internal_canonical = {
        r["name"].strip().lower(): r["name"].strip()
        for r in internal_rows if r["name"].strip()
    }
    vendor_canonical = {n.lower(): n for n in vendor_name_to_id.keys()}

    records: list[tuple] = []
    name_to_id: dict[str, str] = {}

    # Pass 1: internal WCs from resources.csv
    for r in internal_rows:
        name = r["name"].strip()
        if not name:
            continue
        wcid = str(uuid.uuid4())
        name_to_id[name] = wcid
        records.append((
            wcid, company_id, name, "internal", None,
            parse_numeric(r.get("labor_rate_per_hour")),
            blank_to_none(r.get("description")),
        ))
    internal_count = len(records)

    # Pass 2 + 3: walk routings, resolve each unique name
    routing_rows = read_csv(ROUTINGS_CSV)
    raw_to_canonical: dict[str, str] = {}
    auto_created: list[str] = []
    external_added: list[str] = []

    for r in routing_rows:
        wc_raw = (r.get("work_center_name") or "").strip()
        if not wc_raw or wc_raw in raw_to_canonical:
            continue
        canonical, kind = resolve_work_center_name(
            wc_raw, internal_canonical, vendor_canonical
        )
        raw_to_canonical[wc_raw] = canonical

        if canonical in name_to_id:
            continue

        if kind == "external":
            vid = vendor_name_to_id[canonical]
            wcid = str(uuid.uuid4())
            name_to_id[canonical] = wcid
            records.append((
                wcid, company_id, canonical, "external", vid, None, None,
            ))
            external_added.append(canonical)
        elif kind == "new_internal":
            wcid = str(uuid.uuid4())
            name_to_id[canonical] = wcid
            records.append((
                wcid, company_id, canonical, "internal", None, None,
                "Auto-created during import. Set labor rate before quoting with this work center.",
            ))
            auto_created.append(canonical)

    execute_values(
        cur,
        """
        INSERT INTO work_centers
            (id, company_id, name, kind, vendor_id, labor_rate, description)
        VALUES %s
        """,
        records,
        page_size=BATCH_SIZE,
    )

    log(f"inserted internal work centers (resources.csv): {internal_count}", indent=1)
    log(f"inserted external work centers (vendor-matched): {len(external_added)}", indent=1)
    if auto_created:
        log(f"auto-created internal work centers (no rate set): {len(auto_created)}", indent=1)
        log("Review on the Work Centers page and set labor rates:", indent=2)
        for n in sorted(auto_created):
            log(f"- {n}", indent=3)

    return name_to_id, raw_to_canonical


def load_parts(
    cur,
    company_id: str,
    vendor_name_to_id: dict[str, str],
) -> dict[str, str]:
    """Insert parts, return part_name -> id map."""
    log("\nLoading parts...")
    rows = read_csv(PARTS_CSV)

    records: list[tuple] = []
    tier_records: list[tuple] = []
    name_to_id: dict[str, str] = {}
    seen_legacy_ids: set[str] = set()

    for r in rows:
        name = r["part_name"].strip()
        if not name:
            continue
        if name in name_to_id:
            continue  # dedup
        pid = str(uuid.uuid4())
        name_to_id[name] = pid

        is_stocked = parse_bool(r.get("is_stocked"))
        primary_unit = blank_to_none(r.get("primary_unit"))
        if is_stocked and not primary_unit:
            # Schema CHECK: stocked parts must have a unit. Default to EA.
            primary_unit = "EA"

        # Defensive: legacy_id must be unique per company (or NULL)
        legacy_id = blank_to_none(r.get("legacy_id"))
        if legacy_id is not None:
            if legacy_id in seen_legacy_ids:
                legacy_id = None
            else:
                seen_legacy_ids.add(legacy_id)

        preferred_vendor_id = None
        pv_name = blank_to_none(r.get("preferred_vendor_name"))
        if pv_name:
            preferred_vendor_id = vendor_name_to_id.get(pv_name.strip())

        cost_val = parse_numeric(r.get("cost_per_unit"))
        source_val = r.get("source", "made").strip() or "made"

        records.append((
            pid,
            company_id,
            name,
            blank_to_none(r.get("description")),
            is_stocked,
            primary_unit,
            parse_numeric(r.get("quantity")) or 0,
            parse_numeric(r.get("reorder_point")),
            preferred_vendor_id,
            legacy_id,
            source_val,
        ))

        # parts.cost_per_unit was dropped in migration 20260514. For bought
        # rows that carry a cost, route the value into a NULL-vendor
        # procurement tier (min_quantity=1) so quote-time tier lookup picks
        # it up. Made-row costs are ignored — compute_part_cost_at_qty
        # recomputes them live.
        if source_val == "bought" and cost_val is not None and cost_val > 0:
            tier_records.append((pid, 1, float(cost_val)))

    execute_values(
        cur,
        """
        INSERT INTO parts (
            id, company_id, part_name, description,
            is_stocked, primary_unit, quantity,
            reorder_point, preferred_vendor_id, legacy_id, source
        )
        VALUES %s
        """,
        records,
        page_size=BATCH_SIZE,
    )
    log(f"inserted parts: {len(records)}", indent=1)

    if tier_records:
        execute_values(
            cur,
            """
            INSERT INTO part_procurement_tiers (part_id, vendor_id, min_quantity, cost_per_unit)
            VALUES %s
            """,
            [(pid, None, qty, cost) for pid, qty, cost in tier_records],
            page_size=BATCH_SIZE,
        )
        log(f"inserted NULL-vendor procurement tiers: {len(tier_records)}", indent=1)

    return name_to_id


def load_routings(
    cur,
    company_id: str,
    part_name_to_id: dict[str, str],
    wc_name_to_id: dict[str, str],
    wc_raw_to_canonical: dict[str, str],
) -> None:
    """Build routings (one per part w/ ops) and routing_operations."""
    log("\nLoading routings + routing_operations...")
    rows = read_csv(ROUTINGS_CSV)

    # Group operations by part
    by_part: dict[str, list[dict]] = {}
    skipped_unknown_part = 0
    skipped_unknown_wc = 0
    skipped_dup_seq = 0

    for r in rows:
        part_name = (r.get("part_name") or "").strip()
        wc_raw = (r.get("work_center_name") or "").strip()
        if part_name not in part_name_to_id:
            skipped_unknown_part += 1
            continue
        canonical_wc = wc_raw_to_canonical.get(wc_raw)
        if not canonical_wc or canonical_wc not in wc_name_to_id:
            skipped_unknown_wc += 1
            continue
        by_part.setdefault(part_name, []).append((r, canonical_wc))

    # Build routings + routing_operations records
    routing_records: list[tuple] = []
    op_records: list[tuple] = []

    for part_name, ops in by_part.items():
        part_id = part_name_to_id[part_name]
        routing_id = str(uuid.uuid4())
        routing_records.append((
            routing_id,
            company_id,
            part_id,
            f"Default routing for {part_name}",
        ))

        # Dedup (routing_id, sequence) since schema enforces uniqueness
        seen_seqs: set[int] = set()
        for op, canonical_wc in ops:
            seq = parse_int(op.get("sequence"))
            if seq is None:
                continue
            if seq in seen_seqs:
                skipped_dup_seq += 1
                continue
            seen_seqs.add(seq)

            wc_id = wc_name_to_id[canonical_wc]
            op_records.append((
                str(uuid.uuid4()),
                routing_id,
                wc_id,
                seq,
                parse_numeric(op.get("setup_minutes")) or 0,
                parse_numeric(op.get("cycle_minutes_per_unit")),
                parse_numeric(op.get("labor_rate_override")),
                parse_numeric(op.get("external_unit_price")),
                parse_numeric(op.get("external_setup_cost")),
                blank_to_none(op.get("instructions")),
            ))

    execute_values(
        cur,
        """
        INSERT INTO routings (id, company_id, part_id, name)
        VALUES %s
        """,
        routing_records,
        page_size=BATCH_SIZE,
    )
    log(f"inserted routings: {len(routing_records)}", indent=1)

    execute_values(
        cur,
        """
        INSERT INTO routing_operations (
            id, routing_id, work_center_id, sequence,
            setup_minutes, cycle_minutes_per_unit, labor_rate_override,
            external_unit_price, external_setup_cost, instructions
        )
        VALUES %s
        """,
        op_records,
        page_size=BATCH_SIZE,
    )
    log(f"inserted routing_operations: {len(op_records)}", indent=1)

    if skipped_unknown_part:
        log(f"skipped {skipped_unknown_part} ops (unknown parent part)", indent=1)
    if skipped_unknown_wc:
        log(f"skipped {skipped_unknown_wc} ops (unknown work center)", indent=1)
    if skipped_dup_seq:
        log(f"skipped {skipped_dup_seq} ops (duplicate sequence on same part)", indent=1)


def load_bom(cur, part_name_to_id: dict[str, str]) -> None:
    log("\nLoading BOM...")
    rows = read_csv(BOM_CSV)

    records: list[tuple] = []
    seen_pairs: set[tuple[str, str]] = set()
    skipped_unknown_parent = 0
    skipped_unknown_child = 0
    skipped_self_ref = 0
    skipped_dup = 0
    skipped_bad_qty = 0

    for r in rows:
        parent = (r.get("parent_part_name") or "").strip()
        child = (r.get("child_part_name") or "").strip()
        if parent not in part_name_to_id:
            skipped_unknown_parent += 1
            continue
        if child not in part_name_to_id:
            skipped_unknown_child += 1
            continue
        if parent == child:
            skipped_self_ref += 1
            continue

        parent_id = part_name_to_id[parent]
        child_id = part_name_to_id[child]
        pair = (parent_id, child_id)
        if pair in seen_pairs:
            skipped_dup += 1
            continue
        seen_pairs.add(pair)

        qty = parse_numeric(r.get("quantity"))
        if qty is None or qty <= 0:
            skipped_bad_qty += 1
            continue

        unit = (r.get("unit") or "EA").strip() or "EA"

        records.append((
            str(uuid.uuid4()),
            parent_id,
            child_id,
            qty,
            unit,
        ))

    execute_values(
        cur,
        """
        INSERT INTO parts_bom (id, parent_part_id, child_part_id, quantity, unit)
        VALUES %s
        """,
        records,
        page_size=BATCH_SIZE,
    )
    log(f"inserted parts_bom: {len(records)}", indent=1)
    for label, n in [
        ("skipped (unknown parent)", skipped_unknown_parent),
        ("skipped (unknown child)", skipped_unknown_child),
        ("skipped (self-reference)", skipped_self_ref),
        ("skipped (duplicate parent+child)", skipped_dup),
        ("skipped (invalid quantity)", skipped_bad_qty),
    ]:
        if n:
            log(f"{label}: {n}", indent=1)


# =============================================================================
# Main
# =============================================================================


def main() -> int:
    if not DATABASE_URL or not COMPANY_ID:
        sys.exit(
            "Missing config. Set DATABASE_URL and CONTOUR_COMPANY_ID in "
            ".env.local (alongside this script) or export them in your shell."
        )

    for f in (VENDORS_CSV, RESOURCES_CSV, PARTS_CSV, ROUTINGS_CSV, BOM_CSV):
        if not f.exists():
            sys.exit(f"Missing input file: {f}")

    log(f"Connecting to {DATABASE_URL.split('@')[-1].split('/')[0]}...")
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False

    try:
        with conn.cursor() as cur:
            confirm_destructive(cur, COMPANY_ID)
            clear_tables(cur, COMPANY_ID)

            vendor_name_to_id = load_vendors(cur, COMPANY_ID)
            wc_name_to_id, wc_raw_to_canonical = load_work_centers(
                cur, COMPANY_ID, vendor_name_to_id
            )
            part_name_to_id = load_parts(cur, COMPANY_ID, vendor_name_to_id)
            load_routings(
                cur, COMPANY_ID, part_name_to_id, wc_name_to_id, wc_raw_to_canonical
            )
            load_bom(cur, part_name_to_id)

        conn.commit()
        log("\nLoad complete. Transaction committed.\n")
        return 0

    except Exception as e:
        conn.rollback()
        log(f"\nERROR: {e}")
        log("Transaction rolled back. Database is unchanged.")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())