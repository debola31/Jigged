"""
Email service. Thin wrapper around the Resend Python SDK.

Why this lives in the FastAPI backend:
  - Resend's API key is a paid third-party secret. Per CLAUDE.md the
    FastAPI layer is the only place we put credentials that shouldn't
    reach the browser.
  - The invitation-system module spec (docs/modules/invitation-system.md
    §7) targets this same email primitive — keep send_email() generic so
    invitation emails can ride the same plumbing later.

Why this is paid-API-safe to call from a route handler:
  - Resend bills per email, and we only invoke it on an explicit user
    "Send" action. The route is *not* called from a useEffect or page
    mount. (See CLAUDE.md "AI calls require an explicit user action" —
    the same rule applies to any paid third-party call.)
"""
from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass
from typing import Sequence

logger = logging.getLogger(__name__)


@dataclass
class EmailAttachment:
    """A file to attach to an outbound email."""
    filename: str
    content: bytes
    content_type: str = "application/pdf"


class EmailServiceUnavailable(RuntimeError):
    """Raised when RESEND_API_KEY / QUOTES_FROM_EMAIL aren't configured."""


def send_email(
    *,
    to: list[str],
    subject: str,
    body_text: str,
    cc: list[str] | None = None,
    reply_to: str | None = None,
    attachments: Sequence[EmailAttachment] = (),
) -> str:
    """
    Send an email via Resend. Returns the Resend message id.

    Raises:
        EmailServiceUnavailable: when required env vars are missing —
            surfaces as a 503 to the caller so the UI can show a clear
            "email isn't configured yet" message instead of a generic 500.
    """
    api_key = os.getenv("RESEND_API_KEY")
    from_addr = os.getenv("QUOTES_FROM_EMAIL")
    if not api_key or not from_addr:
        raise EmailServiceUnavailable(
            "Email sending is not configured (set RESEND_API_KEY and "
            "QUOTES_FROM_EMAIL)."
        )

    # Import lazily so the rest of the FastAPI app boots even when the
    # `resend` Python SDK isn't installed (e.g., dev environments that
    # haven't pulled the latest requirements.txt).
    try:
        import resend  # type: ignore
    except ImportError as exc:
        raise EmailServiceUnavailable(
            "Email sending requires the `resend` Python package "
            "(add to api/requirements.txt and pip install)."
        ) from exc

    resend.api_key = api_key

    params: dict = {
        "from": from_addr,
        "to": to,
        "subject": subject,
        "text": body_text,
    }
    if cc:
        params["cc"] = cc
    if reply_to:
        # Resend SDK accepts a string or list for reply_to.
        params["reply_to"] = reply_to
    if attachments:
        # Resend expects each attachment as a dict with base64-encoded
        # content (a list[int] also works but base64 is more compact).
        params["attachments"] = [
            {
                "filename": a.filename,
                "content": base64.b64encode(a.content).decode("ascii"),
                "content_type": a.content_type,
            }
            for a in attachments
        ]

    try:
        result = resend.Emails.send(params)
    except Exception as exc:
        logger.exception("Resend send failed")
        raise RuntimeError(f"Resend send failed: {exc}") from exc

    # Resend returns either {"id": "..."} (dict) or an object — handle both.
    if isinstance(result, dict):
        message_id = result.get("id", "")
    else:
        message_id = getattr(result, "id", "")
    return str(message_id)
