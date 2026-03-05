"""
API routes for AI Insights & Charts feature.

Endpoints:
- GET  /{company_id}/dashboard   - Get 5 pre-built insight cards
- POST /{company_id}/refresh     - Force-refresh all cached insights
- POST /{company_id}/chat        - Submit natural language question
- GET  /{company_id}/chat/history - Get last 20 chat queries
- POST /{company_id}/saved       - Save a chart to dashboard
- GET  /{company_id}/saved       - List saved insights
- DELETE /{company_id}/saved/{id} - Delete a saved insight
"""

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Header, HTTPException
from supabase import Client, create_client

from models.insights_models import (
    ChatHistoryItem,
    ChatHistoryResponse,
    ChatRequest,
    ChatResponse,
    DashboardInsightsResponse,
    InsightCard,
    SavedInsight,
    SavedInsightsResponse,
    SaveInsightRequest,
)
from services.insights_service import (
    INSIGHTS_SYSTEM_PROMPT,
    compute_dashboard_insights,
    execute_tool,
)
from tools.metric_tools import METRIC_TOOLS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/insights", tags=["insights"])


def _get_supabase_service_role() -> Client:
    """Get a Supabase client with service role key."""
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Database not available")
    return create_client(url, key)


def _verify_user_access(authorization: str, company_id: str) -> str:
    """
    Verify user has access to the company from the Authorization JWT.
    Returns user_id if authorized.

    Uses the Supabase service role client to verify the JWT and check
    user_company_access for the correct role.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authorization header")

    token = authorization.split(" ", 1)[1]
    supabase = _get_supabase_service_role()

    try:
        # Verify the JWT and get user info
        user_response = supabase.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Invalid token")

        user_id = user_response.user.id

        # Check user has access to this company with appropriate role
        access_response = (
            supabase.table("user_company_access")
            .select("role")
            .eq("user_id", user_id)
            .eq("company_id", company_id)
            .maybe_single()
            .execute()
        )

        if not access_response.data:
            raise HTTPException(status_code=403, detail="No access to this company")

        role = access_response.data.get("role")
        if role not in ("owner", "admin", "user"):
            raise HTTPException(
                status_code=403,
                detail="Insufficient role. Operators cannot access insights.",
            )

        return user_id

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Auth verification error: {e}")
        raise HTTPException(status_code=401, detail="Authentication failed")


def _check_chat_rate_limit(company_id: str) -> None:
    """
    Check if the company has exceeded the chat rate limit (20 queries/hour).
    """
    supabase = _get_supabase_service_role()
    one_hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()

    try:
        response = (
            supabase.table("ai_chat_queries")
            .select("id", count="exact")
            .eq("company_id", company_id)
            .gte("created_at", one_hour_ago)
            .execute()
        )

        count = response.count or 0
        if count >= 20:
            raise HTTPException(
                status_code=429,
                detail="Rate limit exceeded. Maximum 20 AI chat queries per hour per company.",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Rate limit check failed: {e}")
        # If rate limit check fails, allow the request through


# ============================================================
# Dashboard Insights
# ============================================================


@router.get("/{company_id}/dashboard", response_model=DashboardInsightsResponse)
async def get_dashboard_insights(company_id: str):
    """
    Get the 5 pre-built dashboard insight cards.
    Serves from cache if available and not expired, otherwise computes fresh.
    """
    try:
        insights_data = await compute_dashboard_insights(company_id)
        insights = [InsightCard(**insight) for insight in insights_data]
        return DashboardInsightsResponse(insights=insights)
    except Exception as e:
        logger.error(f"Error getting dashboard insights: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to compute dashboard insights: {str(e)}",
        )


@router.post("/{company_id}/refresh", response_model=DashboardInsightsResponse)
async def refresh_insights(company_id: str):
    """
    Force-refresh all cached insights for a company.
    Bypasses cache and recomputes all 5 insight types.
    """
    try:
        insights_data = await compute_dashboard_insights(company_id, force_refresh=True)
        insights = [InsightCard(**insight) for insight in insights_data]
        return DashboardInsightsResponse(insights=insights)
    except Exception as e:
        logger.error(f"Error refreshing insights: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to refresh insights: {str(e)}",
        )


# ============================================================
# Chat
# ============================================================


@router.post("/{company_id}/chat", response_model=ChatResponse)
async def chat(company_id: str, request: ChatRequest):
    """
    Submit a natural language question about company data.
    Uses AI tool-use to query metrics and generate a response.

    Rate limited to 20 queries per company per hour.
    """
    # Check rate limit
    _check_chat_rate_limit(company_id)

    start_time = time.time()

    try:
        from services.ai.claude_provider import ClaudeProvider

        provider = ClaudeProvider()

        # Build messages with company context embedded
        messages = [
            {
                "role": "user",
                "content": (
                    f"company_id: {company_id}\n\n"
                    f"Question: {request.question}"
                ),
            },
        ]

        # Execute the AI chat with tools
        result = await provider.chat_with_tools(
            messages=messages,
            tools=METRIC_TOOLS,
            system_prompt=INSIGHTS_SYSTEM_PROMPT,
            max_tokens=4000,
        )

        duration_ms = int((time.time() - start_time) * 1000)

        # Try to extract chart_config from the response
        # The AI may include it as a JSON block in its response
        chart_config = _extract_chart_config(result["content"])

        # Log to ai_chat_queries
        try:
            supabase = _get_supabase_service_role()
            supabase.table("ai_chat_queries").insert({
                "company_id": company_id,
                "user_id": "00000000-0000-0000-0000-000000000000",  # Placeholder when no auth
                "question": request.question,
                "tool_calls": result.get("tool_calls", []),
                "response": result["content"],
                "chart_config": chart_config,
                "provider": "anthropic",
                "model": result.get("model"),
                "tokens_used": result.get("tokens_used"),
                "duration_ms": duration_ms,
            }).execute()
        except Exception as e:
            logger.warning(f"Failed to log chat query: {e}")

        return ChatResponse(
            answer=result["content"],
            chart_config=chart_config,
            tool_calls=result.get("tool_calls", []),
            provider="anthropic",
            tokens_used=result.get("tokens_used"),
        )

    except HTTPException:
        raise
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as e:
        logger.error(f"Chat error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to process chat query: {str(e)}",
        )


def _extract_chart_config(content: str) -> dict | None:
    """
    Try to extract a chart_config JSON block from the AI response.
    The AI may include chart configuration as ```json blocks or inline JSON.
    """
    try:
        # Look for ```chart_config or ```json blocks
        if "```" in content:
            blocks = content.split("```")
            for i, block in enumerate(blocks):
                if i % 2 == 1:  # Inside code fence
                    # Remove language identifier if present
                    lines = block.strip().split("\n")
                    if lines[0].strip().lower() in ("json", "chart_config", "chart"):
                        json_text = "\n".join(lines[1:])
                    else:
                        json_text = block.strip()

                    try:
                        data = json.loads(json_text)
                        if isinstance(data, dict) and "chart_type" in data:
                            return data
                    except json.JSONDecodeError:
                        continue
    except Exception:
        pass

    return None


