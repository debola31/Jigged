"""Python does the arithmetic; the narrator is only allowed to read it back.

THE FAILURE THIS IS BUILT AGAINST, verbatim from insights_ab.json:

    "The conversion rate from quotes to jobs in the last 90 days is 10%
     (7 out of 8 quotes created during that period converted to jobs)."

7 out of 8 is 87.5%. The query was right and the rows were right; the model did
the division wrong on the way out, and the eval scored it ok, answered AND
grounded -- because `grounded` only asks whether SOME query ran. A shop owner
cannot tell that sentence from a correct one, which is the property that makes it
worse than an error.

TWO HALVES, ONE MODULE, because the guard's allowed set IS what the derivation
produced. Splitting them would mean exporting an internal for the only caller
that can use it.

THE GUARD IS A HARD FAIL IN THIS ARM, AND THAT IS AN ASYMMETRY WORTH KNOWING.
services/ai_features/insights.py deliberately lets a grounded answer through
however it reads -- "a rule that could reject a grounded answer will eventually
reject a good one" -- so the agentic and Claude arms are held only to "is this
substantive". This arm is additionally held to "is every number traceable". The
asymmetry biases AGAINST the pipeline arm, which is the safe direction for a gate,
but a reader comparing the columns has to be told or they will read a lower number
as a worse model. evals/insights_ab.py says so in its docstring.
"""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Sequence

# Ordered by severity, and the order is the API: check_narration returns the
# highest-severity reason that fired, so a narration with several problems reports
# the same one every time regardless of word order.
GUARD_REASONS = (
    "number_with_no_rows",
    "percent_not_in_facts",
    "invented_precision",
    "unmatched_number",
)

_MONTHS = (
    "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|"
    "june|july|august|september|october|november|december"
)

# Blanked before the scan, in this order. Each is a shape whose digits are not a
# quantity, and every one of them appears in a correct answer.
_BLANKED = (
    re.compile(r"\b\d{4}-\d{2}(?:-\d{2})?\b"),                       # 2026-08, 2026-08-14
    re.compile(rf"\b(?:{_MONTHS})\.?\s+\d{{4}}\b", re.I),            # August 2026
    re.compile(r"\bQ[1-4]\s*\d{4}\b", re.I),                         # Q3 2026
    re.compile(r"\b\d+(?:st|nd|rd|th)\b", re.I),                     # 1st, 2nd
    re.compile(r"\b[A-Za-z][\w-]*\d[\w-]*\b"),                       # J-001, PN-4471B, Q3
)

_NUMBER = re.compile(
    r"[-+]?\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?"   # 4,774.82  $16,420  87.5%
    r"|[-+]?\$?\d+(?:\.\d+)?%?"                  # 4774.82   $250     10%
)

_HEDGES = ("about", "approximately", "roughly", "around", "nearly", "almost", "~",
           "over", "under", "just under", "more than", "close to")
_HEDGE_WINDOW = 12

# A fact whose name says it is already a percentage. A percent token in the
# narration has to match one of these (or 0/100), never a raw count that happens
# to share its digits.
_PERCENTISH = ("pct", "percent", "rate", "margin")


