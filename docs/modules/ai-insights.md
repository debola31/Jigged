# AI Insights & Charts Module

## Overview

The AI Insights module gives shop owners and administrators an intelligent data analyst built into their dashboard. Users ask questions in plain English and the AI returns text answers with optional charts. Users pin the answers they find valuable to build a personalized dashboard — so a 50-year-old shop owner who's great at machining doesn't need to be great at spreadsheets.

**Priority:** Should Have (FR-17: Dashboard with AI Insights), Could Have (FR-18: Natural Language Queries)

**Dependencies:** Dashboard, Jobs, Quotes, Customers, Parts, Operations, Inventory modules

**Database Tables:** `ai_insight_cache`, `ai_chat_queries`, `ai_config` (existing), `saved_insights`

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
| Admin | Have insights cached so the page loads fast | I'm not waiting for AI every time I open the dashboard |
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
3. **Table allowlist** — Only 17 business tables. Auth/system/AI tables blocked.
4. **Read-only Postgres role** — `jigged_ai_readonly` with SELECT-only grants on allowed tables
5. **Statement timeout** — 5 seconds via asyncpg connection config
6. **Row limit** — 200 rows max, enforced programmatically
7. **Self-correction** — AI sees SQL errors as tool results and can retry (up to 5 iterations)

### Two Code Paths: Chat vs Dashboard Cache

| | Chat (Ask Bar) | Dashboard Cache |
|---|---|---|
| **How it works** | AI generates SQL via `execute_sql` tool | Direct Python metric functions |
| **Tools** | `CHAT_TOOLS` (text-to-SQL) | `METRIC_TOOLS` (predefined functions) |
| **Flexibility** | Any question | Fixed 5 insight types |
| **Speed** | 3-8 seconds (AI + SQL) | < 1 second (cached) |

The dashboard cache path (`compute_dashboard_insights`) still uses the 10 predefined metric functions for fast, predictable card rendering. Only the chat path uses text-to-SQL.

### Chat Flow

```
1. User asks question in ask bar
       |
       v
2. FastAPI backend constructs prompt with:
   - Database schema context (17 tables, columns, types, relationships)
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
   - Natural language summary
   - Optional chart_config (chart type + formatted data)
       |
       v
7. Frontend renders text + optional MUI X Chart
   - Save button only shown when chart_config exists
```

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
| Table allowlist | Only 17 business tables (see below) |
| Company scoping | Must contain `$1` at least once |
| Nesting limit | Max 3 levels of subquery nesting |

### Allowed Tables (17 business tables)

`companies`, `customers`, `quotes`, `quote_attachments`, `parts`, `routings`, `routing_nodes`, `routing_edges`, `jobs`, `job_operations`, `job_attachments`, `operation_types`, `resource_groups`, `operator_sessions`, `inventory_items`, `inventory_unit_conversions`, `inventory_transactions`

### Excluded Tables (auth/system/AI)

`user_company_access`, `user_preferences`, `system_admins`, `ai_chat_queries`, `ai_insight_cache`, `ai_config`, `saved_insights`, `demo_data_templates`

### Adding a New Table to AI Scope

When a new business table is added to the database and should be queryable by the AI chat:

1. Add table name to `ALLOWED_TABLES` in `api/tools/schema_context.py`
2. Add table description (columns, types, relationships) to `SCHEMA_CONTEXT` string in same file
3. Create a new migration with:
   - `GRANT SELECT ON <table> TO jigged_ai_readonly`
   - `CREATE POLICY ai_readonly_select ON <table> FOR SELECT TO jigged_ai_readonly USING (true)`

---

## Pre-defined Metric Functions (Dashboard Cache Only)

These functions are used by `compute_dashboard_insights()` for the 5 cached dashboard cards. They are **not** used by the chat path (which uses text-to-SQL instead).

| Function | Description | Parameters | Returns |
|---|---|---|---|
| `get_revenue_by_period` | Revenue from shipped jobs over time | `period_type` (daily/weekly/monthly), `num_periods` (default: 8) | `[{period, amount, job_count}]` |
| `get_job_status_distribution` | Current job counts by status | — | `[{status, count}]` |
| `get_quote_conversion_rate` | Quotes accepted vs total | `period_type`, `num_periods` | `{current_rate, previous_rate, trend_direction, periods: [{period, accepted, total, rate}]}` |
| `get_job_cycle_times` | Avg days from created -> shipped | `period_type`, `num_periods` | `[{period, avg_days, job_count}]` |
| `get_customer_revenue_breakdown` | Revenue ranked by customer | `period_type`, `num_periods`, `limit` (default: 10) | `[{customer_name, revenue, job_count, pct_of_total}]` |
| `get_part_profitability` | Revenue vs estimated labor cost by part | `limit` (default: 10) | `[{part_name, description, revenue, estimated_cost, margin_pct}]` |
| `get_inventory_alerts` | Items at or below reorder point | — | `[{item_name, sku, quantity, reorder_point, unit}]` |
| `get_at_risk_jobs` | Jobs behind schedule | — | `[{job_number, customer_name, pct_complete, estimated_completion, severity}]` |
| `get_resource_utilization` | Booked hours by resource group | `period_type`, `num_periods` | `[{resource_group, booked_hours, job_count}]` |
| `get_revenue_forecast` | Pipeline value from open quotes | — | `{total_pipeline, weighted_pipeline, quote_count, avg_conversion_rate}` |

