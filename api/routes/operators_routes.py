"""
Operator routes for the Operator View module.

With Supabase Auth integration, most operations are done directly via Supabase
client from the frontend. This backend API only handles operations that require
the service role key:

- POST /api/operators - Create operator (creates Supabase user + operator record)

All other operations (login, logout, job queries, sessions) use direct Supabase
client calls with RLS policies from the frontend.
"""

import logging
import os
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Depends
from supabase import create_client, Client

from models.operators_models import (
    OperatorCreateRequest,
    OperatorCreateResponse,
    OperatorResponse,
    PasswordResetRequest,
    PasswordResetResponse,
)

logger = logging.getLogger(__name__)

# Create router for admin operations
admin_router = APIRouter(prefix="/api/operators", tags=["operators-admin"])


def get_supabase() -> Client:
    """Get the Supabase client from the main app."""
    from index import supabase
    if supabase is None:
        raise HTTPException(status_code=503, detail="Database not available")
    return supabase


def get_supabase_service_role() -> Client:
    """
    Get a Supabase client with service role key for admin operations.
    Required for creating auth users.

    Checks for SUPABASE_SECRET_KEY first (recommended), then falls back to
    SUPABASE_SERVICE_ROLE_KEY (legacy naming).
    """
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not url or not key:
        raise HTTPException(
            status_code=503,
            detail="Supabase secret key configuration not available. Set SUPABASE_SECRET_KEY."
        )

    return create_client(url, key)


# ============================================================================
# OPERATOR CREATION (Admin only - requires service role)
# ============================================================================

