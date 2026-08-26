# Business term semantics for the insights AI

**This file is documentation and runtime in one.** `_build_chat_system_prompt()` in
[`api/services/insights_service.py`](../../api/services/insights_service.py) loads and renders it
into the system prompt. There is no second copy of these definitions in Python — that is the whole
point, because there used to be, and the two drifted.

**Why it exists.** The Gate 1 eval asked three model arms the same questions and got confidently
different numbers: *"how many jobs are late right now?"* returned 5, 4 and 0; *"average job value
this quarter"* returned $5,447 and $3,044. None of the arms was reasoning badly. The terms were
simply undefined, so each one picked a reasonable reading and stated the result as fact.

**Every SQL block below is executed with `LIMIT 1` under `jigged_ai_readonly` on every CI run**, so a
definition that references a column or table the sandbox cannot read fails the build rather than
failing a shop owner.

**Editing rules.** Change this file only in a PR. The assembled prompt is a stable prefix, and
prompt caching plus Ollama KV reuse depend on it not varying per request.

---

## How to use these definitions

When a question uses one of these terms, use the definition here **even if another reading seems
reasonable**. When a question uses a term that is *not* here, say which reading you took.

`$1` is the company id and the executor binds it. **Rows are already scoped to one company** — never
join an access-control table and never add a company filter beyond the required `$1`.

---

## Late job

**Definition.** A job past its promised date that is not yet in the customer's hands. Work that is
finished but still sitting on the bench **counts as late** — delivery is the promise.

```sql
SELECT COUNT(*) AS late_jobs
FROM jobs
WHERE company_id = $1
  AND deleted_at IS NULL
  AND due_date < CURRENT_DATE
  AND fulfillment_status <> 'fully_shipped'
  AND production_status <> 'cancelled'
```

**Notes.** `due_date` is a DATE, so "late" flips at midnight, not on a rolling 24 hours. A job with
no `due_date` is never late — we never promised. Cancelled jobs are excluded because nobody is
waiting for them.

---

## This quarter, and other relative periods

**Definition.** The **calendar** quarter, from its first day through today. There is no fiscal-year
setting anywhere in the schema, so calendar is the only reading that can be computed rather than
invented.

```sql
SELECT COUNT(*) AS jobs_this_quarter
FROM jobs
WHERE company_id = $1
  AND deleted_at IS NULL
  AND created_at >= DATE_TRUNC('quarter', CURRENT_DATE)
```

**Notes.** "Last quarter" is the preceding `DATE_TRUNC('quarter', …)` window; "this month" and "last
month" follow the same shape with `'month'`. **Say so when a period is partial** — on 26 August,
"this quarter" is about eight weeks, and comparing it to a full previous quarter looks like a
downturn that is not there. All `TIMESTAMPTZ` columns are UTC.

---

## Job value

**Definition.** The **agreed** value of the work on a job, dated by `jobs.created_at`. This is what
was sold, whether or not it has shipped.

```sql
SELECT AVG(job_value) AS average_job_value
FROM (
  SELECT j.id, SUM(jp.total_price) AS job_value
  FROM jobs j
  JOIN job_parts jp ON jp.job_id = j.id
  WHERE j.company_id = $1
    AND j.deleted_at IS NULL
    AND j.created_at >= DATE_TRUNC('quarter', CURRENT_DATE)
  GROUP BY j.id
) per_job
```

**Average job value aggregates twice, and the order is the whole definition.** Sum
`job_parts.total_price` **per job** first, then average those per-job totals **across jobs**. A job
is one sale; a job part is a line on it. Averaging the part rows directly answers a different
question — the average value of a *line* — and it is systematically lower, because jobs with more
lines pull the mean toward their own line size rather than counting once each.

The subquery above is not stylistic. `GROUP BY j.id` produces one row per job, and the outer
`AVG(job_value)` runs over those rows. **A single-level `AVG(jp.total_price)` is wrong**: on the
Gate 2 data it returns **$3,038.04** where the correct figure is **$4,774.82**, and three local
models and an eval arm all produced exactly that number. One of them then described its own method
as "summing the total price of all job parts and dividing by the number of jobs" — the right grain
in prose, the wrong one in SQL, which is why the two-level shape is spelled out here rather than
left to the reference query to imply.

