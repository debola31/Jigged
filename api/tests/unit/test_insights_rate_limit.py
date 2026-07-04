"""
Unit tests for the AI Insights per-company flag + configurable rate limit.

Covers the pure logic added for issue #80:
- _get_company_ai_settings: opt-out ai_insights flag + configurable chat limit
- _check_chat_rate_limit: honors the passed limit, emits 429 + Retry-After
- _seconds_until_window_frees: Retry-After computation

The Supabase client is mocked, so these need no DB / env.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from routes import insights_routes
from routes.insights_routes import (
    DEFAULT_CHAT_LIMIT_PER_HOUR,
    _check_chat_rate_limit,
    _get_company_ai_settings,
    _seconds_until_window_frees,
)

pytestmark = pytest.mark.unit


def _fluent_client(execute_data):
    """A Supabase-style fluent mock whose terminal .execute() returns an object
    with `.data = execute_data`. Every builder method returns the same mock."""
    client = MagicMock()
    for method in ("table", "select", "eq", "gte", "order", "single"):
        getattr(client, method).return_value = client
    result = MagicMock()
    result.data = execute_data
    client.execute.return_value = result
    return client


def _iso(dt: datetime) -> str:
    return dt.isoformat()


class TestGetCompanyAiSettings:
    @patch.object(insights_routes, "_get_supabase_service_role")
    def test_defaults_when_settings_null(self, mock_sr):
        mock_sr.return_value = _fluent_client({"settings": None})
        enabled, limit = _get_company_ai_settings("c1")
        assert enabled is True
        assert limit == DEFAULT_CHAT_LIMIT_PER_HOUR

    @patch.object(insights_routes, "_get_supabase_service_role")
    def test_opt_out_default_on_when_key_absent(self, mock_sr):
        mock_sr.return_value = _fluent_client({"settings": {"features": {}}})
        enabled, _ = _get_company_ai_settings("c1")
        assert enabled is True

    @patch.object(insights_routes, "_get_supabase_service_role")
    def test_explicit_false_disables(self, mock_sr):
        mock_sr.return_value = _fluent_client(
            {"settings": {"features": {"ai_insights": False}}}
        )
        enabled, _ = _get_company_ai_settings("c1")
        assert enabled is False

    @patch.object(insights_routes, "_get_supabase_service_role")
    def test_explicit_true_enables(self, mock_sr):
        mock_sr.return_value = _fluent_client(
            {"settings": {"features": {"ai_insights": True}}}
        )
        enabled, _ = _get_company_ai_settings("c1")
        assert enabled is True

    @patch.object(insights_routes, "_get_supabase_service_role")
    def test_custom_limit_read(self, mock_sr):
        mock_sr.return_value = _fluent_client(
            {"settings": {"ai_limits": {"chat_per_hour": 100}}}
        )
        _, limit = _get_company_ai_settings("c1")
        assert limit == 100

    @patch.object(insights_routes, "_get_supabase_service_role")
    def test_invalid_limit_falls_back(self, mock_sr):
        mock_sr.return_value = _fluent_client(
            {"settings": {"ai_limits": {"chat_per_hour": 0}}}
        )
        _, limit = _get_company_ai_settings("c1")
        assert limit == DEFAULT_CHAT_LIMIT_PER_HOUR

    @patch.object(insights_routes, "_get_supabase_service_role")
    def test_fails_open_on_read_error(self, mock_sr):
        mock_sr.side_effect = RuntimeError("db down")
        enabled, limit = _get_company_ai_settings("c1")
        assert enabled is True
        assert limit == DEFAULT_CHAT_LIMIT_PER_HOUR


class TestCheckChatRateLimit:
    @patch.object(insights_routes, "_get_supabase_service_role")
    def test_under_limit_passes(self, mock_sr):
        rows = [{"created_at": _iso(datetime.now(timezone.utc))} for _ in range(2)]
        mock_sr.return_value = _fluent_client(rows)
        # 2 queries, limit 20 → no raise
        _check_chat_rate_limit("c1", 20)

    @patch.object(insights_routes, "_get_supabase_service_role")
    def test_at_limit_raises_429_with_retry_after(self, mock_sr):
        now = datetime.now(timezone.utc)
        rows = [
            {"created_at": _iso(now - timedelta(minutes=30))},
            {"created_at": _iso(now - timedelta(minutes=5))},
        ]
        mock_sr.return_value = _fluent_client(rows)
        with pytest.raises(HTTPException) as exc:
            _check_chat_rate_limit("c1", 2)
        assert exc.value.status_code == 429
        assert "Maximum 2" in exc.value.detail
        # Retry-After present and sane (oldest was ~30 min into the hour window).
        retry_after = int(exc.value.headers["Retry-After"])
        assert 1 <= retry_after <= 3600

    @patch.object(insights_routes, "_get_supabase_service_role")
    def test_query_error_allows_through(self, mock_sr):
        client = MagicMock()
        for method in ("table", "select", "eq", "gte", "order"):
            getattr(client, method).return_value = client
        client.execute.side_effect = RuntimeError("query blew up")
        mock_sr.return_value = client
        # Read failure is non-fatal — must not raise.
        _check_chat_rate_limit("c1", 1)


class TestSecondsUntilWindowFrees:
    _NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    def test_parses_offset_timestamp(self):
        # Oldest 30 min ago → 30 min left in the 1-hour window.
        assert (
            _seconds_until_window_frees("2026-01-01T11:30:00+00:00", self._NOW) == 1800
        )

    def test_tolerates_trailing_z(self):
        assert _seconds_until_window_frees("2026-01-01T11:30:00Z", self._NOW) == 1800

    def test_clamps_to_minimum_one(self):
        # Oldest exactly an hour ago → 0 remaining → clamped up to 1.
        assert _seconds_until_window_frees("2026-01-01T11:00:00+00:00", self._NOW) == 1

    def test_unparseable_falls_back_to_hour(self):
        assert _seconds_until_window_frees("not-a-date", self._NOW) == 3600
        assert _seconds_until_window_frees(None, self._NOW) == 3600
