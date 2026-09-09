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
# when it does. The examples are pinned to validate_query by
# api/tests/unit/test_chat_tools_contract.py -- an example the validator would
# refuse teaches the model the failure, because the example is what it copies.

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
                        "A single SELECT statement. $1 is the company_id; $2 is today's "
                        "date. Write $2::date wherever the expression does not already fix "
                        "the type — DATE_TRUNC, EXTRACT, AGE and interval arithmetic all "
                        "need the cast; a comparison against a typed column does not.\n"
                        "Example, no date needed: SELECT production_status, COUNT(*) AS count "
                        "FROM jobs WHERE company_id = $1 GROUP BY production_status\n"
                        "Example, bounded by today: SELECT COUNT(*) AS jobs FROM jobs "
                        "WHERE company_id = $1 AND due_date BETWEEN $2::date AND $2::date + 7"
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
