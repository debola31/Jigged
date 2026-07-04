"""Pydantic models for AI Insights & Charts feature."""

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
