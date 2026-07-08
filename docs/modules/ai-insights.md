# AI Insights & Charts Module

## Overview

The AI Insights module gives shop owners and administrators an intelligent data analyst built into their dashboard. Users ask questions in plain English and the AI returns text answers with optional charts. Users pin the answers they find valuable to build a personalized dashboard — so a 50-year-old shop owner who's great at machining doesn't need to be great at spreadsheets.

**Priority:** Should Have (FR-17: Dashboard with AI Insights), Could Have (FR-18: Natural Language Queries)

**Dependencies:** Dashboard, Jobs, Quotes, Customers, Parts, Operations, Inventory modules

**Database Tables:** `ai_chat_queries`, `ai_config` (existing), `saved_insights`

**Chart Library:** `@mui/x-charts` (MUI's native charting — seamless dark theme integration)

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Admin | See a revenue trend chart on my dashboard | I can spot growth or decline at a glance |
| Admin | Know which jobs are at risk of delay | I can intervene before we miss a deadline |
| Admin | Ask questions about my data in plain English | I don't have to export data and crunch it in Excel |
| User | See quote conversion rates with trend context | I can improve the sales process over time |
| Admin | See which customers generate the most revenue | I can prioritize relationships and spot concentration risk |
| User | See a breakdown of jobs by status | I know where the shop floor stands right now |
| Admin | Get AI-generated summaries explaining my metrics | I understand the "so what" behind the numbers |
| Admin | See inventory items that need reordering | I can prevent stockouts before they delay jobs |
| User | Click example prompts to quickly ask common questions | I can get answers without knowing what to type |
| Admin | Pin AI-generated charts to my dashboard | I build a personalized view of the metrics I care about |
| Admin | Remove pinned charts I no longer need | I can keep my dashboard focused and relevant |
| Admin | See starter prompts when my chart grid is empty | I know how to get started without reading docs |

---

## Architecture

### Key Design Decision: Text-to-SQL with Safety Layers

The AI chat uses a **text-to-SQL** approach: the AI generates SQL queries against the database schema, which are validated and executed via a read-only database connection. This replaces the earlier predefined metric tools approach for chat, which was limited to a fixed set of query patterns.

**Why text-to-SQL:**
- **Flexible** — any analytical question can be answered without adding new Python functions
- **Extensible** — adding new tables or columns is automatic (just update the schema context)
- **Natural** — SQL is the lingua franca for data queries; LLMs are very good at generating it

**Safety layers (defense in depth):**
1. **SQL validation** — SELECT-only, forbidden keywords, table allowlist, `$1` placeholder required for company_id
2. **Parameterized company_id** — AI writes `company_id = $1`, backend binds actual UUID (no string interpolation)
3. **Table allowlist** — Only 20 business tables. Auth/system/AI tables blocked.
4. **Read-only Postgres role** — `jigged_ai_readonly` with SELECT-only grants on allowed tables
5. **Statement timeout** — 5 seconds via asyncpg connection config
6. **Row limit** — 200 rows max, enforced programmatically
7. **Self-correction** — AI sees SQL errors as tool results and can retry (up to 5 iterations)

### Single Code Path: Text-to-SQL via Chat

The dashboard page is user-driven: the ask bar is the only way to generate insights, and users pin the results they want to keep (`saved_insights`). There is no pre-built "5 cached cards" panel — that pipeline was removed along with the `ai_insight_cache` table because nothing read the AI summaries it generated and it burned Anthropic credits on every dashboard load. The header `AlertBadge` (at-risk jobs + low inventory) is pure Supabase aggregation; see [utils/alertsAccess.ts](../../utils/alertsAccess.ts).

### Chat Flow

```
1. User asks question in ask bar
       |
       v
2. FastAPI backend constructs prompt with:
   - Database schema context (20 tables, columns, types, relationships)
   - execute_sql tool definition
   - Chart formatting guidelines
       |
       v
3. AI generates SQL query via execute_sql tool call
   (e.g., SELECT COUNT(*) FROM jobs WHERE started_at >= NOW() - INTERVAL '7 days' AND company_id = $1)
       |
       v
4. Backend validates SQL:
   - SELECT/WITH only, no forbidden keywords
   - All tables in allowlist
   - $1 placeholder present
       |
       v
5. Backend executes via read-only asyncpg connection
   (company_id bound as $1 parameter, 5s timeout, 200 row limit)
       |
       v
6. AI interprets results -> returns:
   - Natural language summary (inline markdown + tables stripped for the plain-text UI)
   - Optional *proposed* chart_config (chart type + formatted data)
       |
       v
7. Backend decides the modality deterministically (constrained renderer):
   - validate chart_config against its data; downgrade to text when invalid or
     degenerate (missing keys, non-numeric y, 1-2 dominant values, single category)
   - pick the chart type from the data shape (temporal -> area, nominal -> bar)
       |
       v
8. Frontend renders text + optional MUI X Chart
   - InsightChart fails loud ("No chartable data") instead of blank bars
   - Save button only shown when a chart survived validation
```

### Chart decisioning & validation

Text-first, **constrained-renderer** pattern (industry norm: ThoughtSpot, Power BI
Copilot, Tableau "Show Me", Amazon QuickSight Q): the model *proposes* a chart, but
deterministic code decides whether and how to render it.

- **Modality (prompt):** default to a one-line prose answer; ask for a `chart_config`
  only when there are >=3 data points and a chart genuinely helps (trend over time,
  comparison across categories, part-of-whole). Single facts, dominant top-N, and
  1-2 values stay text.
- **Validation + downgrade** (`_validate_chart_config`, `api/routes/insights_routes.py`):
  drops the chart (keeping the prose answer) when `chart_type` is unsupported, data is
  empty, the declared `x_key`/`y_key` aren't on every row, `y` isn't numeric, or the
  result is degenerate (<2 distinct categories, all-equal/all-zero, a single point, or
  a 2-point chart where one value dominates). A dropped chart is an explicit downgrade —
  never a blank card.
- **Deterministic chart type** (`_select_chart_type`): the rendered type is derived from
  the data shape (temporal x -> `area`; nominal x -> `bar`, or `bar_horizontal` for
  long/many labels; a model-chosen `pie` is kept only for a few slices). An explicit type
  named in the question ("as a pie") wins.
- **Renderer guards** (`components/insights/InsightChart.tsx`): missing `x_key`/`y_key`
  shows an explicit "No chartable data" state (never blank labels / zero bars); bar/area
  use a zero baseline; axis ticks are abbreviated (`7749` -> `7.7K`); nominal bars are
  value-sorted.

### Hybrid Tool Architecture

`CHAT_TOOLS` is a list that currently contains only `execute_sql`, but is designed for extensibility. As user behavior patterns emerge, predefined Python tools can be added alongside SQL for queries that are too complex or error-prone for AI-generated SQL (e.g., multi-step business logic like at-risk job severity scoring). See GitHub issue for tracking.

### Extending the Existing AI Infrastructure

The project already has a multi-provider AI system in `api/services/ai/`. This module extends it:

- **`base_provider.py`** — Add `chat_with_tools()` abstract method alongside existing `suggest_column_mappings()`
- **`factory.py`** — Add `'insights_chat'` as a feature type for `get_provider()` lookups
- **`ai_config` table** — Already exists. Companies can configure which provider to use for `insights_chat` independently from `csv_mapping`

Default provider: Claude (Anthropic). Fallback behavior same as CSV import.

---

## SQL Validation Rules

The `sql_validator.py` module enforces these rules before any query reaches the database:

| Rule | Detail |
|---|---|
| Single statement | No `;` chaining |
| SELECT/WITH only | Must start with `SELECT` or `WITH` (for CTEs) |
| Forbidden keywords | `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `INTO`, `pg_sleep`, `pg_catalog`, `information_schema` |
| Table allowlist | Only business tables in `ALLOWED_TABLES` (`schema_context.py`). Table references are extracted reliably, including comma-joins (`FROM a, b`) and schema-qualified names (`public.tbl`) |
| Sensitive-table denylist | Auth/system tables in `SENSITIVE_TABLES` are rejected if referenced anywhere in the query — a guaranteed catch regardless of join syntax. DB Row-Level Security is the final backstop |
| Company scoping | Must contain `$1` at least once |
| Nesting limit | Max 3 levels of subquery nesting |

### Allowed Tables

`companies`, `customers`, `vendors`, `parts`, `part_pricing_tiers`, `parts_bom`, `parts_unit_conversions`, `markup_rates`, `quotes`, `quote_line_items`, `quote_materials`, `quote_operations`, `jobs`, `job_parts`, `job_operations`, `job_materials`, `work_centers`, `routings`, `routing_operations`, `inventory_transactions`

> Source of truth: the `ALLOWED_TABLES` frozenset in `api/tools/schema_context.py`. Keep this list and `SCHEMA_CONTEXT` in sync with the code.

### Excluded Tables (auth/system/AI)

Enforced by the `SENSITIVE_TABLES` denylist in `api/tools/schema_context.py` — rejected if referenced anywhere in a query:

`user_company_access`, `user_preferences`, `system_admins`, `auth_audit_log`, `ai_chat_queries`, `ai_config`, `saved_insights`, `demo_data_templates`, `quickbooks_connections`, `quickbooks_customer_map`, `quickbooks_invoice_links`

### Adding a New Table to AI Scope

When a new business table is added to the database and should be queryable by the AI chat:

1. Add table name to `ALLOWED_TABLES` in `api/tools/schema_context.py`
2. Add table description (columns, types, relationships) to `SCHEMA_CONTEXT` string in same file
3. Create a new migration with:
   - `GRANT SELECT ON <table> TO jigged_ai_readonly`
   - `CREATE POLICY ai_readonly_select ON <table> FOR SELECT TO jigged_ai_readonly USING (true)`

---

## Pre-defined Metric Functions

These live in `insights_service.py` as chat fallbacks. They are registered in `METRIC_TOOLS` but not passed to the model in `CHAT_TOOLS` (which is `execute_sql` only). The predefined dispatcher in `claude_provider.chat_with_tools` still routes any predefined tool the model emits to these functions, so they stay callable if a predefined tool is ever re-enabled.

| Function | Description | Parameters | Returns |
|---|---|---|---|
| `get_revenue_by_period` | Revenue from shipped jobs over time | `period_type` (daily/weekly/monthly), `num_periods` (default: 8) | `[{period, amount, job_count}]` |
| `get_job_status_distribution` | Current job counts by status | — | `[{status, count}]` |
| `get_quote_conversion_rate` | Quotes accepted vs total | `period_type`, `num_periods` | `{current_rate, previous_rate, trend_direction, periods: [{period, accepted, total, rate}]}` |
| `get_job_cycle_times` | Avg days from created -> shipped | `period_type`, `num_periods` | `[{period, avg_days, job_count}]` |
| `get_customer_revenue_breakdown` | Revenue ranked by customer | `period_type`, `num_periods`, `limit` (default: 10) | `[{customer_name, revenue, job_count, pct_of_total}]` |
| `get_part_profitability` | Revenue vs estimated labor cost by part | `limit` (default: 10) | `[{part_name, description, revenue, estimated_cost, margin_pct}]` |
| `get_revenue_forecast` | Pipeline value from open quotes | — | `{total_pipeline, weighted_pipeline, quote_count, avg_conversion_rate}` |

All functions implicitly receive `company_id` from the authenticated request context.

**Revenue source of truth:** the realized-revenue functions (`get_revenue_by_period`, `get_customer_revenue_breakdown`, `get_part_profitability`) sum **`job_parts.total_price`** (the agreed per-part line total on the job), *not* the source `quote_line_items.total_price`. The job part is the post-conversion source of truth, so revenue reflects any order quantity edited after conversion — and it avoids over-counting a price-options quote's unchosen lines. `get_revenue_forecast` is the exception: it sums `quote_line_items.total_price` because it values the **open** (un-converted) quote pipeline, where no job exists yet. The same rule is encoded in the NL→SQL guidance in `api/tools/schema_context.py`.

At-risk jobs and low-inventory alerts are **not** in this list — they are computed client-side in [utils/alertsAccess.ts](../../utils/alertsAccess.ts) and consumed by the header `AlertBadge` popover. They use Supabase RLS directly (no service-role, no AI).

---

## Data Model

> **Migration files:** `supabase/migrations/20260305000000_create_ai_insights_tables.sql` and `supabase/migrations/20260305000001_create_ai_readonly_role.sql`

### Removed: `ai_insight_cache`

Previously cached pre-built dashboard insight cards. Dropped in `20260416_drop_ai_insight_cache.sql` — the 5-card panel was removed, so nothing read or wrote the table.

### Table: `ai_chat_queries`

Logs chat interactions for analytics, debugging, and cost tracking.

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key, `gen_random_uuid()` |
| company_id | UUID | Yes | FK to `companies` |
| user_id | UUID | Yes | FK to `auth.users` |
| question | TEXT | Yes | User's natural language question |
| tool_calls | JSONB | Yes | Which tools the AI invoked (e.g., `execute_sql` with SQL queries) |
| response | TEXT | Yes | AI's natural language response |
| chart_config | JSONB | No | Chart config if a chart was generated |
| provider | VARCHAR(20) | Yes | AI provider used (`'anthropic'`, `'openai'`, `'gemini'`) |
| model | VARCHAR(50) | No | Specific model used |
| tokens_used | INTEGER | No | Total token count for cost tracking |
| duration_ms | INTEGER | No | End-to-end response time |
| created_at | TIMESTAMPTZ | Yes | Timestamp |

### Table: `saved_insights`

User-pinned chart cards on the dashboard. Scoped **per user within a company** — the RLS policies (`Users can read/insert/delete own saved insights`) filter by `user_id = auth.uid()`, so each user sees only their own pinned cards. There is **no saved-insight limit** — save proceeds unconditionally (no cap in the DB, access layer, or UI).

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key, `gen_random_uuid()` |
| user_id | UUID | Yes | FK to `auth.users` |
| company_id | UUID | Yes | FK to `companies` |
| question | TEXT | Yes | The user's original question |
| answer | TEXT | Yes | AI-generated answer text |
| chart_config | JSONB | No | Chart configuration for rendering |
| created_at | TIMESTAMPTZ | Yes | Timestamp |

---

## UI Screens

### 1. Dashboard — User-Built Insights

**Route:** `/dashboard/{companyId}` (existing page, enhanced)

The dashboard combines a customizable KPI strip, an AI-powered ask bar, and a user-curated chart grid. No static pre-built charts — users build their own dashboard by asking questions and pinning the results.

**Layout:**

```
+-----------------------------------------------------------+
|  Pinned Metrics (customizable, 1-4 KPIs)                  |
|  [Open Quotes: 12] | [Jobs Not Started: 5] | [Revenue: $14K]  |
|  + Add metric / Edit metrics                              |
+-----------------------------------------------------------+
|  Ask about your shop data...                     [Send]   |
|  [Revenue trend] [Top customer?] [Jobs behind?] [Quote]   |
|                                                           |
|  +-----------------------------------------------------+ |
|  | >> Revenue trend this month               [Save]     | |
|  |                                                      | |
|  |  +----------------------------------------------+   | |
|  |  |     Area chart: Revenue by week               |   | |
|  |  +----------------------------------------------+   | |
|  |  "Revenue is up 12% this week..."                    | |
|  +-----------------------------------------------------+ |
+-----------------------------------------------------------+
|  Your Charts                                              |
|                                                           |
|  +------------------------+ +------------------------+    |
|  | Revenue trend       [x] | | Top customer        [x] |  |
|  | ~~~~ area chart ~~~~~~~ | | --- bar chart --------- |  |
|  | "Up 12% this week"      | | "Acme: 38% of rev"     |  |
|  +------------------------+ +------------------------+    |
|  +------------------------+                               |
|  | Job pipeline        [x] |                              |
|  |    donut chart          |                              |
|  | "4 in progress..."      |                              |
|  +------------------------+                               |
+-----------------------------------------------------------+
```

**Empty state (no saved charts yet):**

```
+-----------------------------------------------------------+
|  Your Charts                                              |
|  + - - - - - - - - - - - - - - - - - - - - - - - - - +   |
|  | Ask a question above and save the answer to build  |   |
|  | your dashboard.                                    |   |
|  + - - - - - - - - - - - - - - - - - - - - - - - - - +   |
+-----------------------------------------------------------+
```

**Pinned Metrics (PinnedMetrics component):**
- Flat KPI strip at top of dashboard (no card wrappers)
- Up to 4 pinned metrics (one page) selected via MetricPickerModal; the six available metrics page through 4 at a time via a pager
- Available metrics: open_quotes, not_started_jobs, in_progress_jobs, revenue, completed_jobs, overdue_jobs
- Persisted per user to `user_preferences.preferences.dashboard_pinned_metrics` (Supabase); the Today / This Week period toggle persists to `preferences.dashboard_metric_periods`
- "+ Add metric" / "Edit metrics" text link below

**Ask Bar (InsightsChat component):**
- Text input with Send button (also submits on Enter)
- Pre-canned example prompt chips below the input (click to submit)
- Response appears inline: AI text + optional chart in a Card
- Save button only shown when response includes a chart (`chart_config` is not null)
- Save icon saves to "Your Charts" grid (no saved-insight limit — save always proceeds)
- "Saved" text feedback shown after successful save; card auto-dismisses after 1.5s
- Rotating loading messages while AI processes ("Querying your data...", "Analyzing results...", "Building your answer..." — cycles every 2 seconds)
- Single Q&A per interaction (no conversation history for MVP)
- Error state: inline Alert with error message

**Your Charts grid (InsightsSection component):**
- Shows only user-saved insight cards (the current user's own — RLS-scoped by `auth.uid()`)
- "Your Charts" header (no count indicator; there is no saved-insight cap)
- 2-column responsive grid (1-column on mobile)
- Each card: title (question) + chart + AI summary + x remove button
- Empty state: dashed border box with message

**Example prompt chips:**
- "Revenue trend"
- "Top customer?"
- "Jobs behind schedule?"
- "Quote pipeline worth?"

### 3. Chart Types

Using MUI X Charts (`@mui/x-charts`):

| Insight | Chart Type | MUI Component |
|---|---|---|
| Revenue Trend | Area/Line chart | `<LineChart>` or `<AreaChart>` |
| Job Pipeline | Donut chart | `<PieChart>` with inner radius |
| Quote Conversion | Sparkline + big number | `<SparkLineChart>` + `<Typography>` |
| At-Risk Jobs | Alert list (no chart) | MUI `<Alert>` + `<List>` |
| Inventory Alerts | Alert list (no chart) | MUI `<Alert>` + `<List>` |
| Customer Revenue | Horizontal bar chart | `<BarChart>` with `layout="horizontal"` |
| Part Profitability | Grouped bar chart | `<BarChart>` |
| Resource Utilization | Bar chart | `<BarChart>` |

All charts use the MUI theme palette — no hardcoded colors.

---

## API Endpoints

All endpoints require a valid Supabase JWT and verify the user has `owner`, `admin`, or `user` role for the company. Operators are excluded.

### `POST /api/insights/{company_id}/chat`

Submit a natural language question. The AI generates SQL to query the database and returns a natural language answer with an optional chart.

**Request:**

```json
{
  "question": "What's my most profitable customer?"
}
```

**Response:**

```json
{
  "answer": "Your most profitable customer is Acme Manufacturing, generating $45,200 in revenue across 12 jobs this quarter. They represent 38% of your total revenue. Ajax Industries is second at $28,900 (24%).",
  "chart_config": {
    "chart_type": "bar_horizontal",
    "data": [
      {"label": "Acme Manufacturing", "value": 45200},
      {"label": "Ajax Industries", "value": 28900},
      {"label": "Precision Corp", "value": 18400}
    ],
    "x_label": "Revenue ($)",
    "y_label": "Customer"
  },
  "tool_calls": ["execute_sql"],
  "provider": "anthropic",
  "tokens_used": 1240
}
```

`POST /{company_id}/chat` is the **only** FastAPI insights route. **Chat is stateless today** — each request is a single, independent Q&A with no persisted conversation. There is no `chat/history` endpoint (none is defined in `api/routes/insights_routes.py`, and no frontend caller requests one); `ai_chat_queries` logs turns for analytics/cost only, it is not read back as chat history. Saved-insights CRUD is **not** a backend route either — it runs client-side against the RLS-scoped `saved_insights` table via `utils/savedInsightsAccess.ts` (`saveInsight` / `getSavedInsights` / `deleteSavedInsight`), consistent with the Supabase-first architecture rule. If multi-turn history is added later (Phase 1), it would be scoped **per user within a company** — mirroring the `saved_insights` `user_id + auth.uid()` RLS model.

---

## Rate Limiting & Cost Controls

| Control | Value | Rationale |
|---|---|---|
| Chat queries per company per hour | 20 | Prevents runaway AI costs for a single company |
| Max tokens per chat query | 4,000 | Keeps individual responses bounded |
| SQL statement timeout | 5 seconds | Prevents long-running queries |
| SQL row limit | 200 rows | Bounds data transfer and AI context |

Rate limiting is enforced at the API layer by counting recent `ai_chat_queries` rows:

```python
# Check rate limit
one_hour_ago = datetime.utcnow() - timedelta(hours=1)
count = supabase.table("ai_chat_queries") \
    .select("id", count="exact", head=True) \
    .eq("company_id", company_id) \
    .gte("created_at", one_hour_ago.isoformat()) \
    .execute()

if count.count >= 20:
    raise HTTPException(429, "Rate limit exceeded. Try again later.")
```

---

## Backend Files

```
api/
+-- routes/
|   +-- insights_routes.py          # Chat endpoint (POST /{company_id}/chat) — submit only; no history route
+-- services/
|   +-- ai/
|   |   +-- base_provider.py        # chat_with_tools() abstract method
|   |   +-- claude_provider.py      # chat_with_tools() implementation + execute_sql dispatch
|   |   +-- openai_provider.py      # Future: chat_with_tools() for OpenAI
|   |   +-- gemini_provider.py      # Future: chat_with_tools() for Gemini
|   |   +-- factory.py              # 'insights_chat' feature support
|   +-- insights_service.py         # Metric functions (chat fallback) + chat system prompt + execute_sql_tool()
+-- models/
|   +-- insights_models.py          # Pydantic chat request/response schemas
+-- tools/
    +-- metric_tools.py             # METRIC_TOOLS (schemas) + CHAT_TOOLS (execute_sql only)
    +-- schema_context.py           # Database schema string for AI system prompt (20 tables)
    +-- sql_validator.py            # SQL validation before execution
    +-- sql_executor.py             # asyncpg connection pool + parameterized query execution
```

### Frontend Files

```
components/
+-- dashboard/
|   +-- InsightsSection.tsx         # Saved chart cards grid + empty state
|   +-- PinnedMetrics.tsx           # Customizable KPI strip (1-4 metrics)
|   +-- MetricPickerModal.tsx       # Modal for selecting pinned metrics
+-- insights/
    +-- InsightCard.tsx             # Individual card: title + chart + AI summary
    +-- InsightsChat.tsx            # Ask bar: input + example chips + inline response + save
    +-- InsightChart.tsx            # MUI X Charts wrapper rendering from chart_config

utils/
+-- insightsAccess.ts              # Chat API helpers
+-- alertsAccess.ts                # Client-side at-risk jobs + inventory alerts (AlertBadge)
+-- savedInsightsAccess.ts         # Saved insights CRUD via Supabase (RLS scoped)
+-- dashboardAccess.ts             # Metric values + pinned metric keys (user_preferences)
```

---

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | Yes |
| `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (backend) | Yes |
| `ANTHROPIC_API_KEY` | Claude API key for AI features | Yes |
| `AI_READONLY_DATABASE_URL` | PostgreSQL connection string for read-only AI queries | Yes (for chat) |

The `AI_READONLY_DATABASE_URL` should point to a read-only Postgres role (see Database Setup below).

---

## Database Setup: Read-Only AI Role

The text-to-SQL chat feature requires a read-only database role to execute AI-generated queries safely.

**Migration:** the `jigged_ai_readonly` role and its per-table `GRANT SELECT` / `ai_readonly_select` RLS policies live in the baseline migration (`supabase/migrations/20260527151536_baseline.sql`). Set the environment variable to point at that role:
```
AI_READONLY_DATABASE_URL=postgresql://jigged_ai_readonly:your_password@db.xxx.supabase.co:5432/postgres
```

---

## AI System Prompt (for chat)

The chat system prompt includes:

1. **Role description** — Business analyst for a precision manufacturing shop
2. **Database schema** — All 20 tables with column names, types, enum values, foreign key relationships, and important notes (imported from `schema_context.py`)
3. **SQL guidelines** — Use `$1` for company_id, join patterns for tables without company_id
4. **Example queries** — 4 common patterns for reference
5. **Response guidelines** — Text-first: a one-line prose answer by default, with a chart_config only when there are >=3 points and a chart helps. Plain prose only — no markdown tables, bold, or other markdown (the UI renders plain text). Highlight actionable insights

```
You are a business analyst for a small precision manufacturing shop.
You answer questions by querying the company's PostgreSQL database using the
execute_sql tool.

[Full database schema with 20 tables, columns, types, relationships]

Guidelines:
- Always use execute_sql to get real data. Never make up numbers.
- Use $1 as a placeholder for company_id in all queries.
- Keep summaries to 1-3 sentences. Shop owners are busy.
- Default to a one-line prose answer; include a chart_config only when there are >=3 data points and a chart helps (trend, comparison, part-of-whole). Single facts and 1-2 values stay text.
- Highlight actionable insights: what should the owner DO about this data?
- Compare to previous periods when relevant.
- Flag risks prominently (at-risk jobs, low inventory, revenue decline).
- Use plain language. Avoid jargon. These are machinists, not MBAs.
- Write plain prose. Never use markdown tables, bold (**), or any markdown; for multiple values use chart_config plus a one-line summary or a short inline list.
- Only query tables in the schema above; never reference user/auth/access tables.
```

---

## Phasing

### Phase 0 — MVP

- [x] `@mui/x-charts` integration with dark theme
- [x] `ai_chat_queries` table with rate limiting
- [x] Rate limiting: 20 queries/company/hour
- [x] PinnedMetrics component with customizable KPI strip (1-4 metrics)
- [x] MetricPickerModal for metric selection
- [x] Ask bar on dashboard with example prompt chips (InsightsChat)
- [x] Inline AI response with optional chart + save button (chart responses only)
- [x] Saved insights CRUD: save (no cap), list, delete — per user within a company (RLS `auth.uid()`)
- [x] "Your Charts" grid showing only user-saved insights
- [x] Empty state with message
- [x] Loading states with rotating messages for all components
- [x] Mobile-responsive layout (1-column on small screens)
- [x] Text-to-SQL architecture: schema context, SQL validator, SQL executor
- [x] `execute_sql` tool for AI chat with safety layers
- [x] Read-only database role for AI queries
- [x] `chat_with_tools()` added to AI provider base class + Claude implementation

### Phase 1 — Enhanced

- [x] Header alert badge for at-risk jobs and low inventory (AlertBadge popover) — Supabase-first, no AI
- [ ] Additional chart types (scatter, heatmap for schedule visualization)
- [ ] Multi-turn conversation history in chat (would be scoped per user within a company, mirroring `saved_insights` — chat is stateless today)
- [ ] Predefined tools for complex business logic queries (based on user behavior)
- [ ] OpenAI and Gemini `chat_with_tools()` implementations
- [ ] Export charts as PNG images
- [ ] Date range picker for chart queries (not just fixed periods)
- [ ] Drag/reorder saved chart cards

### Phase 2 — Predictive

- [ ] Trend forecasting (predict next month's revenue based on pipeline)
- [ ] Anomaly detection (automatic alerts when metrics deviate from baseline)
- [ ] Scheduled insight digests (weekly email summary to admins)
- [ ] Operator performance analytics (for admin view — not operator-facing)
- [ ] Comparative analytics (month-over-month, customer vs customer)
- [ ] Natural language -> chart builder ("Show me a bar chart of revenue by customer for Q1")

---

## Performance Targets

| Metric | Target |
|---|---|
| Individual metric function execution | < 1 second |
| Chat response end-to-end | < 8 seconds |
| SQL query execution | < 5 seconds (enforced timeout) |
| AlertBadge fetch (at-risk jobs + inventory) | < 500ms (Supabase, no AI) |

These targets assume the small data volumes typical of target shops (1-50 users, hundreds of jobs, not millions).

---

## Validation Rules

- All API endpoints require authenticated JWT with `owner`, `admin`, or `user` role
- `company_id` in URL must match a company the user has access to
- Chat question must be non-empty and under 500 characters
- Chat rate limit: 20 queries per company per hour (default; per-company override via `settings.ai_limits.chat_per_hour`)
- AI-generated SQL validated before execution (see SQL Validation Rules)
- SQL executed via read-only role with parameterized company_id

---

## Error Handling

| Scenario | Behavior |
|---|---|
| AI provider unavailable | Chat returns 503 with retry-after. |
| AI rate limited by provider | Chat returns 503 with retry-after. |
| No data available | Chat answer explains the gap; AlertBadge shows "All clear". |
| Chat question unrelated to data | AI responds: "I can only answer questions about your shop's data. Try asking about revenue, jobs, quotes, customers, or inventory." |
| SQL validation fails | AI sees the error and can retry with corrected SQL (up to 5 iterations) |
| SQL execution timeout | Returns error to AI; AI can simplify the query or explain the limitation |
| SQL references blocked table | Validator rejects; AI informed and retries with allowed tables |
| Company has no AI config | Falls back to Anthropic/Claude (default provider behavior from factory.py) |
| Text-only response (no chart) | Save button hidden — only chart responses can be saved to dashboard |

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit -> save -> reload -> persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #336.

Because every AI call in this module must be user-initiated (repo rule: no on-mount AI), the chat ACs are all phrased off an explicit gesture — a Send click, an Enter keypress, or an example-chip click — never a render/mount.

**Pinned Metrics (edit -> save -> reload -> persists)**

- [ ] **Given** the dashboard, **when** `PinnedMetrics` mounts, **then** it renders one page of up to 4 metric scorecards from the user's stored selection (defaults include Overdue Jobs when nothing is stored) — *read-path/default verified by `__tests__/utils/dashboardPinnedMetrics.test.ts > 'getPinnedMetricKeys — Overdue-selectable migration' > 'returns defaults (which include Overdue) when no prefs are stored'`*.
- [ ] **Given** a user editing their pinned metrics in `MetricPickerModal` and saving, **when** the selection is persisted, **then** it is written to `user_preferences.preferences.dashboard_pinned_metrics` (Supabase upsert keyed on `user_id`) so a reload restores it — *write-path persistence verified by `__tests__/utils/dashboardPinnedMetrics.test.ts > 'getPinnedMetricKeys — Overdue-selectable migration' > 'persists the folded list AND stamps the migration flag'` (asserts the upsert payload); modal-driven `setPinnedMetricKeys` reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** the metric picker reopened with the same `currentKeys` after adding a metric in-modal without saving, **when** it re-renders, **then** the unsaved addition is dropped and the selection re-seeds from `currentKeys` — *verified by `__tests__/components/dashboard/MetricPickerModal.test.tsx > 'MetricPickerModal — reopen re-seeds selection from currentKeys' > 'drops an in-modal-added metric when reopened with the SAME currentKeys (no stale selection)'`*.
- [ ] **Given** stored legacy metric keys (e.g. `weekly_revenue`, `active_jobs`), **when** `getPinnedMetricKeys` reads them, **then** they are migrated to current keys and the Overdue metric is folded in once — *verified by `__tests__/utils/dashboardPinnedMetrics.test.ts > 'getPinnedMetricKeys — Overdue-selectable migration' > 'still migrates legacy keys while folding Overdue in'`*.
- [ ] **Given** a user who deliberately removed Overdue Jobs (migration flag set), **when** metrics reload, **then** Overdue is NOT re-added — *verified by `__tests__/utils/dashboardPinnedMetrics.test.ts > 'getPinnedMetricKeys — Overdue-selectable migration' > 'does NOT re-add Overdue once the migration flag is set (deliberate removal sticks)'`*.
- [ ] **Given** the Today / This Week period toggle, **when** a user switches period, **then** the choice persists to `user_preferences.preferences.dashboard_metric_periods` and re-fetches time-aware metric values — *automation-pending (`setMetricTimePeriod` / `getPinnedMetricValues`)*.

**Ask Bar (InsightsChat) — chat is user-initiated only**

- [ ] **Given** the ask bar, **when** a user types a question and clicks Send (or presses Enter), **then** exactly one `POST /api/insights/{companyId}/chat` fires and the response (text + optional chart) renders inline — no chat call happens on mount — *manual: type a question, click Send; confirm a single network call to `/api/insights/{id}/chat` in `components/insights/InsightsChat.tsx` (`submitChatQuery`)*.
- [ ] **Given** an example-prompt chip, **when** the user clicks it, **then** that prompt is submitted immediately (not merely populated into the input) — *manual: click a chip; `handleChipClick` calls `handleSubmit(prompt)` in `components/insights/InsightsChat.tsx`*.
- [ ] **Given** a chat response that includes a validated `chart_config`, **when** it renders, **then** a "Save to dashboard" button appears; **given** a text-only response, **then** no save button is shown — *manual: the save button is gated on `result.chart_config` in `components/insights/InsightsChat.tsx`*.
- [ ] **Given** an inline chart response, **when** the user clicks "Save to dashboard", **then** it is inserted into `saved_insights` and "Saved to dashboard" feedback shows before the inline card auto-dismisses (~1.5s) — *write path automation-pending (`saveInsight` in `utils/savedInsightsAccess.ts`); reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** an AI request in flight, **when** it is processing, **then** rotating loading messages ("Querying your data..." → "Analyzing results..." → "Building your answer...") cycle every 2s — *manual: rotation driven by the `loading` interval in `components/insights/InsightsChat.tsx`*.
- [ ] **Given** a submitted question, **when** the backend answers, **then** the interaction (question, tool_calls, response, chart_config, provider/model/tokens) is logged to `ai_chat_queries` — *manual: insert in the `chat` handler of `api/routes/insights_routes.py`*.
- [ ] **Given** a company at its hourly cap, **when** another chat query arrives, **then** the backend returns 429 with the company's actual limit in the message and a `Retry-After` header, and the frontend surfaces that message — *backend verified by `api/tests/unit/test_insights_rate_limit.py > 'TestCheckChatRateLimit' > 'test_at_limit_raises_429_with_retry_after'`; under-limit pass verified by `api/tests/unit/test_insights_rate_limit.py > 'TestCheckChatRateLimit' > 'test_under_limit_passes'`*.

**Your Charts grid (InsightsSection) — saved-insight create/delete**

- [ ] **Given** the "Your Charts" section, **when** the user has saved insights, **then** it renders only user-saved cards in a 2-column (desktop) / 1-column (mobile) grid, each showing the question as title + chart + AI summary + × remove — *manual: `getSavedInsights` + `InsightCard` mapping in `components/dashboard/InsightsSection.tsx` (no pre-built static cards)*.
- [ ] **Given** a saved insight card, **when** the user clicks × remove, **then** the row is deleted from `saved_insights` and the grid re-pulls from that single source — *write path automation-pending (`deleteSavedInsight` in `utils/savedInsightsAccess.ts`); reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** no saved insights, **when** the section renders, **then** a dashed-border empty state reads "Ask a question above and save the answer to build your dashboard." — *manual: empty branch in `components/dashboard/InsightsSection.tsx`*.
- [ ] **Given** a chart config whose declared `x_key`/`y_key` are missing from the rows, **when** `InsightChart` renders it, **then** it fails loud with "No chartable data" instead of blank labels/zero bars — *verified by `__tests__/components/insights/InsightChart.test.tsx > 'InsightChart' > 'fails loud (no blank chart) when x_key/y_key are missing from the rows'`*.
- [ ] **Given** an empty-data chart config, **when** `InsightChart` renders, **then** it shows "No data available for chart" (never a blank chart) — *verified by `__tests__/components/insights/InsightChart.test.tsx > 'InsightChart' > 'shows an empty state when there is no data'`*.
- [ ] **Given** a valid nominal config, **when** it renders, **then** a chart is drawn with no fallback text, using MUI theme colors — *verified by `__tests__/components/insights/InsightChart.test.tsx > 'InsightChart' > 'renders the chart (no fallback text) for a valid config'`*.

**Chart decisioning (constrained renderer — backend)**

- [ ] **Given** a model-proposed chart over degenerate data (single point, single category, all-equal, all-zero, or a dominant 2-point pair), **when** the backend validates it, **then** the chart is dropped and the prose answer is kept — never a blank card — *verified by `api/tests/unit/test_chart_config.py > 'TestValidateChartConfig' > 'test_single_point_downgraded'` AND `api/tests/unit/test_chart_config.py > 'TestValidateChartConfig' > 'test_single_dominant_two_points_downgraded'`*.
- [ ] **Given** a valid multi-category config, **when** validated, **then** it is kept — *verified by `api/tests/unit/test_chart_config.py > 'TestValidateChartConfig' > 'test_valid_multi_category_kept'`*.
- [ ] **Given** a kept config with a temporal x-axis, **when** the chart type is selected, **then** it becomes an area chart deterministically (overriding the model's choice) — *verified by `api/tests/unit/test_chart_config.py > 'TestSelectChartType' > 'test_temporal_x_becomes_area'`*.
- [ ] **Given** a kept config with long nominal labels, **when** the chart type is selected, **then** it becomes a horizontal bar; short labels become a vertical bar — *verified by `api/tests/unit/test_chart_config.py > 'TestSelectChartType' > 'test_long_labels_become_horizontal'` AND `api/tests/unit/test_chart_config.py > 'TestSelectChartType' > 'test_nominal_short_labels_become_bar'`*.
- [ ] **Given** the full chat pipeline on the "top customer" incident data, **when** it runs, **then** the chart is downgraded and inline bold markdown is stripped from the answer — *verified by `api/tests/unit/test_chart_config.py > 'TestChatPipelineComposition' > 'test_top_customer_incident_downgrades_and_strips_bold'`*.
- [ ] **Given** an AI answer containing markdown tables/bold/code, **when** it is cleaned for the plain-text UI, **then** tables flatten to `cell — cell`, bold unwraps, and part numbers like `PART_101` survive — *verified by `api/tests/unit/test_chat_formatting.py > 'TestFlattenMarkdownTables' > 'test_markdown_table_flattened'` AND `api/tests/unit/test_chat_formatting.py > 'TestStripInlineMarkdown' > 'test_part_numbers_and_multiplication_preserved'`*.

**Security & SQL safety**

- [ ] **Given** an AI-generated statement, **when** it is validated, **then** only `SELECT`/`WITH` is accepted and mutation keywords (`INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`) are rejected — *verified by `api/tests/unit/test_sql_validator.py > 'TestBasicValidation' > 'test_simple_select_accepted'` AND `api/tests/unit/test_sql_validator.py > 'TestForbiddenStatements' > 'test_mutation_keywords_rejected'`*.
- [ ] **Given** a query missing the `$1` company placeholder, **when** validated, **then** it is rejected; a query with `$1` present is accepted — *verified by `api/tests/unit/test_sql_validator.py > 'TestCompanyIdPlaceholder' > 'test_missing_placeholder_rejected'` AND `api/tests/unit/test_sql_validator.py > 'TestCompanyIdPlaceholder' > 'test_placeholder_present_accepted'`*.
- [ ] **Given** a query referencing a table outside the allowlist (or a sensitive auth/AI table, in any join form), **when** validated, **then** it is rejected — *verified by `api/tests/unit/test_sql_validator.py > 'TestTableAllowlist' > 'test_system_table_rejected'` AND `api/tests/unit/test_sql_validator.py > 'TestSensitiveTableDenylist' > 'test_sensitive_table_in_comma_join_rejected'`*.
- [ ] **Given** a validated query, **when** it executes via the read-only `jigged_ai_readonly` connection, **then** the row limit (200) is enforced — *verified by `api/tests/integration/test_sql_executor.py > 'TestQueryExecution' > 'test_row_limit_enforced'`*.
- [ ] **Given** a query that fails validation at execution time, **when** run through the executor, **then** it returns a structured error rather than touching the DB — *verified by `api/tests/integration/test_sql_executor.py > 'TestQueryExecution' > 'test_validation_failure_returns_error'`*.
- [ ] **Given** a full chat turn where the model requests a SQL query, **when** the pipeline runs, **then** the query executes and its result flows back into the answer with `execute_sql` recorded in `tool_calls` — *verified by `api/tests/integration/test_insights_chat.py > 'TestChatPipeline' > 'test_full_chat_with_sql_tool'`*.
- [ ] **Given** a SQL error mid-turn, **when** the model sees it as a tool result, **then** it recovers gracefully within the iteration budget — *verified by `api/tests/integration/test_insights_chat.py > 'TestChatPipeline' > 'test_chat_recovers_from_sql_error'`*.
- [ ] **Given** RLS on `saved_insights` and `ai_chat_queries`, **when** a user reads/writes, **then** they are scoped to their own rows / their company — *manual: `ENABLE ROW LEVEL SECURITY` + the "own saved insights" / "own company chat history" policies in `supabase/schema.prod.sql`*.

**AI provider gating & config**

- [ ] **Given** a company with no explicit AI settings, **when** the chat endpoint reads its config, **then** AI Insights defaults ON (opt-out) with the default hourly limit — *verified by `api/tests/unit/test_insights_rate_limit.py > 'TestGetCompanyAiSettings' > 'test_defaults_when_settings_null'` AND `api/tests/unit/test_insights_rate_limit.py > 'TestGetCompanyAiSettings' > 'test_opt_out_default_on_when_key_absent'`*.
- [ ] **Given** a company with `settings.features.ai_insights = false`, **when** a chat query arrives, **then** the endpoint is disabled (403) — *disable-flag verified by `api/tests/unit/test_insights_rate_limit.py > 'TestGetCompanyAiSettings' > 'test_explicit_false_disables'`*.
- [ ] **Given** a company with `settings.ai_limits.chat_per_hour` set, **when** the limit is read, **then** the custom value is used; an invalid value falls back to the default — *verified by `api/tests/unit/test_insights_rate_limit.py > 'TestGetCompanyAiSettings' > 'test_custom_limit_read'` AND `api/tests/unit/test_insights_rate_limit.py > 'TestGetCompanyAiSettings' > 'test_invalid_limit_falls_back'`*.
- [ ] **Given** a transient error reading company AI settings, **when** the endpoint evaluates the gate, **then** it fails open (enabled, default limit) so a DB blip never dark-launches the feature off — *verified by `api/tests/unit/test_insights_rate_limit.py > 'TestGetCompanyAiSettings' > 'test_fails_open_on_read_error'`*.

**Saved-insight limit & scoping (owner-resolved: no cap, per-user)**

- [ ] **Given** a user who already has several saved insights, **when** they pin another chart, **then** the save proceeds unconditionally — there is **no cap** (no `(N/5)` count header, no 5/5 disable, no DB unique/check constraint); `saveInsight` inserts every time — *automation-pending; shipped path is the unconditional insert in `utils/savedInsightsAccess.ts` (`saveInsight`), with no count/disable gate in `components/insights/InsightsChat.tsx` or `components/dashboard/InsightsSection.tsx`*.
- [ ] **Given** two users in the same company, **when** each saves insights and reloads "Your Charts", **then** each sees only their own pinned cards (per-user within the company) — `getSavedInsights` filters by `company_id` and the `saved_insights` RLS `SELECT` policy narrows to `user_id = auth.uid()` — *automation-pending; scoping enforced by `getSavedInsights` in `utils/savedInsightsAccess.ts` + the "Users can read own saved insights" policy (`user_id = auth.uid()`) in `supabase/schema.prod.sql`*.

---

## Open Questions

| # | Question | Status |
|---|---|---|
| 1 | Should insight cards be configurable per user or per company? | **Resolved: Per user within a company.** `saved_insights` is scoped by `user_id` with RLS `auth.uid()` policies — each user builds and sees only their own pinned cards (not a company-shared set). |
| 2 | Should chat support follow-up questions (multi-turn)? | **Resolved: No for MVP.** Single Q&A per interaction. Phase 1 adds multi-turn. |
| 3 | What happens when a company has very little data? | **Resolved:** Empty state messaging per card. Minimum thresholds: revenue trend needs 2+ weeks of shipped jobs, conversion rate needs 5+ quotes. |
| 4 | Should insights be available in Demo Mode? | **Resolved: Yes.** Demo Mode uses a hidden demo company with its own `company_id`. All insight queries naturally scope to the active company — no special filtering needed. See [Demo Mode PRD](./demo-mode.md). |
| 5 | Token cost budget per company per month? | **Open.** Need to establish pricing tier limits once usage patterns are observed. |
| 6 | When should predefined tools be added alongside execute_sql? | **Resolved:** Monitor user behavior patterns. Add predefined Python tools when SQL alone is too complex or error-prone for specific query types. Tracked in GitHub issue. |

---

## Success Metrics

- **Insight engagement:** % of admin sessions that view insight cards on dashboard
- **Chat adoption:** avg chat queries per active company per week
- **SQL success rate:** % of AI-generated SQL queries that execute without errors
- **Time on dashboard:** increase in time spent on dashboard page (indicates value)
- **Feature retention:** % of companies using insights after 30 days
- **AI accuracy:** user satisfaction with AI summaries (future: thumbs up/down feedback)