**Notes.** Use `job_parts.total_price`, never the source quote line. `job_parts.quantity` and
`unit_price` are the post-conversion source of truth — a quantity edited after conversion shows here
— and a price-options quote keeps unchosen lines that would over-count. A job with no job parts has
no value and does not belong in the denominator, which the `JOIN` already handles.

---

## Revenue

**Definition.** **Realised** revenue: only what actually shipped, dated by `shipments.ship_date`,
voided slips excluded. A booked job is not revenue until it goes out the door.

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

**Revenue reads these three tables and these columns, and nothing else is revenue.** Listed rather
than counted — a hand-maintained count in a doc is the thing that rots, and the one that used to
open this paragraph said "four columns" above a table of seven.

| Table | Columns revenue uses | For |
|---|---|---|
| `shipments` | `id`, `ship_date`, `company_id`, `voided_at` | when it shipped, whose it is, whether the slip stands |
| `shipment_line_items` | `quantity`, `shipment_id`, `job_part_id` | **how many actually went out** |
| `job_parts` | `id`, `unit_price` | what one unit sold for |

Join keys are in the list on purpose: the point of naming them is that the query above can be
written from this table alone, without going back to the schema section for what joins to what.

**`job_parts.total_price` is NOT a revenue column — it is the job-value column**, and borrowing it
here is the most common way to get this wrong. `total_price` is the whole agreed line, booked
whether or not anything shipped; revenue is `shipment_line_items.quantity × job_parts.unit_price`,
so a part half shipped contributes half. Summing `total_price` over shipments also double-counts a
line that shipped in two batches, because the line total is repeated on every slip that touches it.

**Top customer by revenue** is the same three tables with `jobs` and `customers` joined on. Start
from `shipments`, never from `job_parts`:

```sql
SELECT c.name AS customer,
       SUM(sli.quantity * jp.unit_price) AS revenue
FROM shipments s
JOIN shipment_line_items sli ON sli.shipment_id = s.id
JOIN job_parts jp ON jp.id = sli.job_part_id
JOIN jobs j ON j.id = jp.job_id
JOIN customers c ON c.id = j.customer_id
WHERE s.company_id = $1
  AND s.voided_at IS NULL
  AND c.deleted_at IS NULL
GROUP BY c.name
ORDER BY revenue DESC
```

Group by the customer's **name**, not `c.id` — name is identity here, and the id is not something to
put in front of a shop owner.

**Notes.** "Revenue trend over time" and "top customer by revenue" both use this, not job value —
otherwise a large order booked today inflates today and never corrects. `shipments` is readable by
column: **list the columns you need, `SELECT *` on it is not available.** For the last ship date of
a single job use `public.job_last_ship_date(job_id)`, which already excludes voided slips.

---

## Dormant customer

**Definition.** A customer who has ordered before and has not ordered within the window. Ordering
means a **job**, not a quote — a prospect who only ever asked for prices was never a customer to
lose.

```sql
SELECT c.id, c.name
FROM customers c
WHERE c.company_id = $1
  AND c.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM jobs j WHERE j.customer_id = c.id AND j.deleted_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.customer_id = c.id
       AND j.deleted_at IS NULL
       AND j.created_at >= CURRENT_DATE - INTERVAL '6 months'
  )
```

**Notes.** Substitute the window the question asks for. The first `EXISTS` is what keeps quote-only
prospects out of a "customers we have lost" answer.

---

## Quote pipeline worth

**Definition.** The value of quotes still genuinely in play: active, unexpired, and not yet
converted to a job.

```sql
SELECT COALESCE(SUM(qli.total_price), 0) AS pipeline_worth
FROM quotes q
JOIN quote_line_items qli ON qli.quote_id = q.id
WHERE q.company_id = $1
  AND q.deleted_at IS NULL
  AND q.status = 'active'
  AND q.expiration_date >= CURRENT_DATE
  AND NOT EXISTS (
    SELECT 1 FROM jobs j WHERE j.quote_id = q.id AND j.deleted_at IS NULL
  )
```

**Notes.** Expired quotes are excluded — an expired quote is not pipeline. Converted quotes are
excluded because their value is now a job, and counting both double-counts the same work.

---

## Quote-to-job conversion

