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
        "- For tables without company_id (job_operations, job_parts, job_materials, routing_operations, parts_bom, parts_unit_conversions), JOIN through parent tables.\n\n"
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

    # Quotes no longer carry total_price; sum each quote's line items via the
    # quote_line_items join. One job → one quote → many line items.
    response = (
        supabase.table("jobs")
        .select(
            "id, shipped_at, "
            "quotes!jobs_quote_id_fkey(quote_line_items(total_price))"
        )
        .eq("company_id", company_id)
        .eq("status", "shipped")
        .gte("shipped_at", start_date)
        .lt("shipped_at", end_date)
        .execute()
    )

    jobs = response.data or []

    def _job_revenue(job: dict) -> float:
        quote = job.get("quotes")
        if isinstance(quote, list):
            quote = quote[0] if quote else None
        if not isinstance(quote, dict):
            return 0.0
        line_items = quote.get("quote_line_items") or []
        return sum(float(li.get("total_price", 0) or 0) for li in line_items)

    # Bucket jobs into periods
    result = []
    total_revenue = 0.0
    for period in periods:
        period_revenue = 0.0
        for job in jobs:
            if job.get("shipped_at") and period["start"] <= job["shipped_at"] < period["end"]:
                period_revenue += _job_revenue(job)
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

    # Quotes no longer carry total_price; sum each quote's line items.
    response = (
        supabase.table("jobs")
        .select(
            "id, customer_id, shipped_at, "
            "customers!left(name), "
            "quotes!jobs_quote_id_fkey(quote_line_items(total_price))"
        )
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

        quote = job.get("quotes")
        if isinstance(quote, list):
            quote = quote[0] if quote else None
        line_items = (quote or {}).get("quote_line_items") or []
        price = sum(float(li.get("total_price", 0) or 0) for li in line_items)

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
    Get part profitability analysis on the unified parts schema.

    Walks shipped jobs → job_parts → parts and aggregates per part:
      - revenue: SUM(quote_line_items.total_price) from each job_part's
        source_quote_line_item (jobs no longer carry a single price; the
        quote line item is the per-part revenue source).
      - labor_cost: SUM over each job_operation belonging to that job_part:
          * For internal work centers (work_centers.kind = 'internal'):
              labor_rate = COALESCE(routing_operations.labor_rate_override,
                                    work_centers.labor_rate)
              cost = (estimated_setup_minutes
                      + estimated_run_minutes_per_unit * job_part.quantity)
                     / 60.0 * labor_rate
              If both override and default are NULL we cannot price the op
              and RAISE — matching compute_part_cost_at_qty's
              no-silent-fallback behavior.
          * For external work centers (kind = 'external'):
              cost = external_unit_price * quantity + external_setup_cost
              Read from routing_operations (the immutable source); job_operations
              don't carry external pricing snapshots.
    """
    supabase = _get_supabase_service_role()

    # Walk jobs → job_parts → parts → job_operations → work_centers.
    # job_operations.routing_operation_id lets us read the override / external
    # pricing fields the operator never sees but the cost contract requires.
    response = (
        supabase.table("jobs")
        .select(
            "id, "
            "job_parts(id, part_id, quantity, source_quote_line_item_id, "
            "parts!job_parts_part_id_fkey(part_name, description), "
            "quote_line_items!job_parts_source_quote_line_item_id_fkey(total_price), "
            "job_operations(estimated_setup_minutes, estimated_run_minutes_per_unit, "
            "work_centers!left(kind, labor_rate), "
            "routing_operations!left(labor_rate_override, external_unit_price, "
            "external_setup_cost)))"
        )
        .eq("company_id", company_id)
        .eq("status", "shipped")
        .execute()
    )

    jobs = response.data or []

    # Aggregate by part_id
    part_data: dict[str, dict] = {}
    for job in jobs:
        job_parts = job.get("job_parts") or []
        if not isinstance(job_parts, list):
            job_parts = [job_parts]

        for jp in job_parts:
            part_id = jp.get("part_id")
            if not part_id:
                continue

            quantity = int(jp.get("quantity", 1) or 1)

            if part_id not in part_data:
                part_info = jp.get("parts") or {}
                if isinstance(part_info, list) and part_info:
                    part_info = part_info[0]
                part_data[part_id] = {
                    "part_name": part_info.get("part_name", "Unknown"),
                    "description": part_info.get("description", ""),
                    "total_revenue": 0.0,
                    "total_labor_cost": 0.0,
                    "job_part_count": 0,
                }

            # Revenue: from the quote_line_item this job_part was created from.
            # If unlinked (manual job_part with no quote origin), revenue is 0.
            qli = jp.get("quote_line_items")
            if isinstance(qli, list) and qli:
                qli = qli[0]
            if isinstance(qli, dict):
                part_data[part_id]["total_revenue"] += float(
                    qli.get("total_price", 0) or 0
                )

            # Labor cost: per-operation rollup using the cost contract.
            operations = jp.get("job_operations") or []
            if isinstance(operations, list):
                for op in operations:
                    wc = op.get("work_centers") or {}
                    if isinstance(wc, list) and wc:
                        wc = wc[0]
                    ro = op.get("routing_operations") or {}
                    if isinstance(ro, list) and ro:
                        ro = ro[0]

                    kind = wc.get("kind") if isinstance(wc, dict) else None

                    if kind == "external":
                        # External op: priced from the routing_operation row
                        # (the source-of-truth for external pricing). Treat
                        # missing pricing as zero contribution from this op
                        # rather than raising — a job that shipped is history,
                        # not a cost recalc context.
                        unit_price = float(
                            (ro.get("external_unit_price") if isinstance(ro, dict) else 0)
                            or 0
                        )
                        setup_cost = float(
                            (ro.get("external_setup_cost") if isinstance(ro, dict) else 0)
                            or 0
                        )
                        op_cost = unit_price * quantity + setup_cost
                    else:
                        # Internal op (or unknown — treat as internal).
                        # estimated_setup_minutes + estimated_run_minutes_per_unit * qty
                        # are minutes; divide by 60 before multiplying by the
                        # per-hour labor rate.
                        setup_minutes = float(
                            op.get("estimated_setup_minutes", 0) or 0
                        )
                        run_minutes_per_unit = float(
                            op.get("estimated_run_minutes_per_unit", 0) or 0
                        )
                        total_minutes = setup_minutes + (run_minutes_per_unit * quantity)
                        total_hours = total_minutes / 60.0

                        # Cost contract: COALESCE(labor_rate_override, wc.labor_rate).
                        # Both NULL = no rate available for this op; raise rather
                        # than silently treating as $0.
                        override = (
                            ro.get("labor_rate_override")
                            if isinstance(ro, dict)
                            else None
                        )
                        wc_rate = wc.get("labor_rate") if isinstance(wc, dict) else None
                        if override is None and wc_rate is None:
                            raise RuntimeError(
                                f"Cannot compute labor cost for job_part {jp.get('id')}: "
                                f"routing op has no labor rate (neither override nor "
                                f"work_center default). Set a rate before re-running "
                                f"profitability."
                            )
                        labor_rate = float(override if override is not None else wc_rate)
                        op_cost = total_hours * labor_rate

                    part_data[part_id]["total_labor_cost"] += op_cost

            part_data[part_id]["job_part_count"] += 1

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
            "job_count": data["job_part_count"],
        })

    parts_list.sort(key=lambda x: x["profit"], reverse=True)

    return {
        "parts": parts_list[:limit],
        "total_parts_analyzed": len(parts_list),
    }


def get_revenue_forecast(company_id: str) -> dict:
    """
    Get revenue forecast from the open quote pipeline.

    "Open" = quotes that are still active (status='active') and have not yet
    been converted to a job (converted_at IS NULL). The simplified quote
    lifecycle (active|expired) means there's a single status worth surfacing
    in the forecast, so we collapse the prior multi-stage breakdown into one
    "open" bucket. Sums each quote's line item totals via the quote_line_items
    join (quotes no longer carry a denormalized total_price).
    """
    supabase = _get_supabase_service_role()

    response = (
        supabase.table("quotes")
        .select(
            "id, status, customer_id, "
            "customers!left(name), "
            "quote_line_items(total_price)"
        )
        .eq("company_id", company_id)
        .eq("status", "active")
        .is_("converted_at", "null")
        .execute()
    )

    quotes = response.data or []

    open_total = 0.0
    open_count = 0
    for quote in quotes:
        line_items = quote.get("quote_line_items") or []
        price = sum(float(li.get("total_price", 0) or 0) for li in line_items)
        open_total += price
        open_count += 1

    pipeline = [
        {"status": "open", "total_value": round(open_total, 2), "count": open_count}
    ]

    total_pipeline = open_total

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
