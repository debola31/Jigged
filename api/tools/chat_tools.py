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

CHAT_TOOLS: list[dict] = [
    {
        "name": "execute_sql",
        "description": (
            "Execute a read-only SQL SELECT query against the company's PostgreSQL database. "
            "The query MUST be a single SELECT statement (or WITH/CTE). "
            "Use $1 as the placeholder for company_id — it will be injected automatically. "
            "Results are limited to 200 rows. Use this for any analytical question about "
            "jobs, quotes, customers, parts, inventory, operations, or other business data."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": (
                        "A single SELECT statement. Use $1 as the company_id placeholder. "
                        "Example: SELECT production_status, COUNT(*) as count FROM jobs "
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
