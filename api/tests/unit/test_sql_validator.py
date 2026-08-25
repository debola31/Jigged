"""
Unit tests for SQL query validator.

Tests validation rules that prevent unsafe or malformed queries
from reaching the database.
"""

import pytest

from tools.sql_validator import validate_query


class TestBasicValidation:
    """Tests for basic query structure validation."""

    def test_empty_query_rejected(self):
        valid, msg = validate_query("")
        assert not valid
        assert "empty" in msg.lower()

    def test_whitespace_only_rejected(self):
        valid, msg = validate_query("   \n  ")
        assert not valid

    def test_none_rejected(self):
        valid, msg = validate_query(None)
        assert not valid

    def test_simple_select_accepted(self):
        valid, _ = validate_query(
            "SELECT id, name FROM customers WHERE company_id = $1"
        )
        assert valid

    def test_select_with_trailing_semicolon(self):
        valid, _ = validate_query(
            "SELECT id FROM customers WHERE company_id = $1;"
        )
        assert valid

    def test_cte_alias_treated_as_table(self):
        """CTE aliases are checked against the allowlist (known limitation).

        The validator's regex can't distinguish CTE aliases from real tables,
        so CTEs must use names that match allowed tables, or the outer SELECT
        must reference a real allowed table.
        """
        # CTE alias "recent" is not in ALLOWED_TABLES, so this fails
        valid, msg = validate_query(
            "WITH recent AS (SELECT * FROM jobs WHERE company_id = $1) "
            "SELECT * FROM recent"
        )
        assert not valid
        assert "restricted" in msg.lower()

    def test_cte_with_allowed_table_in_outer(self):
        """CTE works when the outer query references an allowed table."""
        valid, _ = validate_query(
            "WITH job_counts AS (SELECT customer_id, COUNT(*) AS cnt "
            "FROM jobs WHERE company_id = $1 GROUP BY customer_id) "
            "SELECT c.name, jc.cnt FROM customers c "
            "JOIN jobs ON c.id = jobs.customer_id "
            "WHERE c.company_id = $1"
        )
        assert valid


class TestForbiddenStatements:
    """Tests that mutation statements are blocked."""

    @pytest.mark.parametrize("keyword", [
        "INSERT", "UPDATE", "DELETE", "DROP", "ALTER",
        "CREATE", "TRUNCATE", "GRANT", "REVOKE",
    ])
    def test_mutation_keywords_rejected(self, keyword):
        valid, msg = validate_query(f"{keyword} something")
        assert not valid
        assert "forbidden" in msg.lower() or "must start with" in msg.lower()

    def test_select_into_rejected(self):
        valid, msg = validate_query(
            "SELECT id INTO new_table FROM customers WHERE company_id = $1"
        )
        assert not valid
        assert "SELECT INTO" in msg

    def test_multiple_statements_rejected(self):
        valid, msg = validate_query(
            "SELECT 1 FROM customers WHERE company_id = $1; DROP TABLE customers"
        )
        assert not valid
        assert "Multiple statements" in msg

    def test_semicolon_inside_string_allowed(self):
        valid, _ = validate_query(
            "SELECT id FROM customers WHERE company_id = $1 AND name = 'foo;bar'"
        )
        assert valid


class TestForbiddenPatterns:
    """Tests that dangerous functions and system catalog access are blocked."""

    @pytest.mark.parametrize("pattern", [
        "pg_sleep", "pg_catalog", "information_schema",
        "set_config", "current_setting", "dblink",
        "pg_read_file", "pg_ls_dir",
    ])
    def test_dangerous_functions_rejected(self, pattern):
        valid, msg = validate_query(
            f"SELECT {pattern}('x') FROM customers WHERE company_id = $1"
        )
        assert not valid
        assert "Forbidden pattern" in msg


class TestCompanyIdPlaceholder:
    """Tests that $1 placeholder is required for company_id scoping."""

    def test_missing_placeholder_rejected(self):
        valid, msg = validate_query("SELECT id FROM customers")
        assert not valid
        assert "$1" in msg

    def test_placeholder_present_accepted(self):
        valid, _ = validate_query(
            "SELECT id FROM customers WHERE company_id = $1"
        )
        assert valid

    def test_placeholder_in_subquery_accepted(self):
        valid, _ = validate_query(
            "SELECT * FROM jobs WHERE company_id IN "
            "(SELECT company_id FROM customers WHERE company_id = $1)"
        )
        assert valid


class TestTableAllowlist:
    """Tests that only allowed business tables can be queried."""

    def test_allowed_table_accepted(self):
        valid, _ = validate_query(
            "SELECT id FROM customers WHERE company_id = $1"
        )
        assert valid

    def test_system_table_rejected(self):
        valid, msg = validate_query(
            "SELECT * FROM auth_users WHERE company_id = $1"
        )
        assert not valid
        assert "restricted" in msg.lower()

    def test_join_with_allowed_tables(self):
        valid, _ = validate_query(
            "SELECT j.id, c.name FROM jobs j "
            "JOIN customers c ON j.customer_id = c.id "
            "WHERE j.company_id = $1"
        )
        assert valid

    def test_join_with_restricted_table(self):
        valid, msg = validate_query(
            "SELECT * FROM customers "
            "JOIN user_company_access ON true "
            "WHERE customers.company_id = $1"
        )
        assert not valid
        assert "restricted" in msg.lower()


