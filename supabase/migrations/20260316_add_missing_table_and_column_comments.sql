-- Migration: Add missing table and column comments for text-to-SQL AI agent support
-- Tables missing descriptions: ai_chat_queries, ai_insight_cache, company_custom_units,
-- demo_data_templates, part_categories, saved_insights, system_admins, waitlist

-- ============================================================
-- TABLE COMMENTS
-- ============================================================

COMMENT ON TABLE "public"."ai_chat_queries"
    IS 'Log of AI chat conversations. Stores every question a user asks the AI assistant along with the generated response, tool calls made, chart configs, and token usage metrics for cost tracking.';

COMMENT ON TABLE "public"."ai_insight_cache"
    IS 'Cache for AI-generated dashboard insights. Stores precomputed metric summaries and AI narratives with TTL-based expiration (default 1 hour) to avoid redundant LLM calls. Keyed by company + insight_type.';

COMMENT ON TABLE "public"."company_custom_units"
    IS 'Custom measurement units defined per company for inventory tracking. Supplements the standard built-in units. Each unit name must be unique within a company.';

COMMENT ON TABLE "public"."demo_data_templates"
    IS 'Templates for seeding demo/sample data into new company accounts. Contains versioned JSONB payloads of sample parts, customers, jobs, etc. Only one version per template name can be active at a time.';

COMMENT ON TABLE "public"."part_categories"
    IS 'Categories for organizing parts within a company. Each category can define a default markup percentage used in cost-plus pricing calculations. Category names must be unique per company.';

COMMENT ON TABLE "public"."saved_insights"
    IS 'User-saved AI chat Q&A pairs. When a user finds an AI-generated insight valuable, they can save it for future reference. Includes the original question, answer text, and any chart configuration.';

COMMENT ON TABLE "public"."system_admins"
    IS 'Platform-level administrator access. Users in this table have system-wide admin privileges that span across all companies. Separate from company-level roles in user_company_access.';

COMMENT ON TABLE "public"."waitlist"
    IS 'Pre-launch waitlist signups from the landing page. Captures prospective customer info (email, name, company, shop size) and tracks signup status (pending, approved, invited) and acquisition source.';

-- ============================================================
-- COLUMN COMMENTS: ai_chat_queries
-- ============================================================

COMMENT ON COLUMN "public"."ai_chat_queries"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."ai_chat_queries"."company_id"
    IS 'FK to companies. Isolates chat history per tenant.';

COMMENT ON COLUMN "public"."ai_chat_queries"."user_id"
    IS 'FK to auth.users. The user who asked the question. Nullable for system-generated queries.';

COMMENT ON COLUMN "public"."ai_chat_queries"."question"
    IS 'The natural-language question the user asked the AI assistant.';

COMMENT ON COLUMN "public"."ai_chat_queries"."tool_calls"
    IS 'JSONB array of tool/function calls the AI made to answer the question (e.g., SQL queries, calculations). Default: empty array.';

COMMENT ON COLUMN "public"."ai_chat_queries"."response"
    IS 'The AI-generated text response displayed to the user.';

COMMENT ON COLUMN "public"."ai_chat_queries"."chart_config"
    IS 'Optional JSONB chart configuration if the AI generated a visualization (chart type, data series, labels).';

COMMENT ON COLUMN "public"."ai_chat_queries"."provider"
    IS 'AI provider used for this query. Examples: "anthropic", "openai".';

COMMENT ON COLUMN "public"."ai_chat_queries"."model"
    IS 'Specific model identifier used. Examples: "claude-sonnet-4-20250514", "gpt-4o".';

COMMENT ON COLUMN "public"."ai_chat_queries"."tokens_used"
    IS 'Total token count (input + output) consumed by this query. Used for cost monitoring.';

COMMENT ON COLUMN "public"."ai_chat_queries"."duration_ms"
    IS 'Wall-clock time in milliseconds for the AI to generate the response.';

COMMENT ON COLUMN "public"."ai_chat_queries"."created_at"
    IS 'Timestamp when the query was made. Auto-set on insert.';

-- ============================================================
-- COLUMN COMMENTS: ai_insight_cache
-- ============================================================

COMMENT ON COLUMN "public"."ai_insight_cache"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."ai_insight_cache"."company_id"
    IS 'FK to companies. Cascades on delete. Cache is per-company.';

COMMENT ON COLUMN "public"."ai_insight_cache"."insight_type"
    IS 'Type of insight cached. Examples: "dashboard_summary", "job_efficiency", "inventory_alerts". Unique per company.';

COMMENT ON COLUMN "public"."ai_insight_cache"."metric_data"
    IS 'JSONB payload of raw metric data used to generate the AI summary (e.g., counts, averages, trends).';

COMMENT ON COLUMN "public"."ai_insight_cache"."ai_summary"
    IS 'AI-generated natural language summary of the metrics. Displayed on dashboards.';

COMMENT ON COLUMN "public"."ai_insight_cache"."chart_config"
    IS 'Optional JSONB chart configuration for visualizing the insight.';

COMMENT ON COLUMN "public"."ai_insight_cache"."computed_at"
    IS 'Timestamp when this cache entry was computed. Auto-set on insert.';

COMMENT ON COLUMN "public"."ai_insight_cache"."expires_at"
    IS 'Timestamp when this cache entry expires. Default: 1 hour after computed_at. Entries past expiry should be recomputed.';

