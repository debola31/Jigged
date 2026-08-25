"""Cost arithmetic, asserted to the exact cent-of-a-millionth.

TOLERANCE IS ZERO HERE, ON PURPOSE. A pytest.approx would hide precisely the
bug that makes a monthly rollup disagree with a vendor invoice, and the whole
reason ai_calls exists is to be the number you can put next to that invoice.
Decimal-from-string arithmetic makes exact equality achievable, so anything
looser would be hiding a real defect rather than accommodating floating point.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from services.llm.pricing import ANTHROPIC_PRICES, estimate_cost_usd

pytestmark = pytest.mark.unit

DEEPINFRA_IN = Decimal("0.08")
DEEPINFRA_OUT = Decimal("0.28")


class TestKnownTokenCounts:
    def test_seven_hundred_input_tokens_on_qwen3_32b(self):
        assert estimate_cost_usd(700, 0, DEEPINFRA_IN, DEEPINFRA_OUT) == Decimal("0.000056")

    def test_a_realistic_insights_call(self):
        assert estimate_cost_usd(12_345, 6_789, DEEPINFRA_IN, DEEPINFRA_OUT) == Decimal("0.00288852")

    def test_a_million_tokens_each_way_is_exactly_the_two_list_prices(self):
        """The sanity anchor: at 1 Mtok the formula reduces to price_in + price_out,
        so an error in the divisor cannot hide here."""
        assert estimate_cost_usd(1_000_000, 1_000_000, DEEPINFRA_IN, DEEPINFRA_OUT) == Decimal("0.36")

    def test_anthropic_sonnet_at_list_price(self):
        pin, pout = ANTHROPIC_PRICES["claude-sonnet-4-6"]
        assert (pin, pout) == (Decimal("3.00"), Decimal("15.00"))
        assert estimate_cost_usd(1_000, 500, pin, pout) == Decimal("0.0105")


class TestThePrecisionThatMatters:
    def test_a_single_token_each_way_is_not_rounded_away(self):
        assert estimate_cost_usd(1, 1, DEEPINFRA_IN, DEEPINFRA_OUT) == Decimal("0.00000036")

    def test_the_cheapest_possible_call_is_still_representable(self):
        """8e-8 is exactly the resolution of numeric(12,8). If this ever needs
        relaxing, the DB column's scale is wrong -- not this test."""
        assert estimate_cost_usd(1, 0, DEEPINFRA_IN, DEEPINFRA_OUT) == Decimal("0.00000008")

    def test_naive_float_arithmetic_would_get_the_single_token_case_wrong(self):
        """Kept as a standing argument for the Decimal path. Delete the quantize
        and this is the first case that diverges."""
        naive = (1 * 0.08 + 1 * 0.28) / 1e6
        assert naive == 3.6000000000000005e-07
        assert Decimal(str(naive)) != estimate_cost_usd(1, 1, DEEPINFRA_IN, DEEPINFRA_OUT)

    def test_a_float_price_is_normalised_before_it_can_poison_the_sum(self):
        """Decimal(0.08) is 0.08000000000000000166... The registry declares prices
        as strings, but the constructor signature invites a float literal at the
        call site, so the normalisation is asserted rather than assumed."""
        assert estimate_cost_usd(1_000_000, 0, 0.08, 0.0) == Decimal("0.08")

    def test_no_result_can_exceed_what_the_column_can_store(self):
        """numeric(12,8) truncates silently past 8 dp, so the quantize is what
        keeps Python and Postgres agreeing about a row's value."""
        v = estimate_cost_usd(12_345, 6_789, DEEPINFRA_IN, DEEPINFRA_OUT)
        assert v.as_tuple().exponent >= -8


class TestFreeIsExactlyFree:
    def test_a_local_call_costs_exactly_zero_and_says_so(self):
        """Not None. A local call is free, and free is a number -- a NULL here
        would make every SUM over a mixed month unusable."""
        v = estimate_cost_usd(5_000, 5_000, Decimal("0"), Decimal("0"))
        assert v == Decimal("0")
        assert v is not None

    def test_zero_tokens_is_zero_not_an_error(self):
        """A failed call still writes a row, with 0/0 tokens."""
        assert estimate_cost_usd(0, 0, DEEPINFRA_IN, DEEPINFRA_OUT) == Decimal("0")
