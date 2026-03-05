# AI Insights & Charts Module

## Overview

The AI Insights module gives shop owners and administrators an intelligent data analyst built into their dashboard. It surfaces actionable business insights through pre-built metric cards with charts and a natural language chat interface for ad-hoc questions — so a 50-year-old shop owner who's great at machining doesn't need to be great at spreadsheets.

**Priority:** Should Have (FR-17: Dashboard with AI Insights), Could Have (FR-18: Natural Language Queries)

**Dependencies:** Dashboard, Jobs, Quotes, Customers, Parts, Operations, Inventory modules

**Database Tables:** `ai_insight_cache`, `ai_chat_queries`, `ai_config` (existing)

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

---

## Architecture

### Key Design Decision: Tool-Use Pattern (NOT Raw SQL)

The AI does **not** generate SQL queries. Instead, it selects from pre-defined metric functions (tools) that execute safe, company-scoped Supabase queries. This is:

- **Secure** — no SQL injection risk, no access to other companies' data
- **Predictable** — bounded query cost and execution time
- **Auditable** — every AI interaction logs which tools were called

### Flow

```
1. User asks question (or dashboard triggers proactive insight)
       │
       ▼
2. FastAPI backend constructs prompt with available metric tools
   + company context (company_id, company name)
       │
       ▼
3. AI responds with tool calls
   (e.g., "call get_revenue_by_period with last 8 weeks")
       │
       ▼
4. Backend executes metric functions
   (Supabase queries, always scoped to company_id)
       │
       ▼
5. AI interprets results → returns:
   - Natural language summary
   - Optional chart_config (chart type + formatted data)
       │
       ▼
6. Frontend renders text + MUI X Chart
```

### Extending the Existing AI Infrastructure

The project already has a multi-provider AI system in `api/services/ai/`. This module extends it:

- **`base_provider.py`** — Add `chat_with_tools()` abstract method alongside existing `suggest_column_mappings()`
- **`factory.py`** — Add `'insights_chat'` as a feature type for `get_provider()` lookups
- **`ai_config` table** — Already exists. Companies can configure which provider to use for `insights_chat` independently from `csv_mapping`

Default provider: Claude (Anthropic). Fallback behavior same as CSV import.

---

## Pre-defined Metric Functions (AI Tools)

These are the functions the AI can call. Each returns structured data suitable for charting.

| Function | Description | Parameters | Returns |
|---|---|---|---|
| `get_revenue_by_period` | Revenue from shipped jobs over time | `period_type` (daily/weekly/monthly), `num_periods` (default: 8) | `[{period, amount, job_count}]` |
| `get_job_status_distribution` | Current job counts by status | — | `[{status, count}]` |
| `get_quote_conversion_rate` | Quotes accepted vs total | `period_type`, `num_periods` | `{current_rate, previous_rate, trend_direction, periods: [{period, accepted, total, rate}]}` |
| `get_job_cycle_times` | Avg days from created → shipped | `period_type`, `num_periods` | `[{period, avg_days, job_count}]` |
| `get_customer_revenue_breakdown` | Revenue ranked by customer | `period_type`, `num_periods`, `limit` (default: 10) | `[{customer_name, revenue, job_count, pct_of_total}]` |
| `get_part_profitability` | Revenue vs estimated labor cost by part | `limit` (default: 10) | `[{part_number, description, revenue, estimated_cost, margin_pct}]` |
| `get_inventory_alerts` | Items at or below reorder point | — | `[{item_name, sku, quantity, reorder_point, unit}]` |
| `get_at_risk_jobs` | Jobs behind schedule | — | `[{job_number, customer_name, pct_complete, estimated_completion, severity}]` |
| `get_resource_utilization` | Booked hours by resource group | `period_type`, `num_periods` | `[{resource_group, booked_hours, job_count}]` |
| `get_revenue_forecast` | Pipeline value from open quotes | — | `{total_pipeline, weighted_pipeline, quote_count, avg_conversion_rate}` |

All functions implicitly receive `company_id` from the authenticated request context. The AI never sees or passes company IDs directly.

### At-Risk Job Severity Calculation

```
severity = based on:
  - % complete vs % of estimated time elapsed
  - "critical" if < 50% complete and > 80% of estimated time used
  - "warning" if < 75% complete and > 75% of estimated time used
  - "on_track" otherwise

Estimated time = sum of (estimated_run_hours_per_unit × job quantity) across job_operations
Actual progress = sum of quantity_completed / job quantity across job_operations
```

