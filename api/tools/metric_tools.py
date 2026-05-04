"""
Metric tool definitions for Anthropic tool-use API format.

Each tool describes a metric function that queries company data from Supabase.
These definitions are passed to the Claude API for tool-use during chat interactions.
"""

METRIC_TOOLS: list[dict] = [
    {
        "name": "get_revenue_by_period",
        "description": (
            "Get revenue from shipped jobs grouped by time period. "
            "Revenue is derived from linked quote total_price for jobs with status='shipped'. "
            "Returns data suitable for an area or bar chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_type": {
                    "type": "string",
                    "enum": ["daily", "weekly", "monthly"],
                    "description": "How to group the revenue data",
                },
                "num_periods": {
                    "type": "integer",
                    "description": "Number of periods to return (default 8)",
                    "default": 8,
                },
            },
            "required": ["period_type"],
        },
    },
    {
        "name": "get_job_status_distribution",
        "description": (
            "Get the count of jobs in each status category "
            "(not_started, in_progress, completed, shipped, cancelled). "
            "Returns data suitable for a pie/donut chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "get_quote_conversion_rate",
        "description": (
            "Get the quote conversion rate over time. For each period, shows the total "
            "quotes created and how many were accepted/converted. Uses status_changed_at "
            "for acceptance timestamp. Returns data suitable for a bar chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_type": {
                    "type": "string",
                    "enum": ["daily", "weekly", "monthly"],
                    "description": "How to group the conversion data",
                },
                "num_periods": {
                    "type": "integer",
                    "description": "Number of periods to return (default 8)",
                    "default": 8,
                },
            },
            "required": ["period_type"],
        },
    },
    {
        "name": "get_job_cycle_times",
        "description": (
            "Get average job cycle times (creation to shipment) grouped by period. "
            "Only considers jobs with status='shipped' that have a shipped_at timestamp. "
            "Returns average days per period, suitable for a line/area chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_type": {
                    "type": "string",
                    "enum": ["daily", "weekly", "monthly"],
                    "description": "How to group the cycle time data",
                },
                "num_periods": {
                    "type": "integer",
                    "description": "Number of periods to return (default 8)",
                    "default": 8,
                },
            },
            "required": ["period_type"],
        },
    },
    {
        "name": "get_customer_revenue_breakdown",
        "description": (
            "Get revenue breakdown by customer for shipped jobs. "
            "Shows top customers by total revenue (from linked quote total_price). "
            "Returns data suitable for a horizontal bar chart or pie chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_type": {
                    "type": "string",
                    "enum": ["daily", "weekly", "monthly"],
                    "description": "Time window for grouping (used to set lookback period)",
                },
                "num_periods": {
                    "type": "integer",
                    "description": "Number of periods to look back (default 8)",
                    "default": 8,
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of customers to return (default 10)",
                    "default": 10,
                },
            },
            "required": ["period_type"],
        },
    },
    {
        "name": "get_part_profitability",
        "description": (
            "Get part profitability analysis. Walks shipped jobs -> job_parts -> parts. "
            "Revenue per part comes from the linked quote_line_items.total_price. "
            "Estimated labor cost rolls up job_operations: for internal work_centers, "
            "(estimated_setup_minutes + estimated_run_minutes_per_unit * quantity) / 60 "
            "* COALESCE(routing_operations.labor_rate_override, work_centers.labor_rate); "
            "for external work_centers, external_unit_price * quantity + external_setup_cost. "
            "Returns top parts by profit, suitable for a bar chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of parts to return (default 10)",
                    "default": 10,
                },
            },
            "required": [],
        },
    },
    {
        "name": "get_revenue_forecast",
        "description": (
            "Get revenue forecast from the open quote pipeline. "
            "Sums total_price from quotes with status in (pending_approval, accepted). "
            "Breaks down by status to show pipeline stages. Returns data suitable for a bar chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
]


def get_tool_by_name(name: str) -> dict | None:
    """Look up a tool definition by its name."""
    for tool in METRIC_TOOLS:
        if tool["name"] == name:
            return tool
    return None


# ============================================================
# Chat Tools — used by the AI chat endpoint (text-to-SQL)
# ============================================================
# Starts with just execute_sql. Custom predefined tools can be
# added here later for complex business logic queries.

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
                        "Example: SELECT status, COUNT(*) as count FROM jobs "
                        "WHERE company_id = $1 GROUP BY status"
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
