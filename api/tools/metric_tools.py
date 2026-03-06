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
            "(pending, in_progress, on_hold, completed, shipped, cancelled). "
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
            "Get part profitability analysis. Compares revenue (quote total_price) "
            "against estimated labor cost (job_operations estimated hours * operation_types labor_rate). "
            "Returns top parts by profit margin, suitable for a bar chart."
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
        "name": "get_inventory_alerts",
        "description": (
            "Get inventory items that are at or below their reorder point. "
            "Only returns items where reorder_point is set and quantity <= reorder_point. "
            "Returns a list of alerts (no chart)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "get_at_risk_jobs",
        "description": (
            "Get jobs that are potentially at risk of missing deadlines. "
            "Analyzes pending and in_progress jobs, comparing percentage of operations "
            "completed vs percentage of estimated time elapsed. Returns a list of at-risk "
            "jobs with severity levels (high, medium, low)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "get_resource_utilization",
        "description": (
            "Get resource group utilization showing booked hours by resource group "
            "over time. Joins job_operations with operation_types and resource_groups. "
            "Returns data suitable for a stacked bar chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_type": {
                    "type": "string",
                    "enum": ["daily", "weekly", "monthly"],
                    "description": "How to group the utilization data",
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
        "name": "get_revenue_forecast",
        "description": (
            "Get revenue forecast from the open quote pipeline. "
            "Sums total_price from quotes with status in (draft, pending_approval, accepted). "
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
