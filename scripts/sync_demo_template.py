#!/usr/bin/env python3
"""
Sync Demo Data Templates from Production to Staging

Copies active demo_data_templates rows from the production database
to the staging database, upserting by (name, version).

Usage:
    PROD_SUPABASE_DATABASE_URL=postgresql://... SUPABASE_DATABASE_URL=postgresql://... python scripts/sync_demo_template.py
    PROD_SUPABASE_DATABASE_URL=... SUPABASE_DATABASE_URL=... python scripts/sync_demo_template.py --template default
    PROD_SUPABASE_DATABASE_URL=... SUPABASE_DATABASE_URL=... python scripts/sync_demo_template.py --dry-run
"""

import os
import sys
import json
import argparse

from dotenv import load_dotenv

# Load .env.local from project root
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_project_root, ".env.local"))

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("Error: psycopg2 is required. Install with: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(1)


def get_connection(url: str, label: str):
    """Create a database connection."""
    try:
        conn = psycopg2.connect(url)
        return conn
    except psycopg2.Error as e:
        print(f"Error connecting to {label} database: {e}", file=sys.stderr)
        sys.exit(1)


def fetch_templates(conn, template_name: str = None) -> list:
    """Fetch active demo_data_templates from source database."""
    cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    if template_name:
        cursor.execute(
            """
            SELECT name, version, is_active, template_data
            FROM demo_data_templates
            WHERE name = %s AND is_active = true
            ORDER BY name, version
            """,
            (template_name,),
        )
    else:
        cursor.execute(
            """
            SELECT name, version, is_active, template_data
            FROM demo_data_templates
            WHERE is_active = true
            ORDER BY name, version
            """
        )

    rows = cursor.fetchall()
    cursor.close()
    return [dict(r) for r in rows]


def upsert_templates(conn, templates: list):
    """Insert or update templates in the target database."""
    cursor = conn.cursor()

    for t in templates:
        cursor.execute(
            """
            INSERT INTO demo_data_templates (name, version, is_active, template_data)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (name, version) DO UPDATE SET
                is_active = EXCLUDED.is_active,
                template_data = EXCLUDED.template_data
            """,
            (
                t["name"],
                t["version"],
                t["is_active"],
                json.dumps(t["template_data"]) if isinstance(t["template_data"], dict) else t["template_data"],
            ),
        )

    conn.commit()
    cursor.close()


def main():
    parser = argparse.ArgumentParser(
        description="Sync demo_data_templates from production to staging",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Environment variables:
    PROD_SUPABASE_DATABASE_URL    Production database (source)
    SUPABASE_DATABASE_URL         Staging database (target)

Examples:
    # Sync all active templates
    python scripts/sync_demo_template.py

    # Sync only the 'default' template
    python scripts/sync_demo_template.py --template default

    # Preview without writing
    python scripts/sync_demo_template.py --dry-run
        """,
    )

    parser.add_argument(
        "--template",
        "-t",
        default=None,
        help="Sync a specific template by name (default: all active templates)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print templates that would be synced without writing",
    )

    args = parser.parse_args()

    # Get database URLs
    prod_url = os.environ.get("PROD_SUPABASE_DATABASE_URL")
    staging_url = os.environ.get("SUPABASE_DATABASE_URL")

    if not prod_url:
        print("Error: PROD_SUPABASE_DATABASE_URL environment variable is required", file=sys.stderr)
        sys.exit(1)
    if not staging_url and not args.dry_run:
        print("Error: SUPABASE_DATABASE_URL environment variable is required", file=sys.stderr)
        sys.exit(1)

    # Fetch from production
    print("Connecting to production database...")
    prod_conn = get_connection(prod_url, "production")
    templates = fetch_templates(prod_conn, args.template)
    prod_conn.close()

    if not templates:
        template_filter = f" with name '{args.template}'" if args.template else ""
        print(f"No active templates found{template_filter} in production.", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(templates)} active template(s):")
    for t in templates:
        data = t["template_data"]
        if isinstance(data, str):
            data = json.loads(data)
        entity_counts = {k: len(v) for k, v in data.items() if isinstance(v, list)}
        print(f"  - {t['name']} v{t['version']}: {entity_counts}")

    if args.dry_run:
        print("\n[Dry run] No changes written to staging.")
        return

    # Write to staging
    print("\nConnecting to staging database...")
    staging_conn = get_connection(staging_url, "staging")
    upsert_templates(staging_conn, templates)
    staging_conn.close()

    print(f"Successfully synced {len(templates)} template(s) to staging.")


if __name__ == "__main__":
    main()