---

## Data Model

### New Table: `ai_insight_cache`

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

```sql
CREATE TABLE ai_insight_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    insight_type VARCHAR(50) NOT NULL,
    metric_data JSONB NOT NULL,
    ai_summary TEXT NOT NULL,
    chart_config JSONB,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
    UNIQUE(company_id, insight_type)
);

-- RLS
ALTER TABLE ai_insight_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own company insights"
    ON ai_insight_cache FOR SELECT
    USING (company_id IN (
        SELECT company_id FROM user_company_access WHERE user_id = auth.uid()
    ));
```

### New Table: `ai_chat_queries`

Logs chat interactions for analytics, debugging, and cost tracking.

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key, `gen_random_uuid()` |
| company_id | UUID | Yes | FK to `companies` |
| user_id | UUID | Yes | FK to `auth.users` |
| question | TEXT | Yes | User's natural language question |
| tool_calls | JSONB | Yes | Which metric functions the AI invoked |
| response | TEXT | Yes | AI's natural language response |
| chart_config | JSONB | No | Chart config if a chart was generated |
| provider | VARCHAR(20) | Yes | AI provider used (`'anthropic'`, `'openai'`, `'gemini'`) |
| model | VARCHAR(50) | No | Specific model used |
| tokens_used | INTEGER | No | Total token count for cost tracking |
| duration_ms | INTEGER | No | End-to-end response time |
| created_at | TIMESTAMPTZ | Yes | Timestamp |

```sql
CREATE TABLE ai_chat_queries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    tool_calls JSONB NOT NULL DEFAULT '[]',
    response TEXT NOT NULL,
    chart_config JSONB,
    provider VARCHAR(20) NOT NULL,
    model VARCHAR(50),
    tokens_used INTEGER,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE ai_chat_queries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own company chat history"
    ON ai_chat_queries FOR SELECT
    USING (company_id IN (
        SELECT company_id FROM user_company_access
        WHERE user_id = auth.uid() AND role IN ('owner', 'admin', 'user')
    ));

CREATE POLICY "Users can insert chat queries for own company"
    ON ai_chat_queries FOR INSERT
    WITH CHECK (company_id IN (
        SELECT company_id FROM user_company_access
        WHERE user_id = auth.uid() AND role IN ('owner', 'admin', 'user')
    ));

-- Index for rate limiting lookups
CREATE INDEX idx_ai_chat_queries_rate_limit
    ON ai_chat_queries (company_id, created_at DESC);
```

---

## UI Screens

### 1. Dashboard Enhancement — Insights Section

**Route:** `/dashboard/{companyId}` (existing page, enhanced)

The existing dashboard gets a new `InsightsSection` below the current summary cards grid and above the Recent Activity accordion.

**Layout:**

```
┌─────────────────────────────────────────────────────────┐
│  [Existing: Open Quotes] [Active Jobs] [Revenue]        │  ← existing summary cards
├─────────────────────────────────────────────────────────┤
│                                                         │
│  AI Insights                              [View All →]  │
│                                                         │
│  ┌─────────────────────┐ ┌─────────────────────┐       │
│  │ Revenue Trend        │ │ Job Pipeline         │       │
│  │ ~~~~ chart ~~~~      │ │    🍩 donut chart    │       │
│  │ "Revenue up 12%..."  │ │ "4 in progress..."   │       │
│  └─────────────────────┘ └─────────────────────┘       │
│  ┌─────────────────────┐ ┌─────────────────────┐       │
│  │ Quote Conversion     │ │ At-Risk Jobs         │       │
│  │   67% ↑              │ │ ⚠ J-0023 (critical) │       │
│  │ "Up from 55%..."     │ │ ⚠ J-0041 (warning)  │       │
│  └─────────────────────┘ └─────────────────────┘       │
│  ┌─────────────────────┐                               │
│  │ Inventory Alerts     │                               │
│  │ 3 items low stock    │                               │
│  └─────────────────────┘                               │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  [Existing: Recent Activity accordion]                   │
└─────────────────────────────────────────────────────────┘
```

- 5 insight cards in a responsive 2-column grid (1-column on mobile)
- Each card: title + chart/visual + AI-generated summary text
- "View All" link navigates to the full insights page
- Cards use default `<Card elevation={2}>` per design system
- Loading state: `<CircularProgress>` per card while computing
- Stale cache indicator: subtle "(updated 45m ago)" timestamp

