"""
Insights service: metric computation and chat orchestration.

Contains:
1. Metric functions that query Supabase (exposed via chat tool-use)
2. Chat orchestration (execute tool calls, return results)
"""

import logging
import os
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from supabase import Client, create_client

logger = logging.getLogger(__name__)


# INSIDE api/, NOT docs/, AND THAT IS LOAD-BEARING. vercel.json's excludeFiles
# drops docs/** from every api/** function bundle, so the previous
# docs/ai/semantics.md resolved locally and in CI and raised FileNotFoundError on
# Vercel -- insights was down in production until this moved. Resolve relative to
# this package and the file ships with the code that reads it.
SEMANTICS_PATH = Path(__file__).resolve().parent / "ai" / "semantics.md"


@lru_cache(maxsize=1)
def load_semantics() -> str:
    """The business-term definitions, read from the file that also documents them.

    ONE SOURCE, not a copy. These definitions used to be prose inside
    SCHEMA_CONTEXT with a doc describing them separately, and the two drifted --
    which is how three model arms answered "how many jobs are late right now" with
    5, 4 and 0, each defensibly. api/services/ai/semantics.md is rendered straight
    into the prompt, so the document IS the runtime and drift is structurally
    impossible.

    Cached deliberately: the file changes only via PR, and the assembled prompt has
    to be a stable prefix for prompt caching and Ollama KV reuse to hold.
    """
    return SEMANTICS_PATH.read_text(encoding="utf-8").strip()


