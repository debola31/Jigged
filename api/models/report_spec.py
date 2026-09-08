"""The shape of a one-page executive summary, as the model fills it and the browser draws it.

A REPORT IS A SPEC, NOT A DOCUMENT. The model gathers figures with execute_sql and
then fills THIS object; a deterministic renderer in the browser
(utils/reportPdf.ts) lays it out on exactly one page with the shop's header. The
guardrails the owner asked for -- one page, minimal prose, the AI-inferred title
top-right -- are therefore properties of a schema and a renderer, not requests
made of a model.

STRICT-SCHEMA SHAPE, ON PURPOSE. Ollama's `format` and Anthropic's structured
output both want every object closed (additionalProperties: false) with every
property required, which rules out free-form dicts: a table row is a LIST of
cells aligned with `columns`, a chart is a list of {label, value} points that the
handler turns into a chart_config, and every optional field is nullable rather
than absent. postprocess.strictify also refuses `$defs`, so `model_json_schema`
is overridden to inline the nested models -- keep them flat enough that this
stays a mechanical step.

The caps are the one-page budget expressed as data: four KPI tiles, four blocks,
eight rows by five columns, twelve points, one text block of two sentences. The
renderer still measures and drops what does not fit, naming what it dropped;
these numbers make that rare rather than impossible.

The mirror is utils/reportSpec.ts; __tests__/fixtures/reportSpecExample.json is
validated by both sides so they cannot drift apart unnoticed.
"""
from __future__ import annotations

import copy
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

Format = Literal["currency", "integer", "percent", "plain"]
Cell = str | float | None

TITLE_MAX = 40
HEADLINE_MAX = 200
KPI_MAX = 4
BLOCK_MAX = 4
TABLE_ROWS_MAX = 8
TABLE_COLUMNS_MAX = 5
CHART_POINTS_MIN = 3
CHART_POINTS_MAX = 12
TEXT_BODY_MAX = 240
NOTE_MAX = 120


class Kpi(BaseModel):
    label: str = Field(min_length=1, max_length=24)
    value: float
    format: Format
    caption: str | None = Field(default=None, max_length=32)


class Column(BaseModel):
    label: str = Field(min_length=1, max_length=20)
    format: Format


class TableBlock(BaseModel):
    type: Literal["table"]
    title: str = Field(min_length=1, max_length=TITLE_MAX)
    columns: list[Column] = Field(min_length=1, max_length=TABLE_COLUMNS_MAX)
    rows: list[list[Cell]] = Field(min_length=1, max_length=TABLE_ROWS_MAX)
    total_row: list[Cell] | None = None
    note: str | None = Field(default=None, max_length=NOTE_MAX)

    @model_validator(mode="after")
    def _rows_match_columns(self) -> "TableBlock":
        width = len(self.columns)
        for row in self.rows:
            if len(row) != width:
                raise ValueError(f"every row must have {width} cells, one per column")
        if self.total_row is not None and len(self.total_row) != width:
            raise ValueError(f"total_row must have {width} cells, one per column")
        return self


class ChartPoint(BaseModel):
    label: str = Field(min_length=1, max_length=40)
    value: float


class ChartBlock(BaseModel):
    type: Literal["chart"]
    title: str = Field(min_length=1, max_length=TITLE_MAX)
    chart_type: Literal["area", "bar", "bar_horizontal", "pie"]
    x_label: str = Field(min_length=1, max_length=24)
    y_label: str = Field(min_length=1, max_length=24)
    points: list[ChartPoint] = Field(min_length=CHART_POINTS_MIN, max_length=CHART_POINTS_MAX)
    note: str | None = Field(default=None, max_length=NOTE_MAX)


class TextBlock(BaseModel):
    type: Literal["text"]
    body: str = Field(min_length=1, max_length=TEXT_BODY_MAX)


Block = TableBlock | ChartBlock | TextBlock


def inline_refs(schema: dict[str, Any]) -> dict[str, Any]:
    """Resolve every `$ref` into a copy of its definition and drop `$defs`.

    strictify() refuses `$defs` because strict-mode `$ref` support is uneven
    across vendors. Pydantic emits one per nested model, so the report's schema
    is inlined here, once, rather than each nested type being hand-flattened.
    """
    defs = schema.get("$defs") or {}

    def resolve(node: Any) -> Any:
        if isinstance(node, list):
            return [resolve(n) for n in node]
        if not isinstance(node, dict):
            return node
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            target = copy.deepcopy(defs[ref[len("#/$defs/"):]])
            # Sibling keys beside a $ref (a description, a title) ride along.
            merged = {**resolve(target), **{k: v for k, v in node.items() if k != "$ref"}}
            return merged
        return {k: resolve(v) for k, v in node.items() if k != "$defs"}

    return resolve(schema)


class ReportSpec(BaseModel):
    title: str = Field(min_length=1, max_length=TITLE_MAX)
    period_start: date
    period_end: date
    period_label: str = Field(min_length=1, max_length=40)
    headline: str = Field(min_length=1, max_length=HEADLINE_MAX)
    kpis: list[Kpi] = Field(max_length=KPI_MAX)
    blocks: list[Block] = Field(min_length=1, max_length=BLOCK_MAX)

    @model_validator(mode="after")
    def _one_page_of_prose(self) -> "ReportSpec":
        if sum(1 for b in self.blocks if isinstance(b, TextBlock)) > 1:
            raise ValueError("at most one text block: numbers over words")
        if self.period_start > self.period_end:
            raise ValueError("period_start must not be after period_end")
        return self

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:  # type: ignore[override]
        return inline_refs(super().model_json_schema(*args, **kwargs))


__all__ = [
    "BLOCK_MAX", "CHART_POINTS_MAX", "CHART_POINTS_MIN", "HEADLINE_MAX", "KPI_MAX",
    "NOTE_MAX", "TABLE_COLUMNS_MAX", "TABLE_ROWS_MAX", "TEXT_BODY_MAX", "TITLE_MAX",
    "Block", "Cell", "ChartBlock", "ChartPoint", "Column", "Format", "Kpi", "ReportSpec",
    "TableBlock", "TextBlock", "inline_refs",
]
