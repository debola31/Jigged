# Business term semantics for the insights AI

This file is documentation and runtime in one: `_build_chat_system_prompt()` in
[`api/services/insights_service.py`](../../api/services/insights_service.py) renders it into the
system prompt, and there is no second copy in Python. Every SQL block below runs under
`jigged_ai_readonly` with `LIMIT 1` on every CI run, so a definition the sandbox cannot execute fails
the build rather than a shop owner. Change it only in a PR: the assembled prompt is a cached prefix,
and prompt caching plus Ollama KV reuse depend on it not varying per request.

## How to use these definitions

Use the definition here even when another reading seems reasonable. When a question uses a term that
is not here, say which reading you took.

- `$1` is the company id, bound by the executor. Rows are already scoped to one company: never join
  an access-control table or add a company filter beyond the required `company_id = $1`.
- `$2` is today's date, the caller's local calendar date, and the only clock you have: `CURRENT_DATE`,
  `now()` and `CURRENT_TIMESTAMP` are refused, because this database runs in UTC and is already
  tomorrow for the last hours of every working day in the Americas. Build every relative window from
  `$2`, and write `$2::date` wherever the expression does not already fix the type:
  `DATE_TRUNC('quarter', $2)` is ambiguous and `$2 - INTERVAL '6 months'` fails outright. Inside
  `public.is_job_late(...)` the position declares the type, so a bare `$2` is fine there.
- Archived rows are already gone: the connection filters every table to `deleted_at IS NULL`, so never
  write that clause. It also means you cannot answer questions about archived work; say so plainly
  rather than reporting zero.
- All `TIMESTAMPTZ` columns are UTC.

---

## Late job

**Definition.** A job past its promised date that is not yet in the customer's hands. Work that is
finished but still on the bench counts as late: delivery is the promise.

```sql
SELECT COUNT(*) AS late_jobs
FROM jobs
WHERE company_id = $1
  AND public.is_job_late(due_date, production_status, fulfillment_status, $2)
```

Call the function; never spell the rule out inline. `public.is_job_late()` is the object the jobs list
uses, so an answer from it is the number on the screen, and hand-written clauses once reported 7 late
jobs where the dashboard showed 6. It composes anywhere a boolean does:

```sql
SELECT customer_name, COUNT(*) AS late_jobs
FROM jobs
WHERE company_id = $1
  AND public.is_job_late(due_date, production_status, fulfillment_status, $2)
GROUP BY customer_name
ORDER BY late_jobs DESC
```

**Notes.** `due_date` is a DATE, so late flips at midnight and a job due today is not late. A job with
no `due_date` is never late; cancelled jobs are excluded because nobody is waiting for them.

---

## This quarter, and other relative periods

**Definition.** Calendar periods, from the first day through today. There is no fiscal-year setting
anywhere in the schema, so calendar is the only reading that can be computed rather than invented.

```sql
SELECT COUNT(*) AS jobs_this_quarter
FROM jobs
WHERE company_id = $1
  AND created_at >= DATE_TRUNC('quarter', $2::date)
```

