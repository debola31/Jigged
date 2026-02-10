"""
Pydantic models for Operator View module.

Handles operator creation and session tracking.
Authentication is handled via Supabase Auth (email/password).
"""

from typing import Optional
from datetime import datetime
from pydantic import BaseModel, field_validator, EmailStr
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


# ============================================================================
# JOB OPERATIONS
# ============================================================================

class JobStartRequest(BaseModel):
    """Request body for starting work on a job."""
    operation_type_id: str  # From station QR code


class JobStopRequest(BaseModel):
    """Request body for stopping work on a job."""
    notes: Optional[str] = None


class JobCompleteRequest(BaseModel):
    """Request body for completing a job operation."""
    notes: Optional[str] = None
    quantity_completed: Optional[int] = None
    quantity_scrapped: Optional[int] = None


# ============================================================================
# SESSIONS
# ============================================================================

class SessionResponse(BaseModel):
    """Response model for operator session data."""
    id: str
    operator_id: str
    job_id: str
    job_operation_id: Optional[str]
    operation_type_id: str
    started_at: datetime
    ended_at: Optional[datetime]
    notes: Optional[str]
    duration_seconds: Optional[int] = None  # Computed on response


class ActiveSessionResponse(BaseModel):
    """Response for active session with additional job details."""
    id: str
    operator_id: str
    job_id: str
    job_number: str
    job_operation_id: Optional[str]
    operation_name: Optional[str]
    operation_type_id: str
    started_at: datetime
    notes: Optional[str]


# ============================================================================
# JOB VIEWS
# ============================================================================

class OperatorJobResponse(BaseModel):
    """Job data as seen by operators."""
    id: str
    job_number: str
    customer_name: Optional[str]
    part_name: Optional[str]
    part_number: Optional[str]
    due_date: Optional[datetime]
    status: str
    quantity_ordered: Optional[int]
    quantity_completed: Optional[int]
    # Current operation for this station
    operation_id: Optional[str]
    operation_name: Optional[str]
    operation_status: Optional[str]
    # Who is currently working on this operation
    current_operator_name: Optional[str]


class OperatorJobDetailResponse(BaseModel):
    """Detailed job data for active job view."""
    id: str
    job_number: str
    customer_name: Optional[str]
    part_name: Optional[str]
    part_number: Optional[str]
    due_date: Optional[datetime]
    status: str
    quantity_ordered: Optional[int]
    quantity_completed: Optional[int]
    # Operation details
    operation_id: Optional[str]
    operation_name: Optional[str]
    operation_status: Optional[str]
    instructions: Optional[str]
    estimated_hours: Optional[float]
    # Active session info
    active_session_id: Optional[str]
    session_started_at: Optional[datetime]
    current_operator_id: Optional[str]
    current_operator_name: Optional[str]