-- ============================================================
-- COLUMN COMMENTS: company_custom_units
-- ============================================================

COMMENT ON COLUMN "public"."company_custom_units"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."company_custom_units"."company_id"
    IS 'FK to companies. Cascades on delete. Custom units are per-company.';

COMMENT ON COLUMN "public"."company_custom_units"."unit_name"
    IS 'Display name of the custom unit. Example: "barrel", "spool". Must be unique within the company.';

COMMENT ON COLUMN "public"."company_custom_units"."created_at"
    IS 'Timestamp when the custom unit was created. Auto-set on insert.';

-- ============================================================
-- COLUMN COMMENTS: demo_data_templates
-- ============================================================

COMMENT ON COLUMN "public"."demo_data_templates"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."demo_data_templates"."name"
    IS 'Template name identifier. Example: "precision_machining_shop". Unique per version.';

COMMENT ON COLUMN "public"."demo_data_templates"."version"
    IS 'Version number for this template. Allows iterating on demo data while keeping history. Default: 1.';

COMMENT ON COLUMN "public"."demo_data_templates"."is_active"
    IS 'Whether this template version is the active one used for new demo accounts. Default: false.';

COMMENT ON COLUMN "public"."demo_data_templates"."template_data"
    IS 'JSONB payload containing all demo data: parts, customers, jobs, operations, inventory, etc. Structured for the seed function to process.';

COMMENT ON COLUMN "public"."demo_data_templates"."created_at"
    IS 'Timestamp when the template was created. Auto-set on insert.';

COMMENT ON COLUMN "public"."demo_data_templates"."created_by"
    IS 'FK to auth.users. The admin who created this template. Nullable.';

-- ============================================================
-- COLUMN COMMENTS: part_categories
-- ============================================================

COMMENT ON COLUMN "public"."part_categories"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."part_categories"."company_id"
    IS 'FK to companies. Cascades on delete. Categories are per-company.';

COMMENT ON COLUMN "public"."part_categories"."name"
    IS 'Category display name. Example: "CNC Turned Parts", "Sheet Metal". Must be unique within the company.';

COMMENT ON COLUMN "public"."part_categories"."default_markup_percent"
    IS 'Default markup percentage for parts in this category. Used in cost-plus pricing. Example: 25.00 means 25% markup. Nullable if no default.';

COMMENT ON COLUMN "public"."part_categories"."description"
    IS 'Optional description of this part category.';

COMMENT ON COLUMN "public"."part_categories"."created_at"
    IS 'Timestamp when the category was created. Auto-set on insert.';

COMMENT ON COLUMN "public"."part_categories"."updated_at"
    IS 'Timestamp of last update. Auto-updated via trigger.';

-- ============================================================
-- COLUMN COMMENTS: saved_insights
-- ============================================================

COMMENT ON COLUMN "public"."saved_insights"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."saved_insights"."user_id"
    IS 'FK to auth.users. The user who saved this insight.';

COMMENT ON COLUMN "public"."saved_insights"."company_id"
    IS 'FK to companies. Isolates saved insights per tenant.';

COMMENT ON COLUMN "public"."saved_insights"."question"
    IS 'The original question that was asked to generate this insight.';

COMMENT ON COLUMN "public"."saved_insights"."answer"
    IS 'The AI-generated answer text that the user saved.';

COMMENT ON COLUMN "public"."saved_insights"."chart_config"
    IS 'Optional JSONB chart configuration saved with the insight.';

COMMENT ON COLUMN "public"."saved_insights"."created_at"
    IS 'Timestamp when the insight was saved. Auto-set on insert.';

-- ============================================================
-- COLUMN COMMENTS: system_admins
-- ============================================================

COMMENT ON COLUMN "public"."system_admins"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."system_admins"."user_id"
    IS 'FK to auth.users. The user granted system admin privileges. Must be unique.';

COMMENT ON COLUMN "public"."system_admins"."created_at"
    IS 'Timestamp when admin access was granted. Auto-set on insert.';

COMMENT ON COLUMN "public"."system_admins"."created_by"
    IS 'FK to auth.users. The admin who granted this access. Nullable for initial bootstrap.';

-- ============================================================
-- COLUMN COMMENTS: waitlist
-- ============================================================

COMMENT ON COLUMN "public"."waitlist"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."waitlist"."email"
    IS 'Email address of the signup. Must be unique across the waitlist.';

COMMENT ON COLUMN "public"."waitlist"."name"
    IS 'Full name of the person signing up. Optional.';

COMMENT ON COLUMN "public"."waitlist"."company_name"
    IS 'Name of their manufacturing company/shop. Optional.';

COMMENT ON COLUMN "public"."waitlist"."shop_size"
    IS 'Self-reported shop size. Examples: "1-5 employees", "6-20 employees", "21-50 employees". Optional.';

COMMENT ON COLUMN "public"."waitlist"."status"
    IS 'Signup status. Values: "pending" (default), "approved", "invited", "converted". Tracks progression through the onboarding funnel.';

COMMENT ON COLUMN "public"."waitlist"."source"
    IS 'Acquisition source tracking. Default: "landing_page". Other examples: "referral", "demo_request".';

COMMENT ON COLUMN "public"."waitlist"."created_at"
    IS 'Timestamp when the signup occurred. Auto-set on insert.';
