"""The tool definitions the insights chat hands to the model.

Two entries. execute_sql is the whole of the data path: text-to-SQL replaced an
earlier predefined-metric-tools approach that could only answer a fixed set of
query shapes, and METRIC_TOOLS -- seven specs for functions nothing offered to a
model, with descriptions that had drifted from their own implementations --
lived here until it was deleted. If a future question genuinely needs a
predefined data tool, it arrives with a definition shared with the UI rather than
a second copy of one. That is the lesson the deleted set paid for: the AI and the
dashboard disagreed on revenue and on which jobs were late, because each surface
wrote the rule again.

compose_report (2026-09-08) is not a data tool and restates no business term. It
is how the model says "this person asked for a document". The composer has one
box and no Ask/Report picker, so the form of an answer -- prose, a chart, a
one-page PDF -- is the model's call, the way a chart already is. The handler
intercepts the call and hands the brief to services/ai_features/report.py; the
tool itself computes nothing, and it is never dispatched to anything.
"""

COMPOSE_REPORT_TOOL = "compose_report"


def sql_argument(arguments: dict) -> str:
    """The `sql` argument as a string, unwrapping the schema shape if need be.

    A LOCAL MODEL SOMETIMES RETURNS THE SCHEMA INSTEAD OF THE VALUE:

        {"sql": {"sql": "SELECT ...", "type": "string"},
         "description": {"type": "string", "description": "Top customers"}}

    -- the property definition and the value fused together. Measured on
    qwen3:32b it happens on a small fraction of calls even with a short parameter
    description, and it is not something a prompt can be relied on to prevent.

    Until 2026-09-09 nothing checked: the dict went straight to validate_query,
    `sql.strip()` raised AttributeError deep inside it, _run_tool caught the
    exception and returned {"error": str(exc)} with NO error_kind -- which the loop
    reads as "ours, not the model's, no retry reaches it". So the model got
    `'dict' object has no attribute 'strip'` with no instruction attached, and
    answered the shop owner "I apologize for the error. Let me attempt to retrieve
    the information for you once more." That reached production.

    Unwrapping is safe here because it is not a guess: the intended value is
    present, verbatim, under its own key. Anything else returns "" so the validator
    refuses it as an empty query -- shaped, retryable, and carrying the rewrite
    instruction the model needs, which is the whole difference between a bad turn
    and a dead one.
    """
    value = arguments.get("sql", "")
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        inner = value.get("sql")
        if isinstance(inner, str):
            return inner
    return ""


def description_argument(arguments: dict) -> str:
    """The `description` argument as a string, unwrapped the same way.

    Cosmetic rather than load-bearing -- it is a label on a trace entry -- but a
    dict here put `{"type": "string", "description": "..."}` into
    ai_chat_messages.tool_trace, which is the audit record.
    """
    value = arguments.get("description", "")
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        inner = value.get("description")
        if isinstance(inner, str):
            return inner
    return ""

# THE CLOCK RULE IS STATED HERE TOO, AND THAT IS NOT DRIFT. It is a mechanical
# contract of this tool -- which values are bound -- not a business definition;
# semantics.md still owns those and this file defines none. It is repeated here
# because of WHERE this text lands. Measured on the assembled prompt: Ollama's
# qwen3 template renders the tools block AFTER the entire system prompt, so the
# `sql` parameter description sits at ~98% depth while "TODAY IS $2, NEVER THE
# CLOCK" in SCHEMA_CONTEXT sits at ~46%. Until 2026-09-09 this block carried
# three `$1`, zero `$2`, and called $1 "THE placeholder for company_id" -- a
# false arity claim about fifty tokens before the model writes SQL -- with a
# single worked example that had no date in it at all.
#
# Production 2026-09-08..09: 3 of 27 questions paid a wasted round trip to a
# CURRENT_DATE refusal, and 3 of 3 clock reaches were refused. On a box decoding
# at ~7 tokens/s that is ten to twenty seconds of someone waiting, for a rule the
# prompt already stated twice.
#
# Only two clock functions are named, deliberately: _FORBIDDEN_CLOCK holds eight
# and that list is the validator's to grow. Naming two keeps this sentence true
# when it does. The example is pinned to validate_query by
# api/tests/unit/test_chat_tools_contract.py -- an example the validator would
# refuse teaches the model the failure, because the example is what it copies.
#
# THE `sql` DESCRIPTION IS ONE LINE WITH ONE EXAMPLE, AND THAT IS MEASURED.
# The first version of this change wrote it as four lines with two labelled
# examples and a sentence about which expressions need the cast. Against qwen3:32b
# on the box, sampled with the real system prompt: that version made the model
# emit the JSON SCHEMA of the arguments instead of the arguments --
# `{"sql": {"sql": "SELECT ...", "type": "string"}}` -- in 5 of 14 calls, against
# 1 of 14 for the old $1-only text and 0 of 8 for this one. A property's own
# description is read while that property is being generated, and stuffing it with
# structure invites the model to reproduce structure. Keep it to a sentence and one
# example; put the reasoning in the tool description above, which is where the
# same sampling showed no effect.

CHAT_TOOLS: list[dict] = [
    {
        "name": "execute_sql",
        "description": (
            "Execute a read-only SQL SELECT query against the company's PostgreSQL database. "
            "The query MUST be a single SELECT statement (or WITH/CTE). "
            "Two values are bound for you and they are the only two: $1 is the company_id, "
            "and $2 is TODAY — the caller's own local calendar date. Build every date bound "
            "from $2. Asking the database for the date instead — CURRENT_DATE, now() — is "
            "rejected before execution and the query never runs. "
            "Results are limited to 200 rows. Use this for any analytical question about "
            "jobs, quotes, customers, parts, inventory, operations, or other business data."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": (
                        "A single SELECT statement. $1 is the company_id and $2 is today's "
                        "date; write $2::date where the type is not already fixed. "
                        "Example: SELECT production_status, COUNT(*) AS count FROM jobs "
                        "WHERE company_id = $1 GROUP BY production_status"
                    ),
                },
                "description": {
                    "type": "string",
                    "description": "Brief human-readable description of what this query computes",
                },
            },
            "required": ["sql", "description"],
        },
    },
    {
        "name": COMPOSE_REPORT_TOOL,
        "description": (
            "Produce a one-page PDF report instead of a prose answer. Call this ONLY when the "
            "person asks for a document: a report, a one-pager, a PDF, a printout, an executive "
            "summary, something to hand out or bring to a meeting. A question that a few sentences "
            "or one chart can answer is not a report: answer it directly. Do not run queries before "
            "calling this; the report gathers its own figures from the brief."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "brief": {
                    "type": "string",
                    "description": (
                        "What the page should cover, in one or two sentences that stand on their "
                        "own: the subject, the period, and any customer, vendor, part or work "
                        "centre this conversation has established. Resolve words like 'that' or "
                        "'this' from the conversation so the brief needs no context."
                    ),
                },
            },
            "required": ["brief"],
        },
    },
]
