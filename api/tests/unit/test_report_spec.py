"""ReportSpec: the one-page budget as data, and a schema strict output can take.

Two properties matter more than the caps. The schema has no $defs or $ref
(strictify refuses them, and Ollama's grammar wants closed objects), and the
shared fixture -- the same bytes utils/reportSpec.ts is tested against -- validates,
so the Python producer and the TypeScript renderer cannot drift apart unnoticed.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from models.report_spec import (TITLE_MAX, 
    BLOCK_MAX, CHART_POINTS_MAX, CHART_POINTS_MIN, KPI_MAX, TABLE_ROWS_MAX,
    ReportSpec, inline_refs,
)
from services.llm.postprocess import strictify

pytestmark = pytest.mark.unit

FIXTURE = Path(__file__).resolve().parents[3] / "__tests__" / "fixtures" / "reportSpecExample.json"


def _spec(**over) -> dict:
    base = {
        "title": "OPERATIONS SUMMARY",
        "period_start": "2026-06-01",
        "period_end": "2026-09-03",
        "period_label": "Jun 1 – Sep 3, 2026",
        "headline": "Booked $99,251 across 84 jobs; 32 open.",
        "kpis": [
            {"label": "Quotes issued", "value": 115, "format": "integer", "caption": None},
            {"label": "Booked", "value": 99251, "format": "currency", "caption": "84 jobs"},
        ],
        "blocks": [
            {
                "type": "table", "title": "Backlog aging",
                "columns": [{"label": "Bucket", "format": "plain"}, {"label": "Jobs", "format": "integer"},
                            {"label": "Value", "format": "currency"}],
                "rows": [["Not yet due", 9, 11115], ["1–30 days past due", 18, 25743]],
                "total_row": ["Total open", 27, 36858], "note": None,
            },
            {
                "type": "chart", "title": "Booked by month", "chart_type": "bar",
                "x_label": "Month", "y_label": "Booked ($)",
                "points": [{"label": "Jun", "value": 13367}, {"label": "Jul", "value": 34444},
                           {"label": "Aug", "value": 48971}],
                "note": None,
            },
        ],
    }
    base.update(over)
    return base


class TestTheSchema:
    def test_it_has_no_refs_and_strictifies(self):
        schema = ReportSpec.model_json_schema()
        assert "$defs" not in schema and "$ref" not in json.dumps(schema)
        strict = strictify(schema)
        assert strict["additionalProperties"] is False
        assert set(strict["required"]) == {
            "title", "period_start", "period_end", "period_label", "headline", "kpis", "blocks",
        }

    def test_every_block_variant_is_a_closed_object(self):
        strict = strictify(ReportSpec.model_json_schema())
        variants = strict["properties"]["blocks"]["items"]["anyOf"]
        assert len(variants) == 3
        assert all(v["additionalProperties"] is False and v["required"] for v in variants)

    def test_inline_refs_resolves_nested_definitions_and_keeps_siblings(self):
        schema = {
            "$defs": {"Leaf": {"type": "object", "properties": {"a": {"type": "string"}}}},
            "type": "object",
            "properties": {"leaf": {"$ref": "#/$defs/Leaf", "description": "one leaf"}},
        }
        out = inline_refs(schema)
        assert "$defs" not in out
        assert out["properties"]["leaf"]["type"] == "object"
        assert out["properties"]["leaf"]["description"] == "one leaf"


class TestTheCaps:
    def test_a_well_formed_spec_validates(self):
        spec = ReportSpec.model_validate(_spec())
        assert spec.kpis[1].value == 99251 and spec.blocks[1].type == "chart"

    def test_the_shared_fixture_validates(self):
        """The same file utils/reportSpec.ts is tested against."""
        spec = ReportSpec.model_validate_json(FIXTURE.read_text(encoding="utf-8"))
        assert spec.title and spec.blocks

    @pytest.mark.parametrize("over, fragment", [
        ({"kpis": [{"label": f"K{i}", "value": 1, "format": "plain", "caption": None} for i in range(KPI_MAX + 1)]}, "kpis"),
        ({"blocks": [{"type": "text", "body": "x"}] + [_spec()["blocks"][1]] * BLOCK_MAX}, "blocks"),
        ({"title": "T" * (TITLE_MAX + 1)}, "title"),
        ({"headline": "H" * 201}, "headline"),
        ({"period_start": "2026-09-30", "period_end": "2026-09-01"}, "period_start"),
    ])
    def test_the_one_page_budget_is_enforced_as_data(self, over, fragment):
        with pytest.raises(ValidationError) as exc:
            ReportSpec.model_validate(_spec(**over))
        assert fragment in str(exc.value)

    def test_at_most_one_text_block(self):
        blocks = [{"type": "text", "body": "One."}, {"type": "text", "body": "Two."}]
        with pytest.raises(ValidationError, match="numbers over words"):
            ReportSpec.model_validate(_spec(blocks=blocks))

    def test_a_table_row_must_match_its_columns(self):
        table = dict(_spec()["blocks"][0])
        table["rows"] = [["Not yet due", 9]]
        with pytest.raises(ValidationError, match="one per column"):
            ReportSpec.model_validate(_spec(blocks=[table]))

    def test_a_table_has_at_most_eight_rows(self):
        table = dict(_spec()["blocks"][0])
        table["rows"] = [["r", 1, 1]] * (TABLE_ROWS_MAX + 1)
        with pytest.raises(ValidationError):
            ReportSpec.model_validate(_spec(blocks=[table]))

    def test_a_chart_needs_three_to_twelve_points(self):
        chart = dict(_spec()["blocks"][1])
        chart["points"] = chart["points"][: CHART_POINTS_MIN - 1]
        with pytest.raises(ValidationError):
            ReportSpec.model_validate(_spec(blocks=[chart]))
        chart["points"] = [{"label": f"p{i}", "value": i} for i in range(CHART_POINTS_MAX + 1)]
        with pytest.raises(ValidationError):
            ReportSpec.model_validate(_spec(blocks=[chart]))

    def test_cells_keep_their_kind(self):
        """A JSON number is a number and a JSON string a string: the traceability guard
        checks numbers only, so a label must never be parsed into one."""
        spec = ReportSpec.model_validate(_spec())
        table = spec.blocks[0]
        assert table.rows[0] == ["Not yet due", 9.0, 11115.0]
