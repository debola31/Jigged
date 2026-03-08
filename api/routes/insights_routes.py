"""
API routes for AI Insights & Charts feature.

Endpoints:
- GET  /{company_id}/dashboard   - Get 5 pre-built insight cards
- POST /{company_id}/refresh     - Force-refresh all cached insights
- POST /{company_id}/chat        - Submit natural language question
- GET  /{company_id}/chat/history - Get last 20 chat queries

Note: Saved insights CRUD (get/save/delete) is handled client-side
via direct Supabase queries with RLS policies.
"""

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from supabase import Client, create_client

from models.insights_models import (
    ChatHistoryItem,
    ChatHistoryResponse,
    ChatRequest,
    ChatResponse,
    DashboardInsightsResponse,
    InsightCard,
)
from services.insights_service import (
    _build_chat_system_prompt,
    compute_dashboard_insights,
)
from tools.metric_tools import CHAT_TOOLS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/insights", tags=["insights"])


def _get_supabase_service_role() -> Client:
    """Get a Supabase client with service role key."""
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Database not available")
    return create_client(url, key)


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
            tools=CHAT_TOOLS,
            system_prompt=_build_chat_system_prompt(),
            max_tokens=4000,
        )

        duration_ms = int((time.time() - start_time) * 1000)

        # Try to extract chart_config from the response
        # The AI may include it as a JSON block in its response
        raw_content = result["content"]
        chart_config = _extract_chart_config(raw_content)

        # Strip code blocks from the answer text so users don't see raw JSON
        clean_answer = _strip_code_blocks(raw_content)

        # Log to ai_chat_queries
        try:
            supabase = _get_supabase_service_role()
            supabase.table("ai_chat_queries").insert({
                "company_id": company_id,
                "user_id": None,
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
            answer=clean_answer,
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


def _strip_code_blocks(content: str) -> str:
    """Remove all fenced code blocks (```...```) from AI response text."""
    if "```" not in content:
        return content.strip()

    parts = content.split("```")
    # Keep only even-indexed parts (outside code fences)
    clean_parts = [parts[i] for i in range(len(parts)) if i % 2 == 0]
    return "\n".join(clean_parts).strip()


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
