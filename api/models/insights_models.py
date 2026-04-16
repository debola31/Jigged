"""Pydantic models for AI Insights & Charts feature."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    """Request to submit a natural language question."""

    question: str = Field(..., max_length=500, description="Natural language question about business data")


class ChatResponse(BaseModel):
    """Response from the AI chat interface."""

    answer: str = Field(..., description="AI-generated answer text")
    chart_config: Optional[dict] = Field(
        None, description="Optional chart configuration if the answer includes data visualization"
    )
    tool_calls: list[str] = Field(
        default_factory=list, description="List of tool names that were called to gather data"
    )
    provider: str = Field(..., description="AI provider used (e.g. 'anthropic')")
    tokens_used: Optional[int] = Field(None, description="Total tokens consumed by the request")


class ChatHistoryItem(BaseModel):
    """A single item from chat history."""

    id: str = Field(..., description="Unique chat query ID")
    question: str = Field(..., description="The original question asked")
    response: str = Field(..., description="The AI response text")
    has_chart: bool = Field(False, description="Whether the response included a chart")
    created_at: datetime = Field(..., description="When the query was made")


class ChatHistoryResponse(BaseModel):
    """Response containing chat history items."""

    queries: list[ChatHistoryItem]