### 2. Full Insights Page with Chat

**Route:** `/dashboard/{companyId}/insights`

**Layout:**

```
┌─────────────────────────────────────────────────────────┐
│  Ask a question about your business                     │
│  ┌─────────────────────────────────────────── [Send] ┐  │
│  │ What's my most profitable part?                    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Revenue  │ │ Top      │ │ Jobs     │ │ Quote    │  │
│  │ trend    │ │ customer │ │ behind   │ │ pipeline │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│  ↑ pre-canned example prompt chips                      │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  AI Response Area                                │   │
│  │                                                  │   │
│  │  "Your most profitable part is ACM-001           │   │
│  │   (Precision Bracket) with a 42% margin..."      │   │
│  │                                                  │   │
│  │  ┌─────────────────────────────────────────┐    │   │
│  │  │     Bar chart: Part profitability        │    │   │
│  │  └─────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                                         │
│  All Insights                            [Refresh ↻]    │
│  (expanded versions of the 5 dashboard cards)           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Chat features:**
- Text input with Send button (also submits on Enter)
- Pre-canned example prompt chips below the input (click to auto-fill)
- Response area shows AI text + optional chart
- Loading state: typing indicator animation during AI processing
- Single Q&A per interaction (no conversation history for MVP)
- Error state: "Couldn't process that question. Try rephrasing or pick an example above."

**Example prompt chips:**
- "Show revenue trend"
- "Who's my top customer?"
- "Which jobs are behind schedule?"
- "What's my quote pipeline worth?"

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

Submit a natural language question.

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
  "tool_calls": ["get_customer_revenue_breakdown"],
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

---

## Rate Limiting & Cost Controls

| Control | Value | Rationale |
|---|---|---|
| Chat queries per company per hour | 20 | Prevents runaway AI costs for a single company |
| Max tokens per chat query | 4,000 | Keeps individual responses bounded |
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
├── routes/
│   └── insights_routes.py          # All 4 endpoints
├── services/
│   ├── ai/
│   │   ├── base_provider.py        # Add chat_with_tools() abstract method
│   │   ├── claude_provider.py      # Implement chat_with_tools() for Claude
│   │   ├── openai_provider.py      # Implement chat_with_tools() for OpenAI
│   │   ├── gemini_provider.py      # Implement chat_with_tools() for Gemini
│   │   └── factory.py              # Add 'insights_chat' feature support
│   └── insights_service.py         # Metric functions + insight orchestration
├── models/
│   └── insights_models.py          # Pydantic request/response schemas
└── tools/
    └── metric_tools.py             # Tool definitions for AI (JSON schema format)
```

### Frontend Files

```
components/
├── dashboard/
│   ├── InsightsSection.tsx         # Container for 5 insight cards on dashboard
│   └── InsightCard.tsx             # Individual card: title + chart + AI summary
└── insights/
    ├── InsightsChat.tsx            # Chat input + response + example chips
    └── InsightChart.tsx            # MUI X Charts wrapper rendering from chart_config

app/dashboard/[companyId]/
└── insights/
    └── page.tsx                    # Full insights page with chat

utils/
└── insightsAccess.ts              # Frontend fetch helpers (pattern: dashboardAccess.ts)
```

---

## AI System Prompt (for metric tool selection)

The backend constructs this prompt when calling the AI:

```
You are a business analyst for a small precision manufacturing shop.
You have access to tools that query the company's data. Use them to
answer questions accurately and concisely.

Guidelines:
- Always use the available tools to get real data. Never make up numbers.
- Keep summaries to 1-3 sentences. Shop owners are busy.
- When data supports it, include a chart_config in your response.
- Highlight actionable insights: what should the owner DO about this data?
- Compare to previous periods when relevant (e.g., "up 12% vs last week").
- Flag risks prominently (at-risk jobs, low inventory, revenue decline).
- Use plain language. Avoid jargon. These are machinists, not MBAs.
```

---

## Phasing

### Phase 0 — MVP

- [ ] 5 pre-built insight cards on dashboard (InsightsSection)
- [ ] `@mui/x-charts` integration with dark theme
- [ ] 10 metric tool functions in FastAPI
- [ ] `chat_with_tools()` added to AI provider base class + Claude implementation
- [ ] Basic chat interface on `/dashboard/{companyId}/insights`
- [ ] `ai_insight_cache` table with 1-hour TTL
- [ ] `ai_chat_queries` table with rate limiting
- [ ] Rate limiting: 20 queries/company/hour
- [ ] Loading and error states for all components
- [ ] Mobile-responsive layout (1-column on small screens)

