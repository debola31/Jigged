"""
Pydantic models for Operator View module.

Handles operator creation and password management.
Authentication is handled via Supabase Auth (email/password).
"""

from typing import Optional
from datetime import datetime
from pydantic import BaseModel, field_validator
import re


# ============================================================================
# OPERATOR CRUD (Admin)
# ============================================================================

class OperatorCreateRequest(BaseModel):
    """Request body for creating a new operator (admin)."""
    company_id: str
    name: str
    email: str
    password: str  # Temporary password, operator must change on first login

    @field_validator('email')
    @classmethod
    def validate_email(cls, v):
        # Basic email validation
        if not re.match(r'^[^@]+@[^@]+\.[^@]+$', v):
            raise ValueError('Invalid email address')
        return v.lower()

    @field_validator('password')
    @classmethod
    def validate_password(cls, v):
        if len(v) < 8:
            raise ValueError('Password must be at least 8 characters')
        return v


class OperatorCreateResponse(BaseModel):
    """Response after creating an operator."""
    success: bool
    operator_id: str
    user_id: str
    message: str


class OperatorResponse(BaseModel):
    """Response model for operator data (admin view)."""
    id: str
    company_id: str
    user_id: str
    name: str
    email: Optional[str] = None  # Fetched from auth.users
    last_login_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime


class PasswordResetRequest(BaseModel):
    """Request body for resetting an operator's password (admin action)."""
    new_password: str

    @field_validator('new_password')
    @classmethod
    def validate_password(cls, v):
        if len(v) < 8:
            raise ValueError('Password must be at least 8 characters')
        return v


class PasswordResetResponse(BaseModel):
    """Response after resetting an operator's password."""
    success: bool
    message: str
