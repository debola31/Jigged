"""Unit tests for the QuickBooks route helpers — the signed OAuth state (CSRF +
company binding) and the post-OAuth redirect base resolution."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import routes.quickbooks_routes as qr  # noqa: E402


def test_app_base_url_prefers_explicit_over_allowed_origins(monkeypatch):
    # APP_BASE_URL wins over the (possibly mis-ordered) ALLOWED_ORIGINS list —
    # this is the config knob that fixes the localhost-vs-production redirect.
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://jigged-ai.vercel.app,http://localhost:3000")
    monkeypatch.setenv("APP_BASE_URL", "http://localhost:3000")
    assert qr._app_base_url() == "http://localhost:3000"


def test_app_base_url_falls_back_to_first_allowed_origin(monkeypatch):
    monkeypatch.delenv("APP_BASE_URL", raising=False)
    monkeypatch.delenv("NEXT_PUBLIC_APP_URL", raising=False)
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://jigged.app,http://localhost:3000")
    assert qr._app_base_url() == "https://jigged.app"


def test_state_roundtrips_company_and_user(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_STATE_SECRET", "unit-secret")
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    state = qr._mint_state("co1", "user1")
    claims = qr._verify_state(state)
    assert claims["company_id"] == "co1"
    assert claims["user_id"] == "user1"


def test_state_rejects_tampered(monkeypatch):
    import jwt

    monkeypatch.setenv("QUICKBOOKS_STATE_SECRET", "unit-secret")
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    state = qr._mint_state("co1", "user1")
    with pytest.raises(jwt.InvalidTokenError):
        jwt.decode(state + "x", "unit-secret", algorithms=["HS256"])
