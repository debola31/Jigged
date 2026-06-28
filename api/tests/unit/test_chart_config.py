"""Unit tests for chart_config validation + deterministic chart-type selection.

The chat lets the model PROPOSE a chart_config; deterministic code then decides
whether it's worth charting (validate + downgrade to text) and picks the chart
type from the data shape. These tests cover that gate with no model in the loop.
"""

import pytest

from routes.insights_routes import (
    _extract_chart_config,
    _flatten_markdown_tables,
    _select_chart_type,
    _strip_code_blocks,
    _strip_inline_markdown,
    _validate_chart_config,
)

pytestmark = pytest.mark.unit


def cfg(chart_type="bar", x_key="customer", y_key="revenue", data=None):
    return {
        "chart_type": chart_type,
        "x_key": x_key,
        "y_key": y_key,
        "data": data if data is not None else [],
    }


class TestValidateChartConfig:
    def test_none_returns_none(self):
        assert _validate_chart_config(None) is None

    def test_valid_multi_category_kept(self):
        c = cfg(data=[
            {"customer": "A", "revenue": 100},
            {"customer": "B", "revenue": 80},
            {"customer": "C", "revenue": 60},
        ])
        assert _validate_chart_config(c) is c

    def test_single_dominant_two_points_downgraded(self):
        # The reported incident: top customer 7749 vs 36 -> text, not a chart.
        c = cfg(data=[
            {"customer": "Customer 101", "revenue": 7749.24},
            {"customer": "Other", "revenue": 36.46},
        ])
        assert _validate_chart_config(c) is None

    def test_two_comparable_points_kept(self):
        # A genuine 2-period comparison stays a chart.
        c = cfg(x_key="week", y_key="revenue", data=[
            {"week": "W1", "revenue": 100},
            {"week": "W2", "revenue": 120},
        ])
        assert _validate_chart_config(c) is c

    def test_single_point_downgraded(self):
        assert _validate_chart_config(cfg(data=[{"customer": "A", "revenue": 100}])) is None

    def test_key_mismatch_downgraded(self):
        # Rows keyed name/value but config declares customer/revenue.
        c = cfg(data=[
            {"name": "A", "value": 100},
            {"name": "B", "value": 80},
            {"name": "C", "value": 60},
        ])
        assert _validate_chart_config(c) is None

    def test_non_numeric_y_downgraded(self):
        c = cfg(data=[
            {"customer": "A", "revenue": "n/a"},
            {"customer": "B", "revenue": 80},
            {"customer": "C", "revenue": 60},
        ])
        assert _validate_chart_config(c) is None

    def test_numeric_string_y_coerced_and_kept(self):
        c = cfg(data=[
            {"customer": "A", "revenue": "1,200.50"},
            {"customer": "B", "revenue": "$800"},
            {"customer": "C", "revenue": 600},
        ])
        assert _validate_chart_config(c) is c

    def test_all_equal_downgraded(self):
        c = cfg(data=[
            {"customer": "A", "revenue": 50},
            {"customer": "B", "revenue": 50},
            {"customer": "C", "revenue": 50},
        ])
        assert _validate_chart_config(c) is None

    def test_all_zero_downgraded(self):
        c = cfg(data=[
            {"customer": "A", "revenue": 0},
            {"customer": "B", "revenue": 0},
            {"customer": "C", "revenue": 0},
        ])
        assert _validate_chart_config(c) is None

    def test_single_category_downgraded(self):
        c = cfg(data=[
            {"customer": "A", "revenue": 10},
            {"customer": "A", "revenue": 20},
            {"customer": "A", "revenue": 30},
        ])
        assert _validate_chart_config(c) is None

    def test_unsupported_chart_type_downgraded(self):
        c = cfg(chart_type="radar", data=[
            {"customer": "A", "revenue": 100},
            {"customer": "B", "revenue": 80},
            {"customer": "C", "revenue": 60},
        ])
        assert _validate_chart_config(c) is None

    def test_empty_data_downgraded(self):
        assert _validate_chart_config(cfg(data=[])) is None


