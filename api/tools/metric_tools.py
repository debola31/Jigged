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
            "Revenue is the sum of job_parts.total_price (the agreed line total on the "
            "job, which reflects any post-conversion quantity edit) for jobs with "
            "fulfillment_status='fully_shipped'. "
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
            "Get the count of jobs in each production_status category "
            "(not_started, in_progress, completed, cancelled). "
            "Note: 'shipped' is no longer a production status — see the "
            "separate fulfillment_status enum (unshipped, partially_shipped, "
            "fully_shipped). Returns data suitable for a pie/donut chart."
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
            "Get average job cycle times (creation to last shipment) grouped by period. "
            "Only considers jobs with fulfillment_status='fully_shipped'. "
            "Last ship date comes from the SQL helper public.job_last_ship_date(job_id), "
            "which sums non-voided shipments. "
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
            "Shows top customers by total revenue (from job_parts.total_price, the "
            "agreed line total on the job). "
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
            "Revenue per part is job_parts.total_price (the agreed line total on the job). "
            "Cost is job_parts.true_cost_per_unit * quantity — the all-in TRUE cost "
            "(labor + materials + nested BOM) frozen when the job was created, so a "
            "shipped job's profit does not change when a labor rate or material cost "
            "changes later. Also returns the split: labor_cost, rebuilt from the rates "
            "frozen on job_operations, and material_cost, the remainder. Costs use "
            "ESTIMATED time — actual time per operation is not recorded. Job parts that "
            "could not be costed are excluded and counted in excluded_job_parts, never "
            "counted as free. Returns top parts by profit, suitable for a bar chart."
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
