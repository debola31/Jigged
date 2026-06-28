"""Unit tests for chat answer formatting helpers.

The insights chat answer renders as plain text in the UI, so any markdown table
the model emits shows up as raw `| col | col |` / `|---|---|`. `_flatten_markdown_tables`
is the backstop that converts those to readable plain text.
"""

import pytest

from routes.insights_routes import (
    _flatten_markdown_tables,
    _strip_code_blocks,
    _strip_inline_markdown,
)

pytestmark = pytest.mark.unit


class TestFlattenMarkdownTables:
    def test_plain_text_unchanged(self):
        text = "Revenue is up 12% vs last week."
        assert _flatten_markdown_tables(text) == text

    def test_no_pipes_returns_input(self):
        text = "Top customer: Acme ($50k)."
        assert _flatten_markdown_tables(text) == text

    def test_markdown_table_flattened(self):
        text = (
            "Here are the top customers:\n"
            "| Customer | Revenue |\n"
            "|----------|---------|\n"
            "| Acme | $50k |\n"
            "| Globex | $35k |"
        )
        out = _flatten_markdown_tables(text)
        assert "|" not in out
        assert "---" not in out
        assert "Customer — Revenue" in out
        assert "Acme — $50k" in out
        assert "Globex — $35k" in out
        assert "Here are the top customers:" in out

    def test_separator_row_with_alignment_dropped(self):
        text = "| A | B |\n| :--- | ---: |\n| 1 | 2 |"
        out = _flatten_markdown_tables(text)
        assert "---" not in out
        assert "A — B" in out
        assert "1 — 2" in out

    def test_bullet_list_preserved(self):
        text = "- first item\n- second item"
        assert _flatten_markdown_tables(text) == text

    def test_inline_prose_pipe_preserved(self):
        # A pipe mid-sentence (line doesn't start/end with |) is left alone.
        text = "Throughput is 5 | 6 depending on shift."
        assert _flatten_markdown_tables(text) == text

    def test_unbalanced_row_is_safe(self):
        text = "| Customer | Revenue"
        out = _flatten_markdown_tables(text)
        assert "Customer — Revenue" in out


class TestStripCodeBlocks:
    def test_removes_fenced_json(self):
        text = 'Revenue up.\n```json\n{"chart_type": "bar"}\n```'
        out = _strip_code_blocks(text)
        assert "chart_type" not in out
        assert "Revenue up." in out


class TestStripInlineMarkdown:
    def test_bold_unwrapped(self):
        # The exact reported defect.
        assert _strip_inline_markdown("**Customer 101** is your top customer") == (
            "Customer 101 is your top customer"
        )

    def test_italic_and_code_and_heading_and_link(self):
        assert _strip_inline_markdown("an *italic* word") == "an italic word"
        assert _strip_inline_markdown("the `job_id` field") == "the job_id field"
        assert _strip_inline_markdown("# Heading\nbody") == "Heading\nbody"
        assert _strip_inline_markdown("see [the docs](https://x.io/y)") == "see the docs"

    def test_plain_prose_untouched(self):
        text = "Revenue is up 12% vs last week."
        assert _strip_inline_markdown(text) == text

    def test_part_numbers_and_multiplication_preserved(self):
        # Underscores in identifiers and a literal "a * b" must NOT be mangled.
        assert _strip_inline_markdown("Part PART_101 ships today") == "Part PART_101 ships today"
        assert _strip_inline_markdown("cost is a * b per unit") == "cost is a * b per unit"
        assert _strip_inline_markdown("col revenue_total is high") == "col revenue_total is high"
