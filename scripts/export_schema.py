#!/usr/bin/env python3
"""
PostgreSQL/Supabase Schema Export Script

Exports a complete database schema with deterministic ordering for git diffs.
Includes RLS policies, functions, triggers, and all constraints.

Usage:
    PROD_SUPABASE_DATABASE_URL=postgresql://... python scripts/export_schema.py
    PROD_SUPABASE_DATABASE_URL=postgresql://... python scripts/export_schema.py --output custom_path.sql
    PROD_SUPABASE_DATABASE_URL=postgresql://... python scripts/export_schema.py --dry-run
"""

import os
import re
import sys
import argparse
from datetime import datetime, timezone
from collections import defaultdict
from typing import List, Dict, Any, Optional, Set, Tuple

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


class SchemaExporter:
    """Exports PostgreSQL schema with deterministic ordering."""

    def __init__(self, SUPABASE_DATABASE_URL: str, schemas: List[str]):
        self.SUPABASE_DATABASE_URL = SUPABASE_DATABASE_URL
        self.schemas = schemas
        self.conn = None
        self.cursor = None

    def connect(self):
        """Establish database connection."""
        try:
            self.conn = psycopg2.connect(self.SUPABASE_DATABASE_URL)
            self.cursor = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        except psycopg2.Error as e:
            print(f"Error connecting to database: {e}", file=sys.stderr)
            sys.exit(1)

    def close(self):
        """Close database connection."""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()

    def query(self, sql: str, params: tuple = None) -> List[Dict]:
        """Execute query and return results as list of dicts."""
        try:
            self.cursor.execute(sql, params)
            return [dict(row) for row in self.cursor.fetchall()]
        except psycopg2.Error as e:
            print(f"Query error: {e}", file=sys.stderr)
            return []

    def escape_identifier(self, name: str) -> str:
        """Escape SQL identifier (table/column name)."""
        return f'"{name}"' if name else name

    def format_schema_table(self, schema: str, table: str) -> str:
        """Format schema.table identifier."""
        return f'{self.escape_identifier(schema)}.{self.escape_identifier(table)}'

    # =========================================================================
    # CUSTOM TYPES / ENUMS (only if any exist in user schemas)
    # Note: Extensions are managed by Supabase and don't need to be exported
    # =========================================================================
    def export_types(self) -> str:
        """Export CREATE TYPE statements for enums and composites."""
        sql = """
            SELECT
                n.nspname AS schema,
                t.typname AS name,
                t.typtype AS type_type,
                ARRAY_AGG(e.enumlabel ORDER BY e.enumsortorder) FILTER (WHERE e.enumlabel IS NOT NULL) AS enum_values
            FROM pg_type t
            JOIN pg_namespace n ON t.typnamespace = n.oid
            LEFT JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE n.nspname = ANY(%s)
                AND t.typtype = 'e'
            GROUP BY n.nspname, t.typname, t.typtype
            ORDER BY n.nspname, t.typname
        """
        types = self.query(sql, (['public'],))
        if not types:
            return ""

        lines = ["-- ============================================================",
                 "-- 1. CUSTOM TYPES AND ENUMS",
                 "-- ============================================================"]
        for t in types:
            schema = self.escape_identifier(t["schema"])
            name = self.escape_identifier(t["name"])
            if t["type_type"] == "e" and t["enum_values"]:
                values = ", ".join(f"'{v}'" for v in t["enum_values"])
                lines.append(f"CREATE TYPE {schema}.{name} AS ENUM ({values});")
        lines.append("")
        return "\n".join(lines)

    # =========================================================================
    # TABLES
    # =========================================================================
    def get_tables(self) -> List[Dict]:
        """Get all tables with their metadata."""
        sql = """
            SELECT
                c.oid,
                n.nspname AS schema,
                c.relname AS name,
                c.relrowsecurity AS rls_enabled
            FROM pg_class c
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE c.relkind = 'r'
                AND n.nspname = ANY(%s)
            ORDER BY n.nspname, c.relname
        """
        return self.query(sql, (['public'],))

    def get_columns(self, table_oid: int) -> List[Dict]:
        """Get columns for a table."""
        sql = """
            SELECT
                a.attname AS name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS not_null,
                pg_get_expr(d.adbin, d.adrelid) AS default_value,
                COALESCE(
                    (SELECT 'COLLATE ' || c.collname
                     FROM pg_collation c
                     WHERE c.oid = a.attcollation
                       AND c.collname != 'default'),
                    ''
                ) AS collation
            FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
            WHERE a.attrelid = %s
                AND a.attnum > 0
                AND NOT a.attisdropped
            ORDER BY a.attnum
        """
        return self.query(sql, (table_oid,))

    def get_constraints(self, table_oid: int) -> List[Dict]:
        """Get PK, UNIQUE, and CHECK constraints (NOT foreign keys)."""
        sql = """
            SELECT
                con.conname AS name,
                con.contype AS type,
                pg_get_constraintdef(con.oid) AS definition
            FROM pg_constraint con
            WHERE con.conrelid = %s
                AND con.contype IN ('p', 'u', 'c')
            ORDER BY
                CASE con.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 ELSE 3 END,
                con.conname
        """
        return self.query(sql, (table_oid,))

    def get_foreign_keys(self) -> List[Dict]:
        """Get all foreign key constraints."""
        sql = """
            SELECT
                n.nspname AS schema,
                c.relname AS table_name,
                con.conname AS constraint_name,
                nf.nspname AS ref_schema,
                cf.relname AS ref_table,
                pg_get_constraintdef(con.oid) AS definition
            FROM pg_constraint con
            JOIN pg_class c ON con.conrelid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            JOIN pg_class cf ON con.confrelid = cf.oid
            JOIN pg_namespace nf ON cf.relnamespace = nf.oid
            WHERE con.contype = 'f'
                AND n.nspname = ANY(%s)
            ORDER BY n.nspname, c.relname, con.conname
        """
        return self.query(sql, (['public'],))

    def build_dependency_graph(self, tables: List[Dict], foreign_keys: List[Dict]) -> Dict[str, Set[str]]:
        """Build graph of table dependencies from foreign keys."""
        deps = defaultdict(set)
        table_set = {f"{t['schema']}.{t['name']}" for t in tables}

        for fk in foreign_keys:
            src = f"{fk['schema']}.{fk['table_name']}"
            ref = f"{fk['ref_schema']}.{fk['ref_table']}"
            if src in table_set and ref in table_set and src != ref:
                deps[src].add(ref)

        return deps

    def topological_sort(self, tables: List[Dict], deps: Dict[str, Set[str]]) -> List[Dict]:
        """Sort tables by dependency order using Kahn's algorithm."""
        table_map = {f"{t['schema']}.{t['name']}": t for t in tables}
        all_names = set(table_map.keys())

        # Calculate in-degrees
        in_degree = {name: len(deps.get(name, set()) & all_names) for name in all_names}

        # Start with tables that have no dependencies
        queue = sorted([name for name in all_names if in_degree[name] == 0])
        result = []

        while queue:
            current = queue.pop(0)
            result.append(current)

            # Find tables that depend on current
            for name in all_names:
                if current in deps.get(name, set()):
                    in_degree[name] -= 1
                    if in_degree[name] == 0:
                        # Insert in sorted position for determinism
                        idx = 0
                        for i, q in enumerate(queue):
                            if name < q:
                                break
                            idx = i + 1
                        queue.insert(idx, name)

        # Handle any remaining tables (circular deps)
        remaining = sorted([n for n in all_names if n not in result])
        result.extend(remaining)

        return [table_map[name] for name in result]

    def export_tables(self) -> str:
        """Export CREATE TABLE statements in dependency order."""
        tables = self.get_tables()
        if not tables:
            return ""

        foreign_keys = self.get_foreign_keys()
        deps = self.build_dependency_graph(tables, foreign_keys)
        sorted_tables = self.topological_sort(tables, deps)

        lines = ["-- ============================================================",
                 "-- 2. TABLES (ordered by foreign key dependencies)",
                 "-- ============================================================"]

        for table in sorted_tables:
            schema = self.escape_identifier(table["schema"])
            name = self.escape_identifier(table["name"])
            full_name = f"{schema}.{name}"

            columns = self.get_columns(table["oid"])
            constraints = self.get_constraints(table["oid"])

            lines.append(f"CREATE TABLE IF NOT EXISTS {full_name}")
            lines.append("(")

            # Columns
            col_lines = []
            for col in columns:
                col_def = f'    {self.escape_identifier(col["name"])} {col["type"]}'
                if col["collation"]:
                    col_def += f' {col["collation"]}'
                if col["not_null"]:
                    col_def += " NOT NULL"
                if col["default_value"]:
                    col_def += f' DEFAULT {col["default_value"]}'
                col_lines.append(col_def)

            # Constraints
            for con in constraints:
                col_lines.append(f'    CONSTRAINT {self.escape_identifier(con["name"])} {con["definition"]}')

            lines.append(",\n".join(col_lines))
            lines.append(");")
            lines.append("")

        return "\n".join(lines)

    # =========================================================================
    # ROW LEVEL SECURITY
    # =========================================================================
    def export_rls_enabled(self) -> str:
        """Export ALTER TABLE ENABLE ROW LEVEL SECURITY statements."""
        tables = self.get_tables()
        rls_tables = [t for t in tables if t["rls_enabled"]]
        if not rls_tables:
            return ""

        lines = ["-- ============================================================",
                 "-- 3. ROW LEVEL SECURITY",
                 "-- ============================================================"]

        for table in sorted(rls_tables, key=lambda t: f"{t['schema']}.{t['name']}"):
            full_name = self.format_schema_table(table["schema"], table["name"])
            lines.append(f"ALTER TABLE {full_name} ENABLE ROW LEVEL SECURITY;")

        lines.append("")
        return "\n".join(lines)

    # =========================================================================
    # RLS POLICIES
    # =========================================================================
    def export_policies(self) -> str:
        """Export CREATE POLICY statements."""
        sql = """
            SELECT
                n.nspname AS schema,
                c.relname AS table_name,
                pol.polname AS name,
                CASE pol.polcmd
                    WHEN 'r' THEN 'SELECT'
                    WHEN 'a' THEN 'INSERT'
                    WHEN 'w' THEN 'UPDATE'
                    WHEN 'd' THEN 'DELETE'
                    WHEN '*' THEN 'ALL'
                END AS command,
                CASE pol.polpermissive
                    WHEN TRUE THEN 'PERMISSIVE'
                    ELSE 'RESTRICTIVE'
                END AS permissive,
                pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
                pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check_expr,
                ARRAY(
                    SELECT rolname FROM pg_roles
                    WHERE oid = ANY(pol.polroles)
                    ORDER BY rolname
                ) AS roles
            FROM pg_policy pol
            JOIN pg_class c ON pol.polrelid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE n.nspname = ANY(%s)
            ORDER BY n.nspname, c.relname, pol.polname
        """
        policies = self.query(sql, (self.schemas,))
        if not policies:
            return ""

        lines = ["-- ============================================================",
                 "-- 4. RLS POLICIES",
                 "-- ============================================================"]

        for pol in policies:
            full_name = self.format_schema_table(pol["schema"], pol["table_name"])
            policy_name = self.escape_identifier(pol["name"])

            # Drop existing policy first (policies don't support IF NOT EXISTS)
            lines.append(f"DROP POLICY IF EXISTS {policy_name} ON {full_name};")

            # Build CREATE POLICY
            stmt = f"CREATE POLICY {policy_name}"
            stmt += f"\n    ON {full_name}"
            if pol["permissive"] == "RESTRICTIVE":
                stmt += f"\n    AS RESTRICTIVE"
            stmt += f"\n    FOR {pol['command']}"
            if pol["roles"] and len(pol["roles"]) > 0:
                roles_str = ", ".join(pol["roles"])
                stmt += f"\n    TO {roles_str}"
            if pol["using_expr"]:
                stmt += f"\n    USING ({pol['using_expr']})"
            if pol["with_check_expr"]:
                stmt += f"\n    WITH CHECK ({pol['with_check_expr']})"
            stmt += ";"

            lines.append(stmt)
            lines.append("")

        return "\n".join(lines)

    # =========================================================================
    # FOREIGN KEY CONSTRAINTS
    # =========================================================================
    def export_foreign_keys(self) -> str:
        """Export ALTER TABLE ADD CONSTRAINT for foreign keys."""
        foreign_keys = self.get_foreign_keys()
        if not foreign_keys:
            return ""

        lines = ["-- ============================================================",
                 "-- 5. FOREIGN KEY CONSTRAINTS",
                 "-- ============================================================"]

        for fk in foreign_keys:
            full_name = self.format_schema_table(fk["schema"], fk["table_name"])
            constraint_name = self.escape_identifier(fk["constraint_name"])
            lines.append(f"ALTER TABLE {full_name}")
            lines.append(f"    ADD CONSTRAINT {constraint_name} {fk['definition']};")
            lines.append("")

        return "\n".join(lines)

    # =========================================================================
    # INDEXES
    # =========================================================================
    def export_indexes(self) -> str:
        """Export CREATE INDEX statements."""
        sql = """
            SELECT
                n.nspname AS schema,
                c.relname AS table_name,
                i.relname AS index_name,
                pg_get_indexdef(i.oid) AS definition
            FROM pg_index ix
            JOIN pg_class i ON ix.indexrelid = i.oid
            JOIN pg_class c ON ix.indrelid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE n.nspname = ANY(%s)
                AND NOT ix.indisprimary
                AND NOT ix.indisunique
            ORDER BY n.nspname, c.relname, i.relname
        """
        indexes = self.query(sql, (['public'],))

        # Also get unique indexes that aren't constraints
        sql_unique = """
            SELECT
                n.nspname AS schema,
                c.relname AS table_name,
                i.relname AS index_name,
                pg_get_indexdef(i.oid) AS definition
            FROM pg_index ix
            JOIN pg_class i ON ix.indexrelid = i.oid
            JOIN pg_class c ON ix.indrelid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            LEFT JOIN pg_constraint con ON con.conindid = i.oid
            WHERE n.nspname = ANY(%s)
                AND ix.indisunique
                AND NOT ix.indisprimary
                AND con.oid IS NULL
            ORDER BY n.nspname, c.relname, i.relname
        """
        unique_indexes = self.query(sql_unique, (['public'],))
        all_indexes = indexes + unique_indexes

        if not all_indexes:
            return ""

        # Sort all indexes
        all_indexes.sort(key=lambda x: (x["schema"], x["table_name"], x["index_name"]))

        lines = ["-- ============================================================",
                 "-- 6. INDEXES",
                 "-- ============================================================"]

        for idx in all_indexes:
            # Modify definition to add IF NOT EXISTS
            defn = idx["definition"]
            if "CREATE INDEX" in defn and "IF NOT EXISTS" not in defn:
                defn = defn.replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS", 1)
            elif "CREATE UNIQUE INDEX" in defn and "IF NOT EXISTS" not in defn:
                defn = defn.replace("CREATE UNIQUE INDEX", "CREATE UNIQUE INDEX IF NOT EXISTS", 1)
            lines.append(f"{defn};")

        lines.append("")
        return "\n".join(lines)

    # =========================================================================
    # FUNCTIONS
    # =========================================================================
    def export_functions(self) -> str:
        """Export CREATE FUNCTION statements."""
        sql = """
            SELECT
                n.nspname AS schema,
                p.proname AS name,
                pg_get_function_identity_arguments(p.oid) AS args,
                pg_get_functiondef(p.oid) AS definition
            FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = ANY(%s)
                AND p.prokind = 'f'
            ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
        """
        functions = self.query(sql, (['public'],))
        if not functions:
            return ""

        lines = ["-- ============================================================",
                 "-- 7. FUNCTIONS",
                 "-- ============================================================"]

        for func in functions:
            if func["definition"]:
                # Ensure it's CREATE OR REPLACE
                defn = func["definition"]
                if defn.startswith("CREATE FUNCTION"):
                    defn = defn.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1)
                lines.append(defn)
                if not defn.rstrip().endswith(";"):
                    lines.append(";")
                lines.append("")

        return "\n".join(lines)

    # =========================================================================
    # TRIGGERS
    # =========================================================================
    def export_triggers(self) -> str:
        """Export CREATE TRIGGER statements."""
        sql = """
            SELECT
                n.nspname AS schema,
                c.relname AS table_name,
                t.tgname AS name,
                pg_get_triggerdef(t.oid) AS definition
            FROM pg_trigger t
            JOIN pg_class c ON t.tgrelid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE n.nspname = ANY(%s)
                AND NOT t.tgisinternal
            ORDER BY n.nspname, c.relname, t.tgname
        """
        triggers = self.query(sql, (['public'],))
        if not triggers:
            return ""

        lines = ["-- ============================================================",
                 "-- 8. TRIGGERS",
                 "-- ============================================================"]

        for trig in triggers:
            full_name = self.format_schema_table(trig["schema"], trig["table_name"])
            trig_name = self.escape_identifier(trig["name"])

            # Drop first since triggers don't support IF NOT EXISTS
            lines.append(f"DROP TRIGGER IF EXISTS {trig_name} ON {full_name};")

            # Sanitize secrets from trigger definitions (e.g. webhook Authorization headers)
            defn = trig["definition"]
            # Redact Bearer tokens (JWTs and other bearer auth)
            defn = re.sub(r'Bearer\s+[A-Za-z0-9_\-\.]+', 'Bearer [REDACTED]', defn)
            # Redact any remaining JWT-like patterns (three base64 segments separated by dots)
            defn = re.sub(r'eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+', '[REDACTED_JWT]', defn)

            lines.append(f"{defn};")
            lines.append("")

        return "\n".join(lines)

    # =========================================================================
    # VIEWS
    # =========================================================================
    def export_views(self) -> str:
        """Export CREATE VIEW statements."""
        sql = """
            SELECT
                n.nspname AS schema,
                c.relname AS name,
                pg_get_viewdef(c.oid, true) AS definition
            FROM pg_class c
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE c.relkind = 'v'
                AND n.nspname = ANY(%s)
            ORDER BY n.nspname, c.relname
        """
        views = self.query(sql, (['public'],))
        if not views:
            return ""

        lines = ["-- ============================================================",
                 "-- 9. VIEWS",
                 "-- ============================================================"]

        for view in views:
            full_name = self.format_schema_table(view["schema"], view["name"])
            lines.append(f"CREATE OR REPLACE VIEW {full_name} AS")
            lines.append(view["definition"].rstrip(";") + ";")
            lines.append("")

        return "\n".join(lines)

    # =========================================================================
    # COMMENTS
    # =========================================================================
    def export_comments(self) -> str:
        """Export COMMENT ON statements."""
        # Table comments
        sql_tables = """
            SELECT
                n.nspname AS schema,
                c.relname AS table_name,
                d.description
            FROM pg_description d
            JOIN pg_class c ON d.objoid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE d.objsubid = 0
                AND c.relkind = 'r'
                AND n.nspname = ANY(%s)
                AND d.description IS NOT NULL
            ORDER BY n.nspname, c.relname
        """
        table_comments = self.query(sql_tables, (['public'],))

        # Column comments
        sql_columns = """
            SELECT
                n.nspname AS schema,
                c.relname AS table_name,
                a.attname AS column_name,
                d.description
            FROM pg_description d
            JOIN pg_class c ON d.objoid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
            WHERE d.objsubid > 0
                AND c.relkind = 'r'
                AND n.nspname = ANY(%s)
                AND d.description IS NOT NULL
                AND NOT a.attisdropped
            ORDER BY n.nspname, c.relname, a.attnum
        """
        column_comments = self.query(sql_columns, (['public'],))

        if not table_comments and not column_comments:
            return ""

        lines = ["-- ============================================================",
                 "-- 10. COMMENTS",
                 "-- ============================================================"]

        def escape_comment(text: str) -> str:
            """Escape single quotes in comment text."""
            return text.replace("'", "''") if text else ""

        for tc in table_comments:
            full_name = self.format_schema_table(tc["schema"], tc["table_name"])
            comment = escape_comment(tc["description"])
            lines.append(f"COMMENT ON TABLE {full_name}")
            lines.append(f"    IS '{comment}';")
            lines.append("")

        for cc in column_comments:
            full_name = self.format_schema_table(cc["schema"], cc["table_name"])
            col_name = self.escape_identifier(cc["column_name"])
            comment = escape_comment(cc["description"])
            lines.append(f"COMMENT ON COLUMN {full_name}.{col_name}")
            lines.append(f"    IS '{comment}';")
            lines.append("")

        return "\n".join(lines)

    # =========================================================================
    # STORAGE BUCKETS
    # =========================================================================
    def export_storage_buckets(self) -> str:
        """Export storage bucket configuration."""
        if "storage" not in self.schemas:
            return ""

        sql = """
            SELECT
                id,
                name,
                public,
                file_size_limit,
                allowed_mime_types
            FROM storage.buckets
            ORDER BY name
        """
        try:
            buckets = self.query(sql)
        except Exception:
            return ""

        if not buckets:
            return ""

        lines = ["-- ============================================================",
                 "-- 11. STORAGE BUCKETS",
                 "-- ============================================================"]

        for bucket in buckets:
            public_val = "true" if bucket["public"] else "false"
            file_limit = bucket["file_size_limit"] if bucket["file_size_limit"] else "NULL"

            if bucket["allowed_mime_types"]:
                mime_types = "ARRAY[" + ", ".join(f"'{m}'" for m in bucket["allowed_mime_types"]) + "]"
            else:
                mime_types = "NULL"

            lines.append(f"INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)")
            lines.append(f"VALUES ('{bucket['id']}', '{bucket['name']}', {public_val}, {file_limit}, {mime_types})")
            lines.append("ON CONFLICT (id) DO NOTHING;")
            lines.append("")

        return "\n".join(lines)

    # =========================================================================
    # MAIN EXPORT
    # =========================================================================
    def export(self) -> str:
        """Export complete schema."""
        self.connect()

        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        # Mask password in URL for display
        sections = [
            f"-- ============================================================",
            f"-- Jigged Manufacturing ERP - Database Schema",
            f"-- Generated: {timestamp}",
            f"-- Schemas: {', '.join(self.schemas)}",
            f"-- ============================================================",
            "",
            "BEGIN;",
            "",
            self.export_types(),
            self.export_tables(),
            self.export_rls_enabled(),
            self.export_policies(),
            self.export_foreign_keys(),
            self.export_indexes(),
            self.export_functions(),
            self.export_triggers(),
            self.export_views(),
            self.export_comments(),
            self.export_storage_buckets(),
            "COMMIT;",
            "",
        ]

        self.close()

        # Filter out empty sections and join
        return "\n".join(s for s in sections if s is not None)


