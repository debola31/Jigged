"""
System Admin routes for company onboarding.

These endpoints require the caller to be a system admin (verified via the
system_admins table). They use the service role key because:
- Creating auth users requires auth.admin.create_user()
- Listing all companies bypasses normal RLS (users only see their own)
- Fetching emails from auth.users requires service-role access
"""

import logging
import os
import re
from uuid import uuid4

import sentry_sdk
from fastapi import APIRouter, HTTPException, Request
from supabase import create_client, Client

from models.admin_models import (
    CompanyCreateRequest,
    CompanyCreateResponse,
    CompanyDeleteResponse,
    CompanyFeaturesUpdateRequest,
    CompanyFeaturesUpdateResponse,
    CompanyListItem,
    CompanyUpdateRequest,
    CompanyUpdateResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["system-admin"])


def get_supabase_service_role() -> Client:
    """
    Get a Supabase client with service role key for admin operations.
    Reuses the same pattern as operators_routes.py.
    """
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not url or not key:
        raise HTTPException(
            status_code=503,
            detail="Supabase secret key configuration not available."
        )

    return create_client(url, key)


async def verify_system_admin(request: Request) -> str:
    """
    Extract JWT from Authorization header and verify the caller is a system admin.
    Returns the verified user_id.
    """
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    service_client = get_supabase_service_role()

    try:
        user_response = service_client.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Invalid token")
        user_id = user_response.user.id
    except Exception as e:
        logger.warning(f"Token verification failed: {e}")
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # Check system_admins table
    result = service_client.table("system_admins").select("id").eq("user_id", user_id).execute()
    if not result.data:
        raise HTTPException(status_code=403, detail="Not a system admin")

    return user_id


def generate_slug(company_name: str) -> str:
    """Generate a URL-friendly slug from a company name."""
    slug = company_name.lower().strip()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)
    slug = re.sub(r'[\s]+', '-', slug)
    slug = slug.strip('-')
    return slug or 'company'


# ============================================================================
# AI MODEL HEALTH
# ============================================================================

@router.get("/ai/model-health")
async def ai_model_health(request: Request):
    """Report whether the pinned Anthropic model is still active.

    Uses the free Models API metadata endpoint (no billed inference) so an admin
    can verify the live model on demand and get advance warning before a model
    retirement breaks chat/chart (as claude-sonnet-4-20250514 did). Requires
    system admin access.
    """
    await verify_system_admin(request)

    from services.ai.model_config import check_model_health
    return check_model_health()


# ============================================================================
# LIST COMPANIES
# ============================================================================

@router.get("/companies", response_model=list[CompanyListItem])
async def list_companies(request: Request):
    """
    List all non-demo companies with owner info and member count.
    Requires system admin access.
    """
    await verify_system_admin(request)
    service_client = get_supabase_service_role()

    try:
        # Single joined query: companies + user_company_access
        result = service_client.table("companies") \
            .select("id, name, slug, created_at, settings, user_company_access(user_id, name, email, role)") \
            .eq("is_demo", False) \
            .order("created_at", desc=True) \
            .execute()

        if not result.data:
            return []

        # Batch-fetch emails from auth.users
        # NOTE: list_users() fetches ALL auth users. Fine at <50 users, but
        # switch to targeted get_user_by_id() lookups if user count grows.
        all_users = service_client.auth.admin.list_users()
        email_map = {}
        for user in all_users:
            if hasattr(user, 'id') and hasattr(user, 'email'):
                email_map[user.id] = user.email

        # Build response
        companies = []
        for company in result.data:
            access_records = company.get("user_company_access", [])
            member_count = len(access_records)

            # Find primary admin (first admin is the company creator)
            owner_name = None
            owner_email = None
            for record in access_records:
                if record.get("role") == "admin":
                    owner_name = record.get("name")
                    # Prefer auth email over stored email
                    owner_user_id = record.get("user_id")
                    owner_email = email_map.get(owner_user_id) or record.get("email")
                    break

            settings = company.get("settings") or {}
            settings = settings if isinstance(settings, dict) else {}
            features = _normalize_features(settings.get("features"))
            # Opt-out flags (GA feature + kill-switch): report them ON for companies that never
            # set them, so the admin toggle mirrors the effective state rather than showing an
            # off switch for a feature the tenant can see. Must stay in step with
            # `defaultEnabled` in lib/featureFlags.ts — these are the two places that each carry
            # the default, and only the TS side has a test pinning them together.
            features.setdefault("ai_insights", True)
            features.setdefault("inventory_locations", True)

            ai_limits = settings.get("ai_limits") or {}
            raw_limit = ai_limits.get("chat_per_hour")
            ai_chat_limit_per_hour = (
                int(raw_limit)
                if isinstance(raw_limit, (int, float)) and int(raw_limit) > 0
                else 20
            )

            companies.append(CompanyListItem(
                id=company["id"],
                name=company["name"],
                slug=company.get("slug"),
                created_at=company["created_at"],
                owner_name=owner_name,
                owner_email=owner_email,
                member_count=member_count,
                features=features,
                ai_chat_limit_per_hour=ai_chat_limit_per_hour,
            ))

        return companies

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing companies: {e}")
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")


