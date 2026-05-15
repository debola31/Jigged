"""
Route for emailing a quote PDF to a customer.

Frontend renders the PDF client-side via jsPDF and posts the bytes up
along with the user-edited To/Subject/Body. We don't regenerate the PDF
on the server — the rendering logic lives in TypeScript (utils/quotePdf.ts)
and we don't want to duplicate it in Python.

Auth: caller must have a row in user_company_access for the company that
owns the quote. The check happens with the service role client after we
extract the user from the caller's JWT.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from supabase import Client, create_client

from services.email import EmailAttachment, EmailServiceUnavailable, send_email

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/quotes", tags=["quote-email"])


def _service_client() -> Client:
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Database not configured")
    return create_client(url, key)


async def _verify_quote_access(
    request: Request, quote_id: str
) -> tuple[str, str | None, dict, dict]:
    """
    Extract the caller's user id from the Authorization header and verify
    they have access to the quote's company. Returns
    (user_id, user_email, quote_row, company_row).
    """
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    client = _service_client()
    try:
        user_response = client.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Invalid token")
        user_id = user_response.user.id
        user_email = user_response.user.email
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Token verification failed: {e}")
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    quote_resp = (
        client.table("quotes")
        .select("id, company_id, quote_number")
        .eq("id", quote_id)
        .single()
        .execute()
    )
    if not quote_resp.data:
        raise HTTPException(status_code=404, detail="Quote not found")
    quote = quote_resp.data

    access = (
        client.table("user_company_access")
        .select("role")
        .eq("user_id", user_id)
        .eq("company_id", quote["company_id"])
        .execute()
    )
    if not access.data:
        raise HTTPException(status_code=403, detail="No access to this quote's company")

    company_resp = (
        client.table("companies")
        .select("id, name")
        .eq("id", quote["company_id"])
        .single()
        .execute()
    )
    if not company_resp.data:
        raise HTTPException(status_code=404, detail="Company not found")

    return user_id, user_email, quote, company_resp.data


class EmailQuoteResponse(BaseModel):
    message_id: str


@router.post("/{quote_id}/email", response_model=EmailQuoteResponse)
async def email_quote(
    quote_id: str,
    request: Request,
    to: str = Form(...),
    subject: str = Form(...),
    body: str = Form(...),
    cc: Optional[str] = Form(None),
    pdf: UploadFile = File(...),
):
    """
    Send a quote PDF to the given email address.

    The frontend produces the PDF, the user edits the body, then we send
    it through Resend. Reply-To is set to the sending user's email so
    customer replies land in their personal inbox, and the sender is
    BCC'd so they have a copy of every quote they sent.
    """
    _, user_email, quote, _ = await _verify_quote_access(request, quote_id)

    pdf_bytes = await pdf.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Empty PDF upload")

    filename = f"Quote-{quote.get('quote_number') or quote_id}.pdf"

    try:
        message_id = send_email(
            to=[to.strip()],
            cc=[cc.strip()] if cc and cc.strip() else None,
            bcc=[user_email] if user_email else None,
            subject=subject,
            body_text=body,
            reply_to=user_email,
            attachments=[EmailAttachment(filename=filename, content=pdf_bytes)],
        )
    except EmailServiceUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.exception("email_quote failed for quote %s", quote_id)
        raise HTTPException(status_code=500, detail=f"Failed to send email: {e}")

    return EmailQuoteResponse(message_id=message_id)
