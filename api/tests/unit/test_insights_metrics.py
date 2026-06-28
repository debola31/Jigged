"""Unit tests for the pure metric helpers in services/insights_service.py.

These functions carry the revenue arithmetic and period-bucketing math that the
DB-backed metric functions depend on. The get_* functions themselves hit
Supabase (covered by integration tests); here we pin the pure logic that has no
external dependency.
"""

from datetime import datetime, timedelta

import pytest

from services.insights_service import (
    _get_period_boundaries,
    _job_part_revenue,
    _sum_job_parts_revenue,
)


def _parse(dt_iso: str) -> datetime:
    return datetime.fromisoformat(dt_iso)


class TestGetPeriodBoundaries:
    def test_returns_requested_count(self):
        assert len(_get_period_boundaries("daily", 5)) == 5
        assert len(_get_period_boundaries("weekly", 8)) == 8
        assert len(_get_period_boundaries("monthly", 6)) == 6

    def test_unknown_period_type_returns_empty(self):
        assert _get_period_boundaries("yearly", 5) == []

    def test_periods_are_chronological_and_contiguous(self):
        periods = _get_period_boundaries("daily", 4)
        starts = [_parse(p["start"]) for p in periods]
        # Most recent is last → strictly increasing starts.
        assert starts == sorted(starts)
        # No gaps/overlaps: each period's end is the next period's start.
        for earlier, later in zip(periods, periods[1:]):
            assert earlier["end"] == later["start"]

    def test_daily_spans_one_day(self):
        p = _get_period_boundaries("daily", 1)[0]
        assert _parse(p["end"]) - _parse(p["start"]) == timedelta(days=1)

    def test_weekly_spans_seven_days_and_starts_monday(self):
        p = _get_period_boundaries("weekly", 1)[0]
        start = _parse(p["start"])
        assert _parse(p["end"]) - start == timedelta(weeks=1)
        assert start.weekday() == 0  # Monday

    def test_monthly_starts_on_the_first_and_rolls_over_years(self):
        # 14 periods guarantees the window crosses at least one year boundary.
        periods = _get_period_boundaries("monthly", 14)
        assert len(periods) == 14
        for p in periods:
            start = _parse(p["start"])
            assert start.day == 1
            # End is the first of the following month.
            end = _parse(p["end"])
            assert end.day == 1
            expected_month = 1 if start.month == 12 else start.month + 1
            assert end.month == expected_month


class TestJobPartRevenue:
    def test_prefers_total_price_over_unit_times_qty(self):
        jp = {"total_price": 100, "unit_price": 5, "quantity": 3}
        assert _job_part_revenue(jp) == 100.0

    def test_falls_back_to_unit_price_times_quantity(self):
        assert _job_part_revenue({"unit_price": 5, "quantity": 3}) == 15.0

    def test_coerces_string_numerics(self):
        assert _job_part_revenue({"total_price": "100.50"}) == 100.5

    def test_missing_quantity_falls_through_to_zero(self):
        assert _job_part_revenue({"unit_price": 5}) == 0.0

    def test_empty_dict_is_zero(self):
        assert _job_part_revenue({}) == 0.0

    def test_total_price_zero_is_respected_not_treated_as_missing(self):
        # 0 is a real value; the guard is `is not None`, not truthiness.
        assert _job_part_revenue({"total_price": 0, "unit_price": 5, "quantity": 3}) == 0.0


class TestSumJobPartsRevenue:
    def test_sums_a_list(self):
        parts = [{"total_price": 10}, {"unit_price": 2, "quantity": 4}]
        assert _sum_job_parts_revenue(parts) == 18.0

    def test_accepts_a_single_dict(self):
        assert _sum_job_parts_revenue({"total_price": 42}) == 42.0

    def test_none_is_zero(self):
        assert _sum_job_parts_revenue(None) == 0.0

    def test_empty_list_is_zero(self):
        assert _sum_job_parts_revenue([]) == 0.0

    def test_ignores_non_dict_entries(self):
        assert _sum_job_parts_revenue([None, {"total_price": 7}, "junk"]) == 7.0