def _build_chat_system_prompt() -> str:
    """Build the full system prompt for chat interactions with schema context.

    Order is load-bearing: preamble, structure, semantics, guidelines. Everything
    here is static per deploy, so the whole thing is one cacheable prefix and the
    user's question is the only varying part -- and it arrives as a separate turn.

    NO WORKED ANSWER APPEARS ANYWHERE IN HERE, and that is a rule rather than an
    omission. A local arm answered the payroll question by pasting semantics.md's
    model answer back verbatim, placeholders included -- "$X on $Y of revenue, a
    Z% gross margin" -- so every answer-shaped example is gone and the
    instructions say what to do instead. The chart_config block below is the one
    thing that still shows a sample, and it is a machine format the next sentence
    refers to by key name, not prose to imitate.
    """
    from tools.schema_context import SCHEMA_CONTEXT

    return (
        "You are a business analyst for a small precision manufacturing shop.\n"
        "You have access to the execute_sql tool to query the company's PostgreSQL database.\n\n"
        "Use execute_sql to answer questions by writing SELECT queries. "
        "Always use $1 as the company_id placeholder.\n\n"
        f"{SCHEMA_CONTEXT}\n\n"
        f"{load_semantics()}\n\n"
        "Guidelines:\n"
        "- Always use execute_sql to get real data. Never make up numbers.\n"
        "- Only query the tables documented in the schema above. Never reference user, auth, "
        "access-control, or system tables — they are off-limits.\n"
        "- Rows are ALREADY scoped to one company by the executor. Never join an access-control "
        "table to resolve a person or a company, and never add a company filter beyond the "
        "required $1.\n"
        "- A tool result beginning NOT_PERMITTED is FINAL. No rephrasing grants a privilege, so do "
        "not retry that object: answer from the permitted objects, or say the data is unavailable.\n"
        "- For chat responses: be direct and concise. 1-3 sentences max. Shop owners are busy.\n"
        "- Write answers as plain prose. NEVER use markdown tables or pipe (|) / --- column "
        "formatting — they render as raw text in the UI. For multiple values, rely on the "
        "chart_config plus a one-line summary, or a short inline list of name-and-value pairs "
        "separated by commas.\n"
        "- NEVER write a placeholder or a stand-in figure. State a number you computed from a "
        "query result, or say the figure is unavailable — never a template.\n"
        "- If a query fails, fix it using the error and run it again. NEVER report a database "
        "error, a column name or SQL to the user: if you cannot get the figure, say the figure "
        "is unavailable and why, in plain language.\n"
        "- Default to a one-line prose answer. Only add a chart_config when there are at least "
        "3 data points AND a chart genuinely helps: a trend over time, a comparison across several "
        "categories, or a part-of-whole breakdown. For a single fact, a ranked top-N where one "
        "value dominates, or only 1-2 values, answer in prose only — no chart.\n"
        "- When you do chart: area for trends over time, bar for comparisons across categories, "
        "bar_horizontal for ranked lists with long labels, pie for part-of-whole. Never use bold "
        "(**) or any markdown formatting in the answer.\n"
        "- Answer with facts and numbers only. Do not add advice, opinions, or recommendations unless the user asks.\n"
        "- Include comparisons to previous periods when the data supports it: state the actual "
        "change you computed and the period it is measured against.\n"
        "- Flag risks prominently (low inventory, revenue decline).\n"
        "- Use plain language. Avoid jargon. These are machinists, not MBAs.\n"
        "- In SQL, ALWAYS filter by company_id = $1 on tables that have company_id.\n"
        "- For tables without company_id (job_operations, job_parts, job_materials, routing_operations, parts_bom, parts_unit_conversions), JOIN through parent tables.\n\n"
        "chart_config format (include as a ```json code block when applicable):\n"
        "{\n"
        '  "chart_type": "area" | "pie" | "bar" | "bar_horizontal" | "sparkline",\n'
        '  "data": [{"customer": "Acme", "revenue": 7749.24}, {"customer": "Globex", "revenue": 5210}],\n'
        '  "x_key": "customer",\n'
        '  "y_key": "revenue",\n'
        '  "x_label": "Axis Label",\n'
        '  "y_label": "Axis Label"\n'
        "}\n\n"
        "Every key inside the data row objects MUST be exactly the x_key and y_key strings "
        "(here 'customer' and 'revenue'). Emit valid JSON only — no comments or trailing commas."
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


def _job_part_revenue(jp: dict) -> float:
    """Revenue for one job_part: its agreed line total (job_parts.total_price),
    falling back to unit_price * quantity.

    The job_part — NOT the source quote line — is the post-conversion source of
    truth for price/quantity (see job_parts.unit_price/total_price, added by
    migration 20260621162024). Reading it here means realized revenue reflects
    any quantity edited after the job was created, and it avoids over-counting a
    price-options quote's unchosen lines (the conversion picks one line per part,
    but the quote still holds the others).
    """
    tp = jp.get("total_price")
    if tp is not None:
        return float(tp)
    up = jp.get("unit_price")
    qty = jp.get("quantity")
    if up is not None and qty is not None:
        return float(up) * float(qty)
    return 0.0


def _sum_job_parts_revenue(job_parts) -> float:
    """Sum _job_part_revenue across a job's job_parts (tolerates the PostgREST
    single-object-vs-list embedding shape)."""
    if not isinstance(job_parts, list):
        job_parts = [job_parts] if job_parts else []
    return sum(_job_part_revenue(jp) for jp in job_parts if isinstance(jp, dict))


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

    # Realized revenue is the job's own job_parts line totals — the agreed
    # price/quantity that gets invoiced — NOT the source quote lines. Reading
    # job_parts keeps revenue correct after a post-conversion quantity edit and
    # avoids over-counting price-options quotes (see _job_part_revenue).
    # shipped_at is gone from the jobs table — the last ship date now comes
    # from public.job_last_ship_date(jobs.id). Anchored on
    # fulfillment_status = 'fully_shipped' to scope to delivered orders.
    response = (
        supabase.table("jobs")
        .select(
            "id, last_ship_date:job_last_ship_date, "
            "job_parts(total_price, unit_price, quantity)"
        )
        .eq("company_id", company_id)
        .eq("fulfillment_status", "fully_shipped")
        .execute()
    )

    jobs = response.data or []

    def _job_revenue(job: dict) -> float:
        return _sum_job_parts_revenue(job.get("job_parts"))

    # Bucket jobs into periods using the computed last_ship_date helper.
    result = []
    total_revenue = 0.0
    for period in periods:
        period_revenue = 0.0
        for job in jobs:
            last_ship = job.get("last_ship_date")
            if last_ship and period["start"] <= last_ship < period["end"]:
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
    """Get the count of jobs in each production-status category.

    Returns the breakdown over production_status (not_started, in_progress,
    completed, cancelled). Fulfillment is a separate lifecycle and is not
    surfaced in this metric; PR 4 may add a parallel fulfillment-distribution
    insight if customer feedback asks for one.
    """
    supabase = _get_supabase_service_role()

    response = (
        supabase.table("jobs")
        .select("production_status")
        .eq("company_id", company_id)
        .execute()
    )

    jobs = response.data or []

    # Count by production_status
    status_counts: dict[str, int] = {}
    for job in jobs:
        status = job.get("production_status", "unknown")
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

    # Get fully-shipped jobs in the date range, using the SQL helper
    # job_last_ship_date(job_id) in place of the old shipped_at column.
    # PR 4 fills the helper body; PR 3 ships a NULL stub so this returns
    # no rows until shipments exist.
    response = (
        supabase.table("jobs")
        .select("id, created_at, last_ship_date:job_last_ship_date")
        .eq("company_id", company_id)
        .eq("fulfillment_status", "fully_shipped")
        .execute()
    )

    jobs = response.data or []

    result = []
    for period in periods:
        # Jobs shipped in this period. last_ship_date is a date (YYYY-MM-DD)
        # from job_last_ship_date(); the period bounds are date-like strings,
        # so string comparison is correct.
        period_jobs = [
            j for j in jobs
            if j.get("last_ship_date") and period["start"] <= j["last_ship_date"] < period["end"]
        ]

        cycle_times = []
        for job in period_jobs:
            if job.get("created_at") and job.get("last_ship_date"):
                created = datetime.fromisoformat(job["created_at"].replace("Z", "+00:00"))
                # last_ship_date is a date-only string; treat as UTC midnight.
                shipped = datetime.fromisoformat(job["last_ship_date"] + "T00:00:00+00:00")
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

    # Realized revenue is the job's own job_parts line totals (see
    # _job_part_revenue) — not the source quote lines — so it stays correct
    # after a post-conversion quantity edit.
    response = (
        supabase.table("jobs")
        .select(
            "id, customer_id, last_ship_date:job_last_ship_date, "
            "customers!left(name), "
            "job_parts(total_price, unit_price, quantity)"
        )
        .eq("company_id", company_id)
        .eq("fulfillment_status", "fully_shipped")
        .execute()
    )

    jobs = response.data or []

    # Aggregate revenue by customer
    customer_revenue: dict[str, dict] = {}
    for job in jobs:
        customer_name = "Unknown"
        if isinstance(job.get("customers"), dict):
            customer_name = job["customers"].get("name", "Unknown")

        price = _sum_job_parts_revenue(job.get("job_parts"))

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


def _job_part_labor_cost(jp: dict, quantity: float) -> float:
    """Labour cost for one job_part, from the rates FROZEN on its operations.

    The minutes were already frozen at conversion (estimated_setup_minutes,
    estimated_run_minutes_per_unit); migration 20260811233748 froze the rates
    beside them, so nothing here reads a live work_centers.labor_rate.

      in-house: (setup + run × qty) / 60 × labor_rate_snapshot
      outside:  external_unit_price_snapshot × qty

    Which arm applies is read from `vendor_service_id` — the column that says
    what the op targets. It used to be read from `work_center_kind_snapshot`,
    which was a frozen copy of a discriminator that has since been dropped:
    derivable from the target, so keeping it was vestigial.

    An operation missing its rate contributes 0. That is safe rather than
    silent: the job_part's authoritative cost is job_parts.true_cost_per_unit,
    so an under-counted labour split only shifts money into the materials
    remainder — it can never inflate profit.
    """
    ops = jp.get("job_operations") or []
    if not isinstance(ops, list):
        ops = [ops] if ops else []

    total = 0.0
    for op in ops:
        if not isinstance(op, dict):
            continue

        if op.get("vendor_service_id") is not None:
            price = op.get("external_unit_price_snapshot")
            if price is not None:
                total += float(price) * quantity
            continue

        rate = op.get("labor_rate_snapshot")
        if rate is None:
            continue
        setup = float(op.get("estimated_setup_minutes") or 0)
        run = float(op.get("estimated_run_minutes_per_unit") or 0)
        total += (setup + run * quantity) / 60.0 * float(rate)

    return total


def get_part_profitability(company_id: str, limit: int = 10) -> dict:
    """
    Get part profitability analysis from the job's own frozen cost snapshot.

    Walks shipped jobs -> job_parts -> parts and aggregates per part:

      - revenue: SUM(job_parts.total_price) — the agreed line total on the
        job_part, the post-conversion source of truth (see _job_part_revenue).
      - cost: SUM(job_parts.true_cost_per_unit x quantity) — the all-in TRUE
        cost (labour + materials + the whole nested BOM) frozen when the job was
        created, by the trigger in migration 20260811233748.
      - the labour/materials split: labour is rebuilt from the RATES frozen on
        job_operations against the minutes already frozen there; materials are
        the remainder. Materials are deliberately not snapshot per BOM line —
        costing one line needs the unit conversion, the whole-unit ceiling and
        the made-vs-bought valuation rule, all of which live inside
        part_rollup_at_qty. See that migration's header.

    Nothing here reads a live rate. Raising a work-centre rate today does not
    move the profit of a job that shipped last year — which is the whole point,
    and was not true before: this function used to recompute labour from
    work_centers.labor_rate every call, and had no way to charge materials at
    all, so every bought part was free.

    A job_part whose true_cost_per_unit is NULL could not be costed when it was
    created (incomplete part costing). It is EXCLUDED and reported in
    `excluded_job_parts`, never folded in at zero cost — that would silently
    overstate profit, which is worse than admitting a gap.

    Uses estimated time, not actual: nothing records how long an operation
    really took (job_operation_completions carries quantity_good and a
    timestamp, no duration). Estimated-vs-actual is a separate question.
    """
    supabase = _get_supabase_service_role()

    # Snapshots only — no work_centers or routing_operations embed. Besides
    # being the point of the change, that embed is why this function returned
    # HTTP 400 from 2026-06-23 (when routing_operations.external_setup_cost was
    # dropped by migration 20260623022617) until this rewrite: PostgREST rejects
    # a select naming a column that no longer exists.
    response = (
        supabase.table("jobs")
        .select(
            "id, "
            "job_parts(id, part_id, quantity, total_price, unit_price, "
            "true_cost_per_unit, "
            "parts!job_parts_part_id_fkey(part_name, description), "
            "job_operations(estimated_setup_minutes, estimated_run_minutes_per_unit, "
            "vendor_service_id, labor_rate_snapshot, "
            "external_unit_price_snapshot))"
        )
        .eq("company_id", company_id)
        .is_("deleted_at", "null")
        .eq("fulfillment_status", "fully_shipped")
        .execute()
    )

    jobs = response.data or []

    part_data: dict[str, dict] = {}
    excluded_job_parts = 0

    for job in jobs:
        job_parts = job.get("job_parts") or []
        if not isinstance(job_parts, list):
            job_parts = [job_parts]

        for jp in job_parts:
            if not isinstance(jp, dict):
                continue
            part_id = jp.get("part_id")
            if not part_id:
                continue

            true_cost_per_unit = jp.get("true_cost_per_unit")
            if true_cost_per_unit is None:
                # "We could not tell" is not "it was free."
                excluded_job_parts += 1
                continue

            quantity = float(jp.get("quantity") or 0)

            if part_id not in part_data:
                part_info = jp.get("parts") or {}
                if isinstance(part_info, list) and part_info:
                    part_info = part_info[0]
                part_data[part_id] = {
                    "part_name": part_info.get("part_name", "Unknown"),
                    "description": part_info.get("description", ""),
                    "total_revenue": 0.0,
                    "total_cost": 0.0,
                    "total_labor_cost": 0.0,
                    "job_part_count": 0,
                }

            data = part_data[part_id]
            data["total_revenue"] += _job_part_revenue(jp)
            data["total_cost"] += float(true_cost_per_unit) * quantity
            data["total_labor_cost"] += _job_part_labor_cost(jp, quantity)
            data["job_part_count"] += 1

    parts_list = []
    for data in part_data.values():
        revenue = data["total_revenue"]
        cost = data["total_cost"]
        labor_cost = data["total_labor_cost"]
        # Materials by subtraction from the authoritative total. Exact by
        # construction, and impossible to drift from the rollup.
        material_cost = cost - labor_cost
        profit = revenue - cost
        margin = (profit / revenue * 100) if revenue > 0 else 0.0

        parts_list.append({
            "part_name": data["part_name"],
            "description": data["description"],
            "revenue": round(revenue, 2),
            "cost": round(cost, 2),
            "labor_cost": round(labor_cost, 2),
            "material_cost": round(material_cost, 2),
            "profit": round(profit, 2),
            "margin_pct": round(margin, 1),
            "job_count": data["job_part_count"],
        })

    parts_list.sort(key=lambda x: x["profit"], reverse=True)

    return {
        "parts": parts_list[:limit],
        "total_parts_analyzed": len(parts_list),
        "excluded_job_parts": excluded_job_parts,
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