All functions implicitly receive `company_id` from the authenticated request context.

### At-Risk Job Severity Calculation

```
severity = based on:
  - % complete vs % of estimated time elapsed
  - "critical" if < 50% complete and > 80% of estimated time used
  - "warning" if < 75% complete and > 75% of estimated time used
  - "on_track" otherwise

Estimated time = sum of (estimated_run_hours_per_unit x job quantity) across job_operations
Actual progress = sum of quantity_completed / job quantity across job_operations
```

---

## Data Model

> **Migration files:** `supabase/migrations/20260305000000_create_ai_insights_tables.sql` and `supabase/migrations/20260305000001_create_ai_readonly_role.sql`

### Table: `ai_insight_cache`

Caches pre-computed dashboard insight cards to avoid calling the AI on every page load.

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key, `gen_random_uuid()` |
| company_id | UUID | Yes | FK to `companies` |
| insight_type | VARCHAR(50) | Yes | `'revenue_trend'`, `'job_pipeline'`, `'quote_conversion'`, `'at_risk_jobs'`, `'inventory_alerts'` |
| metric_data | JSONB | Yes | Raw output from the metric function |
| ai_summary | TEXT | Yes | AI-generated one-liner interpretation |
| chart_config | JSONB | No | `{chart_type, data, x_axis, y_axis, ...}` for frontend rendering |
| computed_at | TIMESTAMPTZ | Yes | When this insight was computed |
| expires_at | TIMESTAMPTZ | Yes | Cache expiry (default: `computed_at + 1 hour`) |

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

User-pinned chart cards on the dashboard (max 5 per user per company).

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
|  Your Charts (3/5)                                        |
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
- 1-4 customizable metrics selected via MetricPickerModal
- Available metrics: open_quotes, not_started_jobs, in_progress_jobs, revenue, completed_jobs, overdue_jobs
- Persisted to localStorage per user
- "+ Add metric" / "Edit metrics" text link below

**Ask Bar (InsightsChat component):**
- Text input with Send button (also submits on Enter)
- Pre-canned example prompt chips below the input (click to submit)
- Response appears inline: AI text + optional chart in a Card
- Save button only shown when response includes a chart (`chart_config` is not null)
- Save icon saves to "Your Charts" grid (max 5)
- Save disabled at 5/5 with tooltip: "Remove a chart below to save new ones"
- "Saved" text feedback shown after successful save; card auto-dismisses after 1.5s
- Rotating loading messages while AI processes ("Querying your data...", "Analyzing results...", "Building your answer..." — cycles every 2 seconds)
- Single Q&A per interaction (no conversation history for MVP)
- Error state: inline Alert with error message

**Your Charts grid (InsightsSection component):**
- Shows only user-saved insight cards
- "Your Charts (N/5)" header with count indicator
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

### `GET /api/insights/{company_id}/dashboard`

Returns all 5 pre-built insight cards. Serves from cache if not expired; otherwise computes fresh.

**Response:**

```json
{
  "insights": [
    {
      "type": "revenue_trend",
      "summary": "Revenue is up 12% this week ($14,200 vs $12,680 last week), driven by Acme Manufacturing's bracket order.",
      "metric_data": [
        {"period": "2026-02-02", "amount": 8500, "job_count": 3},
        {"period": "2026-02-09", "amount": 12680, "job_count": 5}
      ],
      "chart_config": {
        "chart_type": "area",
        "x_key": "period",
        "y_key": "amount",
        "x_label": "Week",
        "y_label": "Revenue ($)"
      },
      "computed_at": "2026-03-02T10:30:00Z",
      "is_cached": true
    }
  ]
}
```

### `POST /api/insights/{company_id}/refresh`

Force-refresh all cached insights. Returns updated insights.

**Response:** Same structure as `GET /dashboard`.

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

### `GET /api/insights/{company_id}/chat/history`

Returns the user's recent chat queries (last 20).

**Response:**

```json
{
  "queries": [
    {
      "id": "uuid",
      "question": "What's my most profitable customer?",
      "response": "Your most profitable customer is...",
      "has_chart": true,
      "created_at": "2026-03-02T10:45:00Z"
    }
  ]
}
```