# ============================================================================
# CREATE COMPANY
# ============================================================================

@router.post("/companies", response_model=CompanyCreateResponse)
async def create_company(request: Request, body: CompanyCreateRequest):
    """
    Create a new company with its first owner account.

    Steps:
    1. Generate slug from company name
    2. Insert companies row
    3. Create auth user (email/password, skip email verification)
    4. Insert user_company_access (owner role)
    5. Optionally add system admin as company admin

    Rolls back on failure at any step.
    """
    admin_user_id = await verify_system_admin(request)
    service_client = get_supabase_service_role()

    company_id = None
    owner_user_id = None
    user_already_existed = False

    try:
        # 1. Check if email already exists (reuse existing user for multi-tenancy)
        existing_user = None
        existing_users = service_client.auth.admin.list_users()
        for user in existing_users:
            if hasattr(user, 'email') and user.email == body.owner_email:
                existing_user = user
                break

        # 2. Generate slug with collision handling
        base_slug = generate_slug(body.company_name)
        slug = base_slug
        suffix = 2
        while True:
            existing = service_client.table("companies") \
                .select("id") \
                .eq("slug", slug) \
                .execute()
            if not existing.data:
                break
            slug = f"{base_slug}-{suffix}"
            suffix += 1

        # 3. Insert company
        company_result = service_client.table("companies").insert({
            "id": str(uuid4()),
            "name": body.company_name.strip(),
            "slug": slug,
        }).execute()

        if not company_result.data:
            raise HTTPException(status_code=500, detail="Failed to create company")

        company_id = company_result.data[0]["id"]

        # 4. Reuse existing auth user or create new one via invite
        if existing_user:
            owner_user_id = existing_user.id
            user_already_existed = True
        else:
            auth_response = service_client.auth.admin.invite_user_by_email(
                body.owner_email,
                options={
                    "data": {"name": body.owner_name}
                }
            )

            if not auth_response.user:
                raise HTTPException(status_code=500, detail="Failed to create auth user")

            owner_user_id = auth_response.user.id

        # 5. Create user_company_access for company admin (first user)
        service_client.table("user_company_access").insert({
            "user_id": owner_user_id,
            "company_id": company_id,
            "role": "admin",
            "name": body.owner_name,
            "email": body.owner_email,
        }).execute()

        # 6. Add system admin as company admin for support access
        existing_access = service_client.table("user_company_access") \
            .select("id") \
            .eq("user_id", admin_user_id) \
            .eq("company_id", company_id) \
            .execute()

        if not existing_access.data:
            service_client.table("user_company_access").insert({
                "user_id": admin_user_id,
                "company_id": company_id,
                "role": "admin",
            }).execute()

        logger.info(f"Created company {company_id} ({body.company_name}) with owner {owner_user_id}")

        return CompanyCreateResponse(
            success=True,
            company_id=company_id,
            company_name=body.company_name.strip(),
            slug=slug,
            owner_user_id=owner_user_id,
            message="Company created successfully",
        )

    except HTTPException:
        # Rollback on known errors — don't delete pre-existing auth users
        _rollback(service_client, company_id, owner_user_id if not user_already_existed else None)
        raise
    except Exception as e:
        logger.error(f"Error creating company: {e}")
        sentry_sdk.capture_exception(e)
        _rollback(service_client, company_id, owner_user_id if not user_already_existed else None)
        raise HTTPException(status_code=500, detail="Internal server error")


# ============================================================================
# UPDATE COMPANY
# ============================================================================

