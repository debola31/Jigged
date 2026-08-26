# AI Insights & Charts Module

**As-built reference.** Shop owners ask questions in plain English; the AI writes SQL, the backend
validates and runs it read-only, and the answer comes back as prose with an optional chart. Users
pin the answers worth keeping. **Priority:** Should Have (FR-17) / Could Have (FR-18) ·
**Tables:** `ai_chat_queries`, `ai_config`, `saved_insights` · **Charts:** `@mui/x-charts`

> **Condensed 2026-08-03: 6,787 → ~2,480 words (−63%), for [#634](https://github.com/debola31/Jigged/issues/634).**
>
> **Two corrections on the security boundary, which is why this doc was prioritised:**
> it said "**20 tables**" four times while its own list held the correct **19**, and its
> `SENSITIVE_TABLES` denylist was **missing `customer_carrier_accounts`** — the customer's carrier
> account number. A denylist that a reader trusts and that is short by one entry is worse than no
> list, so both are fixed and the lists are now marked as needing to match the code exactly.
>
> Also corrected: three cited migration files do not exist (folded into the baseline), and a
> `### 3. Chart Types` section — orphaned, with no `### 2.` — listed insights from the deleted
> 5-card panel while the doc had already described the real deterministic selection 200 lines
> above. Superseded content standing beside its replacement, again.
>
> What went: ASCII dashboard mockups, a pasted rate-limit snippet, directory listings an `ls`
> reproduces, and an AC block restating what its own tests assert.

---

## Text-to-SQL, with layered safety

The AI generates SQL against a schema context, which is validated and executed through a
read-only connection. **This replaced an earlier predefined-metric-tools approach for chat**,
which could only answer a fixed set of query shapes. Text-to-SQL is flexible (any analytical
question, no new Python per question), extensible (a new table is a schema-context edit), and
plays to what LLMs are good at.

**Defence in depth. Listed, not counted** — a hand-maintained count in a doc is exactly the
thing that rots, and the one that used to sit here did:

1. **SQL validation** — SELECT/WITH only, forbidden keywords, no non-`public` schema, `$1` required
2. **Parameterised `company_id`** — the model writes `company_id = $1`; the backend binds the
   UUID. No string interpolation, ever
3. **Read-only Postgres role** — `jigged_ai_readonly`, SELECT-only. There is no longer a second
   copy of the table list in Python
4. **Per-company RLS** — an `ai_readonly_select` policy scoped to
   `current_setting('jigged.company_id')`, which the executor sets per query. **This is the layer
   that decides**, not the grant — see below
5. **Statement timeout** — `STATEMENT_TIMEOUT_MS = 5000`
6. **Row limit** — `MAX_ROWS = 200`, appended as a `LIMIT` programmatically
7. **Self-correction** — a failed query comes back as `SQL_ERROR: <cause>` *plus what to do about
   it*, and the model rewrites and retries, up to 5 iterations
8. **A non-answer is a failure, not an answer** — see below. The loop refuses to return the tool's
   error text to a shop owner

### Validation rules (`api/tools/sql_validator.py`)

| Rule | Detail |
|---|---|
| Single statement | No `;` chaining |
| SELECT/WITH only | Must start with `SELECT` or `WITH` |
| Forbidden keywords | `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `INTO`, `pg_sleep`, `pg_catalog`, `information_schema` |
| Non-`public` schemas | `auth`, `storage`, `vault`, `extensions`, `realtime`, `cron` … rejected whole. The one exclusion that does **not** grow as our schema does |
| Sensitive-table denylist | `SENSITIVE_TABLES` — rejected if referenced *anywhere* in the query, regardless of join syntax. Not a boundary: it refuses before the round trip and returns a sentence the model can act on, where the database returns a bare `permission denied` |
| Company scoping | Must contain `$1` at least once |
| Nesting limit | Max 3 levels of subquery nesting |

### What the AI may read

**Readable means a `SELECT` grant AND an `ai_readonly_select` policy — both.** This doc
deliberately does not copy the list; ask the database:

```sql
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND has_any_column_privilege('jigged_ai_readonly', c.oid, 'SELECT')
   AND EXISTS (SELECT 1 FROM pg_policy p
                WHERE p.polrelid = c.oid AND p.polname = 'ai_readonly_select')
 ORDER BY 1;
```

**The grant on its own decides nothing, which is easy to get wrong.** 55 of 65 public tables hold
one, because the baseline's `ALTER DEFAULT PRIVILEGES` grants `SELECT` to this role on every new
public table. Measured on a seeded stack, `auth_audit_log`, `user_company_access`, `company_billing`
and the `quickbooks_*` tables all hold a grant and all return **zero rows** — their policies key on
`auth.uid()`, which is NULL on the sandbox connection. That is real protection but incidental to
those policies' purpose, so the guards below test for the **policy**.

**Withdrawn:** a hand-maintained `ALLOWED_TABLES` in `schema_context.py`, enumerated here as well
— wrong because four copies of one decision drift, and all four did. The Python list named 19
tables where 21 were granted; this doc claimed 19 while enumerating 17; and production carried an
`ai_readonly_select` policy on `shipments` with no grant behind it, so the helper this very doc
recommends for ship dates failed on every call. `ALLOWED_TABLES` was deleted in
[`20260826010319`](../../supabase/migrations/20260826010319_ai_read_access_and_guard.sql), which
also added the two guards that make the remaining copy impossible to forget:

| Guard | Fails CI when |
|---|---|
| `tenant_tables_missing_ai_decision()` | a `public` table with `company_id` is neither AI-readable nor on the reviewed exempt list — so a new tenant table cannot ship until somebody decides |
| `ai_policies_without_grant()` | a table carries `ai_readonly_select` with no grant behind it — RLS with no grant is unreachable, and that is the exact shape of the `shipments` bug |
| `test_schema_context_describes_only_real_readable_columns` | `SCHEMA_CONTEXT` names a table or column that does not exist, or one the AI role cannot read. It caught two on the day it was written: `customers.website` and `part_pricing_tiers.unit_price`, both described and neither real |

All three live in [`test_ai_read_access.py`](../../api/tests/integration/test_ai_read_access.py),
which also calls `job_last_ship_date()` **as `jigged_ai_readonly`** rather than checking a grant in
the catalogue — a helper changed to touch some third ungranted table is the same bug in a new
costume. Those tests **skip rather than pass** if `AI_READONLY_DATABASE_URL` is not really that
role, because for years it was the `postgres` superuser locally and every one of them would have
been vacuous.

**`SCHEMA_CONTEXT` is the schema the model actually navigates by.** It is pasted verbatim into the
system prompt, which then says *"Only query the tables documented in the schema above"* — so a
granted table nobody describes is invisible, and a described column that does not exist costs a
round trip and a self-correction the owner waits through. It is the last hand-maintained copy of the
schema in this design, and now the only one with a check behind it.

**Access is not default-on, and that was a deliberate call.** Keying it off "has a `company_id`
column" was considered and rejected: 47 `public` tables have one, and they include the
`quickbooks_*` OAuth tokens, `customer_carrier_accounts`, `user_company_access`, `auth_audit_log`,
`company_billing`, and the per-operator pace tables below. Default-allow makes the next credentials
table readable the moment it is created. The default is that a **decision** is required.

**`SENSITIVE_TABLES` stays**, as a whole-word pre-refusal rather than a boundary — read it from
[`api/tools/schema_context.py`](../../api/tools/schema_context.py), which is the source of truth.

**`note_views` and `operator_events` are excluded for a product reason, not just privacy hygiene.**
*"Which operators read the setup notes?"* is a natural question for an owner to type, and
answering it is precisely what the notes feature forbids: **if an owner can audit who reads notes,
reading becomes an admission of ignorance and the read side dies.** They are blocked three ways —
no `GRANT` to `jigged_ai_readonly`, no `ai_readonly_select` policy, and a named entry in the
surveillance block of `tenant_tables_missing_ai_decision()`'s exempt list — with the denylist as a
whole-word pre-refusal. **Never grant them.** (`notes.viewer_count` / `usage_count` riding along if
`notes` is ever opened is fine: those are aggregate counts, never identities.)

**`customer_carrier_accounts` holds the customer's own carrier account number** — see
[customers.md](customers.md). It belongs on the denylist for the same reason as the QuickBooks
tables: it is a credential, not business data.

**`ai_calls`, `ai_jobs` and `ai_workers` are the AI layer's own plumbing.** *"How much are we
spending on AI?"* is a natural thing for an owner to type, and `ai_calls` is the table that would
answer it. `ai_jobs` is worse: its `payload` carries the questions **other companies** asked. Both
are blocked the same three ways, with `ai_call_write_leaks()` and `ai_job_write_leaks()` asserting
the grant and policy layers on every CI run.

### An answer that is a database error is not an answer

**Added 2026-08-26, from the local-model A/B.** Every local arm reached its final turn holding
nothing but a failed query and said so — *"The column total_price does not exist…"*, *"The SQL query
encountered a syntax error, please review…"* — and the handler returned that as the answer with the
job settled `succeeded`. A shop owner cannot tell it from a real answer. It is the same silent
degradation [`services/llm/errors.py`](../../api/services/llm/errors.py) refuses one layer down; it
was just happening one layer above where that rule was enforced. Three changes, all in the **shared**
path, so Claude gets them too:

| Layer | What it does |
|---|---|
| **The tool result** ([`retryable_sql_error`](../../api/tools/sql_executor.py)) | A fixable failure returns `SQL_ERROR: <one-line cause>. Rewrite the query using this error and execute again. Never describe this error to the user.` The executor used to say only what went wrong, so passing it on was a reasonable thing to do with it |
| **One corrective turn** ([`ai_features/insights.py`](../../api/services/ai_features/insights.py)) | A model trying to answer while **every** query failed and none succeeded is told to fix the SQL and run it once more. **Once per conversation** — a second injection would push the real work past the iteration cap, and the cap is what ends a loop that is not converging |
| **The answer gate** (`looks_like_error_echo`) | No successful query **and** an empty or error-shaped final text → `LLMErrorEcho`, `error_kind = 'error_echo'`, never an answer |

**Which failures are the model's to fix is now a property of the result, not of its wording.**
`SQL_ERROR` means a rewrite can reach it (syntax, a column that does not exist, a timeout, a
validator rejection). `NOT_PERMITTED` means no rewrite ever can. A dead pool or a malformed
`company_id` carries **neither** — those are ours, and inviting a retry would spend a turn on
something no query can reach. The loop counts on exactly that distinction, so a refused object can
neither earn a retry nor condemn a legitimate *"Jigged does not track that"* answer.

**The gate is deliberately conservative: if any query succeeded, the answer passes through
untouched** — however it reads. It is a floor under "no data at all", not a judge of answers, because
a rule that *could* reject a grounded answer will eventually reject a good one. Judging a grounded
answer is the eval's job and a human's.

Two things this does not do. `ai_calls` has no `error_kind`, and the provider call genuinely
succeeded — so a gated run appears in the ledger as a **successful** call, with the verdict on the
`ai_jobs` row. And a gated run never reaches `_log_chat_query`, so it does not count against the
hourly cap, exactly like `LLMToolLoopExhausted`.

**No worked answer appears in the assembled prompt, and that is a rule.** A local arm answered the
payroll question by pasting `semantics.md`'s model answer back verbatim — placeholders and all,
*"$X on $Y of revenue, a Z% gross margin"*. Every answer-shaped example is gone; the instructions say
what to do instead. The `chart_config` sample survives because it is a machine format the next
sentence refers to by key name, not prose to imitate.

### Business terms live in `docs/ai/semantics.md`, and it is runtime

[`ai/semantics.md`](../ai/semantics.md) defines late, revenue, job value, this quarter, dormant,
pipeline and conversion — **and `_build_chat_system_prompt()` renders it straight into the system
prompt.** It is documentation and source in one, so editing it changes what the product answers.
There is no second copy in Python, deliberately: the Gate 1 eval had three arms answer *"how many
jobs are late right now"* with 5, 4 and 0, each defensibly, because the term was undefined and the
prose that gestured at it lived somewhere the runtime never read.

Every ```sql block in that file is executed with `LIMIT 1` as `jigged_ai_readonly` on each CI run,
so a definition citing an unreadable column fails the build. Assembly order —
preamble → `SCHEMA_CONTEXT` → semantics → guidelines — is fixed so the prompt stays one cacheable
prefix; the file changes only via PR.

### Adding a table to AI scope

1. Migration: `SELECT public.apply_ai_read_access('public.<table>');` — one call, which issues the
   `GRANT` **and** the company-scoped `ai_readonly_select` policy together, so the two cannot drift
   apart the way they did on `shipments`. It **refuses** a table with no `company_id` column, and
   refuses one with RLS disabled: a grant without RLS is not a narrower grant, it is every
   company's rows.
2. Describe its columns, types and relationships in `SCHEMA_CONTEXT` in
   [`schema_context.py`](../../api/tools/schema_context.py) — otherwise the model is never told the
   table exists, and a readable table nobody mentions is invisible.

For a **child table** (no `company_id`, scoped through a parent) the helper raises and you write
both halves by hand in the same migration — see `customer_contacts` in the baseline, or
`shipment_line_items`.

To keep a new tenant table **out** of AI scope, add it to the exempt list in
`tenant_tables_missing_ai_decision()` with a line saying why. Doing neither fails CI, which is the
entire point: there is no longer a way to ship a tenant table nobody thought about.

> **This step used to say `USING (true)`, and that was a cross-tenant read waiting to happen.**
> Corrected 2026-08-25. All 29 real `ai_readonly_select` policies scope on
> `current_setting('jigged.company_id', true)`, which [`api/tools/sql_executor.py`](../../api/tools/sql_executor.py)
> sets per query — a `USING (true)` policy would have let one shop's question return another shop's
> rows, because RLS is the layer that actually enforces tenancy here (the validator only checks that
> `$1` is *present*, never that it filters anything). `20260728040701` had already flagged this
> instruction by name as the reason `note_views` names `jigged_ai_readonly` in its RESTRICTIVE deny.
> **If you followed the old wording, check your policy now.**

---

## Chart decisioning

**Text-first, constrained renderer** — the model *proposes* a chart; deterministic code decides
whether and how to render it. This is the industry norm (ThoughtSpot, Power BI Copilot, Tableau
"Show Me", Amazon QuickSight Q).

- **Modality (prompt):** default to a one-line prose answer; ask for a `chart_config` only when
  there are ≥3 data points and a chart genuinely helps — trend over time, comparison across
  categories, part-of-whole. Single facts, dominant top-N and 1–2 values stay text.
- **Validation and downgrade** (`_validate_chart_config`): the chart is dropped, keeping the prose,
  when the type is unsupported, data is empty, the declared `x_key`/`y_key` aren't on every row,
  `y` isn't numeric, or the result is degenerate — fewer than 2 distinct categories, all-equal or
  all-zero, a single point, or a 2-point chart where one value dominates. **A dropped chart is an
  explicit downgrade, never a blank card.**
- **Deterministic type** (`_select_chart_type`): derived from data shape — temporal x → `area`;
  nominal x → `bar`, or `bar_horizontal` for long or many labels; a model-chosen `pie` survives
  only for a few slices. **An explicit type named in the question ("as a pie") wins.**
- **Renderer guards** (`components/insights/InsightChart.tsx`): missing keys show an explicit
  "No chartable data" state rather than blank labels or zero bars; bar and area use a zero
  baseline; axis ticks abbreviate (`7749` → `7.7K`); nominal bars are value-sorted.

`_ALLOWED_CHART_TYPES` is exactly `{area, pie, bar, bar_horizontal, sparkline}`.

*(A `### 3. Chart Types` table used to sit here mapping "Revenue Trend", "Job Pipeline",
"Inventory Alerts" and "Resource Utilization" to MUI components. Those were the surfaces of the
**deleted 5-card panel**, not chart types, and the section had no `### 2.` before it. Removed.)*

---

## One code path

The dashboard is user-driven: the ask bar is the only way to generate an insight, and users pin
what they want to keep into `saved_insights`.

**Withdrawn — the pre-built "5 cached cards" panel**, along with the `ai_insight_cache` table:
nothing read the AI summaries it generated and it burned Anthropic credits on **every dashboard
load**. The header alert badge beside it (at-risk jobs + low inventory) was removed in August
2026 — at-risk was retired as a concept, and low stock is surfaced by the shortage lens on the
parts page (`?status=low` / `?status=out`), computed client-side over RLS with **no service role
and no AI**.

This is the concrete case behind CLAUDE.md's rule that **an AI call requires an explicit user
action** — never a `useEffect`, a page load or a poll.

## Feature gating, limits and cost

`ai_insights` is **opt-out**: a GA feature with a per-tenant kill-switch. It is enabled unless the
company row explicitly stores `settings.features.ai_insights = false`.

The hourly chat cap is **per company and configurable** — `settings.ai_limits.chat_per_hour`,
adjustable by a system admin from `/admin`, falling back to `DEFAULT_CHAT_LIMIT_PER_HOUR = 20`
when unset or invalid. *(This doc previously described a flat, uneditable 20.)*

**Both read paths fail open** — a transient DB error returns `(enabled, default limit)` rather
than blocking, so a blip never dark-launches the GA feature off. That is a deliberate choice:
the failure mode of failing closed here is a silently dead product surface.

| Control | Value |
|---|---|
| Chat queries per company per hour | `chat_per_hour`, default 20 |
| Max tokens per chat response | 4,000 |
| SQL statement timeout | 5,000 ms |
| SQL row limit | 200 |

Rate limiting counts recent `ai_chat_queries` rows for the company.

---

## Data model

**`ai_chat_queries`** — one row per turn, for analytics, debugging and cost tracking:
`company_id`, `user_id`, `question`, `tool_calls` (jsonb — which tools ran, with their SQL),
`response`, `chart_config`, `provider`, `model`, `tokens_used`, `duration_ms`, `created_at`.
It is **written, never read back as chat history.**

**`saved_insights`** — user-pinned cards: `user_id`, `company_id`, `question`, `answer`,
`chart_config`, `created_at`. Scoped **per user within a company** — the RLS policies filter on
`user_id = auth.uid()`, so each user sees only their own pins. **There is no saved-insight cap**
in the database, the access layer or the UI.

**Removed: `ai_insight_cache`** — dropped when the 5-card panel went; nothing read or wrote it.

*(This doc used to cite `20260305000000_create_ai_insights_tables.sql`,
`20260305000001_create_ai_readonly_role.sql` and `20260416_drop_ai_insight_cache.sql`. **None of
the three exists** — they were folded into
[`20260527151536_baseline.sql`](../../supabase/migrations/20260527151536_baseline.sql), which the
doc separately said in another section.)*

## Interfaces

`POST /api/insights/{company_id}/chat` is the **only** FastAPI insights route. It takes
`{question}` and returns `{answer, chart_config?, tool_calls, provider, tokens_used}`. Requires a
Supabase JWT and an `owner` / `admin` / `user` role — **operators are excluded.**

**Chat is stateless.** Each request is an independent Q&A; there is no `chat/history` endpoint and
no frontend caller for one. If multi-turn history is added it should be scoped per user within a
company, mirroring the `saved_insights` RLS model.

**Saved-insights CRUD is not a backend route** — it runs client-side against the RLS-scoped table
via [`utils/savedInsightsAccess.ts`](../../utils/savedInsightsAccess.ts), per the Supabase-first
architecture rule.

**Backend** (`api/`): `routes/insights_routes.py` (the endpoint, chart validation and selection) ·
`services/insights_service.py` (metric functions, chat system prompt, `execute_sql_tool`) ·
`services/ai/` (`base_provider.chat_with_tools`, `claude_provider` implementation + dispatch,
`factory` with the `insights_chat` feature type) · `tools/` (`metric_tools`, `schema_context`,
`sql_validator`, `sql_executor`).

**Frontend:** `components/insights/` (`InsightsChat`, `InsightCard`, `InsightChart`) and
`components/dashboard/` (`InsightsSection`, `PinnedMetrics`, `MetricPickerModal`).

**Env:** `ANTHROPIC_API_KEY` and `AI_READONLY_DATABASE_URL` (the read-only connection string) on
top of the standard Supabase vars.

## Dashboard surfaces

**Pinned metrics** — a flat KPI strip, up to 4 at a time, chosen from six
(`open_quotes`, `not_started_jobs`, `in_progress_jobs`, `revenue`, `completed_jobs`,
`overdue_jobs`) via a pager. Persisted per user to
`user_preferences.preferences.dashboard_pinned_metrics`; the Today / This Week toggle to
`dashboard_metric_periods`.

**Ask bar** — input plus example prompt chips, inline response, rotating loading messages, and a
**Save button shown only when a chart survived validation**. Single Q&A per interaction.

**Your Charts** — the current user's saved cards in a responsive grid, each with question, chart,
summary and a remove button; a dashed empty state inviting the first question.

## Pre-defined metric functions

These live in `insights_service.py` and are registered in `METRIC_TOOLS`, but **`CHAT_TOOLS`
contains only `execute_sql`**, so they are not offered to the model. The dispatcher in
`claude_provider.chat_with_tools` still routes a predefined tool call to them, so they remain
callable if one is ever re-enabled: `get_revenue_by_period`, `get_job_status_distribution`,
`get_quote_conversion_rate`, `get_job_cycle_times`, `get_customer_revenue_breakdown`,
`get_part_profitability`, `get_revenue_forecast`. All receive `company_id` implicitly from the
authenticated request.

**Revenue source of truth — the rule that keeps two numbers from disagreeing.** Realized-revenue
functions (`get_revenue_by_period`, `get_customer_revenue_breakdown`, `get_part_profitability`)
sum **`job_parts.total_price`**, the agreed per-part line total on the *job* — not the source
`quote_line_items.total_price`. The job part is the post-conversion source of truth, so revenue
follows an order quantity edited after conversion, **and it avoids over-counting a price-options
quote's unchosen lines.** `get_revenue_forecast` is the deliberate exception: it sums
`quote_line_items.total_price`, because it values the **open, unconverted** pipeline where no job
exists yet. The same rule is encoded in the NL→SQL guidance in `schema_context.py`.

**Cost source of truth — the same discipline, on the other side of the margin.** `get_part_profitability`
costs a job from **`job_parts.true_cost_per_unit`**, the all-in TRUE cost (labour + materials + the whole
nested BOM) frozen when the job_part was created and re-taken only when its quantity changes
([`20260811233748`](../../supabase/migrations/20260811233748_job_cost_snapshot.sql)). It must **never**
recompute cost from the part's current routing or rates: a job that shipped is history, and re-costing it
against today's numbers means last year's profit moves whenever someone re-rates a work centre. The
labour/materials split comes from the rates frozen on `job_operations` (`labor_rate_snapshot`,
`external_unit_price_snapshot`) with materials as the remainder — materials are deliberately not stored per
BOM line, because costing one line needs the unit conversion, whole-unit ceiling and made-vs-bought
valuation rules that live inside `part_rollup_at_qty`.

A `true_cost_per_unit` of NULL means the cost could not be determined when the job was created. Those
job_parts are **excluded** and counted in `excluded_job_parts`; folding them in at zero would overstate
profit, which is the one direction a shop must not be misled in. Costs use **estimated** time — no actual
duration per operation is recorded anywhere.

**This function returned HTTP 400 from 2026-06-23 to 2026-08-11.** It selected
`routing_operations.external_setup_cost` after [`20260623022617`](../../supabase/migrations/20260623022617_drop_external_setup_cost.sql)
dropped that column, and nothing executed the real select string — the predefined metric tools are not
offered to the model (see above), so no call path reached it and no test covered it.
`test_job_cost_snapshot.py::test_get_part_profitability_runs_and_charges_materials` now calls the real
function against a real PostgREST, which is the only thing that would have caught it.

---

## Acceptance Criteria

Convention stated once in [modules/README.md](README.md#the-acceptance-criteria-convention);
`automation-pending` here means [#367](https://github.com/debola31/Jigged/issues/367).

**The safety boundary**

- [ ] **Given** SQL that is not a single `SELECT`/`WITH`, contains a forbidden keyword, omits `$1`, or nests more than 3 deep, **then** the validator rejects it before execution — *verified by `api/tests/unit/test_sql_validator.py`*.
- [ ] **Given** a query naming a denylisted table — including via a comma-join or a `public.`-qualified name — or any non-`public` schema, **then** it is rejected — *verified by `api/tests/unit/test_sql_validator.py`*.
- [ ] **Given** a table the role holds no grant on, **then** the database refuses it rather than the validator — *verified by `api/tests/integration/test_ai_read_access.py`*.
- [ ] **Given** a query referencing **any** `SENSITIVE_TABLES` entry anywhere, **then** it is rejected regardless of join syntax; and even if it were not, no `GRANT` or `ai_readonly_select` policy exists for those tables — *verified by `api/tests/unit/test_sql_validator.py`; the grant/policy half is automation-pending (#367)*.
- [ ] **Given** a validated query, **when** it executes, **then** `company_id` is bound as `$1`, the statement times out at 5,000 ms, and no more than 200 rows return — *verified by `api/tests/integration/test_sql_executor.py`*.
- [ ] **Given** a new `company_id` table, **then** it is either AI-readable or on the reviewed exempt list — *enforced by `tenant_tables_missing_ai_decision()`*. **This closes the gap that used to sit here**: the doc no longer copies the readable-table list at all, so it cannot drift from it, and `SENSITIVE_TABLES` is read from the code rather than duplicated.

**Chart decisioning**

- [ ] **Given** a `chart_config` whose type is unsupported, whose keys are missing from some row, whose `y` is non-numeric, or whose data is degenerate, **then** the chart is dropped and the prose answer is kept — *verified by `api/tests/unit/test_chart_config.py`*.
- [ ] **Given** valid data, **then** the rendered type is chosen from the data shape, except when the question names one explicitly — *verified by `api/tests/unit/test_chart_config.py`*.
- [ ] **Given** a config missing `x_key` or `y_key` at render time, **then** the card shows "No chartable data" rather than blank bars — *verified by `__tests__/components/insights/InsightChart.test.tsx`*.

**Gating, limits and access**

- [ ] **Given** a company at its hourly cap, **then** the endpoint returns 429; the cap is `settings.ai_limits.chat_per_hour`, defaulting to 20 — *verified by `api/tests/unit/test_insights_rate_limit.py`*.
- [ ] **Given** `settings.features.ai_insights = false`, **then** chat is refused; **given** the key absent, **then** it is enabled — *verified by `api/tests/unit/test_insights_rate_limit.py`*.
- [ ] **Given** the settings read fails, **then** the request proceeds enabled at the default limit — failing open is deliberate — *verified by `api/tests/unit/test_insights_rate_limit.py`*.
- [ ] **Given** an operator, **then** the endpoint refuses; owner/admin/user are allowed — *automation-pending (#367)*.

**Saved insights**

- [ ] **Given** a response with a surviving chart, **then** Save is offered and the pin is written; **given** one without, **then** Save is not shown — *automation-pending (#367)*.
- [ ] **Given** two users in one company, **then** each sees only their own pins (`user_id = auth.uid()`), with no cap on either — *automation-pending (#367)*.

## Known gaps

- **Nothing enforces that this doc's two table lists match the code.** Both had drifted — the
  count in four places, and one missing denylist entry. A test asserting the doc's lists against
  the frozensets would have caught it; that is the shape of guard this repo already uses elsewhere.
- **No E2E covers the chat path** — validation and chart selection are unit-tested, the browser
  round-trip is not.
- **`CHAT_TOOLS` is single-tool by design but built for more.** Predefined Python tools can be
  added alongside `execute_sql` for questions too error-prone for generated SQL (multi-step
  business logic such as margin attribution across a BOM). Not needed yet.
- **Multi-turn chat is not built**; `ai_chat_queries` is write-only today.