def main():
    parser = argparse.ArgumentParser(
        description="Export PostgreSQL/Supabase database schema with deterministic ordering",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Export using PROD_SUPABASE_DATABASE_URL environment variable
    PROD_SUPABASE_DATABASE_URL=postgresql://user:pass@host:5432/db python scripts/export_schema.py

    # Export to custom output file
    PROD_SUPABASE_DATABASE_URL=... python scripts/export_schema.py --output /path/to/schema.sql

    # Export specific schemas only
    PROD_SUPABASE_DATABASE_URL=... python scripts/export_schema.py --schemas public

    # Dry run - print to stdout
    PROD_SUPABASE_DATABASE_URL=... python scripts/export_schema.py --dry-run
        """,
    )

    parser.add_argument(
        "--output",
        "-o",
        default="supabase/schema.sql",
        help="Output file path (default: supabase/schema.sql)",
    )
    parser.add_argument(
        "--schemas",
        "-s",
        nargs="+",
        default=["public", "storage"],
        help="Schemas to export (default: public storage)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print to stdout instead of writing to file",
    )

    args = parser.parse_args()

    # Get database URL (production is the schema source of truth)
    SUPABASE_DATABASE_URL = os.environ.get("PROD_SUPABASE_DATABASE_URL")
    if not SUPABASE_DATABASE_URL:
        print("Error: PROD_SUPABASE_DATABASE_URL environment variable is required", file=sys.stderr)
        print("Example: PROD_SUPABASE_DATABASE_URL=postgresql://user:pass@host:5432/db", file=sys.stderr)
        sys.exit(1)

    # Export schema
    exporter = SchemaExporter(SUPABASE_DATABASE_URL, args.schemas)
    sql = exporter.export()

    if args.dry_run:
        print(sql)
    else:
        # Resolve output path relative to script location
        output_path = args.output
        if not os.path.isabs(output_path):
            script_dir = os.path.dirname(os.path.abspath(__file__))
            project_root = os.path.dirname(script_dir)
            output_path = os.path.join(project_root, output_path)

        # Ensure directory exists
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        with open(output_path, "w") as f:
            f.write(sql)
        print(f"Schema exported to {output_path}")
        print(f"Schemas included: {', '.join(args.schemas)}")


if __name__ == "__main__":
    main()