### `POST /api/insights/{company_id}/saved`

Save a chart response to the user's dashboard. Requires `chart_config` to be present.

### `GET /api/insights/{company_id}/saved`

List user's saved insights for this company.

### `DELETE /api/insights/{company_id}/saved/{insight_id}`

Delete a saved insight. Verifies ownership.

---

## Rate Limiting & Cost Controls

| Control | Value | Rationale |
|---|---|---|
| Chat queries per company per hour | 20 | Prevents runaway AI costs for a single company |
| Max tokens per chat query | 4,000 | Keeps individual responses bounded |
| SQL statement timeout | 5 seconds | Prevents long-running queries |
| SQL row limit | 200 rows | Bounds data transfer and AI context |
| Insight cache TTL | 1 hour | Balance freshness vs AI cost |
| Max concurrent insight refreshes per company | 1 | Prevents duplicate computation |

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
|   +-- insights_routes.py          # All endpoints (dashboard, chat, saved CRUD)
+-- services/
|   +-- ai/
|   |   +-- base_provider.py        # chat_with_tools() abstract method
|   |   +-- claude_provider.py      # chat_with_tools() implementation + execute_sql dispatch
|   |   +-- openai_provider.py      # Future: chat_with_tools() for OpenAI
|   |   +-- gemini_provider.py      # Future: chat_with_tools() for Gemini
|   |   +-- factory.py              # 'insights_chat' feature support
|   +-- insights_service.py         # Metric functions (dashboard cache) + chat system prompt + execute_sql_tool()
+-- models/
|   +-- insights_models.py          # Pydantic request/response schemas
+-- tools/
    +-- metric_tools.py             # METRIC_TOOLS (dashboard) + CHAT_TOOLS (text-to-SQL)
    +-- schema_context.py           # Database schema string for AI system prompt (17 tables)
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
+-- insightsAccess.ts              # Insights API helpers (chat, save, delete, fetch)
+-- dashboardAccess.ts             # Metric values + pinned metric keys (localStorage)
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

**Migration:** `supabase/migrations/20260305000001_create_ai_readonly_role.sql`

Before running the migration, replace `CHANGE_ME_secure_password` with a real password. Then set the environment variable:
```
AI_READONLY_DATABASE_URL=postgresql://jigged_ai_readonly:your_password@db.xxx.supabase.co:5432/postgres
```

---

## AI System Prompt (for chat)

The chat system prompt includes:

1. **Role description** — Business analyst for a precision manufacturing shop
2. **Database schema** — All 17 tables with column names, types, enum values, foreign key relationships, and important notes (imported from `schema_context.py`)
3. **SQL guidelines** — Use `$1` for company_id, join patterns for tables without company_id
4. **Example queries** — 4 common patterns for reference
5. **Response guidelines** — Keep summaries concise, include chart_config when appropriate, highlight actionable insights

```
You are a business analyst for a small precision manufacturing shop.
You answer questions by querying the company's PostgreSQL database using the
execute_sql tool.

[Full database schema with 17 tables, columns, types, relationships]

Guidelines:
- Always use execute_sql to get real data. Never make up numbers.
- Use $1 as a placeholder for company_id in all queries.
- Keep summaries to 1-3 sentences. Shop owners are busy.
- When data supports it, include a chart_config JSON block.
- Highlight actionable insights: what should the owner DO about this data?
- Compare to previous periods when relevant.
- Flag risks prominently (at-risk jobs, low inventory, revenue decline).
- Use plain language. Avoid jargon. These are machinists, not MBAs.
```

---

## Phasing

### Phase 0 — MVP

- [x] `@mui/x-charts` integration with dark theme
- [x] 10 metric tool functions in FastAPI (for dashboard cache)
- [x] `ai_insight_cache` table with 1-hour TTL
- [x] `ai_chat_queries` table with rate limiting
- [x] Rate limiting: 20 queries/company/hour
- [x] PinnedMetrics component with customizable KPI strip (1-4 metrics)
- [x] MetricPickerModal for metric selection
- [x] Ask bar on dashboard with example prompt chips (InsightsChat)
- [x] Inline AI response with optional chart + save button (chart responses only)
- [x] Saved insights CRUD: save (max 5), list, delete
- [x] "Your Charts" grid showing only user-saved insights
- [x] Empty state with message
- [x] Loading states with rotating messages for all components
- [x] Mobile-responsive layout (1-column on small screens)
- [x] Text-to-SQL architecture: schema context, SQL validator, SQL executor
- [x] `execute_sql` tool for AI chat with safety layers
- [x] Read-only database role for AI queries
- [x] `chat_with_tools()` added to AI provider base class + Claude implementation

### Phase 1 — Enhanced

