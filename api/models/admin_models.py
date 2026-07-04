"""
Pydantic models for System Admin operations.

Handles company onboarding: creating companies and their first owner accounts.
"""

from typing import Optional
from pydantic import BaseModel, field_validator
import re


class CompanyCreateRequest(BaseModel):
    """Request body for creating a new company with its first admin."""
    company_name: str
    owner_name: str
    owner_email: str

    @field_validator('company_name')
    @classmethod
    def validate_company_name(cls, v):
        v = v.strip()
        if not v:
            raise ValueError('Company name is required')
        if len(v) > 100:
            raise ValueError('Company name must be 100 characters or less')
        return v

    @field_validator('owner_email')
    @classmethod
    def validate_email(cls, v):
        if not re.match(r'^[^@]+@[^@]+\.[^@]+$', v):
            raise ValueError('Invalid email address')
        return v.lower()


class CompanyCreateResponse(BaseModel):
    """Response after creating a company."""
    success: bool
    company_id: str
    company_name: str
    slug: str
    owner_user_id: str
    message: str


class CompanyUpdateRequest(BaseModel):
    """Request body for updating a company."""
    name: str

    @field_validator('name')
    @classmethod
    def validate_name(cls, v):
        v = v.strip()
        if not v:
            raise ValueError('Company name is required')
        if len(v) > 100:
            raise ValueError('Company name must be 100 characters or less')
        return v


class CompanyUpdateResponse(BaseModel):
    """Response after updating a company."""
    success: bool
    company_id: str
    name: str
    slug: str
    message: str


class CompanyDeleteResponse(BaseModel):
    """Response after deleting a company."""
    success: bool
    message: str


class CompanyListItem(BaseModel):
    """Response model for a company in the list."""
    id: str
    name: str
    slug: Optional[str] = None
    created_at: str
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    member_count: int
    # Feature flags currently enabled on the company. Sourced from
    # companies.settings.features (jsonb). Keys mirror the entries in
    # lib/featureFlags.ts KNOWN_FEATURES so the admin UI can render
    # toggles without hardcoding the list per call site.
    features: dict[str, bool] = {}
    # Per-company AI chat rate limit (queries/hour), from
    # companies.settings.ai_limits.chat_per_hour. Defaults to 20 when unset.
    ai_chat_limit_per_hour: int = 20


class CompanyFeaturesUpdateRequest(BaseModel):
    """Request body for replacing a company's feature flags.

    Idiomatic call sets the desired enabled flags as `{ "<key>": true }`.
    Anything omitted is treated as false (replace-style, not patch-style)
    so the request is self-describing — the caller sends what they want
    on, the server stores exactly that under settings.features.

    Optionally carries the per-company AI chat rate limit (queries/hour),
    persisted to settings.ai_limits.chat_per_hour. Omitted → left unchanged.
    """
    features: dict[str, bool]
    ai_chat_limit_per_hour: Optional[int] = None

    @field_validator("ai_chat_limit_per_hour")
    @classmethod
    def validate_chat_limit(cls, v):
        if v is None:
            return v
        if v < 1 or v > 1000:
            raise ValueError("ai_chat_limit_per_hour must be between 1 and 1000")
        return v


class CompanyFeaturesUpdateResponse(BaseModel):
    success: bool
    company_id: str
    features: dict[str, bool]
    message: str
