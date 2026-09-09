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

# Anchored on the LABEL, not on the line start: the description is one line and the
# example sits inline at the end of it. A bare `SELECT .*` would also match the
# prose "a single SELECT statement" and "SELECT query", which is why the literal
# `Example:` is required.
EXAMPLE = re.compile(r"Example[^:]*:\s*(SELECT [^\n]+)")


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


def test_there_is_exactly_one_example_and_the_description_is_one_line():
    """ONE example and one line, and both numbers are measured rather than chosen.

    The first version of this change wrote four lines with two labelled examples.
    Sampled against qwen3:32b on the box with the real system prompt, that made the
    model return the JSON SCHEMA of the arguments instead of the arguments --
    `{"sql": {"sql": "SELECT ...", "type": "string"}}` -- in 5 of 14 calls, against
    1 of 14 for the old $1-only text and 1 of 16 for this one. It reached production
    as "I apologize for the error. Let me attempt to retrieve the information for
    you once more."

    A property's description is read while that property is generated, so structure
    in it invites structure in the value. The teaching about $2 lives in the tool
    description above instead, where the same sampling showed no such effect and
    0 of 16 calls reached for the clock.
    """
    assert len(EXAMPLE.findall(TOOL_TEXT)) == 1, (
        "one example only -- two is what made the model echo the schema"
    )
    assert "\n" not in SQL_PARAM, (
        "keep the sql parameter description to a single line; newlines in it are "
        "part of the structure the model reproduces"
    )


def test_no_example_compares_a_timestamp_column_against_the_bound_date():
    """$2::date against a TIMESTAMPTZ column is the bug this change is fighting.

    `created_at >= DATE_TRUNC('month', $2::date)` validates cleanly and compares a
    UTC instant to a local midnight -- the same day-boundary error as CURRENT_DATE,
    wearing the fix's clothes. Asserted over every example rather than only a dated
    one, so it still holds if someone adds a date to the example later.
    """
    for sql in EXAMPLE.findall(TOOL_TEXT):
        if "$2" not in sql:
            continue
        assert "created_at" not in sql and "completed_at" not in sql, (
            "the worked example must not compare a timestamptz column against $2::date"
        )


class TestTheArgumentBoundaryIsDefended:
    """A local model sometimes returns the schema fused with the value.

    Not hypothetical: it reached production on 2026-09-09, where the dict went into
    validate_query, `sql.strip()` raised AttributeError, and _run_tool returned the
    exception text with NO error_kind -- so the model got no rewrite instruction and
    apologised to the shop owner instead of retrying.
    """

    def test_a_plain_string_passes_through(self):
        from tools.chat_tools import description_argument, sql_argument

        assert sql_argument({"sql": "SELECT 1"}) == "SELECT 1"
        assert description_argument({"description": "Top customers"}) == "Top customers"

    def test_the_schema_shape_is_unwrapped(self):
        """The intended value is present verbatim under its own key, so this is a
        known shape rather than a guess."""
        from tools.chat_tools import description_argument, sql_argument

        assert sql_argument({"sql": {"sql": "SELECT 1", "type": "string"}}) == "SELECT 1"
        assert (
            description_argument(
                {"description": {"type": "string", "description": "Top customers"}}
            )
            == "Top customers"
        )

    @pytest.mark.parametrize(
        "arguments",
        [{}, {"sql": None}, {"sql": 42}, {"sql": []}, {"sql": {"type": "string"}}, {"sql": {"sql": 7}}],
        ids=["missing", "null", "number", "list", "schema-only", "nested-non-string"],
    )
    def test_anything_else_becomes_an_empty_query(self, arguments):
        """"" is deliberate: the validator refuses it as an empty query, which is
        SHAPED and retryable and carries the rewrite instruction. Raising here, or
        letting a dict through, is what produced an apology instead of an answer."""
        from tools.chat_tools import sql_argument
        from tools.sql_validator import validate_query_detailed

        text = sql_argument(arguments)
        assert text == ""
        ok, message, reason = validate_query_detailed(text)
        assert ok is False and reason == "empty" and message


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
