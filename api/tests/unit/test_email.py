"""Unit tests for the email service wrapper."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Make the api/ package importable when tests run from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from services.email import (  # noqa: E402
    EmailAttachment,
    EmailServiceUnavailable,
    send_email,
)


def test_raises_when_api_key_missing(monkeypatch):
    """Without RESEND_API_KEY we should fail loud, not silently swallow."""
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.setenv("QUOTES_FROM_EMAIL", "noreply@mail.jigged.app")

    with pytest.raises(EmailServiceUnavailable):
        send_email(to=["someone@example.com"], subject="x", body_text="x")


def test_raises_when_from_address_missing(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re_test")
    monkeypatch.delenv("QUOTES_FROM_EMAIL", raising=False)

    with pytest.raises(EmailServiceUnavailable):
        send_email(to=["someone@example.com"], subject="x", body_text="x")


def test_sends_with_attachment(monkeypatch):
    """Resend params should include from/to/subject/text/attachments correctly."""
    monkeypatch.setenv("RESEND_API_KEY", "re_test")
    monkeypatch.setenv("QUOTES_FROM_EMAIL", "noreply@mail.jigged.app")

    # Build a fake resend module that records the params passed to send().
    captured: dict = {}

    class _FakeEmails:
        @staticmethod
        def send(params):
            captured["params"] = params
            return {"id": "msg_abc123"}

    fake_resend = type("FakeResend", (), {"api_key": None, "Emails": _FakeEmails})

    with patch.dict(sys.modules, {"resend": fake_resend}):
        message_id = send_email(
            to=["customer@example.com"],
            cc=["sales@shop.example"],
            subject="Quote Q-0001",
            body_text="Please find attached.",
            reply_to="shop@example.com",
            attachments=[
                EmailAttachment(filename="Quote-Q-0001.pdf", content=b"%PDF-1.4 ..."),
            ],
        )

    assert message_id == "msg_abc123"
    params = captured["params"]
    assert params["from"] == "noreply@mail.jigged.app"
    assert params["to"] == ["customer@example.com"]
    assert params["cc"] == ["sales@shop.example"]
    assert params["subject"] == "Quote Q-0001"
    assert params["text"] == "Please find attached."
    assert params["reply_to"] == "shop@example.com"
    assert len(params["attachments"]) == 1
    att = params["attachments"][0]
    assert att["filename"] == "Quote-Q-0001.pdf"
    # Content must be base64-encoded — not raw bytes — so Resend's JSON
    # serializer accepts it.
    import base64
    assert base64.b64decode(att["content"]) == b"%PDF-1.4 ..."
    assert att["content_type"] == "application/pdf"


def test_send_failure_wraps_exception(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re_test")
    monkeypatch.setenv("QUOTES_FROM_EMAIL", "noreply@mail.jigged.app")

    class _FakeEmails:
        @staticmethod
        def send(params):
            raise RuntimeError("Resend 500")

    fake_resend = type("FakeResend", (), {"api_key": None, "Emails": _FakeEmails})

    with patch.dict(sys.modules, {"resend": fake_resend}):
        with pytest.raises(RuntimeError) as exc_info:
            send_email(to=["a@b"], subject="x", body_text="x")
    assert "Resend send failed" in str(exc_info.value)
