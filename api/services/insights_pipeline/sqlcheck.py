"""Catch an invented column before spending a round trip on it.

WHAT THIS IS FOR, PRECISELY. Every SQL failure in the Gate 2 eval run was a
column that does not exist, on a table whose real columns were already in the
prompt -- due_at, jp.true_cost, jp.quote_id, job_operations.work_centre,
company_id. Postgres catches all of them. This catches them without a connection,
a 5-second statement timeout and a round trip, and -- the part that matters more
-- it makes "the model invented a column" its own line in the dump instead of one
more `sql_error` indistinguishable from a syntax slip or a timeout.

WHAT IT IS NOT. It is not a boundary, not a validator, and not a parser. There is
no sqlglot in this repo and adding one for this would walk into the same argument
api/requirements.txt already had about psycopg2-binary and wheel weight. This is a
lexical check with an explicit bias: it flags only what it can resolve, and every
ambiguity resolves to "allow".

THE BIAS IS THE DESIGN. A false negative costs a round trip Postgres was going to
refuse anyway. A false positive burns the single regeneration and can turn a
correct answer into a failure. So an unresolvable alias is skipped, an unknown
construct is skipped, and a bare identifier is checked against the UNION of every
referenced table rather than any one of them. The guard on all of that is
test_no_reference_query_in_semantics_is_rejected, which runs the ten known-good
reference queries -- the ones CI executes for real under jigged_ai_readonly --
through this module and fails if any is flagged.
"""
from __future__ import annotations

import re
from functools import lru_cache

# Stripped before anything else is read, so a column name inside a string literal
# or a comment can never be mistaken for a reference.
_LINE_COMMENT = re.compile(r"--[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_STRING_LITERAL = re.compile(r"'(?:[^']|'')*'")
_CAST = re.compile(r"::\s*\w+")

_IDENTIFIER = re.compile(r"\b([a-z_][a-z0-9_]*)\b", re.I)
# The select list: everything between the first SELECT and its FROM, at depth 0.
_SELECT_LIST = re.compile(r"\bSELECT\b(.*?)\bFROM\b", re.I | re.S)
_OUTPUT_LABEL = re.compile(r"\bAS\s+[a-z_][a-z0-9_]*", re.I)
_QUALIFIED = re.compile(r"\b([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)\b", re.I)

# FROM/JOIN <table> [AS] [alias]
_TABLE_REF = re.compile(
    r"\b(?:FROM|JOIN)\s+(?:public\s*\.\s*)?([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?",
    re.I,
)
# A name introduced by the query rather than by the schema.
_CTE = re.compile(r"(?:\bWITH\b|,)\s*([a-z_][a-z0-9_]*)\s+AS\s*\(", re.I)
_LABEL = re.compile(r"\bAS\s+([a-z_][a-z0-9_]*)", re.I)
_SUBQUERY_ALIAS = re.compile(r"\)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)", re.I)

# Reserved words, type names and anything else that is not a column. Generous on
# purpose: a word wrongly listed here is a missed catch, a word wrongly ABSENT is
# a rejected valid query, and only the second one hurts.
_RESERVED = frozenset(
    """
    select from where join inner left right full outer cross on using and or not null is
    as group by order having limit offset distinct all union except intersect with
    case when then else end filter over partition between like ilike similar in exists
    any some asc desc nulls first last returning lateral natural
    true false unknown interval current_date current_time current_timestamp localtime
    localtimestamp now cast coalesce nullif greatest least
    date time timestamp timestamptz text varchar char numeric decimal integer int bigint
    smallint boolean bool uuid jsonb json real double precision float serial money bytea
    year month day hour minute second quarter week epoch dow doy
    """.split()
)


