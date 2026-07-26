"""Request/response models for the Stripe billing endpoints."""
from __future__ import annotations

from pydantic import BaseModel, field_validator


def _require_uuid_like(v: str, field: str) -> str:
    v = (v or "").strip()
    if not v:
        raise ValueError(f"{field} is required")
    return v


class CheckoutRequest(BaseModel):
    """Start a subscription Checkout. Body carries ONLY company_id — the price and
    trial are chosen server-side (frontend never names a price)."""

    company_id: str

    @field_validator("company_id")
    @classmethod
    def _validate_company_id(cls, v: str) -> str:
        return _require_uuid_like(v, "company_id")


class PortalRequest(BaseModel):
    """Open the Stripe Customer Portal for a company."""

    company_id: str

    @field_validator("company_id")
    @classmethod
    def _validate_company_id(cls, v: str) -> str:
        return _require_uuid_like(v, "company_id")


class CheckoutSyncRequest(BaseModel):
    """Reconcile the billing cache from a completed Checkout Session (success-page
    fallback for the webhook race)."""

    company_id: str
    session_id: str

    @field_validator("company_id")
    @classmethod
    def _validate_company_id(cls, v: str) -> str:
        return _require_uuid_like(v, "company_id")

    @field_validator("session_id")
    @classmethod
    def _validate_session_id(cls, v: str) -> str:
        return _require_uuid_like(v, "session_id")


class UrlResponse(BaseModel):
    """A hosted Stripe URL (Checkout or Portal) for the client to redirect to."""

    url: str


class SyncResponse(BaseModel):
    """Result of a checkout/sync reconcile."""

    status: str | None = None
