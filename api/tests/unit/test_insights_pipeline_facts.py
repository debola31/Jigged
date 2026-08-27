"""Python does the arithmetic; the narrator is only allowed to read it back.

THE FAILURE THIS IS BUILT AGAINST is in insights_ab.json, from the Gate 2 run:

    "The conversion rate from quotes to jobs in the last 90 days is 10%
     (7 out of 8 quotes created during that period converted to jobs)."

7 out of 8 is 87.5%. The query was right, the rows were right, and the model did
the division wrong on the way out -- then scored ok, answered AND grounded,
because `grounded` only asks whether SOME query ran. A shop owner cannot tell that
sentence from a correct one.

So the pipeline computes every derived figure in Python and injects it as a stated
fact, and the guard refuses a narration containing a number that is in neither the
rows nor the facts.

WHAT THE GUARD DELIBERATELY DOES NOT CATCH, stated in the register Outcome.grounded
uses for its own honesty ("A crude proxy, and honestly labelled as one"):
  * word-form numbers -- "twelve late jobs", "half", "a third";
  * the right number under the wrong label -- "$16,420 is your top customer" when
    16,420 was row two. Every digit is in the rows;
  * the right number for the wrong question, which is displacement, not arithmetic;
  * unit swaps -- "16,420 hours";
  * direction and negation -- "revenue is down 12%" when the fact says up;
  * anything inside an identifier, because job numbers are stripped before the scan.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

pytestmark = pytest.mark.unit


# ============================================================ derived figures


def test_a_single_column_over_several_rows_gets_sum_average_and_extremes():
    from services.insights_pipeline.facts import derive_facts

    rows = [{"month": "2026-06", "revenue": 100}, {"month": "2026-07", "revenue": 250},
            {"month": "2026-08", "revenue": 400}]
    facts = derive_facts(["month", "revenue"], rows)

    assert facts["revenue_total"] == Decimal("750")
    assert facts["revenue_average"] == Decimal("250")
    assert facts["revenue_min"] == Decimal("100")
    assert facts["revenue_max"] == Decimal("400")
    assert facts["row_count"] == 3


def test_two_periods_get_the_change_and_the_percent_change():
    """'What did we quote last month versus the month before' is one of the eleven,
    and the comparison is exactly the arithmetic a narrator gets wrong."""
    from services.insights_pipeline.facts import derive_facts

    rows = [{"month": "2026-07", "quoted": 100}, {"month": "2026-08", "quoted": 150}]
    facts = derive_facts(["month", "quoted"], rows)

    assert facts["quoted_change"] == Decimal("50")
    assert facts["quoted_pct_change"] == Decimal("50.0")


def test_a_percent_change_from_zero_is_not_reported_rather_than_infinite():
    from services.insights_pipeline.facts import derive_facts

    rows = [{"month": "2026-07", "quoted": 0}, {"month": "2026-08", "quoted": 150}]
    facts = derive_facts(["month", "quoted"], rows)

    assert "quoted_change" in facts
    assert "quoted_pct_change" not in facts


def test_two_counts_on_one_row_get_the_ratio_that_the_eval_got_wrong():
    from services.insights_pipeline.facts import derive_facts

    rows = [{"converted": 7, "quotes_created": 8}]
    facts = derive_facts(["converted", "quotes_created"], rows)

    assert facts["converted_as_pct_of_quotes_created"] == Decimal("87.5")


def test_a_ratio_out_of_zero_is_not_reported():
    from services.insights_pipeline.facts import derive_facts

    facts = derive_facts(["converted", "quotes_created"], [{"converted": 0, "quotes_created": 0}])
    assert "converted_as_pct_of_quotes_created" not in facts


def test_a_full_page_of_rows_is_flagged_as_truncated():
    """execute_sql_query appends LIMIT 200 when the query has none, so a real shop
    asking 'which parts have no routing' gets exactly 200 rows back. '200 parts'
    passes every other check -- the digits ARE in the rows -- and is wrong. The
    narrator contract turns this fact into 'at least'."""
    from tools.sql_executor import MAX_ROWS
    from services.insights_pipeline.facts import derive_facts

    rows = [{"id": n} for n in range(MAX_ROWS)]
    facts = derive_facts(["id"], rows)

    assert facts["truncated"] is True
    assert facts["row_count"] == MAX_ROWS


def test_a_short_result_is_not_flagged_as_truncated():
    from services.insights_pipeline.facts import derive_facts

    assert derive_facts(["id"], [{"id": 1}])["truncated"] is False


def test_an_empty_result_derives_nothing_but_says_so():
    from services.insights_pipeline.facts import derive_facts

    facts = derive_facts([], [])
    assert facts["row_count"] == 0
    assert facts["truncated"] is False


def test_a_text_column_derives_no_arithmetic():
    from services.insights_pipeline.facts import derive_facts

    facts = derive_facts(["customer"], [{"customer": "Acme"}, {"customer": "Borg"}])
    assert not any(k.startswith("customer_") for k in facts)


# ============================================================== the guard


def _facts(**kw):
    base = {"row_count": 1, "truncated": False}
    base.update(kw)
    return base


def test_a_number_that_is_in_the_rows_passes():
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "The average job value this quarter is $4,774.82.",
        rows=[{"average_job_value": Decimal("4774.82")}],
        facts=_facts(),
        question="What is the average value of a job this quarter?",
    ) is None


def test_a_number_that_is_nowhere_fails():
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "The average job value this quarter is $3,038.04.",
        rows=[{"average_job_value": Decimal("4774.82")}],
        facts=_facts(),
        question="What is the average value of a job this quarter?",
    ) == "unmatched_number"


def test_the_conversion_rate_the_eval_invented_is_rejected():
    """The whole reason this module exists."""
    from services.insights_pipeline.facts import check_narration

    reason = check_narration(
        "The conversion rate from quotes to jobs in the last 90 days is 10% "
        "(7 out of 8 quotes created during that period converted to jobs).",
        rows=[{"converted": 7, "quotes_created": 8}],
        facts=_facts(converted_as_pct_of_quotes_created=Decimal("87.5")),
        question="How many quotes turned into jobs in the last 90 days?",
    )
    assert reason == "percent_not_in_facts"


def test_the_correct_percentage_from_the_facts_passes():
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "87.5% of quotes converted -- 7 of the 8 raised in the last 90 days.",
        rows=[{"converted": 7, "quotes_created": 8}],
        facts=_facts(converted_as_pct_of_quotes_created=Decimal("87.5")),
        question="How many quotes turned into jobs in the last 90 days?",
    ) is None


def test_rounding_to_whole_currency_is_admitted():
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "The average job value is $4,775.",
        rows=[{"v": Decimal("4774.82")}], facts=_facts(), question="q",
    ) is None


def test_a_hedged_restatement_is_admitted():
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "The average job value is about 4,800.",
        rows=[{"v": Decimal("4774.82")}], facts=_facts(), question="q",
    ) is None


def test_an_unhedged_two_significant_figure_claim_is_not_admitted():
    """`about 4,800` is a restatement; `4,800` flat is a different figure."""
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "The average job value is 4,800.",
        rows=[{"v": Decimal("4774.82")}], facts=_facts(), question="q",
    ) == "unmatched_number"


def test_precision_the_rows_do_not_support_is_named_as_such():
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "The average job value is $4,774.82.",
        rows=[{"v": Decimal("4775")}], facts=_facts(), question="q",
    ) == "invented_precision"


def test_any_number_at_all_with_no_rows_behind_it_is_refused():
    """Not a quality judgement -- this is the class LLMErrorEcho already refuses,
    and the class `grounded` claims to measure."""
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "You have 12 late jobs.", rows=[], facts=_facts(row_count=0), question="q",
    ) == "number_with_no_rows"


def test_a_decline_with_no_number_in_it_passes_with_no_rows():
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "Jigged does not track payroll, so that cannot be calculated here.",
        rows=[], facts=_facts(row_count=0), question="What is our net profit margin after payroll?",
    ) is None


@pytest.mark.parametrize(
    "text",
    [
        "Revenue rose between 2026-06 and 2026-08.",
        "August 2026 was the strongest month.",
        "Q3 2026 is tracking ahead.",
        "The 1st and 2nd shifts both ran.",
        "Job J-001 and part PN-4471B are the ones affected.",
    ],
)
def test_dates_ordinals_and_identifiers_are_not_treated_as_figures(text):
    from services.insights_pipeline.facts import check_narration

    assert check_narration(text, rows=[{"n": 1}], facts=_facts(), question="q") is None


def test_a_number_the_question_itself_names_is_allowed():
    """'in the last 90 days' has to be repeatable in the answer."""
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "3 quotes converted in the last 90 days.",
        rows=[{"converted": 3}], facts=_facts(),
        question="How many quotes turned into jobs in the last 90 days?",
    ) is None


def test_zero_is_allowed_but_a_hundred_percent_is_not():
    """An empty or zero result honestly reads as zero. "100% of work is on time"
    never reads off the data -- it is a division the narrator performed from a
    count of late jobs, and this arm forbids the narrator from dividing.

    A blanket allowance for 100 was also a live hole: on the payroll question the
    generator wrote `SELECT '100%' AS net_profit_margin_after_payroll`, and the
    narration passed the guard partly on this rule."""
    from services.insights_pipeline.facts import check_narration

    assert check_narration(
        "0 jobs are late.", rows=[{"late_jobs": 0}], facts=_facts(), question="q",
    ) is None
    assert check_narration(
        "0 jobs are late, so 100% of work is on time.",
        rows=[{"late_jobs": 0}], facts=_facts(), question="q",
    ) == "percent_not_in_facts"


def test_the_reason_names_the_rule_rather_than_returning_a_bare_bool():
    """Mirrors classify_non_answer: a bool sends whoever is triaging back to the
    transcript, and this failure has four distinguishable causes."""
    from services.insights_pipeline.facts import GUARD_REASONS

    assert GUARD_REASONS == (
        "number_with_no_rows",
        "percent_not_in_facts",
        "invented_precision",
        "unmatched_number",
    )
