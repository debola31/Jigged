import logging

import sentry_sdk
from fastapi import APIRouter, HTTPException

from models.waitlist_models import WaitlistRequest, WaitlistResponse
from utils.rate_limiter import RateLimiter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/waitlist", tags=["waitlist"])
rate_limiter = RateLimiter(max_requests=5, window_seconds=60)


@router.post("", response_model=WaitlistResponse)
async def join_waitlist(request: WaitlistRequest):
    """Add an email to the waitlist."""
    if not rate_limiter.check(request.email):
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please try again in a minute.",
        )

    from index import supabase

    if not supabase:
        raise HTTPException(status_code=500, detail="Database not available")

    try:
        supabase.table("waitlist").upsert(
            {"email": request.email, "source": request.source},
            on_conflict="email",
        ).execute()

        return WaitlistResponse(
            success=True,
            message="You're on the list! We'll be in touch.",
        )
    except Exception as e:
        logger.error(f"Waitlist error: {e}")
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Internal server error")
