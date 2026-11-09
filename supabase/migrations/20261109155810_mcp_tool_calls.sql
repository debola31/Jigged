-- The AI-assistant call log: one row per tool call an assistant (Claude, ChatGPT, ...) makes
-- through the MCP server at /mcp. It does two jobs, and both need it written by the server and
-- by nothing else:
--
--   AUDIT       what each assistant did, for whom, in which company, and whether it worked
--   RATE LIMIT  lib/mcp/audit.ts counts recent rows before running a call. An in-memory limiter
--               does not hold on serverless (every instance has its own memory); counting a
--               table does, the same pattern insights uses with ai_jobs.
--
-- SERVICE ROLE ONLY. RLS on, no policies, no anon/authenticated grants: an assistant's own
-- token can neither read the log of what it did nor forge a row of what it did not do.
--
-- NO `deleted_at`, deliberately, against the archive rule in CLAUDE.md. That rule is for shop
-- records a person archives and documents keep referencing; this is an append-only log nobody
-- archives and nothing references.
--
-- `company_id` is NULL for calls that act in no company (list_my_companies). Because the table
-- carries a company_id, both tenant-table guards would flag it; it joins the exempt list of each
-- below, with the reason, rather than being gated or opened to the insights AI.
--
-- NO FUNCTIONS of its own. The two below are the guards' existing bodies, redefined from their
-- newest versions (20261001025551 and 20260907234149) with one entry added each. CREATE OR
-- REPLACE keeps each function's ACL and COMMENT.

-- ============================================================================
-- 1. The table
-- ============================================================================
CREATE TABLE public.mcp_tool_calls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 200),
    client_name text CHECK (client_name IS NULL OR char_length(client_name) BETWEEN 1 AND 200),
    tool text NOT NULL CHECK (tool ~ '^[a-z][a-z0-9_]{0,63}$'),
    is_write boolean NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('ok', 'refused', 'rate_limited', 'error')),
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The two rate-limit reads: this company's calls in the last minute, and this person's calls in
-- the last minute (for calls that name no company).
CREATE INDEX mcp_tool_calls_company_created_at_idx
    ON public.mcp_tool_calls (company_id, created_at DESC)
    WHERE company_id IS NOT NULL;
CREATE INDEX mcp_tool_calls_user_created_at_idx
    ON public.mcp_tool_calls (user_id, created_at DESC);

COMMENT ON TABLE public.mcp_tool_calls IS
  'One row per tool call an AI assistant makes through /mcp: the audit log and the rate limiter''s count. Written only by the MCP route as service role; RLS on with no policies. Append-only, deliberately not soft-deleted (see the migration header).';
COMMENT ON COLUMN public.mcp_tool_calls.company_id IS
  'The company the call acted in, a demo company included. NULL for calls that act in no company (list_my_companies).';
COMMENT ON COLUMN public.mcp_tool_calls.client_id IS
  'The OAuth client the token was issued to (the client_id claim). One assistant registration, not a person.';
COMMENT ON COLUMN public.mcp_tool_calls.client_name IS
  'The name the assistant reported for itself in the request, when it sent one. A claim, not an identity.';
COMMENT ON COLUMN public.mcp_tool_calls.tool IS 'The MCP tool name, e.g. list_my_companies.';
COMMENT ON COLUMN public.mcp_tool_calls.is_write IS
  'Whether the tool changes data. Writes have their own, lower rate limit.';
COMMENT ON COLUMN public.mcp_tool_calls.outcome IS
  'ok = ran; refused = a guard or the tool itself said no (role, company setting, billing, no such record); rate_limited = over the per-minute limit; error = failed unexpectedly (reported to Sentry).';
COMMENT ON COLUMN public.mcp_tool_calls.duration_ms IS 'Wall time of the call on the server, guards included.';

-- ============================================================================
-- 2. RLS - enabled, and NO policies
-- ============================================================================
-- Explicit: public.rls_auto_enable() exists locally and on preview branches but never in
-- production. With RLS on and no policy, anon and authenticated are denied every row even if a
-- grant ever appears; service_role bypasses RLS and is the only intended caller.
ALTER TABLE public.mcp_tool_calls ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. Grants - backend-only, append-only
-- ============================================================================
-- Named revokes, not REVOKE ALL: a new public table still arrives with TRUNCATE, REFERENCES,
-- TRIGGER and MAINTAIN for anon and authenticated, and SELECT for the insights AI's role
-- (docs/modules/legal-acceptance.md, "The default-privilege trap"). Those are the privileges
-- actually present, so those are the ones revoked. service_role gets SELECT (the rate-limit
-- count) and INSERT (the log) only: nothing in the app updates or deletes a logged call.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.mcp_tool_calls FROM anon, authenticated;
REVOKE SELECT ON TABLE public.mcp_tool_calls FROM jigged_ai_readonly;

GRANT SELECT, INSERT ON TABLE public.mcp_tool_calls TO service_role;

