"""Unit tests for centralized Anthropic model config + the deprecation check.

These mock the Anthropic client so no network call or API key is needed. The
live early-warning test lives in tests/integration/test_model_active.py.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from services.ai.model_config import DEFAULT_ANTHROPIC_MODEL, check_model_health

pytestmark = pytest.mark.unit

RETIRED_MODEL = "claude-sonnet-4-20250514"  # the id that broke chat/chart


def _fake_client(model_ids):
    client = MagicMock()
    client.models.list.return_value = [SimpleNamespace(id=mid) for mid in model_ids]
    return client


def test_default_model_is_a_nonretired_sonnet():
    assert DEFAULT_ANTHROPIC_MODEL.startswith("claude-sonnet-")
    assert DEFAULT_ANTHROPIC_MODEL != RETIRED_MODEL


def test_claude_provider_uses_default_model():
    # Regression guard: the chat/chart route builds ClaudeProvider() with no
    # model, so the default must be the pinned model — never the retired id.
    from services.ai.claude_provider import ClaudeProvider

    provider = ClaudeProvider(api_key="test-key")
    assert provider.model == DEFAULT_ANTHROPIC_MODEL
    assert provider.model != RETIRED_MODEL


@patch("services.ai.model_config.anthropic.Anthropic")
def test_check_model_health_active(mock_anthropic):
    mock_anthropic.return_value = _fake_client(
        ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"]
    )
    result = check_model_health(model="claude-sonnet-4-6", api_key="test-key")
    assert result["checked"] is True
    assert result["active"] is True
    assert result["error"] is None
    assert "claude-sonnet-4-6" in result["active_model_ids"]


@patch("services.ai.model_config.anthropic.Anthropic")
def test_check_model_health_flags_retired_model(mock_anthropic):
    # Reproduce the incident: the pinned model is no longer in the active list.
    mock_anthropic.return_value = _fake_client(["claude-sonnet-4-6", "claude-opus-4-8"])
    result = check_model_health(model=RETIRED_MODEL, api_key="test-key")
    assert result["checked"] is True
    assert result["active"] is False
    assert result["error"] is None


@patch("services.ai.model_config.anthropic.Anthropic")
def test_check_model_health_never_raises_on_api_error(mock_anthropic):
    client = MagicMock()
    client.models.list.side_effect = RuntimeError("network down")
    mock_anthropic.return_value = client

    result = check_model_health(model="claude-sonnet-4-6", api_key="test-key")
    assert result["checked"] is False
    assert result["active"] is None
    assert "network down" in result["error"]
    assert result["active_model_ids"] == []
