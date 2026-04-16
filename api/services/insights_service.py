"""
Insights service: metric computation and chat orchestration.

Contains:
1. Metric functions that query Supabase (exposed via chat tool-use)
2. Chat orchestration (execute tool calls, return results)
"""

import logging
import os
from datetime import datetime, timedelta, timezone

from supabase import Client, create_client

logger = logging.getLogger(__name__)


def _build_chat_system_prompt() -> str:
    """Build the full system prompt for chat interactions with schema context."""
    from tools.schema_context import SCHEMA_CONTEXT

    return (
        "You are a business analyst for a small precision manufacturing shop.\n"
        "You have access to the execute_sql tool to query the company's PostgreSQL database.\n\n"
        "Use execute_sql to answer questions by writing SELECT queries. "
        "Always use $1 as the company_id placeholder.\n\n"
        f"{SCHEMA_CONTEXT}\n\n"
        "Guidelines:\n"
        "- Always use execute_sql to get real data. Never make up numbers.\n"
        "- For chat responses: be direct and concise. 1-3 sentences max. Shop owners are busy.\n"
        "- ALWAYS include a chart_config JSON block when the data has multiple values, trends, comparisons, or distributions.\n"
        "- Use area for trends over time, bar for comparisons, bar_horizontal for ranked lists, pie for distributions.\n"
        "- Only omit charts for yes/no answers or single-number lookups.\n"
        "- Answer with facts and numbers only. Do not add advice, opinions, or recommendations unless the user asks.\n"
        "- Include comparisons to previous periods when the data supports it (e.g., 'up 12% vs last week').\n"
        "- Flag risks prominently (at-risk jobs, low inventory, revenue decline).\n"
        "- Use plain language. Avoid jargon. These are machinists, not MBAs.\n"
        "- In SQL, ALWAYS filter by company_id = $1 on tables that have company_id.\n"
        "- For tables without company_id (job_operations, routing_nodes, etc.), JOIN through parent tables.\n\n"
        "chart_config format (include as a ```json code block when applicable):\n"
        "{\n"
        '  "chart_type": "area" | "pie" | "bar" | "bar_horizontal" | "sparkline",\n'
        '  "data": [{"x_key_value": ..., "y_key_value": ...}, ...],\n'
        '  "x_key": "field_name",\n'
        '  "y_key": "field_name",\n'
        '  "x_label": "Axis Label",\n'
        '  "y_label": "Axis Label"\n'
        "}"
    )


def _get_supabase_service_role() -> Client:
    """Get a Supabase client with service role key for backend queries."""
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not url or not key:
        raise RuntimeError("Supabase service role configuration not available")

    return create_client(url, key)