**Definition.** A quote is converted when a job references it via `jobs.quote_id`. The rate is
conversions divided by quotes **created** in the window.

```sql
SELECT COUNT(*) FILTER (WHERE converted) AS converted,
       COUNT(*) AS quotes_created,
       ROUND(100.0 * COUNT(*) FILTER (WHERE converted) / NULLIF(COUNT(*), 0), 1) AS pct
FROM (
  SELECT q.id,
         EXISTS (
           SELECT 1 FROM jobs j WHERE j.quote_id = q.id AND j.deleted_at IS NULL
         ) AS converted
  FROM quotes q
  WHERE q.company_id = $1
    AND q.deleted_at IS NULL
    AND q.created_at >= CURRENT_DATE - INTERVAL '90 days'
) t
```

**Notes.** State the denominator when you answer. A quote created inside the window that converts
next month is counted as unconverted here, so a short window understates the rate — say so rather
than presenting the number bare. `quotes.converted_at` records when conversion happened, if the
question is about conversion *timing* rather than rate.

---

## Started and shipped

**Definition.** A job is **started** when `started_at IS NOT NULL` or
`production_status = 'in_progress'`. A job is **shipped** when
`fulfillment_status = 'fully_shipped'`.

```sql
SELECT COUNT(*) FILTER (WHERE started_at IS NOT NULL OR production_status = 'in_progress') AS started,
       COUNT(*) FILTER (WHERE fulfillment_status = 'fully_shipped') AS shipped
FROM jobs
WHERE company_id = $1
  AND deleted_at IS NULL
```

**Notes.** There is no `jobs.shipped_at` column. `partially_shipped` is neither shipped nor
unshipped — count it explicitly if the question turns on it.

---

## Cost, and what it does and does not include

**Definition.** `job_parts.true_cost_per_unit` is the all-in cost of one unit — labour, materials and
the whole nested BOM — **frozen** when the job part was created and re-taken only when its quantity
changes.

```sql
SELECT SUM(jp.total_price) AS revenue_booked,
       SUM(jp.true_cost_per_unit * jp.quantity) AS cost,
       SUM(jp.total_price) - SUM(jp.true_cost_per_unit * jp.quantity) AS gross_profit
FROM job_parts jp
JOIN jobs j ON j.id = jp.job_id
WHERE j.company_id = $1
  AND j.deleted_at IS NULL
  AND jp.true_cost_per_unit IS NOT NULL
```

**Notes.** Never recompute cost from a part's current routing or rates — a shipped job's profit would
move whenever a rate changed. **`NULL` means the cost could not be determined: exclude that job part
and say you did. Never treat `NULL` as zero cost.** Labour inside this figure is costed at
**standard rates**, not at what anyone was actually paid.

---

## When the data is not there

**Rule.** When the data a question needs is not in the permitted objects, say plainly that Jigged
does not track it, name the nearest available figures, and **never substitute a proxy without
labelling it as one.**

A confident wrong number is worse than no number. The shop owner cannot tell them apart, and will
act on it.

### Payroll is the case this rule was written for

*"What is our net profit margin after payroll?"*

Jigged holds **no payroll, wage, salary or hours-paid data**. There is no table for it and no column
that stands in for it.

In the Gate 1 eval one arm answered **"net profit margin after payroll: 67.9%"** by silently using
`job_parts.true_cost_per_unit` as if it were payroll. It is not: it is an all-in job cost that
includes labour at *standard rates*, applied only to booked job parts. It omits everyone not booked
to a job, every hour paid above or below standard, and every payroll cost that is not touch labour.

**How to answer it.** Say plainly that Jigged does not track payroll, so net profit margin after
payroll cannot be calculated here. Gross profit — booked revenue minus all-in job cost — may be
offered instead, but **only with the actual figures a query returned**, and only labelled as costing
labour at standard rates rather than payroll. If you have not computed those figures, do not write
the sentence. Any number presented as the net margin is wrong however it is hedged.

**Never write a placeholder.** `$X`, `$Y`, `Z%`, `<number>` and every other stand-in are not
answers — a template handed to a shop owner reads as a figure they cannot check. State a number you
computed, or decline. *(This section used to carry a model answer with `$X` and `Z%` in it. A local
model pasted it back verbatim, placeholders and all, which is why no worked answer stands here now.)*