### Phase 1 — Enhanced

- [ ] Customizable dashboard (drag/reorder insight cards, show/hide)
- [ ] Additional chart types (scatter, heatmap for schedule visualization)
- [ ] Multi-turn conversation history in chat
- [ ] OpenAI and Gemini `chat_with_tools()` implementations
- [ ] Export charts as PNG images
- [ ] Date range picker for insight cards (not just fixed periods)
- [ ] In-app notification badges for critical insights (at-risk jobs, stockouts)

### Phase 2 — Predictive

- [ ] Trend forecasting (predict next month's revenue based on pipeline)
- [ ] Anomaly detection (automatic alerts when metrics deviate from baseline)
- [ ] Scheduled insight digests (weekly email summary to admins)
- [ ] Operator performance analytics (for admin view — not operator-facing)
- [ ] Comparative analytics (month-over-month, customer vs customer)
- [ ] Natural language → chart builder ("Show me a bar chart of revenue by customer for Q1")

---

## Performance Targets

| Metric | Target |
|---|---|
| Dashboard insight cards (cached) | < 500ms |
| Dashboard insight cards (fresh computation) | < 3 seconds |
| Individual metric function execution | < 1 second |
| Chat response end-to-end | < 8 seconds |
| Cache refresh | Background, non-blocking |

These targets assume the small data volumes typical of target shops (1-50 users, hundreds of jobs, not millions).

---

## Validation Rules

- All API endpoints require authenticated JWT with `owner`, `admin`, or `user` role
- `company_id` in URL must match a company the user has access to
- Chat question must be non-empty and under 500 characters
- Chat rate limit: 20 queries per company per hour (configurable)
- Insight cache is per-company, per-type (UNIQUE constraint)

---

## Error Handling

| Scenario | Behavior |
|---|---|
| AI provider unavailable | Show metric data without AI summary. Fallback text: "AI summary unavailable. Raw metrics shown below." |
| AI rate limited by provider | Return cached insights if available. Chat returns 503 with retry-after. |
| Metric function fails | Individual insight card shows error state. Other cards unaffected. |
| No data available | Card shows empty state: "Not enough data yet. Create some quotes and jobs to see insights here." |
| Chat question unrelated to data | AI responds: "I can only answer questions about your shop's data. Try asking about revenue, jobs, quotes, customers, or inventory." |
| Company has no AI config | Falls back to Anthropic/Claude (default provider behavior from factory.py) |

---

## Acceptance Criteria

### Dashboard Insight Cards

- [ ] 5 insight cards render below existing summary cards on the dashboard
- [ ] Each card displays a chart (or alert list) and an AI-generated summary
- [ ] Cards load from cache when available (< 500ms)
- [ ] Cards compute fresh when cache is expired (< 3 seconds)
- [ ] Loading spinner shown per card while computing
- [ ] Graceful degradation: metric data shown even if AI summary fails
- [ ] "View All" link navigates to full insights page
- [ ] Responsive: 2-column on desktop, 1-column on mobile
- [ ] Charts use MUI theme colors (no hardcoded values)

### Chat Interface

- [ ] Text input accepts natural language questions
- [ ] Pre-canned example chips populate the input on click
- [ ] AI response includes text and optional chart
- [ ] Loading state shown during AI processing
- [ ] Rate limit enforced: 20 queries/company/hour
- [ ] Rate limit exceeded shows clear error message
- [ ] Chat queries logged to `ai_chat_queries` table
- [ ] Recent chat history viewable on insights page

### Security

- [ ] All endpoints verify user role (owner/admin/user only)
- [ ] All metric functions scoped to `company_id`
- [ ] No raw SQL generated or executed by AI
- [ ] Operator role cannot access any insights endpoints
- [ ] RLS policies on `ai_insight_cache` and `ai_chat_queries`

### AI Provider Integration

- [ ] `chat_with_tools()` method added to `AIProvider` base class
- [ ] Claude provider implements `chat_with_tools()`
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

---

## Success Metrics

- **Insight engagement:** % of admin sessions that view insight cards on dashboard
- **Chat adoption:** avg chat queries per active company per week
- **Time on dashboard:** increase in time spent on dashboard page (indicates value)
- **Feature retention:** % of companies using insights after 30 days
- **AI accuracy:** user satisfaction with AI summaries (future: thumbs up/down feedback)
