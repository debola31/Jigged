"""Unit tests for UOM normalization (services/uom_normalizer.py).

Covers the pure logic — alias resolution and the alias/dedup/cap orchestration
in resolve_units_for_rows. The AI inference call (infer_uom_with_ai) is patched
so these tests never hit Anthropic and stay deterministic.
"""

from unittest.mock import patch

import pytest

from services.uom_normalizer import normalize_uom_alias, resolve_units_for_rows


class TestNormalizeUomAlias:
    def test_empty_string_returns_none(self):
        assert normalize_uom_alias("") is None

    def test_whitespace_only_returns_none(self):
        assert normalize_uom_alias("   ") is None

    def test_canonical_value_passes_through(self):
        assert normalize_uom_alias("inches") == "inches"

    def test_canonical_value_is_case_insensitive(self):
        assert normalize_uom_alias("Inches") == "inches"

    def test_alias_is_mapped(self):
        assert normalize_uom_alias("EA") == "each"
        assert normalize_uom_alias("lbs") == "pounds"

    def test_alias_match_trims_and_lowercases(self):
        assert normalize_uom_alias("  IN  ") == "inches"

    def test_multiword_alias(self):
        assert normalize_uom_alias("sq ft") == "square feet"

    def test_unknown_value_returns_none(self):
        assert normalize_uom_alias("widgets") is None


class TestResolveUnitsForRows:
    def test_no_uom_column_returns_empty(self):
        rows = [{"name": "Bar"}]
        assert resolve_units_for_rows(
            rows, name_column="name", description_column=None, uom_column=None
        ) == {}

    @patch("services.uom_normalizer.infer_uom_with_ai")
    def test_alias_resolved_rows_never_call_ai(self, mock_ai):
        rows = [{"uom": "in"}, {"uom": "EA"}]
        result = resolve_units_for_rows(
            rows, name_column=None, description_column=None, uom_column="uom"
        )
        assert result == {1: "inches", 2: "each"}
        mock_ai.assert_not_called()

    @patch("services.uom_normalizer.infer_uom_with_ai")
    def test_empty_uom_with_no_name_left_unresolved(self, mock_ai):
        rows = [{"uom": ""}]
        result = resolve_units_for_rows(
            rows, name_column="name", description_column=None, uom_column="uom"
        )
        assert result == {1: None}
        mock_ai.assert_not_called()

    @patch("services.uom_normalizer.infer_uom_with_ai")
    def test_unresolvable_uom_with_name_goes_to_ai(self, mock_ai):
        mock_ai.return_value = {"0": "feet"}
        rows = [{"uom": "stick", "name": "Aluminum Bar"}]
        result = resolve_units_for_rows(
            rows, name_column="name", description_column=None, uom_column="uom"
        )
        assert result == {1: "feet"}
        mock_ai.assert_called_once()

    @patch("services.uom_normalizer.infer_uom_with_ai")
    def test_identical_rows_are_deduped_into_one_ai_item(self, mock_ai):
        mock_ai.return_value = {"0": "feet"}
        rows = [
            {"uom": "stick", "name": "Aluminum Bar"},
            {"uom": "STICK", "name": "aluminum bar"},  # same after lowercasing
        ]
        result = resolve_units_for_rows(
            rows, name_column="name", description_column=None, uom_column="uom"
        )
        # Both rows get the single inferred value...
        assert result == {1: "feet", 2: "feet"}
        # ...and the AI was asked about exactly one unique item.
        sent_items = mock_ai.call_args.args[0]
        assert len(sent_items) == 1

    @patch("services.uom_normalizer.infer_uom_with_ai")
    def test_ai_cap_sends_first_n_and_leaves_remainder_none(self, mock_ai):
        mock_ai.return_value = {"0": "feet"}
        rows = [
            {"uom": "stick", "name": "Aluminum Bar"},
            {"uom": "blob", "name": "Steel Powder"},
        ]
        result = resolve_units_for_rows(
            rows,
            name_column="name",
            description_column=None,
            uom_column="uom",
            max_ai_items=1,
        )
        assert result == {1: "feet", 2: None}
        # Only the first unique item is sent when capped.
        sent_items = mock_ai.call_args.args[0]
        assert len(sent_items) == 1