@router.put("/companies/{company_id}", response_model=CompanyUpdateResponse)
async def update_company(request: Request, company_id: str, body: CompanyUpdateRequest):
    """
    Update a company's name (and auto-regenerate slug).
    Requires system admin access.
    """
    await verify_system_admin(request)
    service_client = get_supabase_service_role()

    try:
        # Verify company exists
        existing = service_client.table("companies").select("id, name").eq("id", company_id).execute()
        if not existing.data:
            raise HTTPException(status_code=404, detail="Company not found")

        # Generate new slug with collision handling (exclude self)
        base_slug = generate_slug(body.name)
        slug = base_slug
        suffix = 2
        while True:
            collision = service_client.table("companies") \
                .select("id") \
                .eq("slug", slug) \
                .neq("id", company_id) \
                .execute()
            if not collision.data:
                break
            slug = f"{base_slug}-{suffix}"
            suffix += 1

        # Update company
        result = service_client.table("companies").update({
            "name": body.name,
            "slug": slug,
        }).eq("id", company_id).execute()

        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to update company")

        logger.info(f"Updated company {company_id}: name='{body.name}', slug='{slug}'")

        return CompanyUpdateResponse(
            success=True,
            company_id=company_id,
            name=body.name,
            slug=slug,
            message="Company updated successfully",
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating company {company_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")


# ============================================================================
# DELETE COMPANY
# ============================================================================

@router.delete("/companies/{company_id}", response_model=CompanyDeleteResponse)
async def delete_company(request: Request, company_id: str):
    """
    Delete a company and all associated data (cascades via FK constraints).
    Does NOT delete auth users — they may belong to other companies.
    Requires system admin access.
    """
    await verify_system_admin(request)
    service_client = get_supabase_service_role()

    try:
        # Verify company exists
        existing = service_client.table("companies").select("id, name").eq("id", company_id).execute()
        if not existing.data:
            raise HTTPException(status_code=404, detail="Company not found")

        company_name = existing.data[0]["name"]

        # Delete company — all child data cascades automatically
        service_client.table("companies").delete().eq("id", company_id).execute()

        logger.info(f"Deleted company {company_id} ({company_name})")

        return CompanyDeleteResponse(
            success=True,
            message=f"Company '{company_name}' deleted successfully",
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting company {company_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")


def _normalize_features(raw) -> dict[str, bool]:
    """Coerce settings.features to a flat {key: bool} dict.

    Tolerates legacy strings like "true"/"false" the way isShipmentsEnabled
    in lib/featureFlags.ts does, so the admin UI doesn't double-write
    those legacy entries silently as `false`.
    """
    if not isinstance(raw, dict):
        return {}
    out: dict[str, bool] = {}
    for key, value in raw.items():
        if value is True or value == "true":
            out[key] = True
        elif value is False or value == "false":
            out[key] = False
        else:
            # Drop non-bool entries from the response (they won't survive
            # a save anyway — the request model only accepts dict[str, bool]).
            continue
    return out


# ============================================================================
# UPDATE COMPANY FEATURE FLAGS
# ============================================================================

@router.patch(
    "/companies/{company_id}/features",
    response_model=CompanyFeaturesUpdateResponse,
)
async def update_company_features(
    request: Request,
    company_id: str,
    body: CompanyFeaturesUpdateRequest,
):
    """
    Replace the feature flags on a company's settings.features block.
    Other settings sub-keys are preserved.
    Requires system admin access.
    """
    await verify_system_admin(request)
    service_client = get_supabase_service_role()

    try:
        existing = (
            service_client.table("companies")
            .select("id, name, settings")
            .eq("id", company_id)
            .execute()
        )
        if not existing.data:
            raise HTTPException(status_code=404, detail="Company not found")

        current_settings = existing.data[0].get("settings") or {}
        if not isinstance(current_settings, dict):
            current_settings = {}

        # Replace-style: the supplied features dict is the new state.
        # Anything not in the request is treated as "not enabled."
        # Merging into the rest of settings preserves unrelated sub-keys
        # (packing-slip format, etc. — stored as top-level columns today,
        # but future settings sub-keys may live here).
        new_settings = dict(current_settings)
        new_settings["features"] = {k: bool(v) for k, v in body.features.items()}

        # Persist the per-company AI chat rate limit alongside the flags, under
        # settings.ai_limits.chat_per_hour. Omitted → leave the existing value.
        if body.ai_chat_limit_per_hour is not None:
            new_settings["ai_limits"] = {
                **(current_settings.get("ai_limits") or {}),
                "chat_per_hour": int(body.ai_chat_limit_per_hour),
            }

        result = (
            service_client.table("companies")
            .update({"settings": new_settings})
            .eq("id", company_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to update features")

        logger.info(
            f"Updated company {company_id} features: {new_settings['features']}"
        )

        # No backfill on flag-flip any more.
        #
        # This used to call `enable_location_tracking_for_company` when `inventory_locations` went
        # from off to on, because tracking was a per-part opt-in that existing parts hadn't taken.
        # 20260802015837 removed the opt-in: every part in every company has a balance row at that
        # company's `Unassigned` bucket, flag or no flag, and the trigger keeps new ones that way.
        # There is nothing left for a flip to catch up — which is the point of doing it at rest
        # rather than at the moment somebody happens to toggle a switch.

        return CompanyFeaturesUpdateResponse(
            success=True,
            company_id=company_id,
            features=_normalize_features(new_settings["features"]),
            message="Features updated successfully",
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating features for {company_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")


def _rollback(service_client: Client, company_id: str | None, user_id: str | None):
    """Best-effort cleanup of partially created resources."""
    if user_id:
        try:
            service_client.auth.admin.delete_user(user_id)
            logger.info(f"Rolled back auth user {user_id}")
        except Exception as e:
            logger.error(f"Failed to rollback auth user {user_id}: {e}")

    if company_id:
        try:
            service_client.table("companies").delete().eq("id", company_id).execute()
            logger.info(f"Rolled back company {company_id}")
        except Exception as e:
            logger.error(f"Failed to rollback company {company_id}: {e}")
