"""The tool description is the last text the model reads before it writes SQL.

Ollama's qwen3 template renders the tools block AFTER the whole system prompt, so
the `sql` parameter description sits at ~98% prompt depth while the clock rule in
SCHEMA_CONTEXT sits at ~46%. Whatever this block says is what a 32B imitates.

Until 2026-09-09 it said `$1` three times, `$2` never, and called `$1` "THE
placeholder for company_id" -- a false claim about the arity of the bound values,
about fifty tokens before generation -- with a single worked example that had no
date in it at all. Over 2026-09-08..09, 3 of 27 production questions paid a wasted
round trip to a CURRENT_DATE refusal, and 3 of 3 clock reaches were refused.

Nothing asserted anything about this text before, beyond the tool's NAME
(test_chart_exemplar.py), which is how it stayed $1-only through the change that
introduced $2. Two halves can rot, so both are pinned: the prose still names $2 and
the cast, and every worked example is still a query this pipeline would actually
run.
"""
from __future__ import annotations

import re

import pytest

from tools.chat_tools import CHAT_TOOLS
from tools.sql_validator import validate_query

SQL_TOOL = next(t for t in CHAT_TOOLS if t["name"] == "execute_sql")
SQL_PARAM = SQL_TOOL["input_schema"]["properties"]["sql"]["description"]
TOOL_TEXT = SQL_TOOL["description"] + "\n" + SQL_PARAM

# Anchored on the label: a bare `SELECT .*` would also match the prose "a single
# SELECT statement" and "SELECT query".
EXAMPLE = re.compile(r"^Example[^:]*:\s*(SELECT .+)$", re.MULTILINE)


def test_the_tool_names_the_bound_date_and_not_only_the_company():
    assert "$1" in TOOL_TEXT
    assert "$2" in SQL_TOOL["description"], (
        "the last text before the model writes SQL must name BOTH bound values; "
        "naming only $1 is what taught it to reach for CURRENT_DATE"
    )
    assert "$2::date" in SQL_PARAM, "and must show the cast _UNTYPED_TODAY requires"


def test_it_no_longer_claims_one_placeholder_exists():
    """The original defect was a false arity claim, not merely an omission.

    "Use $1 as THE placeholder for company_id" reads as an enumeration of what is
    bound, and it enumerated one of two.
    """
    assert "the placeholder for company_id" not in SQL_TOOL["description"].lower()


def test_the_tool_says_the_clock_is_rejected_before_execution():
    text = SQL_TOOL["description"].lower()
    assert "current_date" in text
    assert "rejected before execution" in text, (
        "state the consequence, not a bare prohibition: the model is told the "
        "query never runs, which is exactly what the validator does"
    )


@pytest.mark.parametrize("example", EXAMPLE.findall(TOOL_TEXT))
def test_every_worked_example_passes_the_validator(example):
    """The example is what a 32B copies, so an example the validator refuses
    teaches it the failure. This is the tie that keeps the two files honest."""
    valid, msg = validate_query(example)
    assert valid, f"the tool's own example is refused by the validator: {msg}"


def test_there_are_two_examples_and_one_of_them_is_bounded_by_today():
    examples = EXAMPLE.findall(TOOL_TEXT)
    assert len(examples) == 2, "one dateless example and one bounded by $2"
    assert any("$2::date" in sql for sql in examples)


def test_the_dated_example_bounds_a_date_column_not_a_timestamp():
    """$2::date against a TIMESTAMPTZ column is the bug this change is fighting.

    `created_at >= DATE_TRUNC('month', $2::date)` validates cleanly and compares a
    UTC instant to a local midnight -- the same day-boundary error as CURRENT_DATE,
    wearing the fix's clothes. `due_date` is a DATE (schema_context.py), so the
    exemplar cannot teach that.
    """
    dated = [s for s in EXAMPLE.findall(TOOL_TEXT) if "$2" in s]
    assert dated, "no dated example to check"
    for sql in dated:
        assert "created_at" not in sql and "completed_at" not in sql, (
            "the worked example must not compare a timestamptz column against $2::date"
        )


@pytest.mark.parametrize("term", ["late", "revenue", "job value", "open quote", "dormant"])
def test_no_example_restates_a_business_term(term):
    """semantics.md owns those. A second definition here is the METRIC_TOOLS
    mistake this very file's docstring records -- the AI and the dashboard
    disagreeing about which jobs were late."""
    assert term not in TOOL_TEXT.lower()


def test_the_opening_lines_name_both_placeholders():
    """A 32B weights the opening of a long prompt; the file's own docstring
    records that moving the scope sentence there is what made it hold."""
    from services.insights_service import _stable_prefix

    assert "$2" in _stable_prefix()[:900]
