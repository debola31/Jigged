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

**Defence in depth — seven layers, each independently sufficient to stop the obvious attack:**

1. **SQL validation** — SELECT/WITH only, forbidden keywords, table allowlist, `$1` required
2. **Parameterised `company_id`** — the model writes `company_id = $1`; the backend binds the
   UUID. No string interpolation, ever
3. **Table allowlist** — 19 business tables; auth / system / AI tables are not among them
4. **Read-only Postgres role** — `jigged_ai_readonly`, SELECT-only grants on allowed tables
5. **Statement timeout** — `STATEMENT_TIMEOUT_MS = 5000`
6. **Row limit** — `MAX_ROWS = 200`, appended as a `LIMIT` programmatically
7. **Self-correction** — the model sees SQL errors as tool results and retries, up to 5 iterations

### Validation rules (`api/tools/sql_validator.py`)

| Rule | Detail |
|---|---|
| Single statement | No `;` chaining |
| SELECT/WITH only | Must start with `SELECT` or `WITH` |
| Forbidden keywords | `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `INTO`, `pg_sleep`, `pg_catalog`, `information_schema` |
| Table allowlist | `ALLOWED_TABLES`. References are extracted reliably, **including comma-joins (`FROM a, b`) and schema-qualified names (`public.tbl`)** |
| Sensitive-table denylist | `SENSITIVE_TABLES` — rejected if referenced *anywhere* in the query, a guaranteed catch regardless of join syntax. **RLS is the final backstop** |
| Company scoping | Must contain `$1` at least once |
| Nesting limit | Max 3 levels of subquery nesting |

### The two lists

**These must match [`api/tools/schema_context.py`](../../api/tools/schema_context.py) exactly.**
The code is the source of truth; this doc has been wrong about both before.

**`ALLOWED_TABLES` — 19:** `companies`, `customers`, `vendors`, `parts`, `part_pricing_tiers`,
`parts_bom`, `parts_unit_conversions`, `quotes`, `quote_line_items`, `jobs`, `job_parts`, `job_operations`, `job_materials`, `work_centers`,
`routings`, `routing_operations`, `inventory_transactions`.

**`SENSITIVE_TABLES` — 14:** `user_company_access`, `user_preferences`, `system_admins`,
`auth_audit_log`, `ai_chat_queries`, `ai_config`, `saved_insights`, `demo_data_templates`,
`quickbooks_connections`, `quickbooks_customer_map`, `quickbooks_invoice_links`,
**`customer_carrier_accounts`**, `note_views`, `operator_events`.

**`note_views` and `operator_events` are excluded for a product reason, not just privacy hygiene.**
*"Which operators read the setup notes?"* is a natural question for an owner to type, and
answering it is precisely what the notes feature forbids: **if an owner can audit who reads notes,
reading becomes an admission of ignorance and the read side dies.** They are blocked three ways —
absent from `ALLOWED_TABLES`, no `GRANT` to `jigged_ai_readonly`, no `ai_readonly_select` policy —
with the denylist as a whole-word backstop. **Never** add them to `ALLOWED_TABLES` or grant them.
(`notes.viewer_count` / `usage_count` riding along if `notes` is ever allowlisted is fine: those
are aggregate counts, never identities.)

**`customer_carrier_accounts` holds the customer's own carrier account number** — see
[customers.md](customers.md). It belongs on the denylist for the same reason as the QuickBooks
tables: it is a credential, not business data.

### Adding a table to AI scope

1. Add it to `ALLOWED_TABLES`
2. Describe its columns, types and relationships in `SCHEMA_CONTEXT` in the same file
3. Migration: `GRANT SELECT ON <table> TO jigged_ai_readonly` **and**
   `CREATE POLICY ai_readonly_select ON <table> FOR SELECT TO jigged_ai_readonly USING (true)`

Skip step 3 and the allowlist passes while the query fails at the database — which is the correct
failure direction, but a confusing one.

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

---

## Acceptance Criteria

Convention stated once in [modules/README.md](README.md#the-acceptance-criteria-convention);
`automation-pending` here means [#367](https://github.com/debola31/Jigged/issues/367).

**The safety boundary**

- [ ] **Given** SQL that is not a single `SELECT`/`WITH`, contains a forbidden keyword, omits `$1`, or nests more than 3 deep, **then** the validator rejects it before execution — *verified by `api/tests/unit/test_sql_validator.py`*.
- [ ] **Given** a query naming a table outside `ALLOWED_TABLES` — including via a comma-join or a `public.`-qualified name — **then** it is rejected — *verified by `api/tests/unit/test_sql_validator.py`*.
- [ ] **Given** a query referencing **any** `SENSITIVE_TABLES` entry anywhere, **then** it is rejected regardless of join syntax; and even if it were not, no `GRANT` or `ai_readonly_select` policy exists for those tables — *verified by `api/tests/unit/test_sql_validator.py`; the grant/policy half is automation-pending (#367)*.
- [ ] **Given** a validated query, **when** it executes, **then** `company_id` is bound as `$1`, the statement times out at 5,000 ms, and no more than 200 rows return — *verified by `api/tests/integration/test_sql_executor.py`*.
- [ ] **Given** `ALLOWED_TABLES` or `SENSITIVE_TABLES` changing in code, **then** this doc's two lists must be updated in the same PR — **no check enforces this today**; it is the gap that let both lists drift.

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