@admin_router.post("", response_model=OperatorCreateResponse)
async def create_operator(request: OperatorCreateRequest):
    """
    Create a new operator with Supabase Auth.

    This endpoint:
    1. Creates a Supabase auth user with email/password
    2. Sets needs_password_change: true in user metadata
    3. Creates an operator record linked to the auth user
    4. Creates user_company_access record with 'operator' role

    Requires service role key because auth.admin.createUser() needs elevated permissions.
    """
    supabase = get_supabase()
    service_client = get_supabase_service_role()

    try:
        # 1. Check if email already exists as a user
        existing_check = service_client.auth.admin.list_users()
        for user in existing_check:
            if hasattr(user, 'email') and user.email == request.email:
                # User exists - check if they already have an operator record for this company
                existing_op = supabase.table("operators").select("id").eq(
                    "user_id", user.id
                ).eq("company_id", request.company_id).execute()

                if existing_op.data:
                    raise HTTPException(
                        status_code=400,
                        detail="An operator with this email already exists for this company"
                    )

                # User exists but no operator record - create operator for existing user
                operator_id = str(uuid4())
                supabase.table("operators").insert({
                    "id": operator_id,
                    "company_id": request.company_id,
                    "user_id": user.id,
                    "name": request.name
                }).execute()

                # Check if user_company_access exists
                access_check = supabase.table("user_company_access").select("id").eq(
                    "user_id", user.id
                ).eq("company_id", request.company_id).execute()

                if not access_check.data:
                    supabase.table("user_company_access").insert({
                        "user_id": user.id,
                        "company_id": request.company_id,
                        "role": "operator"
                    }).execute()

                return OperatorCreateResponse(
                    success=True,
                    operator_id=operator_id,
                    user_id=user.id,
                    message="Operator created for existing user"
                )

        # 2. Create new Supabase auth user
        auth_response = service_client.auth.admin.create_user({
            "email": request.email,
            "password": request.password,
            "email_confirm": True,  # Skip email verification
            "user_metadata": {
                "needs_password_change": True,
                "name": request.name
            }
        })

        if not auth_response.user:
            raise HTTPException(status_code=500, detail="Failed to create auth user")

        user_id = auth_response.user.id

        # 3. Create operator record
        operator_id = str(uuid4())
        supabase.table("operators").insert({
            "id": operator_id,
            "company_id": request.company_id,
            "user_id": user_id,
            "name": request.name
        }).execute()

        # 4. Create user_company_access record
        supabase.table("user_company_access").insert({
            "user_id": user_id,
            "company_id": request.company_id,
            "role": "operator"
        }).execute()

        logger.info(f"Created operator {operator_id} for user {user_id}")

        return OperatorCreateResponse(
            success=True,
            operator_id=operator_id,
            user_id=user_id,
            message="Operator created successfully"
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating operator: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create operator: {str(e)}")


# ============================================================================
# OPERATOR LIST & GET (Admin only - requires service role for email lookup)
# ============================================================================

@admin_router.get("", response_model=list[OperatorResponse])
async def list_operators(company_id: str):
    """
    List all operators for a company with their emails.

    Requires service role key to fetch emails from auth.users.
    """
    supabase = get_supabase()
    service_client = get_supabase_service_role()

    try:
        # 1. Get operators for this company
        result = supabase.table("operators").select(
            "id, company_id, user_id, name, last_login_at, created_at, updated_at"
        ).eq("company_id", company_id).order("name").execute()

        if not result.data:
            return []

        # 2. Build a map of user_id -> email from auth.users
        user_ids = [op["user_id"] for op in result.data if op.get("user_id")]
        email_map = {}

        if user_ids:
            # Fetch all users and filter to the ones we need
            all_users = service_client.auth.admin.list_users()
            for user in all_users:
                if hasattr(user, 'id') and user.id in user_ids:
                    email_map[user.id] = user.email

        # 3. Combine operator data with emails
        operators = []
        for op in result.data:
            operators.append(OperatorResponse(
                id=op["id"],
                company_id=op["company_id"],
                user_id=op["user_id"],
                name=op["name"],
                email=email_map.get(op["user_id"]),
                last_login_at=op.get("last_login_at"),
                created_at=op["created_at"],
                updated_at=op["updated_at"],
            ))

        return operators

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing operators: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list operators: {str(e)}")


@admin_router.get("/{operator_id}", response_model=OperatorResponse)
async def get_operator(operator_id: str):
    """
    Get a single operator by ID with their email.

    Requires service role key to fetch email from auth.users.
    """
    supabase = get_supabase()
    service_client = get_supabase_service_role()

    try:
        # 1. Get operator
        result = supabase.table("operators").select(
            "id, company_id, user_id, name, last_login_at, created_at, updated_at"
        ).eq("id", operator_id).single().execute()

        if not result.data:
            raise HTTPException(status_code=404, detail="Operator not found")

        op = result.data

        # 2. Get email from auth.users
        email = None
        if op.get("user_id"):
            try:
                user = service_client.auth.admin.get_user_by_id(op["user_id"])
                if user and user.user:
                    email = user.user.email
            except Exception as e:
                logger.warning(f"Could not fetch email for user {op['user_id']}: {e}")

        return OperatorResponse(
            id=op["id"],
            company_id=op["company_id"],
            user_id=op["user_id"],
            name=op["name"],
            email=email,
            last_login_at=op.get("last_login_at"),
            created_at=op["created_at"],
            updated_at=op["updated_at"],
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting operator: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get operator: {str(e)}")


# ============================================================================
# OPERATOR PASSWORD RESET (Admin only - requires service role)
# ============================================================================

@admin_router.post("/{operator_id}/reset-password", response_model=PasswordResetResponse)
async def reset_operator_password(operator_id: str, request: PasswordResetRequest):
    """
    Reset an operator's password (admin action).

    Sets a new temporary password and marks needs_password_change = true,
    requiring the operator to change their password on next login.

    This is used when an operator has forgotten their password and cannot
    use the email-based reset flow.
    """
    supabase = get_supabase()
    service_client = get_supabase_service_role()

    try:
        # 1. Get operator to find user_id
        result = supabase.table("operators").select("user_id, name").eq("id", operator_id).single().execute()

        if not result.data:
            raise HTTPException(status_code=404, detail="Operator not found")

        user_id = result.data.get("user_id")
        operator_name = result.data.get("name", "Operator")

        if not user_id:
            raise HTTPException(status_code=400, detail="Operator has no linked user account")

        # 2. Update password and set needs_password_change flag
        service_client.auth.admin.update_user_by_id(
            user_id,
            {
                "password": request.new_password,
                "user_metadata": {
                    "needs_password_change": True
                }
            }
        )

        logger.info(f"Password reset for operator {operator_id} (user {user_id})")

        return PasswordResetResponse(
            success=True,
            message=f"Password reset for {operator_name}. They will be required to change it on next login."
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error resetting operator password: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to reset password: {str(e)}")
