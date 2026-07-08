"""Unit tests for the health-report AI provider methods (services/ai/claude_provider.py).

Mocks self.client.messages.create so no Anthropic calls happen. Covers the shared JSON
parse helper, structure parsing (incl. hallucinated-header rejection + graceful degrade),
narrative parsing (incl. the no-fabrication failure path), and that the OpenAI/Gemini
subclasses are still concrete after the new abstract methods were added.
"""

import inspect
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from services.ai.base_provider import HealthNarrativeResult, StructureResult
from services.ai.claude_provider import ClaudeProvider, _clamp01, _parse_json_response
from services.ai.factory import create_provider

pytestmark = pytest.mark.unit


def _resp(text: str):
    return SimpleNamespace(content=[SimpleNamespace(text=text)])


def _provider_with_response(text: str) -> ClaudeProvider:
    p = ClaudeProvider(api_key="test-key")
    p.client = MagicMock()
    p.client.messages.create = MagicMock(return_value=_resp(text))
    return p


# --------------------------------------------------------------------------- helpers
class TestParseJsonResponse:
    def test_plain_json(self):
        assert _parse_json_response('{"a": 1}') == {"a": 1}

    def test_json_fence(self):
        assert _parse_json_response('```json\n{"a": 1}\n```') == {"a": 1}

    def test_bare_fence(self):
        assert _parse_json_response('```\n{"a": 2}\n```') == {"a": 2}

    def test_malformed_raises(self):
        with pytest.raises(json.JSONDecodeError):
            _parse_json_response("not json at all {")

    def test_clamp01(self):
        assert _clamp01(1.5) == 1.0
        assert _clamp01(-3) == 0.0
        assert _clamp01("nope") == 0.0
        assert _clamp01(0.42) == 0.42


# --------------------------------------------------------------------------- subclasses concrete
class TestProvidersConcrete:
    def test_claude_openai_gemini_have_no_abstract_methods(self):
        from services.ai.openai_provider import OpenAIProvider
        from services.ai.gemini_provider import GeminiProvider

        for cls in (ClaudeProvider, OpenAIProvider, GeminiProvider):
            assert not inspect.isabstract(cls), f"{cls.__name__} still abstract"
            assert cls.__abstractmethods__ == frozenset(), f"{cls.__name__} missing overrides"

    def test_create_provider_openai_constructs(self, monkeypatch):
        # Adding abstract methods must not make the subclass un-instantiable.
        monkeypatch.setenv("OPENAI_API_KEY", "x")
        assert create_provider("openai").provider_name == "openai"


# --------------------------------------------------------------------------- analyze_structure
class TestAnalyzeStructure:
    async def test_parses_erp_and_column_roles(self):
        payload = {
            "erp": {
                "source": "tangle",
                "display_name": "Tangle",
                "confidence": 0.82,
                "matched_headers": [{"header": "JobNo", "signal": "job-shop id"}],
                "evidence": "job-shop vocabulary",
                "alternatives": [{"source": "e2", "confidence": 0.3}],
            },
            "files": [
                {"filename": "parts.csv", "entity_type": "parts", "entity_confidence": 0.9,
                 "column_roles": {"part_name": "PartNo", "preferred_vendor_name": "Vendor"}},
            ],
        }
        p = _provider_with_response(json.dumps(payload))
        result = await p.analyze_structure(
            files=[{"filename": "parts.csv", "headers": ["PartNo", "Vendor"], "column_samples": {}}],
            entity_schemas={"parts": {}},
            erp_catalog=[],
        )
        assert isinstance(result, StructureResult)
        assert result.erp.source == "tangle"
        assert result.erp.confidence == 0.82
        assert result.files[0].column_roles == {"part_name": "PartNo", "preferred_vendor_name": "Vendor"}

    async def test_drops_hallucinated_headers(self):
        payload = {
            "erp": {"source": "unknown", "confidence": 0.0},
            "files": [
                {"filename": "parts.csv", "entity_type": "parts", "entity_confidence": 0.5,
                 "column_roles": {"part_name": "PartNo", "preferred_vendor_name": "Ghost"}},
            ],
        }
        p = _provider_with_response(json.dumps(payload))
        result = await p.analyze_structure(
            files=[{"filename": "parts.csv", "headers": ["PartNo"], "column_samples": {}}],
            entity_schemas={"parts": {}},
            erp_catalog=[],
        )
        # "Ghost" isn't a real header in the file -> dropped; "PartNo" kept.
        assert result.files[0].column_roles == {"part_name": "PartNo"}

    async def test_malformed_degrades_to_unknown_without_raising(self):
        p = _provider_with_response("this is not json")
        result = await p.analyze_structure(
            files=[{"filename": "parts.csv", "headers": ["PartNo"], "column_samples": {}}],
            entity_schemas={"parts": {}},
            erp_catalog=[],
        )
        assert result.erp.source == "unknown"
        assert result.files[0].filename == "parts.csv"
        assert result.files[0].entity_type == "unknown"
        assert result.files[0].column_roles == {}

    async def test_clamps_out_of_range_confidence(self):
        payload = {"erp": {"source": "x", "confidence": 5}, "files": []}
        p = _provider_with_response(json.dumps(payload))
        result = await p.analyze_structure(files=[], entity_schemas={}, erp_catalog=[])
        assert result.erp.confidence == 1.0


# --------------------------------------------------------------------------- narrative
class TestGenerateNarrative:
    async def test_parses_summary_recs_gotchas(self):
        payload = {
            "summary": "Your data is mostly ready.",
            "recommendations": ["Dedupe vendors", "Fill missing costs"],
            "gotchas": [{"title": "Trailing spaces", "detail": "check", "recommended_action": "trim"}],
        }
        p = _provider_with_response(json.dumps(payload))
        result = await p.generate_health_narrative(erp={}, findings=[], file_summaries=[])
        assert isinstance(result, HealthNarrativeResult)
        assert result.available is True
        assert result.summary.startswith("Your data")
        assert len(result.recommendations) == 2
        assert result.gotchas[0]["title"] == "Trailing spaces"

    async def test_failure_sets_unavailable_and_no_fabricated_prose(self):
        p = _provider_with_response("<garbage/>")
        result = await p.generate_health_narrative(erp={}, findings=[], file_summaries=[])
        assert result.available is False
        assert result.summary == ""
        assert result.recommendations == []