class TestSelectChartType:
    def test_none_passthrough(self):
        assert _select_chart_type(None) is None

    def test_temporal_x_becomes_area(self):
        c = cfg(chart_type="bar", x_key="week", y_key="revenue", data=[
            {"week": "2026-01-01", "revenue": 100},
            {"week": "2026-02-01", "revenue": 120},
            {"week": "2026-03-01", "revenue": 90},
        ])
        assert _select_chart_type(c, "revenue over time")["chart_type"] == "area"

    def test_nominal_short_labels_become_bar(self):
        c = cfg(chart_type="bar", data=[
            {"customer": "A", "revenue": 100},
            {"customer": "B", "revenue": 80},
            {"customer": "C", "revenue": 60},
        ])
        assert _select_chart_type(c, "top customers")["chart_type"] == "bar"

    def test_long_labels_become_horizontal(self):
        c = cfg(chart_type="bar", data=[
            {"customer": "Acme Manufacturing Co", "revenue": 100},
            {"customer": "Globex International Ltd", "revenue": 80},
            {"customer": "Initech Industrial Group", "revenue": 60},
        ])
        assert _select_chart_type(c, "top customers")["chart_type"] == "bar_horizontal"

    def test_explicit_user_request_overrides(self):
        c = cfg(chart_type="bar", data=[
            {"customer": "A", "revenue": 100},
            {"customer": "B", "revenue": 80},
            {"customer": "C", "revenue": 60},
        ])
        assert _select_chart_type(c, "show me a pie chart of revenue")["chart_type"] == "pie"

    def test_pipeline_does_not_trigger_line_keyword(self):
        # "pipeline" must NOT match the "line" keyword (word-boundary).
        c = cfg(chart_type="bar", data=[
            {"customer": "A", "revenue": 100},
            {"customer": "B", "revenue": 80},
            {"customer": "C", "revenue": 60},
        ])
        assert _select_chart_type(c, "what is my quote pipeline worth?")["chart_type"] == "bar"

    def test_model_pie_with_few_slices_kept(self):
        c = cfg(chart_type="pie", data=[
            {"customer": "A", "revenue": 50},
            {"customer": "B", "revenue": 30},
            {"customer": "C", "revenue": 20},
        ])
        assert _select_chart_type(c, "revenue split by customer")["chart_type"] == "pie"

    def test_does_not_mutate_input(self):
        c = cfg(chart_type="pie", data=[
            {"customer": "A", "revenue": 100},
            {"customer": "B", "revenue": 80},
            {"customer": "C", "revenue": 60},
        ])
        _select_chart_type(c, "top customers")
        assert c["chart_type"] == "pie"  # original object unchanged


def _process(raw: str, question: str = ""):
    """Mirror exactly what the chat route does to a raw model response."""
    clean = _strip_inline_markdown(_flatten_markdown_tables(_strip_code_blocks(raw)))
    chart = _select_chart_type(_validate_chart_config(_extract_chart_config(raw)), question)
    return clean, chart


class TestChatPipelineComposition:
    """End-to-end of the route's text-cleanup + chart-decision chain (no model)."""

    def test_top_customer_incident_downgrades_and_strips_bold(self):
        # The reported incident, end to end: bold stripped, degenerate 2-bar
        # (one dominant value) chart downgraded to a text-only answer.
        raw = (
            "**Customer 101** is your top customer by a wide margin — $7,749.24.\n"
            "```json\n"
            '{"chart_type": "bar", "x_key": "customer", "y_key": "revenue", '
            '"data": [{"customer": "Customer 101", "revenue": 7749.24}, '
            '{"customer": "Other", "revenue": 36.46}]}\n'
            "```"
        )
        clean, chart = _process(raw, "who is my top customer by revenue?")
        assert "**" not in clean
        assert "Customer 101 is your top customer" in clean
        assert chart is None  # degenerate -> text only

    def test_key_mismatch_downgrades(self):
        raw = (
            "Here is revenue by customer.\n```json\n"
            '{"chart_type": "bar", "x_key": "customer", "y_key": "revenue", '
            '"data": [{"name": "A", "value": 5}, {"name": "B", "value": 3}, '
            '{"name": "C", "value": 2}]}\n```'
        )
        _, chart = _process(raw)
        assert chart is None

    def test_valid_trend_kept_and_typed_area(self):
        raw = (
            "Revenue is trending up.\n```json\n"
            '{"chart_type": "bar", "x_key": "week", "y_key": "revenue", '
            '"data": [{"week": "2026-01-01", "revenue": 100}, '
            '{"week": "2026-02-01", "revenue": 140}, '
            '{"week": "2026-03-01", "revenue": 120}]}\n```'
        )
        clean, chart = _process(raw, "revenue over time")
        assert chart is not None
        assert chart["chart_type"] == "area"  # temporal -> area
        assert "```" not in clean
