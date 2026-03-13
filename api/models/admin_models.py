"""
Pydantic models for System Admin operations.

Handles company onboarding: creating companies and their first owner accounts.
"""

from typing import Optional
from pydantic import BaseModel, field_validator
import re


class CompanyCreateRequest(BaseModel):
    """Request body for creating a new company with its first owner."""
    company_name: str
    owner_name: str
    owner_email: str
    owner_password: str
    add_admin_access: bool = True  # Add system admin as company admin

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

    @field_validator('owner_password')
    @classmethod
    def validate_password(cls, v):
        if len(v) < 8:
            raise ValueError('Password must be at least 8 characters')
        return v


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
