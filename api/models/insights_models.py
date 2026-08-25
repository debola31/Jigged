"""Pydantic models for AI Insights & Charts feature."""

from typing import Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    """Request to submit a natural language question."""

    question: str = Field(..., max_length=500, description="Natural language question about business data")


class ChatEnqueued(BaseModel):
    """What POST /chat returns now that answering is asynchronous.

    The answer is NOT here. The browser polls ai_jobs directly over PostgREST --
    RLS-scoped to its own company, one indexed SELECT, zero Vercel invocations and
    provably credit-free because it is a table read. Returning the job id rather
    than the answer is what removes the 60-second wall from this path entirely.
    """

    job_id: str = Field(..., description="ai_jobs row to poll for the answer")
    status: str = Field(..., description="Lifecycle state at enqueue: queued, or already terminal")
    executor: str = Field(..., description="'worker' (desktop, local model) or 'backend' (inline)")


class ChatResponse(BaseModel):
    """The shape stored in ai_jobs.result and rendered by the ask bar.

    Unchanged from when this was the HTTP response body, so the frontend renders
    the same object it always did -- it just reads it from a job row now.
    """

    answer: str = Field(..., description="AI-generated answer text")
    chart_config: Optional[dict] = Field(
        None, description="Optional chart configuration if the answer includes data visualization"
    )
    tool_calls: list[str] = Field(
        default_factory=list, description="List of tool names that were called to gather data"
    )
    provider: str = Field(..., description="Provider that actually answered: anthropic | ollama | deepinfra")
    model: Optional[str] = Field(None, description="Model that actually answered")
    tokens_used: Optional[int] = Field(None, description="Total tokens consumed by the request")