@lru_cache(maxsize=1)
def declared_columns() -> dict[str, frozenset[str]]:
    """Every column SCHEMA_CONTEXT declares, keyed by table.

    Parsed from the same blocks the generation prompt ships, which is the point:
    the check can only ever be as good as what the model was shown.
    """
    from services.insights_pipeline.retrieval import load_cards

    out: dict[str, frozenset[str]] = {}
    for card in load_cards():
        names: set[str] = set()
        for line in card.block.splitlines():
            stripped = line.strip()
            if not stripped.startswith("- "):
                continue
            body = _LINE_COMMENT.sub("", stripped[2:]).strip()
            if not body or body.upper().startswith("NOTE:"):
                continue
            # `- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ` declares two.
            names.update(m.group(1).lower() for m in re.finditer(r"\b([a-z_][a-z0-9_]*)\s*:", body, re.I))
        out[card.name] = frozenset(names)
    return out


@lru_cache(maxsize=1)
def columns_by_table() -> dict[str, frozenset[str]]:
    """Alias kept for callers; the declared set is the only set."""
    return declared_columns()


@lru_cache(maxsize=1)
def known_columns() -> frozenset[str]:
    """Every column name SCHEMA_CONTEXT declares ANYWHERE, table forgotten.

    THE CHECK IS GLOBAL RATHER THAN PER-TABLE, AND THAT IS A CORRECTION.
    Per-table looks strictly better and is unsound here, because SCHEMA_CONTEXT is
    incomplete: it declares `deleted_at` on customers, vendors, work_centers and
    vendor_services and on no other table, while jobs, quotes and parts all have
    the column in the database. A per-table rule therefore rejects `j.deleted_at`
    with the message "column j.deleted_at does not exist on jobs", which is false.

    An error message that lies to the model is worse than the mistake it is
    reporting: it spends the single regeneration, and it teaches the model
    something untrue about the schema on the way. The two cases are structurally
    identical from here -- `jp.quote_id` (quote_id is declared on jobs; job_parts
    almost certainly has no such column) and `j.deleted_at` (deleted_at is declared
    on customers; jobs certainly does have one) -- and nothing in SCHEMA_CONTEXT
    distinguishes them, so per-table precision cannot be had honestly.

    Global is sound for the reason that matters: the model can only see the schema
    blocks it was given, so a name appearing nowhere in them is one it invented.

    WHAT THIS GIVES UP, stated rather than discovered later: a column used against
    the WRONG table still passes when some other table declares it. Of the five
    invented columns in the Gate 2 run it catches due_at, true_cost and
    work_centre, and misses jp.quote_id and the bare company_id. Postgres catches
    both of those on the next line anyway; this layer only ever saved the round
    trip.
    """
    return frozenset().union(*declared_columns().values())


def _strip_noise(sql: str) -> str:
    sql = _BLOCK_COMMENT.sub(" ", sql)
    sql = _LINE_COMMENT.sub(" ", sql)
    # A SPACE, not a placeholder word: substituting `'literal'` put a fresh
    # identifier into the very text being scanned for identifiers.
    sql = _STRING_LITERAL.sub(" ", sql)
    return _CAST.sub(" ", sql)


def _defined_names(sql: str) -> set[str]:
    """Names the query itself introduces: CTEs, result labels, subquery aliases."""
    names = {m.group(1).lower() for m in _CTE.finditer(sql)}
    names |= {m.group(1).lower() for m in _LABEL.finditer(sql)}
    names |= {m.group(1).lower() for m in _SUBQUERY_ALIAS.finditer(sql)}
    return names - _RESERVED


def _table_refs(sql: str, known: dict[str, frozenset[str]]) -> tuple[set[str], dict[str, str]]:
    """Which real tables the query names, and what each alias points at.

    A FROM/JOIN target that is not a known table is a CTE or a subquery, and it is
    dropped rather than guessed at -- which is what keeps a WITH clause from being
    read as a typo'd table.
    """
    tables: set[str] = set()
    aliases: dict[str, str] = {}
    for match in _TABLE_REF.finditer(sql):
        name, alias = match.group(1).lower(), (match.group(2) or "").lower()
        if name not in known:
            continue
        tables.add(name)
        aliases[name] = name
        if alias and alias not in _RESERVED:
            aliases[alias] = name
    return tables, aliases


