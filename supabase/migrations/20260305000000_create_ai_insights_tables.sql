-- ============================================================
-- AI Insights Tables
-- 1. ai_insight_cache - Cached dashboard insight cards
-- 2. ai_chat_queries - Chat interaction logs
-- 3. saved_insights - User-pinned chart cards
-- ============================================================

-- ai_insight_cache: pre-computed dashboard insight cards
CREATE TABLE IF NOT EXISTS ai_insight_cache (
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

ALTER TABLE ai_insight_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own company insights" ON ai_insight_cache;
CREATE POLICY "Users can read own company insights"
    ON ai_insight_cache FOR SELECT
    USING (company_id IN (
        SELECT company_id FROM user_company_access WHERE user_id = auth.uid()
    ));

-- ai_chat_queries: logs chat interactions for analytics, debugging, cost tracking
CREATE TABLE IF NOT EXISTS ai_chat_queries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
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

ALTER TABLE ai_chat_queries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own company chat history" ON ai_chat_queries;
CREATE POLICY "Users can read own company chat history"
    ON ai_chat_queries FOR SELECT
    USING (company_id IN (
        SELECT company_id FROM user_company_access
        WHERE user_id = auth.uid() AND role IN ('owner', 'admin', 'user')
    ));

DROP POLICY IF EXISTS "Users can insert chat queries for own company" ON ai_chat_queries;
CREATE POLICY "Users can insert chat queries for own company"
    ON ai_chat_queries FOR INSERT
    WITH CHECK (company_id IN (
        SELECT company_id FROM user_company_access
        WHERE user_id = auth.uid() AND role IN ('owner', 'admin', 'user')
    ));

-- Index for rate limiting lookups (20 queries/company/hour)
CREATE INDEX IF NOT EXISTS idx_ai_chat_queries_rate_limit
    ON ai_chat_queries (company_id, created_at DESC);

-- saved_insights: user-pinned chart cards on dashboard (max 5 per user per company)
CREATE TABLE IF NOT EXISTS saved_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    chart_config JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE saved_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own saved insights" ON saved_insights;
CREATE POLICY "Users can read own saved insights"
    ON saved_insights FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own saved insights" ON saved_insights;
CREATE POLICY "Users can insert own saved insights"
    ON saved_insights FOR INSERT
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own saved insights" ON saved_insights;
CREATE POLICY "Users can delete own saved insights"
    ON saved_insights FOR DELETE
    USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_saved_insights_user_company
    ON saved_insights (user_id, company_id, created_at DESC);
