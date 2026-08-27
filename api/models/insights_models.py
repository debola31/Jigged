"""Pydantic models for AI Insights & Charts feature."""

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

    The payload that eventually lands in `ai_jobs.result` is
    `{answer, chart_config, tool_calls, provider, model, tokens_used}`, built by
    hand in services/ai_features/insights.py and read by the `ChatResponse`
    interface in utils/insightsAccess.ts. A Pydantic `ChatResponse` used to sit
    here describing it, and that is all it did -- no route declared it as a
    response_model and nothing validated against it, so it was a comment shaped
    like code. Deleted; the two ends that actually have to agree are the builder
    and the TypeScript interface.
    """

    job_id: str = Field(..., description="ai_jobs row to poll for the answer")
    status: str = Field(..., description="Lifecycle state at enqueue: queued, or already terminal")
    executor: str = Field(..., description="'worker' (desktop, local model) or 'backend' (inline)")