-- ============================================================================
-- 4. The billing write-gate guard: exempt, service-role only
-- ============================================================================
CREATE OR REPLACE FUNCTION public.tenant_tables_missing_write_gate()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN (
      -- identity / bootstrap (gating would block signup / team / preferences)
      'companies', 'user_company_access', 'user_preferences', 'system_admins',
      'invitations', 'demo_data_templates', 'waitlist', 'saved_insights', 'feedback',
      'company_billing',
      -- service-role-only / SELECT-only (writes never come from the browser).
      -- `part_location_stock` was removed from this list in 20260801150944: its
      -- writes DO come from the browser, through SECURITY DEFINER RPCs, and the
      -- exemption was what hid issue #645.
      -- `quickbooks_invoice_links` and `quickbooks_invoice_line_items` left the
      -- list HERE for the same reason: correct_invoice_recorded_quantities is a
      -- browser-callable SECURITY DEFINER writer, so "writes never come from the
      -- browser" stopped being true of them. Both are gated below.
      'auth_audit_log', 'job_fulfillment_audit',
      'company_order_counters', 'quickbooks_connections', 'quickbooks_customer_map',
      'quickbooks_desktop_connections', 'quickbooks_terms_cache',
      -- SECURITY DEFINER-only writers; see 20260728040701
      'note_views', 'operator_events',
      -- `operator_time_access_log` stood HERE, added 20260816203641 and carried
      -- forward by 20260818142814. The table is dropped in 20260825170421, so
      -- the entry goes with it. job_operation_intervals is unaffected: it IS
      -- gated (apply_billing_write_gate, 20260816203641), so it is satisfied by
      -- the policy-existence check below and never by this list.
      -- Append-only legal record, service-role write only
      'terms_acceptances',
      -- The AI-assistant (MCP) call log, 20261109155810: written only by the /mcp route as
      -- service role, never by the browser. Gating it would also leave a lapsed company's
      -- refused calls unrecorded, the opposite of what an audit log is for.
      'mcp_tool_calls'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.relname
        AND p.policyname = 'billing_gate_insert'
    )
  ORDER BY 1;
$$;

-- ============================================================================
-- 5. The insights-AI read guard: exempt, never readable by the AI
-- ============================================================================
CREATE OR REPLACE FUNCTION public.tenant_tables_missing_ai_decision()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $fn$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN (
      -- Third-party credentials and customer account numbers. Never.
      'quickbooks_connections', 'quickbooks_customer_map', 'quickbooks_desktop_connections',
      'quickbooks_invoice_line_items', 'quickbooks_invoice_links', 'quickbooks_terms_cache',
      'customer_carrier_accounts',
      -- Authentication, authorisation, and the legal record. Never.
      'user_company_access', 'invitations', 'auth_audit_log', 'terms_acceptances',
      -- Billing state. "Am I paid up" is a support question rather than an
      -- analytics one, and this table backs the write gate.
      'company_billing',
      -- Per-operator pace and attention data. Excluded on the surveillance
      -- guardrail in docs/modules/operator-view.md: an owner able to ask "rank my
      -- operators by speed" is the reporting layer that document forbids, even
      -- though the guardrail's letter covers operator-FACING surfaces only.
      'operator_events', 'job_operation_completions', 'job_operation_intervals',
      'note_views', 'note_reactions',
      -- The AI's own plumbing. Feeding a model its own logs, config, queue and
      -- conversations invites it to answer questions about itself instead of
      -- about the shop.
      'ai_chat_queries', 'ai_config', 'ai_jobs', 'saved_insights',
      'ai_chat_threads', 'ai_chat_messages',
      -- The AI-assistant (MCP) call log, 20261109155810: who asked which assistant to do
      -- what, and when. Per-person activity, and plumbing. Never.
      'mcp_tool_calls',
      -- Free text and uploads: note bodies, attachments, comments. Readable in
      -- principle, but each wants its own look at what the text contains before
      -- it lands in a prompt. `lot_certificates` added 20260906121901 -- a mill
      -- cert is a supplier's PDF, and its contents deserve that same look.
      'notes', 'note_media', 'job_attachments', 'part_attachments',
      'work_center_attachments', 'part_comments', 'lot_certificates',
      -- Closed today with no objection known. Opening one is a single
      -- apply_ai_read_access call plus a schema_context.py entry, so that the
      -- model is also told the table exists.
      'company_custom_units', 'company_order_counters', 'feedback',
      'inventory_locations', 'part_location_stock', 'part_customer_references',
      'job_fulfillment_audit'
    )
    -- BOTH layers. has_any_column_privilege rather than has_table_privilege so a
    -- column-level grant still counts as a decision (see `shipments`).
    AND NOT (
      has_any_column_privilege('jigged_ai_readonly', c.oid, 'SELECT')
      AND EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = c.oid AND p.polname = 'ai_readonly_select'
      )
    )
  ORDER BY 1;
$fn$;
