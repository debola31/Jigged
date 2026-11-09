"""Pydantic models for AI Insights & Charts feature."""

from datetime import date
from typing import Any
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
    # The conversation this report is asked in. A report is a turn like any other
    # since 2026-09-08: the job joins the thread and the trigger materialises the
    # request and the headline, with the spec beside them.
    thread_id: UUID | None = Field(default=None, description="ai_chat_threads.id this report is asked in")


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


# ---------------------------------------------------------------------------
# The data query: a customer's own assistant reading shop data with SQL.
# No model of ours runs; see POST /{company_id}/query in routes/insights_routes.py.
# ---------------------------------------------------------------------------

# Several times the longest reference query in semantics.md, and short enough that a request body
# is never the expensive part. lib/mcp/tools/query.ts carries the same cap.
DATA_QUERY_MAX_SQL_CHARS = 10_000


class DataQueryRequest(BaseModel):
    """One SELECT, written by the caller, run in the insights SQL sandbox."""

    sql: str = Field(
        ...,
        min_length=1,
        max_length=DATA_QUERY_MAX_SQL_CHARS,
        description="One SELECT or WITH statement; $1 is the company id, $2 today's date",
    )
    # Optional, unlike ChatRequest.today: a query that never mentions $2 needs no date, and one
    # that does is refused without it rather than handed the server's UTC day.
    today: date | None = Field(default=None, description="The caller's LOCAL calendar date, bound as $2")


class DataQueryResult(BaseModel):
    """The rows the query returned, at most `row_cap` of them."""

    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int
    row_cap: int = Field(..., description="The most rows one query returns (sql_executor.MAX_ROWS)")
    capped: bool = Field(
        ...,
        description="True when row_cap rows came back: the query may match more than were returned",
    )


class DataSchema(BaseModel):
    """What the insights AI navigates by, served to a caller writing its own SQL."""

    schema_context: str = Field(..., description="tools/schema_context.SCHEMA_CONTEXT, verbatim")
    semantics: str = Field(..., description="api/services/ai/semantics.md, verbatim")
    query_rules: list[str] = Field(..., description="What POST /query holds a statement to")
    row_cap: int
    timeout_seconds: float
