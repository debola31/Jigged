"""Pydantic models for AI Insights & Charts feature."""

from datetime import date
from uuid import UUID

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    """Request to submit a natural language question.

    `today` is the browser's local calendar date, and it is required. The database
    runs in UTC, so for part of every evening in the Americas its idea of "today"
    is a day ahead of the shop's -- which is enough to call a job late before it
    is. The jobs list already sends the same value into SQL as p_today; this is the
    chat catching up, not a new idea. The route sanity-checks it against the
    server's own date rather than trusting it outright.
    """

    question: str = Field(..., max_length=500, description="Natural language question about business data")
    today: date = Field(..., description="The caller's LOCAL calendar date, bound as $2 in generated SQL")
    # The conversation this question continues, or absent for a one-off. The
    # browser creates the thread under RLS (created_by = auth.uid()) and sends its
    # id; the route loads the replay set from it and never writes a message --
    # the trigger on ai_jobs does that when the job succeeds.
    thread_id: UUID | None = Field(default=None, description="ai_chat_threads.id this question continues")


class ReportRequest(BaseModel):
    """What the owner wants a one-page summary of, in their words.

    Same door as a question -- the flag, the cap, the worker's heartbeat -- and
    the same job row with kind='report'. The answer is a ReportSpec on the job's
    result, rendered to PDF in the browser.
    """

    request: str = Field(..., max_length=500, description="What the report should cover")
    today: date = Field(..., description="The caller's LOCAL calendar date, bound as $2 in generated SQL")


class ChatEnqueued(BaseModel):
    """What POST /chat returns now that answering is asynchronous.

    The answer is NOT here. The browser polls ai_jobs directly over PostgREST --
    RLS-scoped to its own company, one indexed SELECT, zero Vercel invocations and
    provably credit-free because it is a table read. Returning the job id rather
    than the answer is what removes the 60-second wall from this path entirely.

    The payload that eventually lands in `ai_jobs.result` is
    `{answer, chart_config, tool_calls, tool_trace, provider, model, tokens_used,
    not_permitted, summary, summary_covers_through_seq, summary_error}`, built
    by hand in services/ai_features/insights.py and read by the `ChatResponse`
    interface in utils/insightsAccess.ts (the browser never reads the summary
    keys; the ai_jobs trigger does). A Pydantic `ChatResponse` used to sit
    here describing it, and that is all it did -- no route declared it as a
    response_model and nothing validated against it, so it was a comment shaped
    like code. Deleted; the two ends that actually have to agree are the builder
    and the TypeScript interface.
    """

    job_id: str = Field(..., description="ai_jobs row to poll for the answer")
    status: str = Field(..., description="Lifecycle state at enqueue: queued, or already terminal")
    executor: str = Field(..., description="'worker' (desktop, local model) or 'backend' (inline)")