class TestSubqueryDepth:
    """Tests that deeply nested subqueries are rejected."""

    def test_depth_3_accepted(self):
        valid, _ = validate_query(
            "SELECT * FROM customers WHERE company_id = $1 "
            "AND id IN (SELECT customer_id FROM jobs WHERE id IN "
            "(SELECT job_id FROM job_operations WHERE id IN "
            "(SELECT id FROM job_operations)))"
        )
        assert valid

    def test_depth_4_rejected(self):
        valid, msg = validate_query(
            "SELECT * FROM customers WHERE company_id = $1 "
            "AND id IN (SELECT customer_id FROM jobs WHERE id IN "
            "(SELECT job_id FROM job_operations WHERE id IN "
            "(SELECT id FROM job_operations WHERE id IN "
            "(SELECT id FROM job_operations))))"
        )
        assert not valid
        assert "nesting" in msg.lower()


class TestEdgeCases:
    """Tests for edge cases and regression prevention."""

    def test_quoted_table_names(self):
        valid, _ = validate_query(
            'SELECT id FROM "customers" WHERE company_id = $1'
        )
        assert valid

    def test_multiline_query(self):
        valid, _ = validate_query("""
            SELECT
                c.name,
                COUNT(j.id) as job_count
            FROM customers c
            LEFT JOIN jobs j ON j.customer_id = c.id
            WHERE c.company_id = $1
            GROUP BY c.name
        """)
        assert valid

    def test_aggregate_query(self):
        valid, _ = validate_query(
            "SELECT COUNT(*), SUM(quantity) FROM job_operations "
            "WHERE company_id = $1"
        )
        assert valid


class TestSensitiveTableDenylist:
    """Sensitive auth/system tables are rejected however they're referenced."""

    @pytest.mark.parametrize("table", [
        "user_company_access", "system_admins", "ai_config",
        "ai_chat_queries", "user_preferences", "auth_audit_log",
        # The AI layer's own tables. ai_calls answers "what are we spending on
        # AI?" and ai_jobs.payload carries other companies' questions, so both
        # are exactly the shape of thing an owner might reasonably ask about and
        # must never be able to reach.
        "ai_calls", "ai_jobs", "ai_workers",
    ])
    def test_sensitive_table_in_from_rejected(self, table):
        valid, msg = validate_query(
            f"SELECT * FROM {table} WHERE company_id = $1"
        )
        assert not valid
        assert "restricted" in msg.lower()

    def test_sensitive_table_in_comma_join_rejected(self):
        # Comma-join: the old regex only saw the first table; the denylist
        # guarantees the restricted table is still caught.
        valid, msg = validate_query(
            "SELECT * FROM jobs, user_company_access WHERE jobs.company_id = $1"
        )
        assert not valid
        assert "user_company_access" in msg.lower()

    def test_sensitive_table_in_subquery_rejected(self):
        valid, msg = validate_query(
            "SELECT * FROM jobs WHERE company_id = $1 "
            "AND id IN (SELECT id FROM ai_config)"
        )
        assert not valid
        assert "restricted" in msg.lower()

    def test_schema_qualified_sensitive_table_rejected(self):
        valid, msg = validate_query(
            "SELECT * FROM public.user_company_access WHERE company_id = $1"
        )
        assert not valid
        assert "restricted" in msg.lower()


class TestTableExtractionHardening:
    """Regression tests for comma-joins and schema-qualified table names."""

    def test_comma_join_disallowed_table_rejected(self):
        # 'auth_users' is not on the sensitive denylist, but must still fail the
        # allowlist even in a comma-join (the old regex saw only the first table).
        valid, msg = validate_query(
            "SELECT * FROM jobs, auth_users WHERE jobs.company_id = $1"
        )
        assert not valid
        assert "restricted" in msg.lower()

    def test_comma_join_allowed_tables_accepted(self):
        valid, _ = validate_query(
            "SELECT j.id, c.name FROM jobs, customers "
            "WHERE jobs.customer_id = customers.id AND jobs.company_id = $1"
        )
        assert valid

    def test_schema_qualified_allowed_table_accepted(self):
        # 'public.customers' must normalize to 'customers' (the old regex
        # captured 'public' and wrongly rejected this).
        valid, _ = validate_query(
            "SELECT id FROM public.customers WHERE company_id = $1"
        )
        assert valid

    def test_schema_qualified_disallowed_table_rejected(self):
        valid, msg = validate_query(
            "SELECT * FROM public.auth_users WHERE company_id = $1"
        )
        assert not valid
        assert "restricted" in msg.lower()