def _as_decimal(value: Any) -> Decimal | None:
    """A number, or None for anything that is not one.

    Decimal rather than float throughout, matching test_llm_cost_math.py's rule
    against pytest.approx: a guard that admits a number because of binary rounding
    is a guard with a hole in it.
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, str):
        cleaned = value.strip().replace("$", "").replace(",", "").rstrip("%")
        if not cleaned:
            return None
        try:
            return Decimal(cleaned)
        except InvalidOperation:
            return None
    return None


# ==================================================== derived figures


def derive_facts(columns: Sequence[str], rows: Sequence[dict]) -> dict[str, Any]:
    """Every figure the narrator is allowed to state, computed here.

    Deliberately bounded to totals, averages, extremes, period-over-period change
    and one-row ratios. That is what the eleven questions actually need, and an
    open-ended derivation would produce facts nobody asked for -- each one widening
    the allowed set and weakening the guard that reads it.
    """
    from tools.sql_executor import MAX_ROWS

    row_count = len(rows)
    facts: dict[str, Any] = {
        "row_count": row_count,
        # THE TRUNCATION FACT. execute_sql_query appends LIMIT 200 to a query with
        # no limit, so a real shop asking "which parts have no routing" gets exactly
        # 200 rows. "200 parts" then passes every other check -- the digits ARE in
        # the rows -- and is wrong. The narrator contract turns this into "at least".
        "truncated": row_count >= MAX_ROWS,
    }
    if not rows:
        return facts

    numeric: dict[str, list[Decimal]] = {}
    for column in columns:
        values = [_as_decimal(row.get(column)) for row in rows]
        present = [v for v in values if v is not None]
        if present and len(present) == len(values):
            numeric[column] = present

    for column, values in numeric.items():
        if row_count > 1:
            total = sum(values, Decimal(0))
            facts[f"{column}_total"] = total
            facts[f"{column}_average"] = total / Decimal(row_count)
            facts[f"{column}_min"] = min(values)
            facts[f"{column}_max"] = max(values)

        # Two rows of one measure is a period comparison -- "what did we quote last
        # month versus the month before" is one of the eleven, and the subtraction
        # is exactly the arithmetic a narrator gets wrong.
        if row_count == 2:
            change = values[1] - values[0]
            facts[f"{column}_change"] = change
            if values[0] != 0:
                facts[f"{column}_pct_change"] = change / values[0] * Decimal(100)

    # One row with several measures is a ratio question. Only a <= b, so the
    # reported figure is always a share of a whole and never a meaningless 114%.
    if row_count == 1 and len(numeric) > 1:
        for a, (a_value,) in numeric.items():
            for b, (b_value,) in numeric.items():
                if a != b and b_value > 0 and a_value <= b_value:
                    facts[f"{a}_as_pct_of_{b}"] = a_value / b_value * Decimal(100)

    return facts


# ============================================================ the guard


def _blank_non_quantities(text: str) -> str:
    """Replace date, ordinal and identifier spans with spaces of the same length.

    Same length so the offsets of everything after them are unchanged, which is
    what lets the hedge lookbehind read the real words to the left of a number.
    """
    for pattern in _BLANKED:
        text = pattern.sub(lambda m: " " * len(m.group()), text)
    return text


def _significant(value: Decimal, digits: int = 2) -> Decimal:
    if value == 0:
        return Decimal(0)
    step = Decimal(1).scaleb(value.copy_abs().adjusted() - digits + 1)
    return (value / step).quantize(Decimal(1), rounding=ROUND_HALF_UP) * step


def _allowed(rows: Sequence[dict], facts: dict[str, Any], question: str):
    """Everything the narration may state, split into plain and percent-typed.

    Percent-typed is separate because it is the whole 10%-versus-87.5% case: the
    digits `1` and `0` are both in the rows, and a flat membership test over every
    number in sight would admit the sentence that made this module necessary.
    """
    # ZERO IS ALLOWED OUTRIGHT AND ONE HUNDRED IS NOT, which is not a symmetry
    # anyone would guess. An empty result set honestly means zero -- "no customers
    # have gone quiet" is a reading of the data. "100%" is never a reading; it is
    # always a division the narrator performed, and this arm forbids the narrator
    # from dividing. A blanket allowance for 100 also let a fabricated `SELECT
    # '100%'` through the guard untouched on the payroll question.
    plain: set[Decimal] = {Decimal(0)}
    percent: set[Decimal] = {Decimal(0)}

    for row in rows:
        for value in row.values():
            number = _as_decimal(value)
            if number is not None:
                plain.add(number)
                # A share expressed 0..1 is the same claim as one expressed 0..100 --
                # but STRICTLY between, because 0 and 1 are overwhelmingly counts.
                # Inclusive bounds meant row_count=1 legitimised any "100%" claim,
                # which is how the fabricated payroll narration passed the guard.
                if 0 < number < 1:
                    percent.add(number * Decimal(100))

    for key, value in facts.items():
        number = _as_decimal(value)
        if number is None:
            continue
        plain.add(number)
        if any(marker in key.lower() for marker in _PERCENTISH):
            percent.add(number)
        elif 0 < number < 1:
            percent.add(number * Decimal(100))

    asked = {Decimal(n) for n in re.findall(r"\d+", question)}
    return plain | asked, percent, asked


def check_narration(
    text: str,
    *,
    rows: Sequence[dict],
    facts: dict[str, Any],
    question: str,
) -> str | None:
    """Which guard rule the narration broke, or None if every number is traceable.

    Returns the RULE rather than a bool, mirroring
    insights_presentation.classify_non_answer: this failure has four
    distinguishable causes and "the narration is bad" sends whoever is triaging
    straight back to the transcript.
    """
    plain, percent, asked = _allowed(rows, facts, question)
    scrubbed = _blank_non_quantities(text or "")

    fired: set[str] = set()

    for match in _NUMBER.finditer(scrubbed):
        raw = match.group()
        is_percent = raw.endswith("%")
        core = raw.rstrip("%").replace("$", "").replace(",", "").lstrip("+")
        try:
            value = Decimal(core)
        except InvalidOperation:
            continue

        # A NUMBER WITH NOTHING BEHIND IT. Not a quality judgement: this is the
        # class LLMErrorEcho already refuses and the class `grounded` claims to
        # measure. Anything the question itself named is still repeatable.
        if not rows and value not in asked and value != Decimal(0):
            fired.add("number_with_no_rows")
            continue

        decimals = len(core.split(".")[1]) if "." in core else 0
        tolerance = Decimal(5).scaleb(-(decimals + 1))
        window = scrubbed[max(0, match.start() - _HEDGE_WINDOW) : match.start()].lower()
        hedged = any(h in window for h in _HEDGES)

        candidates = percent if is_percent else plain
        if any(abs(value - a) <= tolerance for a in candidates):
            continue
        if hedged and any(_significant(value) == _significant(a) for a in candidates):
            continue

        if is_percent:
            fired.add("percent_not_in_facts")
        elif any(abs(value - a) <= Decimal("0.5") for a in candidates):
            # Close enough that the model clearly meant this figure, and then
            # asserted digits the rows do not support.
            fired.add("invented_precision")
        else:
            fired.add("unmatched_number")

    for reason in GUARD_REASONS:
        if reason in fired:
            return reason
    return None


__all__ = ["GUARD_REASONS", "check_narration", "derive_facts"]