@router.get("/{company_id}/chat/history", response_model=ChatHistoryResponse)
async def get_chat_history(company_id: str):
    """
    Get the last 20 chat queries for this company.
    """
    try:
        supabase = _get_supabase_service_role()

        response = (
            supabase.table("ai_chat_queries")
            .select("id, question, response, chart_config, created_at")
            .eq("company_id", company_id)
            .order("created_at", desc=True)
            .limit(20)
            .execute()
        )

        queries = []
        for row in response.data or []:
            queries.append(
                ChatHistoryItem(
                    id=row["id"],
                    question=row["question"],
                    response=row["response"],
                    has_chart=row.get("chart_config") is not None,
                    created_at=row["created_at"],
                )
            )

        return ChatHistoryResponse(queries=queries)

    except Exception as e:
        logger.error(f"Error fetching chat history: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch chat history: {str(e)}",
        )


# ============================================================
# Saved Insights
# ============================================================


@router.post("/{company_id}/saved", response_model=SavedInsight)
async def save_insight(
    company_id: str,
    request: SaveInsightRequest,
    authorization: str = Header(None),
):
    """
    Save a chart to the user's dashboard.
    Enforces a maximum of 5 saved insights per user per company.
    """
    user_id = _verify_user_access(authorization, company_id)

    try:
        supabase = _get_supabase_service_role()

        # Check count of existing saved insights
        count_response = (
            supabase.table("saved_insights")
            .select("id", count="exact")
            .eq("user_id", user_id)
            .eq("company_id", company_id)
            .execute()
        )

        count = count_response.count or 0
        if count >= 5:
            raise HTTPException(
                status_code=400,
                detail="Maximum 5 saved insights per company. Remove one to save another.",
            )

        # Insert the saved insight
        insert_response = (
            supabase.table("saved_insights")
            .insert({
                "user_id": user_id,
                "company_id": company_id,
                "question": request.question,
                "answer": request.answer,
                "chart_config": request.chart_config,
            })
            .execute()
        )

        row = insert_response.data[0]
        return SavedInsight(
            id=row["id"],
            question=row["question"],
            answer=row["answer"],
            chart_config=row.get("chart_config"),
            created_at=row["created_at"],
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving insight: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save insight: {str(e)}",
        )


@router.get("/{company_id}/saved", response_model=SavedInsightsResponse)
async def get_saved_insights(
    company_id: str,
    authorization: str = Header(None),
):
    """
    List user's saved insights for this company, sorted by newest first.
    """
    user_id = _verify_user_access(authorization, company_id)

    try:
        supabase = _get_supabase_service_role()

        response = (
            supabase.table("saved_insights")
            .select("id, question, answer, chart_config, created_at")
            .eq("user_id", user_id)
            .eq("company_id", company_id)
            .order("created_at", desc=True)
            .execute()
        )

        insights = [
            SavedInsight(
                id=row["id"],
                question=row["question"],
                answer=row["answer"],
                chart_config=row.get("chart_config"),
                created_at=row["created_at"],
            )
            for row in response.data or []
        ]

        return SavedInsightsResponse(insights=insights)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching saved insights: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch saved insights: {str(e)}",
        )


@router.delete("/{company_id}/saved/{insight_id}")
async def delete_saved_insight(
    company_id: str,
    insight_id: str,
    authorization: str = Header(None),
):
    """
    Delete a saved insight. Verifies the user owns it.
    """
    user_id = _verify_user_access(authorization, company_id)

    try:
        supabase = _get_supabase_service_role()

        # Verify ownership before deleting
        existing = (
            supabase.table("saved_insights")
            .select("id")
            .eq("id", insight_id)
            .eq("user_id", user_id)
            .eq("company_id", company_id)
            .maybe_single()
            .execute()
        )

        if not existing or not existing.data:
            raise HTTPException(status_code=404, detail="Saved insight not found")

        supabase.table("saved_insights").delete().eq("id", insight_id).execute()

        return {"status": "deleted"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting saved insight: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete saved insight: {str(e)}",
        )