def precheck_columns(sql: str) -> dict | None:
    """A model-fixable failure for an invented column, or None if nothing is wrong.

    The returned shape is deliberately identical to
    tools.sql_executor.retryable_sql_error's, so the pipeline's retry rule keys on
    error_kind and never has to know which layer refused.
    """
    from tools.sql_executor import retryable_sql_error

    declared = declared_columns()
    permitted = known_columns()
    cleaned = _strip_noise(sql)
    tables, aliases = _table_refs(cleaned, declared)
    if not tables:
        # Nothing resolvable to check against -- a pure CTE query, or SQL this
        # module does not understand. Postgres is still downstream.
        return None

    defined = _defined_names(cleaned)

    def _reject(shown: str) -> dict:
        return retryable_sql_error(
            f"there is no column called {shown} anywhere in this schema. "
            f"Check the column list for {', '.join(sorted(tables))} and use a real one"
        )

    for match in _QUALIFIED.finditer(cleaned):
        qualifier, column = match.group(1).lower(), match.group(2).lower()
        if aliases.get(qualifier) is None or column == "*" or column in permitted:
            continue
        return _reject(f"{qualifier}.{column}")

    # BOTH halves of a qualified reference. Missing the qualifier is how
    # `public.is_job_late(...)` came back as "there is no column called public":
    # the schema qualifier was scanned as if it were a bare column name.
    qualified_spans = {
        span for m in _QUALIFIED.finditer(cleaned) for span in (m.span(1), m.span(2))
    }
    for match in _IDENTIFIER.finditer(cleaned):
        word = match.group(1).lower()
        if match.span(1) in qualified_spans:
            continue
        if word in _RESERVED or word in declared or word in aliases or word in defined:
            continue
        if word in permitted:
            continue
        # A function call, not a column.
        if cleaned[match.end() :].lstrip().startswith("("):
            continue
        return _reject(f'"{word}"')

    # A SELECT LIST THAT NAMES NO DATA IS ANSWERING FROM NOWHERE. Asked for net
    # profit margin after payroll -- which this schema cannot answer -- Arctic wrote
    # `SELECT '100%' AS net_profit_margin_after_payroll FROM job_parts WHERE
    # company_id = $1`. It executed, returned 37 rows, and the narrator reported
    # 100%. Every layer downstream was right to pass it: 100 genuinely WAS in the
    # rows. Only here is a constant still distinguishable from a figure.
    #
    # Runs last so a query that is both wrong and constant reports the specific
    # column first, which is the more actionable of the two.
    selected = _SELECT_LIST.search(cleaned)
    if selected:
        # The list's OWN labels are stripped first: `AS net_profit_margin_after_payroll`
        # is a name this query invents, and counting it as data would let every
        # literal launder itself through its own alias.
        body = _OUTPUT_LABEL.sub(" ", selected.group(1))
        names_data = "*" in body or any(
            m.group(1).lower() in permitted or m.group(1).lower() in defined
            for m in _IDENTIFIER.finditer(body)
        )
        if not names_data:
            return retryable_sql_error(
                "this query selects only constants, so it reports a value you wrote "
                "rather than one the database computed. Answer from real columns, or "
                "return an empty string for sql if this data is not in the schema"
            )

    return None


_OFFENDING = re.compile(r'no column called "?([\w.]+)"?')
# The constants rejection names no identifier -- there isn't one -- so the dump
# would otherwise record a pre-check that fired for no stated reason.
_CONSTANTS = "selects only constants"


def offending_column(result: dict) -> str | None:
    """Which identifier a precheck rejection was about, for the dump.

    Parsed back out of the message rather than returned alongside it, so the
    rejection stays byte-identical in shape to retryable_sql_error's -- the retry
    rule keys on error_kind and must never learn to recognise a second shape.
    """
    message = result.get("error", "") if result else ""
    if _CONSTANTS in message:
        return "(select list is all constants)"
    match = _OFFENDING.search(message)
    return match.group(1) if match else None
