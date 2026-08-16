-- QuickBooks Desktop (via Conductor) as a SECOND accounting provider.
--
-- A company connects EITHER QuickBooks Online OR QuickBooks Desktop, never both.
-- QBD gets its own connection table; it SHARES quickbooks_customer_map,
-- quickbooks_invoice_links and quickbooks_invoice_line_items, because those three are
-- already provider-agnostic (realm_id is an opaque scope key) and sharing them keeps
-- the invoicing_status trigger family, the assert_invoice_not_over_ordered backstop and
-- the entire job-page invoicing UI working for the new provider with no new code.
--
-- Why a SEPARATE connection table rather than reusing quickbooks_connections:
-- that table's access_token / access_expires_at / refresh_token are NOT NULL and its
-- compare-and-set refresh reads conn["refresh_token"] unguarded, so serving both
-- providers from it would mean relaxing three NOT NULLs and turning a schema guarantee
-- into a runtime KeyError waiting for the first QBD company. Worse, get_connection()
-- filters on company_id ALONE, so a shared table would make every existing QBO read
-- silently pick up QBD rows unless a provider filter were retrofitted onto all of them.

-- ============================================================================
-- 1. quickbooks_desktop_connections (backend-only, mirrors quickbooks_connections)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.quickbooks_desktop_connections (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    -- Conductor's end-user id (end_usr_...). Identifies ONE QuickBooks Desktop company
    -- file, exactly as realm_id identifies one QBO company, and is written verbatim into
    -- quickbooks_customer_map.realm_id / quickbooks_invoice_links.realm_id as the
    -- provider scope key -- so every scope-carrying read already written for QBO keeps
    -- working unchanged.
    conductor_end_user_id text NOT NULL,
    -- Conductor's integration_connection id, cached once the shop completes the auth
    -- flow ON THE WINDOWS MACHINE running QuickBooks. There is no OAuth redirect back to
    -- us, so this is part of how "did it work?" gets answered.
    --
    -- IT IS NOT SUFFICIENT ON ITS OWN. Verified live 2026-08-10: Conductor creates the
    -- integration_connection row the moment the auth flow STARTS, and a half-finished
    -- setup (Web Connector never run) presents as a connection whose
    -- lastSuccessfulRequestAt is null while health-check returns 409
    -- INTEGRATION_CONNECTION_NOT_SET_UP. So "connected" must be judged on
    -- last_successful_request_at below, never on this column being non-null.
    integration_connection_id text,
    -- The Conductor PROJECT this end user belongs to. Mirrors
    -- quickbooks_connections.environment: Conductor has no sandbox HOST, it has separate
    -- projects, and an end-user id minted in the testing project must never be addressed
    -- with the production secret key.
    environment text NOT NULL DEFAULT 'sandbox',
    qb_company_name text,
    -- Lazily resolved on first push and cached, exactly like QBO's default_item_id.
    -- The income account is CHOSEN BY AN ADMIN, not guessed: QBO's resolve_income_account
    -- takes accounts[0], and a wrong revenue account is invisible until month end.
    default_service_item_id text,
    default_income_account_id text,
    -- NO refNumber counter lives here, deliberately. Verified against Enterprise 24 on
    -- 2026-08-10: posting an invoice with NO refNumber makes QuickBooks assign the next
    -- one itself (file's max was 1098, we got 1100), contradicting Conductor's docs. And
    -- posting an explicit DUPLICATE refNumber is accepted silently -- two invoices, same
    -- number, no error. So reserving a number is unnecessary for continuity and worthless
    -- as a uniqueness latch. QuickBooks owns numbering; recovery keys off externalId.
    last_successful_request_at timestamptz,
    last_health_check_at timestamptz,
    connected_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT quickbooks_desktop_connections_pkey PRIMARY KEY (id),
    CONSTRAINT quickbooks_desktop_connections_company_key UNIQUE (company_id),
    CONSTRAINT quickbooks_desktop_connections_end_user_key UNIQUE (conductor_end_user_id),
    CONSTRAINT quickbooks_desktop_connections_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT quickbooks_desktop_connections_company_fkey FOREIGN KEY (company_id)
        REFERENCES public.companies (id) ON DELETE CASCADE,
    CONSTRAINT quickbooks_desktop_connections_connected_by_fkey FOREIGN KEY (connected_by)
        REFERENCES public.user_company_access (id) ON DELETE SET NULL
);

ALTER TABLE public.quickbooks_desktop_connections ENABLE ROW LEVEL SECURITY;

-- Backend-only, exactly like quickbooks_connections: create NO policies for
-- anon/authenticated -> default deny, PLUS an explicit REVOKE so the intent survives
-- someone later adding a policy "for convenience". The end-user id is not a bearer token,
-- but it is the sole addressing key for every Conductor call this company makes and the
-- browser has no use for it.
REVOKE ALL ON TABLE public.quickbooks_desktop_connections FROM anon, authenticated;
GRANT ALL ON TABLE public.quickbooks_desktop_connections TO service_role;

-- The baseline's ALTER DEFAULT PRIVILEGES grants SELECT on every new public table to the
-- AI SQL role, so this revoke is load-bearing, not decorative.
REVOKE ALL ON TABLE public.quickbooks_desktop_connections FROM jigged_ai_readonly;

DROP TRIGGER IF EXISTS quickbooks_desktop_connections_updated_at
    ON public.quickbooks_desktop_connections;
CREATE TRIGGER quickbooks_desktop_connections_updated_at
    BEFORE UPDATE ON public.quickbooks_desktop_connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.quickbooks_desktop_connections IS
  'One Conductor end user = one connected QuickBooks Desktop company file. Separate from quickbooks_connections deliberately: that table''s token columns are NOT NULL and its CAS refresh reads them unguarded, so serving both providers from it would mean relaxing those NOT NULLs and retrofitting a provider filter onto every existing QBO query (get_connection filters on company_id alone). A company connects EITHER provider - enforced by assert_single_accounting_provider().';

COMMENT ON COLUMN public.quickbooks_desktop_connections.conductor_end_user_id IS
  'Written verbatim into quickbooks_customer_map.realm_id and quickbooks_invoice_links.realm_id as the provider scope key. The QBD analogue of a QBO realm id: one value per connected company file, and distinct between the Conductor testing and production projects.';

COMMENT ON COLUMN public.quickbooks_desktop_connections.integration_connection_id IS
  'Conductor''s integration_connection id. NOT proof of a working connection: Conductor creates this row when the auth flow STARTS, and a half-finished setup shows a connection with a null lastSuccessfulRequestAt while health-check returns 409. Judge connectivity on last_successful_request_at.';

COMMENT ON COLUMN public.quickbooks_desktop_connections.default_income_account_id IS
  'Chosen by an admin, never guessed. QBO''s resolve_income_account takes accounts[0]; a wrong revenue account is invisible until month end, so the QBD path blocks the first push until someone picks one.';

-- ============================================================================
-- 2. One accounting provider per company (cross-table, so it cannot be a CHECK)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.assert_single_accounting_provider()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF TG_TABLE_NAME = 'quickbooks_connections' THEN
        IF EXISTS (SELECT 1 FROM public.quickbooks_desktop_connections
                   WHERE company_id = NEW.company_id) THEN
            RAISE EXCEPTION
                'Company % is already connected to QuickBooks Desktop; disconnect it first',
                NEW.company_id USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        IF EXISTS (SELECT 1 FROM public.quickbooks_connections
                   WHERE company_id = NEW.company_id) THEN
            RAISE EXCEPTION
                'Company % is already connected to QuickBooks Online; disconnect it first',
                NEW.company_id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $function$;

-- Trigger functions need no EXECUTE grant (permission is checked when the trigger is
-- created, not when it fires), but revoking is free and records the intent. Not
-- SECURITY DEFINER, so this does not appear in function_execute_leaks().
REVOKE EXECUTE ON FUNCTION public.assert_single_accounting_provider()
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.assert_single_accounting_provider() IS
  'A company connects EITHER QuickBooks Online OR QuickBooks Desktop. BEFORE INSERT only: a QBO reconnect is an UPDATE (persist_connection upserts by company_id) and must not trip this. The routes 409 with a readable message first; this is the invariant that holds when they do not.';

DROP TRIGGER IF EXISTS trigger_single_provider_qbo ON public.quickbooks_connections;
CREATE TRIGGER trigger_single_provider_qbo
    BEFORE INSERT ON public.quickbooks_connections
    FOR EACH ROW EXECUTE FUNCTION assert_single_accounting_provider();

DROP TRIGGER IF EXISTS trigger_single_provider_qbd ON public.quickbooks_desktop_connections;
CREATE TRIGGER trigger_single_provider_qbd
    BEFORE INSERT ON public.quickbooks_desktop_connections
    FOR EACH ROW EXECUTE FUNCTION assert_single_accounting_provider();

-- ============================================================================
-- 3. quickbooks_terms_cache
-- ============================================================================
-- PaymentTermsPicker calls listQuickBooksTerms from a MOUNT effect, on every quote form
-- and every customer detail page. Against QBO that is an Intuit read. Against QBD it would
-- be a multi-second Web Connector round trip on page load, aimed at a PC that may be
-- powered off -- exactly the failure mode the "no third-party call from a mount" rule
-- exists to prevent. Terms are therefore cached, refreshed on connect and by an explicit
-- admin action, never by a render.
CREATE TABLE IF NOT EXISTS public.quickbooks_terms_cache (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    provider text NOT NULL,
    -- Scope key, so a reconnect to a different company file cannot serve the previous
    -- file's terms.
    realm_id text NOT NULL,
    qb_term_id text NOT NULL,
    name text NOT NULL,
    due_days integer,
    refreshed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT quickbooks_terms_cache_pkey PRIMARY KEY (id),
    CONSTRAINT quickbooks_terms_cache_unique UNIQUE (company_id, realm_id, qb_term_id),
    CONSTRAINT quickbooks_terms_cache_provider_check CHECK (provider IN ('qbo', 'qbd')),
    CONSTRAINT quickbooks_terms_cache_company_fkey FOREIGN KEY (company_id)
        REFERENCES public.companies (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_terms_cache_lookup
    ON public.quickbooks_terms_cache (company_id, realm_id);

ALTER TABLE public.quickbooks_terms_cache ENABLE ROW LEVEL SECURITY;

-- Member-readable, backend-written: the quickbooks_customer_map posture, not the
-- quickbooks_connections one. A payment-term label ("Net 30") is not a secret and every
-- quote form already renders these to the user, so a restrictive posture would be
-- arbitrary. v1 still serves them through /api/quickbooks/{company}/terms so the picker's
-- call sites and the QBO live-read path are untouched; this grant is what makes dropping
-- that hop later a code change rather than another migration.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.quickbooks_terms_cache FROM anon, authenticated;
GRANT SELECT ON TABLE public.quickbooks_terms_cache TO authenticated;
GRANT ALL ON TABLE public.quickbooks_terms_cache TO service_role;

DROP POLICY IF EXISTS "Users can view their company's quickbooks terms"
    ON public.quickbooks_terms_cache;
CREATE POLICY "Users can view their company's quickbooks terms"
    ON public.quickbooks_terms_cache
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

REVOKE ALL ON TABLE public.quickbooks_terms_cache FROM jigged_ai_readonly;

DROP TRIGGER IF EXISTS quickbooks_terms_cache_updated_at ON public.quickbooks_terms_cache;
CREATE TRIGGER quickbooks_terms_cache_updated_at
    BEFORE UPDATE ON public.quickbooks_terms_cache
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.quickbooks_terms_cache IS
  'Payment terms mirrored from the connected accounting system, so PaymentTermsPicker''s mount-time read never becomes a third-party call. Refreshed on connect and by an explicit admin action - never by a render.';

-- ============================================================================
-- 4. Generalise the shared map / link tables
-- ============================================================================
-- No backfill statement is needed and none is missing: every existing row IS a QBO row,
-- so the DEFAULT satisfies the new invariant at rest the moment the column exists. (No
-- runtime "if null, assume" fallback -- the data is correct at rest.) A NOT NULL DEFAULT
-- on an existing table is metadata-only in PG11+.
ALTER TABLE public.quickbooks_customer_map
    ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'qbo';
ALTER TABLE public.quickbooks_customer_map
    DROP CONSTRAINT IF EXISTS quickbooks_customer_map_provider_check;
ALTER TABLE public.quickbooks_customer_map
    ADD CONSTRAINT quickbooks_customer_map_provider_check CHECK (provider IN ('qbo', 'qbd'));

ALTER TABLE public.quickbooks_invoice_links
    ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'qbo';
ALTER TABLE public.quickbooks_invoice_links
    DROP CONSTRAINT IF EXISTS quickbooks_invoice_links_provider_check;
ALTER TABLE public.quickbooks_invoice_links
    ADD CONSTRAINT quickbooks_invoice_links_provider_check CHECK (provider IN ('qbo', 'qbd'));

-- NOTE: no qb_ref_number column, and no unique index on one.
--
-- An earlier design reserved an invoice number before posting and used it to answer "did
-- that create actually land?". Two probes against Enterprise 24 (2026-08-10) killed it:
-- QuickBooks assigns a blank refNumber itself, and it accepts a DUPLICATE refNumber
-- silently -- so a reservation is unnecessary for continuity and cannot prove uniqueness.
-- A unique index here would also be actively wrong: duplicate invoice numbers are legal in
-- QuickBooks, so Jigged must be able to record them.
--
-- The recovery key is instead `qb_request_id`, already on this table, which is sent to
-- QuickBooks as the invoice's `externalId`. externalId is not filterable, but it does not
-- need to be: listing by customerIds + a one-day transactionDate window returns a handful
-- of rows and the match is client-side. Verified end to end.
-- The number QuickBooks assigned is recorded in the existing qb_invoice_doc_number.

-- What the recovery probe needs to narrow its window, captured at claim time.
--
-- find_created_invoice lists by customerIds + a one-day transactionDate window and
-- matches externalId client-side. Both are recorded rather than re-derived: the customer
-- could be re-mapped between the push and the verify, and transaction_date is supplied by
-- the browser (which knows the shop's timezone), so deriving it from created_at::date
-- would be wrong at exactly the day boundary where it matters most.
ALTER TABLE public.quickbooks_invoice_links
    ADD COLUMN IF NOT EXISTS qb_customer_id text,
    ADD COLUMN IF NOT EXISTS transaction_date date;

COMMENT ON COLUMN public.quickbooks_invoice_links.qb_customer_id IS
  'The accounting-system customer this invoice was pushed to, recorded at claim time so the QuickBooks Desktop recovery probe can narrow its search window without re-deriving a mapping that may since have changed.';
COMMENT ON COLUMN public.quickbooks_invoice_links.transaction_date IS
  'The invoice date sent to the accounting system. Recorded because the recovery probe filters on it, and because it comes from the browser''s timezone rather than the server''s UTC date.';

-- A fourth status. 'needs_verification' = the create returned an AMBIGUOUS outcome
-- (timeout / connection loss) and a probe could not yet find the invoice. It deliberately
-- does NOT count toward invoiced quantity: every compute function and
-- assert_invoice_not_over_ordered filter status='created', and money we cannot confirm
-- must not silently satisfy a billing cap. The route blocks a NEW invoice on any job
-- holding one, so the uncounted quantity cannot be billed twice either.
ALTER TABLE public.quickbooks_invoice_links
    DROP CONSTRAINT IF EXISTS quickbooks_invoice_links_status_check;
ALTER TABLE public.quickbooks_invoice_links
    ADD CONSTRAINT quickbooks_invoice_links_status_check
    CHECK (status IN ('pending', 'created', 'error', 'needs_verification'));

CREATE INDEX IF NOT EXISTS idx_qb_invoice_links_needs_verification
    ON public.quickbooks_invoice_links (company_id, job_id)
    WHERE status = 'needs_verification';

COMMENT ON COLUMN public.quickbooks_invoice_links.provider IS
  'Which accounting system this invoice was pushed to. realm_id remains the scope key for both (a QBO realm id, or a Conductor end-user id); this column is what makes a row self-describing for display and for reconciliation after a provider switch.';
COMMENT ON COLUMN public.quickbooks_invoice_links.qb_request_id IS
  'Idempotency key for one draft. QBO replays it as ?requestid= (Intuit dedups server-side). QuickBooks Desktop has no such mechanism, so it is sent as the invoice''s externalId instead and is the key the verify path matches on when a create ends with an unknown outcome.';
COMMENT ON COLUMN public.quickbooks_invoice_links.status IS
  'pending | created | error | needs_verification. Only ''created'' counts toward invoiced quantity (compute_job_part_invoicing_status, assert_invoice_not_over_ordered). needs_verification means a QuickBooks Desktop create had an unknown outcome and a human must resolve it.';
COMMENT ON COLUMN public.quickbooks_invoice_links.realm_id IS
  'The accounting file this invoice lives in: a QBO realm id, or a Conductor end-user id for QuickBooks Desktop.';

-- ============================================================================
-- 5. Billing write-gate completeness
-- ============================================================================
-- Recreated VERBATIM from 20260801150944 (the current declaration - NOT the original in
-- 20260726033616, which predates the part_location_stock removal and the note_views /
-- operator_events entries) with TWO new exempt entries. Both new tables are
-- service-role-write only, so RLS cannot gate them anyway:
--   quickbooks_desktop_connections - backend-only, browser cannot even read it
--   quickbooks_terms_cache         - member-readable, but written only by the backend
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
      'auth_audit_log', 'job_fulfillment_audit',
      'company_order_counters', 'quickbooks_connections', 'quickbooks_customer_map',
      'quickbooks_invoice_links', 'quickbooks_invoice_line_items',
      'quickbooks_desktop_connections', 'quickbooks_terms_cache',
      -- SECURITY DEFINER-only writers; see 20260728040701
      'note_views', 'operator_events'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.relname
        AND p.policyname = 'billing_gate_insert'
    )
  ORDER BY 1;
$$;

COMMENT ON FUNCTION public.tenant_tables_missing_write_gate() IS
  'Lists public tables with a company_id column that are neither billing-gated nor exempt. A CI test asserts this returns no rows, so a new tenant table left un-gated fails the build instead of silently bypassing billing.';

GRANT EXECUTE ON FUNCTION public.tenant_tables_missing_write_gate() TO service_role;