- [ ] Header alert badge for at-risk jobs and low inventory (AlertBadge popover)
- [ ] Additional chart types (scatter, heatmap for schedule visualization)
- [ ] Multi-turn conversation history in chat
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
| Dashboard insight cards (cached) | < 500ms |
| Dashboard insight cards (fresh computation) | < 3 seconds |
| Individual metric function execution | < 1 second |
| Chat response end-to-end | < 8 seconds |
| SQL query execution | < 5 seconds (enforced timeout) |
| Cache refresh | Background, non-blocking |

These targets assume the small data volumes typical of target shops (1-50 users, hundreds of jobs, not millions).

---

## Validation Rules

- All API endpoints require authenticated JWT with `owner`, `admin`, or `user` role
- `company_id` in URL must match a company the user has access to
- Chat question must be non-empty and under 500 characters
- Chat rate limit: 20 queries per company per hour (configurable)
- Insight cache is per-company, per-type (UNIQUE constraint)
- AI-generated SQL validated before execution (see SQL Validation Rules)
- SQL executed via read-only role with parameterized company_id

---

## Error Handling

| Scenario | Behavior |
|---|---|
| AI provider unavailable | Show metric data without AI summary. Fallback text: "AI summary unavailable. Raw metrics shown below." |
| AI rate limited by provider | Return cached insights if available. Chat returns 503 with retry-after. |
| Metric function fails | Individual insight card shows error state. Other cards unaffected. |
| No data available | Card shows empty state: "Not enough data yet. Create some quotes and jobs to see insights here." |
| Chat question unrelated to data | AI responds: "I can only answer questions about your shop's data. Try asking about revenue, jobs, quotes, customers, or inventory." |
| SQL validation fails | AI sees the error and can retry with corrected SQL (up to 5 iterations) |
| SQL execution timeout | Returns error to AI; AI can simplify the query or explain the limitation |
| SQL references blocked table | Validator rejects; AI informed and retries with allowed tables |
| Company has no AI config | Falls back to Anthropic/Claude (default provider behavior from factory.py) |
| Text-only response (no chart) | Save button hidden — only chart responses can be saved to dashboard |

---

## Acceptance Criteria

### Pinned Metrics

- [ ] KPI strip renders at top of dashboard with 1-4 user-selected metrics
- [ ] MetricPickerModal allows selecting/deselecting metrics (max 4)
- [ ] Metric selection persisted to localStorage
- [ ] Values fetched from backend on load
- [ ] "+ Add metric" / "Edit metrics" link visible below strip

### Ask Bar (InsightsChat)

- [ ] Text input accepts natural language questions
- [ ] Pre-canned example chips submit on click (not just populate)
- [ ] AI response includes text and optional chart, displayed inline
- [ ] Save button only visible when response includes a chart
- [ ] Save icon saves response to "Your Charts" grid (max 5 per company)
- [ ] Save disabled at 5/5 with tooltip: "Remove a chart below to save new ones"
- [ ] "Saved" text feedback shown after successful save
- [ ] Rotating loading messages shown during AI processing
- [ ] Rate limit enforced: 20 queries/company/hour
- [ ] Rate limit exceeded shows clear error message
- [ ] Chat queries logged to `ai_chat_queries` table

### Your Charts Grid (InsightsSection)

- [ ] Shows only user-saved insight cards (no pre-built static charts)
- [ ] "Your Charts (N/5)" header with count indicator
- [ ] Responsive: 2-column on desktop, 1-column on mobile
- [ ] Each card: question as title + chart + AI summary + x remove button
- [ ] Empty state: dashed border box with message
- [ ] Charts use MUI theme colors (no hardcoded values)

### Security

- [ ] All endpoints verify user role (owner/admin/user only)
- [ ] All queries scoped to `company_id` via parameterized `$1` placeholder
- [ ] SQL validated before execution: SELECT-only, table allowlist, no forbidden keywords
- [ ] SQL executed via read-only Postgres role (`jigged_ai_readonly`)
- [ ] Statement timeout (5s) and row limit (200) enforced
- [ ] Operator role cannot access any insights endpoints
- [ ] RLS policies on `ai_insight_cache` and `ai_chat_queries`

### AI Provider Integration

- [ ] `chat_with_tools()` method added to `AIProvider` base class
- [ ] Claude provider implements `chat_with_tools()` with `execute_sql` tool dispatch
- [ ] `get_provider()` supports `'insights_chat'` feature type
- [ ] Per-company provider configuration works via `ai_config` table
- [ ] Default fallback to Anthropic/Claude when no config exists

---

## Open Questions

| # | Question | Status |
|---|---|---|
| 1 | Should insight cards be configurable per user or per company? | **Resolved: Per company for MVP.** Phase 1 adds per-user customization. |
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
