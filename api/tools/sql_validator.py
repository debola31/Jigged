"""
SQL query validator for AI-generated queries.

Validates that queries are safe to execute:
- SELECT-only (no mutations)
- Contains the company_id placeholder ($1)
- Names no denylisted table, whole-word, however it is referenced
- No dangerous patterns

WHAT THIS FILE IS NOT. It is not the boundary on which tables are readable.
That is a SELECT grant to jigged_ai_readonly AND an ai_readonly_select policy
scoping it to one company -- BOTH, applied together by
public.apply_ai_read_access() in migration 20260826010319, which also deleted
the hand-written allowlist this file used to enforce. The grant alone decides
nothing: the baseline's ALTER DEFAULT PRIVILEGES hands one to this role on
nearly every public table, and it is the policy that makes rows visible. A table
the role cannot read fails in Postgres -- as `permission denied` where the grant
is missing, or as zero rows where the policy is -- and that goes back to the
model as tool output either way.
"""

import re

from .schema_context import SENSITIVE_TABLES

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

# Non-public SCHEMAS, refused whole. The sandbox has USAGE on public and
# nowhere else, so this changes no outcome -- it makes the refusal immediate
# and legible instead of a Postgres error, and it is the one exclusion that
# does NOT grow with our schema. auth.users is the reason it exists: the old
# table allowlist happened to reject it as a side effect of not listing it,
# and deleting that allowlist would otherwise have lost the early refusal on
# the most sensitive table in the system.
_FORBIDDEN_SCHEMA_PATTERN = re.compile(
    r"\b(auth|storage|vault|extensions|graphql|graphql_public|realtime|"
    r"supabase_functions|supabase_migrations|net|cron|pgsodium|pgbouncer)\s*\.",
    re.IGNORECASE,
)

# SELECT INTO is a mutation (creates a table)
_SELECT_INTO = re.compile(r"\bSELECT\b.*\bINTO\b", re.IGNORECASE | re.DOTALL)

# The clock, refused so the caller's day boundary is the only one available.
#
# This database is UTC. A shop in the Americas is hours behind it, so for part of
# every evening CURRENT_DATE is already tomorrow and "past its due date" is true a
# day early -- which is how the chat and the jobs list came to disagree about which
# jobs were late. The executor binds the CALLER's local date as $2, the same date
# the jobs list already threads into SQL as p_today.
#
# THIS RULE IS THE MECHANICAL HALF OF THE FIX, and the only half worth automating.
# "Did you filter deleted_at?" cannot be decided by looking at a query -- that one
# is enforced in RLS instead. "Did you read the clock?" is exactly a regex.
#
# now() is matched with its parens so a column or alias merely CALLED now is not
# refused; the bare words CURRENT_DATE / CURRENT_TIMESTAMP / LOCALTIMESTAMP are
# reserved and cannot be identifiers, so \b is enough for them.
_FORBIDDEN_CLOCK = re.compile(
    r"\b(CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIMESTAMP|LOCALTIME|now\s*\(\s*\)|"
    r"statement_timestamp\s*\(\s*\)|transaction_timestamp\s*\(\s*\)|"
    r"clock_timestamp\s*\(\s*\))",
    re.IGNORECASE,
)

# THE BOUND DATE HAS NO TYPE UNTIL SOMETHING GIVES IT ONE.
#
# $2 is a parameter, so Postgres infers its type from context. Compared against a
# typed column it does -- `due_date < $2` resolves to date, `created_at >= $2` to
# timestamptz -- and a declared parameter position does too, which is why a bare
# $2 inside public.is_job_late(...) is correct. Handed to an overloaded date
# function, or to interval arithmetic, there is nothing to infer from, and the
# query dies on a message that never mentions casting:
#
#     function date_trunc(unknown, unknown) is not unique
#     operator does not exist: timestamp with time zone >= interval
#
# THE SAME ARGUMENT AS THE CLOCK RULE ABOVE. semantics.md states this in bold and
# gives both examples, and a local model drops the cast anyway. In the Gate 2
# five-arm run it accounted for one of eight SQL failures -- but for THE one: the
# average-job-value question, which this whole line of work exists to get right.
# That arm had reproduced the canonical query at 0.988 similarity and dropped
# exactly this token, while the arm denied that exemplar wrote its own query and
# got the right figure. Handing Postgres's message back did not fix it --
# the retry made the same mistake -- because the message does not say what to do.
# "Did you forget the cast?" is a regex; this is that regex.
#
# The positions listed are the ones that actually fail, established by running
# each shape against Postgres rather than reasoning about overload resolution.
# `(?!\d)` keeps $2 from matching inside $20, matching the executor's own bind
# check -- disagreeing with it would refuse a query it would happily run.
_UNTYPED_TODAY = re.compile(
    r"\bDATE_TRUNC\s*\(\s*[^,()]+,\s*\$2(?!\d)(?!\s*::)"
    r"|\bEXTRACT\s*\([^()]*?\bFROM\s+\$2(?!\d)(?!\s*::)"
    r"|\bAGE\s*\(\s*\$2(?!\d)(?!\s*::)"
    r"|\$2(?!\d)(?!\s*::)\s*[-+]\s*INTERVAL\b"
    r"|\bINTERVAL\s*'[^']*'\s*[-+]\s*\$2(?!\d)(?!\s*::)",
    re.IGNORECASE,
)

# Whole-word denylist: reject if any sensitive/auth table name appears
# anywhere in the query, however it is referenced. Not a second boundary --
# it refuses before the round trip and returns a sentence the model can act
# on, where the database would return a bare `permission denied`.
_SENSITIVE_TABLE_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(t) for t in sorted(SENSITIVE_TABLES)) + r")\b",
    re.IGNORECASE,
)


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

    # 5b. The clock. Refused so today has exactly one source: the bound $2.
    clock = _FORBIDDEN_CLOCK.search(cleaned)
    if clock:
        return False, (
            f"{clock.group(1)} is not available. Use $2 for today's date -- it is "
            f"bound to the date where the user actually is. The database runs in "
            f"UTC and would call a job late hours before the shop's day ends."
        )

    # 5c. The bound date, used where nothing can type it.
    if _UNTYPED_TODAY.search(cleaned):
        return False, (
            "$2 has no type of its own in this expression, so Postgres cannot "
            "resolve it -- write $2::date. Comparing $2 against a typed column is "
            "fine, and so is passing it to a function that declares its parameter "
            "type; handing it to DATE_TRUNC, EXTRACT, AGE or interval arithmetic "
            "is not."
        )

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

    # 7b. Anything outside the public schema.
    off_schema = _FORBIDDEN_SCHEMA_PATTERN.search(cleaned)
    if off_schema:
        return False, (
            f"Query references the {off_schema.group(1).lower()} schema. "
            f"Only the public schema is available."
        )

    # 8. The table allowlist used to live here, and deleting it is the point of
    # 20260826010319. It duplicated a decision the database already owns, and the
    # copy cost three things: it DRIFTED (19 names against 21 grants); it could
    # not see through a function call, so it passed queries calling
    # public.job_last_ship_date() that Postgres then refused on `shipments`; and
    # it rejected every CTE whose alias was not coincidentally a table name,
    # against a tool description that promises WITH is supported.

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