**Every relative period is an expression on `$2::date`. Build it; never estimate it.** A current
period runs from its first day to today; a completed period is the half-open range from its first
day to the next period's first day; "last N days" is `>= $2::date - INTERVAL 'N days'`; a month named
without a year is the most recent one on or before today (asked in September, "June" is this year's
and "November" is last year's). This block defines each one and runs in CI:

```sql
SELECT COUNT(*) FILTER (WHERE created_at >= $2::date) AS today,
       COUNT(*) FILTER (WHERE created_at >= $2::date - INTERVAL '1 day'
                          AND created_at <  $2::date) AS yesterday,
       COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('week', $2::date)) AS this_week,
       COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('week', $2::date) - INTERVAL '7 days'
                          AND created_at <  DATE_TRUNC('week', $2::date)) AS last_week,
       COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', $2::date)) AS this_month,
       COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', $2::date) - INTERVAL '1 month'
                          AND created_at <  DATE_TRUNC('month', $2::date)) AS last_month,
       COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('quarter', $2::date) - INTERVAL '3 months'
                          AND created_at <  DATE_TRUNC('quarter', $2::date)) AS last_quarter,
       COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('year', $2::date)) AS this_year,
       COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('year', $2::date) - INTERVAL '1 year'
                          AND created_at <  DATE_TRUNC('year', $2::date)) AS last_year,
       COUNT(*) FILTER (WHERE created_at >= $2::date - INTERVAL '30 days') AS last_30_days,
       COUNT(*) FILTER (WHERE created_at >= MAKE_DATE(EXTRACT(YEAR FROM $2::date)::int
                                - CASE WHEN EXTRACT(MONTH FROM $2::date) < 6 THEN 1 ELSE 0 END, 6, 1)
                          AND created_at <  MAKE_DATE(EXTRACT(YEAR FROM $2::date)::int
                                - CASE WHEN EXTRACT(MONTH FROM $2::date) < 6 THEN 1 ELSE 0 END, 6, 1)
                                        + INTERVAL '1 month') AS june_most_recent
FROM jobs
WHERE company_id = $1
```

**Notes.** Weeks start on Monday. "Last month versus the month before" compares two completed ranges,
`last_month` and the month before it, never a partial current month against a full one. Say so when a
period is partial: on 26 August "this quarter" is eight weeks, and set against a full quarter it looks
like a downturn that is not there.

---

## Job value

**Definition.** The agreed value of the work on a job, dated by `jobs.created_at`: what was sold,
whether or not it has shipped.

```sql
SELECT AVG(job_value) AS average_job_value
FROM (
  SELECT j.id, SUM(jp.total_price) AS job_value
  FROM jobs j
  JOIN job_parts jp ON jp.job_id = j.id
  WHERE j.company_id = $1
    AND j.created_at >= DATE_TRUNC('quarter', $2::date)
  GROUP BY j.id
) per_job
```

**Average job value aggregates twice, and the order is the definition.** Sum `job_parts.total_price`
per job first, then average those per-job totals across jobs: a job is one sale, a job part is a line
on it. A single-level `AVG(jp.total_price)` averages lines, not jobs, and is systematically lower; on
the Gate 2 data it returned $3,038.04 where the correct figure is $4,774.82, and three local models
produced exactly that number while describing the right method in prose. Nearly every new job has one
part, which makes the two forms agree for new work and the error smaller and harder to notice, not
absent. Only the average has this grain problem; every `SUM` over `job_parts` is unaffected.

**Notes.** Use `job_parts.total_price`, never the source quote line: `quantity` and `unit_price` on
the job part are the post-conversion truth, and a price-options quote keeps unchosen lines. A job with
no parts has no value and is not in the denominator, which the `JOIN` already handles.

---

## Revenue

**Definition.** Realised revenue: only what actually shipped, dated by `shipments.ship_date`, voided
slips excluded. A booked job is not revenue until it goes out the door.

```sql
SELECT DATE_TRUNC('month', s.ship_date)::date AS month,
       SUM(sli.quantity * jp.unit_price) AS revenue
FROM shipments s
JOIN shipment_line_items sli ON sli.shipment_id = s.id
JOIN job_parts jp ON jp.id = sli.job_part_id
WHERE s.company_id = $1
  AND s.voided_at IS NULL
GROUP BY 1
ORDER BY 1
```

Revenue reads these three tables and these columns, and nothing else is revenue:

| Table | Columns revenue uses | For |
|---|---|---|
| `shipments` | `id`, `ship_date`, `company_id`, `voided_at` | when it shipped, whose it is, whether the slip stands |
| `shipment_line_items` | `quantity`, `shipment_id`, `job_part_id` | how many actually went out |
| `job_parts` | `id`, `unit_price` | what one unit sold for |

**`job_parts.total_price` is not a revenue column; it is the job-value column.** Revenue is
`shipment_line_items.quantity × job_parts.unit_price`, so a part half shipped contributes half, and
summing `total_price` over shipments double-counts a line shipped in two batches.

Top customer by revenue is the same three tables with `jobs` joined on. Start from `shipments`, never
from `job_parts`:

```sql
SELECT j.customer_name AS customer,
       SUM(sli.quantity * jp.unit_price) AS revenue
FROM shipments s
JOIN shipment_line_items sli ON sli.shipment_id = s.id
JOIN job_parts jp ON jp.id = sli.job_part_id
JOIN jobs j ON j.id = jp.job_id
WHERE s.company_id = $1
  AND s.voided_at IS NULL
GROUP BY j.customer_name
ORDER BY revenue DESC
```

**Group by `jobs.customer_name`, the snapshot on the job, not by a join to `customers`.** Archived rows
are hidden from this connection, so an inner join to `customers` silently drops every job whose
customer has since been archived. Join `customers` only for something the snapshot lacks (an address,
a contact), knowing you are then asking only about live customers. Group by the name, never an id.

**Notes.** "Revenue trend" and "top customer by revenue" use this, not job value, or a large order
booked today inflates today and never corrects. `shipments` is readable by column only: list the
columns you need, `SELECT *` on it is not available. For the last ship date of one job use
`public.job_last_ship_date(job_id)`, which already excludes voided slips.

---

## Dormant customer

**Definition.** A customer who has ordered before and not within the window. Ordering means a job,
not a quote: a prospect who only asked for prices was never a customer to lose.

```sql
SELECT c.id, c.name
FROM customers c
WHERE c.company_id = $1
  AND EXISTS (
    SELECT 1 FROM jobs j WHERE j.customer_id = c.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.customer_id = c.id
       AND j.created_at >= $2::date - INTERVAL '6 months'
  )
```

**Notes.** Substitute the window the question asks for. The first `EXISTS` keeps quote-only prospects
out of a "customers we have lost" answer.

---

## Quote pipeline worth

**Definition.** The value of quotes still genuinely in play: active, unexpired, not yet converted.

```sql
SELECT COALESCE(SUM(qli.total_price), 0) AS pipeline_worth
FROM quotes q
JOIN quote_line_items qli ON qli.quote_id = q.id
WHERE q.company_id = $1
  AND q.status = 'active'
  AND q.expiration_date >= $2::date
  AND NOT EXISTS (
    SELECT 1 FROM jobs j WHERE j.quote_id = q.id
  )
```

**Notes.** An expired quote is not pipeline. A converted quote's value is now a job, and counting both
double-counts the same work. Say what "pipeline" counted when you answer.

---

## Quote-to-job conversion

**Definition.** A quote is converted when a job references it via `jobs.quote_id`. The rate is
conversions divided by quotes created in the window.

```sql
SELECT COUNT(*) FILTER (WHERE converted) AS converted,
       COUNT(*) AS quotes_created,
       ROUND(100.0 * COUNT(*) FILTER (WHERE converted) / NULLIF(COUNT(*), 0), 1) AS pct
FROM (
  SELECT q.id,
         EXISTS (
           SELECT 1 FROM jobs j WHERE j.quote_id = q.id
         ) AS converted
  FROM quotes q
  WHERE q.company_id = $1
    AND q.created_at >= $2::date - INTERVAL '90 days'
) t
```

**Notes.** State the denominator. A quote created inside the window that converts next month counts as
unconverted here, so a short window understates the rate; say so. "How many quotes turned into jobs in
the last 90 days" can mean this rate's numerator or the conversions that happened in the window
(`quotes.converted_at`); pick one and say which.

---

## Started and shipped

**Definition.** A job is started when `started_at IS NOT NULL` or `production_status = 'in_progress'`,
and shipped when `fulfillment_status = 'fully_shipped'`.

```sql
SELECT COUNT(*) FILTER (WHERE started_at IS NOT NULL OR production_status = 'in_progress') AS started,
       COUNT(*) FILTER (WHERE fulfillment_status = 'fully_shipped') AS shipped
FROM jobs
WHERE company_id = $1
```

**Notes.** There is no `jobs.shipped_at`. `partially_shipped` is neither shipped nor unshipped; count
it explicitly when the question turns on it.

---

## Cost, and what it does and does not include

**Definition.** `job_parts.true_cost_per_unit` is the all-in cost of one unit (labour, materials, the
whole nested BOM), frozen when the job part was created and re-taken only when its quantity changes.

```sql
SELECT SUM(jp.total_price) AS revenue_booked,
       SUM(jp.true_cost_per_unit * jp.quantity) AS cost,
       SUM(jp.total_price) - SUM(jp.true_cost_per_unit * jp.quantity) AS gross_profit
FROM job_parts jp
JOIN jobs j ON j.id = jp.job_id
WHERE j.company_id = $1
  AND jp.true_cost_per_unit IS NOT NULL
```

**Notes.** Never recompute cost from a part's current routing or rates; a shipped job's profit would
move whenever a rate changed. `NULL` means the cost could not be determined: exclude that job part and
say you did, never treat it as zero. Labour inside this figure is costed at standard rates, not at
what anyone was paid.

---

## When the data is not there

**Rule.** When the data a question needs is not in the permitted objects, say plainly that Jigged does
not track it, name the nearest available figures, and never substitute a proxy without labelling it
as one. A confident wrong number is worse than no number: the shop owner cannot tell them apart and
will act on it.

### Payroll

Jigged holds no payroll, wage, salary or hours-paid data, and no column stands in for it.
`job_parts.true_cost_per_unit` is not payroll: it is an all-in job cost with labour at standard rates,
applied only to booked job parts. So "net profit margin after payroll" cannot be calculated here; say
so. Gross profit (booked revenue minus all-in job cost) may be offered instead, only with figures a
query actually returned and only labelled as costing labour at standard rates.

**Never write a placeholder.** `$X`, `Z%`, `<number>` and every other stand-in read as a figure the
shop owner cannot check. State a number you computed, or decline.
