"""The tool definition the insights chat hands to the model.

One entry: execute_sql. Text-to-SQL replaced an earlier predefined-metric-tools
approach that could only answer a fixed set of query shapes, and METRIC_TOOLS --
seven specs for functions nothing offered to a model, with descriptions that had
drifted from their own implementations -- lived here until it was deleted.

If a future question genuinely needs a predefined tool, it arrives with a
definition shared with the UI rather than a second copy of one. That is the
lesson the deleted set paid for: the AI and the dashboard disagreed on revenue
and on which jobs were late, because each surface wrote the rule again.
"""

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
]
