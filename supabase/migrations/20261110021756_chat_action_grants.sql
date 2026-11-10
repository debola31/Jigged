-- "Always allow": the changes a person has told Jigged chat it may make for them without asking.
--
-- Jigged chat can act through the same tools as the MCP server (lib/mcp/tools). Every change it
-- proposes waits for the person to approve it, unless they chose "Always allow" for that action
-- before; that choice is one row here.
--
-- PER PERSON, PER ACTION, PER COMPANY (the user's call, 2026-11-09). Allowing quote creation for
-- yourself allows neither archiving parts nor quote creation for a colleague. `tool_name` is the
-- MCP tool's name (create_quote, archive_record, ...): the action IS the tool, so the grant is
-- checked against exactly what is about to run.
--
-- Revoking is archive, per CLAUDE.md: `deleted_at` is set, never a DELETE. Allowing the same
-- action again revives the row (the route's upsert), so the unique key stays FULL.
--
-- WHO WRITES
--   insert / revive   the backend (service role), when the person clicks "Always allow" on a
--                     proposed change -- the same request that runs it
--   revoke            the browser, from Settings, as the person (RLS: own rows only)
--   read              the backend, before running a change; the browser, to list them
--
-- AN AI ASSISTANT'S TOKEN GETS NOTHING HERE (restrictive policy below). /mcp never touches this
-- table, and an assistant must not be able to grant Jigged chat anything on its own behalf.

-- ============================================================================
-- 1. The table
-- ============================================================================
CREATE TABLE public.chat_action_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tool_name text NOT NULL CHECK (tool_name ~ '^[a-z][a-z0-9_]{0,63}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT chat_action_grants_one_per_action UNIQUE (company_id, user_id, tool_name)
);

COMMENT ON TABLE public.chat_action_grants IS
  'Jigged chat "Always allow": one row per person, company and action (MCP tool name) the chat may run without asking. Revoked = deleted_at set. See migration 20261110021756.';
COMMENT ON COLUMN public.chat_action_grants.tool_name IS
  'The MCP tool the grant covers, e.g. create_quote. Checked against the exact tool about to run.';
COMMENT ON COLUMN public.chat_action_grants.deleted_at IS
  'Set when the person revokes the grant in Settings. Allowing the action again clears it.';

-- The backend's check runs on every proposed change: company + person, live rows only.
CREATE INDEX chat_action_grants_live
    ON public.chat_action_grants (company_id, user_id)
    WHERE deleted_at IS NULL;

-- ============================================================================
-- 2. RLS
-- ============================================================================
-- Explicit: rls_auto_enable() exists locally and on preview but never in prod.
ALTER TABLE public.chat_action_grants ENABLE ROW LEVEL SECURITY;

-- A person reads and revokes their OWN grants, in a company they still belong to. Both halves
-- matter, as on ai_chat_threads: user_id keeps a colleague out, company_id keeps someone who has
-- left the company out even though the row still names them.
CREATE POLICY chat_action_grants_own ON public.chat_action_grants
    FOR ALL TO authenticated
    USING (user_id = auth.uid() AND company_id IN (SELECT public.get_user_company_ids()))
    WITH CHECK (user_id = auth.uid() AND company_id IN (SELECT public.get_user_company_ids()));

-- RESTRICTIVE, so it narrows the policy above rather than adding to it. A browser session has no
-- client_id claim and passes; an AI assistant's OAuth token is refused outright.
CREATE POLICY chat_action_grants_no_assistant_tokens ON public.chat_action_grants
    AS RESTRICTIVE
    FOR ALL TO authenticated
    USING ((auth.jwt() ->> 'client_id') IS NULL)
    WITH CHECK ((auth.jwt() ->> 'client_id') IS NULL);

-- Browser-writable (revoke) and carries company_id, so it takes the billing write gate. A lapsed
-- company's writes are refused on every table a chat action would touch anyway.
SELECT public.apply_billing_write_gate('public.chat_action_grants');

-- ============================================================================
-- 3. Grants
-- ============================================================================
-- Named revokes, not REVOKE ALL (CLAUDE.md): a new public table arrives with TRUNCATE,
-- REFERENCES, TRIGGER and MAINTAIN for the browser roles and SELECT for the insights AI's role.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.chat_action_grants FROM anon, authenticated;
REVOKE SELECT ON TABLE public.chat_action_grants FROM jigged_ai_readonly;

-- The browser lists and revokes; it never inserts. A column grant, so a revoke can change
-- deleted_at and nothing else -- a person cannot turn one grant into another by renaming it.
GRANT SELECT ON TABLE public.chat_action_grants TO authenticated;
GRANT UPDATE (deleted_at) ON TABLE public.chat_action_grants TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.chat_action_grants TO service_role;

-- ============================================================================
-- 4. The insights-AI read guard: exempt, never readable by the AI
-- ============================================================================
-- The guard's newest body (20261109155810), redefined with one entry added. CREATE OR REPLACE
-- keeps the function's ACL and COMMENT.
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
      -- Jigged chat's "Always allow" grants, 20261110021756: who lets the chat act for them.
      -- Per-person permission state and plumbing, never shop data. Never.
      'chat_action_grants',
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