def _get_period_boundaries(period_type: str, num_periods: int) -> list[dict]:
    """
    Calculate time boundaries for the given number of periods.
    Returns a list of dicts with 'start', 'end', and 'label' for each period.
    Most recent period is last in the list.
    """
    now = datetime.now(timezone.utc)
    periods = []

    if period_type == "daily":
        for i in range(num_periods - 1, -1, -1):
            start = (now - timedelta(days=i)).replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=1)
            periods.append({
                "start": start.isoformat(),
                "end": end.isoformat(),
                "label": start.strftime("%b %d"),
            })
    elif period_type == "weekly":
        # Start from Monday of current week
        current_monday = (now - timedelta(days=now.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        for i in range(num_periods - 1, -1, -1):
            start = current_monday - timedelta(weeks=i)
            end = start + timedelta(weeks=1)
            periods.append({
                "start": start.isoformat(),
                "end": end.isoformat(),
                "label": f"W{start.isocalendar()[1]} ({start.strftime('%b %d')})",
            })
    elif period_type == "monthly":
        for i in range(num_periods - 1, -1, -1):
            # Calculate month offset
            month = now.month - i
            year = now.year
            while month <= 0:
                month += 12
                year -= 1
            start = datetime(year, month, 1, tzinfo=timezone.utc)
            # End of month: start of next month
            if month == 12:
                end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
            else:
                end = datetime(year, month + 1, 1, tzinfo=timezone.utc)
            periods.append({
                "start": start.isoformat(),
                "end": end.isoformat(),
                "label": start.strftime("%b %Y"),
            })

    return periods


# ============================================================
# Metric Functions
# ============================================================


def get_revenue_by_period(
    company_id: str,
    period_type: str = "weekly",
    num_periods: int = 8,
) -> dict:
    """Get revenue from shipped jobs grouped by time period."""
    supabase = _get_supabase_service_role()
    periods = _get_period_boundaries(period_type, num_periods)

    # Get the overall time range
    start_date = periods[0]["start"]
    end_date = periods[-1]["end"]

    # Query shipped jobs with their quote prices in the date range
    response = (
        supabase.table("jobs")
        .select("id, shipped_at, quotes!jobs_quote_id_fkey(total_price)")
        .eq("company_id", company_id)
        .eq("status", "shipped")
        .gte("shipped_at", start_date)
        .lt("shipped_at", end_date)
        .execute()
    )

    jobs = response.data or []

    # Bucket jobs into periods
    result = []
    total_revenue = 0.0
    for period in periods:
        period_revenue = 0.0
        for job in jobs:
            if job.get("shipped_at") and period["start"] <= job["shipped_at"] < period["end"]:
                price = 0.0
                quote = job.get("quotes")
                if isinstance(quote, dict):
                    price = float(quote.get("total_price", 0) or 0)
                elif isinstance(quote, list) and quote:
                    price = float(quote[0].get("total_price", 0) or 0)
                period_revenue += price
        total_revenue += period_revenue
        result.append({
            "period": period["label"],
            "revenue": round(period_revenue, 2),
        })

    return {
        "periods": result,
        "total_revenue": round(total_revenue, 2),
        "period_type": period_type,
        "num_periods": num_periods,
    }


def get_job_status_distribution(company_id: str) -> dict:
    """Get the count of jobs in each status category."""
    supabase = _get_supabase_service_role()

    response = (
        supabase.table("jobs")
        .select("status")
        .eq("company_id", company_id)
        .execute()
    )

    jobs = response.data or []

    # Count by status
    status_counts: dict[str, int] = {}
    for job in jobs:
        status = job.get("status", "unknown")
        status_counts[status] = status_counts.get(status, 0) + 1

    distribution = [
        {"status": status, "count": count}
        for status, count in sorted(status_counts.items())
    ]

    return {
        "distribution": distribution,
        "total_jobs": len(jobs),
    }


def get_quote_conversion_rate(
    company_id: str,
    period_type: str = "weekly",
    num_periods: int = 8,
) -> dict:
    """
    Get quote conversion rate over time.
    For each period, counts quotes created in that period and how many
    reached 'accepted' or 'converted' status.
    Uses status_changed_at WHERE status IN ('accepted','converted') as acceptance timestamp.
    """
    supabase = _get_supabase_service_role()
    periods = _get_period_boundaries(period_type, num_periods)

    start_date = periods[0]["start"]
    end_date = periods[-1]["end"]

    # Get quotes created in the date range
    response = (
        supabase.table("quotes")
        .select("id, status, created_at, status_changed_at")
        .eq("company_id", company_id)
        .gte("created_at", start_date)
        .lt("created_at", end_date)
        .execute()
    )

    quotes = response.data or []

    result = []
    for period in periods:
        # Quotes created in this period
        created_in_period = [
            q for q in quotes
            if q.get("created_at") and period["start"] <= q["created_at"] < period["end"]
        ]
        total_created = len(created_in_period)

        # Of those, how many are accepted/converted
        converted = [
            q for q in created_in_period
            if q.get("status") in ("accepted", "converted")
        ]
        total_converted = len(converted)

        rate = (total_converted / total_created * 100) if total_created > 0 else 0.0

        result.append({
            "period": period["label"],
            "total_quotes": total_created,
            "converted_quotes": total_converted,
            "conversion_rate": round(rate, 1),
        })

    return {
        "periods": result,
        "period_type": period_type,
        "num_periods": num_periods,
    }


def get_job_cycle_times(
    company_id: str,
    period_type: str = "weekly",
    num_periods: int = 8,
) -> dict:
    """Get average job cycle times (creation to shipment) grouped by period."""
    supabase = _get_supabase_service_role()
    periods = _get_period_boundaries(period_type, num_periods)

    start_date = periods[0]["start"]
    end_date = periods[-1]["end"]

    # Get shipped jobs in the date range (by shipped_at)
    response = (
        supabase.table("jobs")
        .select("id, created_at, shipped_at")
        .eq("company_id", company_id)
        .eq("status", "shipped")
        .not_.is_("shipped_at", "null")
        .gte("shipped_at", start_date)
        .lt("shipped_at", end_date)
        .execute()
    )

    jobs = response.data or []

    result = []
    for period in periods:
        # Jobs shipped in this period
        period_jobs = [
            j for j in jobs
            if j.get("shipped_at") and period["start"] <= j["shipped_at"] < period["end"]
        ]

        cycle_times = []
        for job in period_jobs:
            if job.get("created_at") and job.get("shipped_at"):
                created = datetime.fromisoformat(job["created_at"].replace("Z", "+00:00"))
                shipped = datetime.fromisoformat(job["shipped_at"].replace("Z", "+00:00"))
                days = (shipped - created).total_seconds() / 86400
                cycle_times.append(days)

        avg_days = sum(cycle_times) / len(cycle_times) if cycle_times else 0.0

        result.append({
            "period": period["label"],
            "avg_cycle_days": round(avg_days, 1),
            "job_count": len(period_jobs),
        })

    return {
        "periods": result,
        "period_type": period_type,
        "num_periods": num_periods,
    }


def get_customer_revenue_breakdown(
    company_id: str,
    period_type: str = "weekly",
    num_periods: int = 8,
    limit: int = 10,
) -> dict:
    """Get revenue breakdown by customer for shipped jobs."""
    supabase = _get_supabase_service_role()
    periods = _get_period_boundaries(period_type, num_periods)

    start_date = periods[0]["start"]
    end_date = periods[-1]["end"]

    # Get shipped jobs with customer and quote data
    response = (
        supabase.table("jobs")
        .select("id, customer_id, shipped_at, customers!left(name), quotes!jobs_quote_id_fkey(total_price)")
        .eq("company_id", company_id)
        .eq("status", "shipped")
        .gte("shipped_at", start_date)
        .lt("shipped_at", end_date)
        .execute()
    )

    jobs = response.data or []

    # Aggregate revenue by customer
    customer_revenue: dict[str, dict] = {}
    for job in jobs:
        customer_name = "Unknown"
        if isinstance(job.get("customers"), dict):
            customer_name = job["customers"].get("name", "Unknown")

        price = 0.0
        quote = job.get("quotes")
        if isinstance(quote, dict):
            price = float(quote.get("total_price", 0) or 0)
        elif isinstance(quote, list) and quote:
            price = float(quote[0].get("total_price", 0) or 0)

        customer_id = job.get("customer_id", "unknown")
        if customer_id not in customer_revenue:
            customer_revenue[customer_id] = {
                "customer_name": customer_name,
                "revenue": 0.0,
                "job_count": 0,
            }
        customer_revenue[customer_id]["revenue"] += price
        customer_revenue[customer_id]["job_count"] += 1

    # Sort by revenue descending and limit
    sorted_customers = sorted(
        customer_revenue.values(),
        key=lambda x: x["revenue"],
        reverse=True,
    )[:limit]

    # Round revenue values
    for c in sorted_customers:
        c["revenue"] = round(c["revenue"], 2)

    return {
        "customers": sorted_customers,
        "period_type": period_type,
        "num_periods": num_periods,
        "lookback_start": start_date,
    }


def get_part_profitability(company_id: str, limit: int = 10) -> dict:
    """
    Get part profitability analysis.
    Compares revenue (quote total_price) vs estimated labor cost
    (job_operations estimated_run_hours_per_unit * operation_types.labor_rate).
    """
    supabase = _get_supabase_service_role()

    # Get shipped jobs with part, quote, and operation data
    response = (
        supabase.table("jobs")
        .select(
            "id, part_id, "
            "parts!left(part_name, description), "
            "quotes!jobs_quote_id_fkey(total_price, quantity), "
            "job_operations(estimated_setup_hours, estimated_run_hours_per_unit, "
            "operation_types!left(labor_rate))"
        )
        .eq("company_id", company_id)
        .eq("status", "shipped")
        .execute()
    )

    jobs = response.data or []

    # Aggregate by part
    part_data: dict[str, dict] = {}
    for job in jobs:
        part_id = job.get("part_id")
        if not part_id:
            continue

        if part_id not in part_data:
            part_info = job.get("parts") or {}
            if isinstance(part_info, list) and part_info:
                part_info = part_info[0]
            part_data[part_id] = {
                "part_name": part_info.get("part_name", "Unknown"),
                "description": part_info.get("description", ""),
                "total_revenue": 0.0,
                "total_labor_cost": 0.0,
                "job_count": 0,
            }

        # Revenue from quote
        quote = job.get("quotes")
        quantity = 1
        if isinstance(quote, dict):
            part_data[part_id]["total_revenue"] += float(quote.get("total_price", 0) or 0)
            quantity = int(quote.get("quantity", 1) or 1)
        elif isinstance(quote, list) and quote:
            part_data[part_id]["total_revenue"] += float(quote[0].get("total_price", 0) or 0)
            quantity = int(quote[0].get("quantity", 1) or 1)

        # Estimated labor cost from operations
        operations = job.get("job_operations") or []
        if isinstance(operations, list):
            for op in operations:
                setup_hours = float(op.get("estimated_setup_hours", 0) or 0)
                run_hours = float(op.get("estimated_run_hours_per_unit", 0) or 0)
                total_hours = setup_hours + (run_hours * quantity)

                op_type = op.get("operation_types") or {}
                if isinstance(op_type, list) and op_type:
                    op_type = op_type[0]
                labor_rate = float(op_type.get("labor_rate", 0) or 0)
                part_data[part_id]["total_labor_cost"] += total_hours * labor_rate

        part_data[part_id]["job_count"] += 1

    # Calculate profit margin and sort
    parts_list = []
    for part_id, data in part_data.items():
        revenue = data["total_revenue"]
        cost = data["total_labor_cost"]
        profit = revenue - cost
        margin = (profit / revenue * 100) if revenue > 0 else 0.0

        parts_list.append({
            "part_name": data["part_name"],
            "description": data["description"],
            "revenue": round(revenue, 2),
            "labor_cost": round(cost, 2),
            "profit": round(profit, 2),
            "margin_pct": round(margin, 1),
            "job_count": data["job_count"],
        })

    parts_list.sort(key=lambda x: x["profit"], reverse=True)

    return {
        "parts": parts_list[:limit],
        "total_parts_analyzed": len(parts_list),
    }


def get_resource_utilization(
    company_id: str,
    period_type: str = "weekly",
    num_periods: int = 8,
) -> dict:
    """Get resource group utilization showing booked hours over time."""
    supabase = _get_supabase_service_role()
    periods = _get_period_boundaries(period_type, num_periods)

    start_date = periods[0]["start"]
    end_date = periods[-1]["end"]

    # Get job operations with their operation types and resource groups
    # We scope by job created_at in the date range
    response = (
        supabase.table("jobs")
        .select(
            "id, created_at, "
            "job_operations(estimated_setup_hours, estimated_run_hours_per_unit, "
            "operation_types!left(name, resource_group_id, resource_groups!left(name)))"
        )
        .eq("company_id", company_id)
        .in_("status", ["not_started", "in_progress", "completed", "shipped"])
        .gte("created_at", start_date)
        .lt("created_at", end_date)
        .execute()
    )

    jobs = response.data or []

    # Build period data keyed by resource group
    resource_groups: dict[str, dict[str, float]] = {}

    for job in jobs:
        job_created = job.get("created_at", "")
        if not job_created:
            continue

        # Find which period this job belongs to
        period_label = None
        for period in periods:
            if period["start"] <= job_created < period["end"]:
                period_label = period["label"]
                break
        if not period_label:
            continue

        operations = job.get("job_operations") or []
        if not isinstance(operations, list):
            continue

        for op in operations:
            setup = float(op.get("estimated_setup_hours", 0) or 0)
            run = float(op.get("estimated_run_hours_per_unit", 0) or 0)
            total_hours = setup + run  # Simplified; per-unit * 1

            op_type = op.get("operation_types") or {}
            if isinstance(op_type, list) and op_type:
                op_type = op_type[0]

            rg = op_type.get("resource_groups") or {}
            if isinstance(rg, list) and rg:
                rg = rg[0]
            rg_name = rg.get("name", "Unassigned") if isinstance(rg, dict) else "Unassigned"

            if rg_name not in resource_groups:
                resource_groups[rg_name] = {}
            resource_groups[rg_name][period_label] = (
                resource_groups[rg_name].get(period_label, 0) + total_hours
            )

    # Format output
    result_periods = []
    for period in periods:
        period_entry = {"period": period["label"]}
        for rg_name in resource_groups:
            period_entry[rg_name] = round(resource_groups[rg_name].get(period["label"], 0), 1)
        result_periods.append(period_entry)

    return {
        "periods": result_periods,
        "resource_groups": list(resource_groups.keys()),
        "period_type": period_type,
        "num_periods": num_periods,
    }


def get_revenue_forecast(company_id: str) -> dict:
    """
    Get revenue forecast from the open quote pipeline.
    Sums total_price from quotes with status in (pending_approval, accepted).
    """
    supabase = _get_supabase_service_role()

    response = (
        supabase.table("quotes")
        .select("id, status, total_price, customer_id, customers!left(name)")
        .eq("company_id", company_id)
        .in_("status", ["pending_approval", "accepted"])
        .execute()
    )

    quotes = response.data or []

    # Group by status
    by_status: dict[str, dict] = {}
    for quote in quotes:
        status = quote.get("status", "unknown")
        price = float(quote.get("total_price", 0) or 0)

        if status not in by_status:
            by_status[status] = {"status": status, "total_value": 0.0, "count": 0}
        by_status[status]["total_value"] += price
        by_status[status]["count"] += 1

    # Sort by pipeline stage order
    stage_order = {"accepted": 0, "pending_approval": 1}
    pipeline = sorted(
        by_status.values(),
        key=lambda x: stage_order.get(x["status"], 99),
    )

    for p in pipeline:
        p["total_value"] = round(p["total_value"], 2)

    total_pipeline = sum(p["total_value"] for p in pipeline)

    return {
        "pipeline": pipeline,
        "total_pipeline_value": round(total_pipeline, 2),
        "total_open_quotes": sum(p["count"] for p in pipeline),
    }


# ============================================================
# Tool Execution Dispatcher
# ============================================================

# Map tool names to their implementation functions
TOOL_FUNCTIONS = {
    "get_revenue_by_period": get_revenue_by_period,
    "get_job_status_distribution": get_job_status_distribution,
    "get_quote_conversion_rate": get_quote_conversion_rate,
    "get_job_cycle_times": get_job_cycle_times,
    "get_customer_revenue_breakdown": get_customer_revenue_breakdown,
    "get_part_profitability": get_part_profitability,
    "get_resource_utilization": get_resource_utilization,
    "get_revenue_forecast": get_revenue_forecast,
}


def execute_tool(company_id: str, tool_name: str, tool_input: dict) -> dict:
    """
    Execute a predefined metric tool by name, injecting company_id.
    Used by dashboard cache and as fallback for any predefined chat tools.

    Args:
        company_id: The company UUID
        tool_name: Name of the tool to execute
        tool_input: Parameters from the AI tool call (without company_id)

    Returns:
        The metric data dict from the tool function
    """
    func = TOOL_FUNCTIONS.get(tool_name)
    if not func:
        raise ValueError(f"Unknown tool: {tool_name}")

    return func(company_id=company_id, **tool_input)


async def execute_sql_tool(company_id: str, sql: str, description: str = "") -> dict:
    """
    Execute an AI-generated SQL query via the SQL executor.
    This is the handler for the 'execute_sql' chat tool.

    Args:
        company_id: The company UUID (bound as $1)
        sql: The SELECT query with $1 placeholder
        description: Brief description of what the query computes

    Returns:
        Dict with columns, rows, row_count (or error message)
    """
    from tools.sql_executor import execute_sql_query

    return await execute_sql_query(
        company_id=company_id,
        sql=sql,
        description=description,
    )
