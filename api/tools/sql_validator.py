"""
SQL query validator for AI-generated queries.

Validates that queries are safe to execute:
- SELECT-only (no mutations)
- References only allowed tables
- Contains company_id placeholder ($1)
- No dangerous patterns
"""

import re

from .schema_context import ALLOWED_TABLES, SENSITIVE_TABLES

# Statements that are NOT allowed
_FORBIDDEN_STATEMENT_TYPES = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|EXECUTE|CALL)\b",
    re.IGNORECASE,
)

# Dangerous functions and system access
_FORBIDDEN_PATTERNS = re.compile(
    r"\b(pg_sleep|pg_catalog|information_schema|pg_tables|pg_views|"
    r"set_config|current_setting|lo_import|lo_export|"
    r"dblink|pg_read_file|pg_ls_dir)\b",
    re.IGNORECASE,
)

# SELECT INTO is a mutation (creates a table)
_SELECT_INTO = re.compile(r"\bSELECT\b.*\bINTO\b", re.IGNORECASE | re.DOTALL)

# Capture the table list immediately after FROM / JOIN: one or more
# comma-separated table references, each optionally schema-qualified and/or
# double-quoted (e.g. `jobs`, `public.customers`, `"work_centers"`,
# `FROM jobs, parts`). Comma-joins that interleave aliases ("FROM a x, b y")
# aren't fully parsed here — the SENSITIVE_TABLES denylist is the guaranteed
# backstop for restricted tables regardless of query shape.
_TABLE_LIST_AFTER_FROM_JOIN = re.compile(
    r'(?:\bFROM\b|\bJOIN\b)\s+'
    r'("?\w+"?(?:\."?\w+"?)?'
    r'(?:\s*,\s*"?\w+"?(?:\."?\w+"?)?)*)',
    re.IGNORECASE,
)

# Guaranteed-catch denylist: reject if any sensitive/auth table name appears
# anywhere in the query as a whole word, however it's referenced.
_SENSITIVE_TABLE_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(t) for t in sorted(SENSITIVE_TABLES)) + r")\b",
    re.IGNORECASE,
)


def _normalize_table_token(token: str) -> str:
    """Strip quotes and any schema prefix -> bare lowercase table name.

    `"public"."user_company_access"` -> `user_company_access`.
    """
    token = token.replace('"', "").strip()
    if "." in token:
        token = token.rsplit(".", 1)[-1]
    return token.lower()


def _extract_table_names(cleaned: str) -> set[str]:
    """Extract referenced table names from FROM/JOIN clauses (allowlist check)."""
    tables: set[str] = set()
    for m in _TABLE_LIST_AFTER_FROM_JOIN.finditer(cleaned):
        for part in m.group(1).split(","):
            name = _normalize_table_token(part)
            if name:
                tables.add(name)
    return tables


def validate_query(sql: str) -> tuple[bool, str]:
    """
    Validate an AI-generated SQL query before execution.

    Args:
        sql: The SQL query string to validate.

    Returns:
        Tuple of (is_valid, error_message).
        If valid, error_message is empty string.
    """
    if not sql or not sql.strip():
        return False, "Query is empty."

    cleaned = sql.strip().rstrip(";").strip()

    # 1. Check for multiple statements (semicolon in the middle)
    # Allow semicolons inside string literals by checking outside quotes
    in_single_quote = False
    for i, ch in enumerate(cleaned):
        if ch == "'" and (i == 0 or cleaned[i - 1] != "\\"):
            in_single_quote = not in_single_quote
        elif ch == ";" and not in_single_quote:
            return False, "Multiple statements are not allowed. Send one SELECT at a time."

    # 2. Must start with SELECT or WITH (for CTEs)
    first_keyword = cleaned.split()[0].upper() if cleaned.split() else ""
    if first_keyword not in ("SELECT", "WITH"):
        return False, f"Query must start with SELECT or WITH. Got: {first_keyword}"

    # 3. Check for forbidden statement types
    match = _FORBIDDEN_STATEMENT_TYPES.search(cleaned)
    if match:
        return False, f"Forbidden keyword: {match.group(1).upper()}. Only SELECT queries are allowed."

    # 4. Check for SELECT INTO
    if _SELECT_INTO.search(cleaned):
        return False, "SELECT INTO is not allowed. Use a plain SELECT."

    # 5. Check for dangerous patterns
    match = _FORBIDDEN_PATTERNS.search(cleaned)
    if match:
        return False, f"Forbidden pattern: {match.group(1)}. System catalog access is not allowed."

    # 6. Check for $1 placeholder (company_id scoping)
    if "$1" not in cleaned:
        return False, "Query must include $1 placeholder for company_id filtering."

    # 7. Guaranteed-catch denylist: sensitive/auth tables are never allowed,
    # even if the table extraction below misses an unusual reference form.
    deny = _SENSITIVE_TABLE_PATTERN.search(cleaned)
    if deny:
        return False, (
            f"Query references restricted table(s): {deny.group(1).lower()}. "
            f"Only business tables are allowed."
        )

    # 8. Extract and validate table references against the allowlist.
    tables_found = _extract_table_names(cleaned)
    disallowed = tables_found - ALLOWED_TABLES
    if disallowed:
        return False, (
            f"Query references restricted table(s): {', '.join(sorted(disallowed))}. "
            f"Only business tables are allowed."
        )

    # 9. Check subquery depth (max 3 levels)
    depth = 0
    max_depth = 0
    for ch in cleaned:
        if ch == "(":
            depth += 1
            max_depth = max(max_depth, depth)
        elif ch == ")":
            depth -= 1
    if max_depth > 3:
        return False, f"Query has {max_depth} levels of nesting. Maximum is 3."

    return True, ""
