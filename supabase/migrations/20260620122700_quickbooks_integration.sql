-- QuickBooks Online integration: push a converted quote to QBO as an invoice.
--
-- One-directional (Jigged -> QBO). Three tables:
--   1. quickbooks_connections  - per-company OAuth tokens (BACKEND-ONLY, never the browser)
--   2. quickbooks_customer_map - durable Jigged customer -> QBO Customer id link (realm-scoped)
--   3. quickbooks_invoice_links - quote -> QBO invoice link + idempotency ledger
--
-- SECURITY NOTE: the baseline ALTER DEFAULT PRIVILEGES blanket-grants ALL on new
-- tables to anon + authenticated (see baseline ~line 6418). RLS-with-no-policy
-- denies reads, but for the TOKEN table we ALSO explicitly REVOKE so the refresh
-- token can never reach the browser even if a policy is later added by mistake.
-- The map/link tables hold no secrets and are member-readable (RLS), backend-written.

-- ───────────────────────── 1. quickbooks_connections (tokens) ─────────────────────────
CREATE TABLE IF NOT EXISTS "public"."quickbooks_connections"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "realm_id" text NOT NULL,                       -- QBO company id, returned on the OAuth callback
    "environment" text NOT NULL DEFAULT 'sandbox',  -- 'sandbox' | 'production'; a sandbox token is never used against prod
    "access_token" text NOT NULL,
    "access_expires_at" timestamp with time zone NOT NULL,
    "refresh_token" text NOT NULL,                  -- rotates ~every 24h and on every refresh; always persist the new value
    "refresh_expires_at" timestamp with time zone,  -- from x_refresh_token_expires_in (~100d inactivity); never hardcoded
    -- Optimistic-concurrency key for refresh: bumped on every rotation. Two serverless
    -- requests can both refresh; the CAS update filtered on this version lets exactly
    -- one win, and an invalid_grant on a stale token is recognised (version changed)
    -- rather than false-flagging a healthy connection as disconnected.
    "token_version" integer NOT NULL DEFAULT 0,
    "reconnect_required" boolean NOT NULL DEFAULT false,  -- set on a genuine invalid_grant; cleared on every successful connect
    "qb_company_name" text,                         -- optional label for the UI (from CompanyInfo)
    "default_item_id" text,                         -- the one shared QBO Product/Service every invoice line references
    "default_income_account_id" text,               -- needed only when auto-creating the default item
    "connected_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "quickbooks_connections_pkey" PRIMARY KEY (id),
    CONSTRAINT "quickbooks_connections_company_id_key" UNIQUE (company_id),
    CONSTRAINT "quickbooks_connections_environment_check" CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT "quickbooks_connections_company_id_fkey" FOREIGN KEY (company_id)
        REFERENCES "public"."companies" (id) ON DELETE CASCADE,
    CONSTRAINT "quickbooks_connections_connected_by_fkey" FOREIGN KEY (connected_by)
        REFERENCES "public"."user_company_access" (id) ON DELETE SET NULL
);

ALTER TABLE "public"."quickbooks_connections" ENABLE ROW LEVEL SECURITY;

-- Backend-only. Override the baseline blanket grant; create NO policies for
-- anon/authenticated -> default-deny. service_role bypasses RLS and keeps ALL.
REVOKE ALL ON TABLE "public"."quickbooks_connections" FROM "anon", "authenticated";
GRANT ALL ON TABLE "public"."quickbooks_connections" TO "service_role";

DROP TRIGGER IF EXISTS "quickbooks_connections_updated_at" ON "public"."quickbooks_connections";
CREATE TRIGGER quickbooks_connections_updated_at BEFORE UPDATE ON public.quickbooks_connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ───────────────────────── 2. quickbooks_customer_map ─────────────────────────
-- Durable Jigged customer -> QBO Customer id. Realm-scoped so a sandbox link never
-- leaks into production (QBO ids differ per realm). Resolved once (by DisplayName),
-- then reused on every push -> no fuzzy matching, no duplicates.
CREATE TABLE IF NOT EXISTS "public"."quickbooks_customer_map"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "customer_id" uuid NOT NULL,
    "realm_id" text NOT NULL,
    "qb_customer_id" text NOT NULL,
    "qb_display_name" text,
    "linked_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "quickbooks_customer_map_pkey" PRIMARY KEY (id),
    CONSTRAINT "quickbooks_customer_map_unique" UNIQUE (company_id, customer_id, realm_id),
    CONSTRAINT "quickbooks_customer_map_company_id_fkey" FOREIGN KEY (company_id)
        REFERENCES "public"."companies" (id) ON DELETE CASCADE,
    CONSTRAINT "quickbooks_customer_map_customer_id_fkey" FOREIGN KEY (customer_id)
        REFERENCES "public"."customers" (id) ON DELETE CASCADE,
    CONSTRAINT "quickbooks_customer_map_linked_by_fkey" FOREIGN KEY (linked_by)
        REFERENCES "public"."user_company_access" (id) ON DELETE SET NULL
);

ALTER TABLE "public"."quickbooks_customer_map" ENABLE ROW LEVEL SECURITY;

-- No secrets here -> company members may read; writes are backend-only (service_role).
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."quickbooks_customer_map" FROM "anon", "authenticated";

DROP POLICY IF EXISTS "Users can view their company's qb customer map" ON "public"."quickbooks_customer_map";
CREATE POLICY "Users can view their company's qb customer map"
    ON "public"."quickbooks_customer_map"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP TRIGGER IF EXISTS "quickbooks_customer_map_updated_at" ON "public"."quickbooks_customer_map";
CREATE TRIGGER quickbooks_customer_map_updated_at BEFORE UPDATE ON public.quickbooks_customer_map
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ───────────────────────── 3. quickbooks_invoice_links ─────────────────────────
-- Quote -> QBO invoice link AND idempotency ledger. A pending row is inserted with a
-- server-minted qb_request_id BEFORE the QBO POST; the UNIQUE(quote_id, realm_id) makes
-- the insert race-safe (ON CONFLICT DO NOTHING), and qb_request_id is replayed to QBO on
-- retry so a lost ack or double-submit never creates a second invoice. Quote-keyed is
-- safe given the verified 1:1 quote->job invariant; job_id is kept for traceability.
CREATE TABLE IF NOT EXISTS "public"."quickbooks_invoice_links"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "quote_id" uuid NOT NULL,
    "job_id" uuid,
    "realm_id" text NOT NULL,
    "qb_request_id" uuid NOT NULL,                  -- server-minted idempotency key passed to QBO as ?requestid=
    "qb_invoice_id" text,                           -- null while pending; set on success
    "qb_invoice_doc_number" text,
    "qb_invoice_sync_token" text,
    "status" text NOT NULL DEFAULT 'pending',       -- 'pending' | 'created' | 'error'
    "pushed_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "quickbooks_invoice_links_pkey" PRIMARY KEY (id),
    CONSTRAINT "quickbooks_invoice_links_quote_realm_key" UNIQUE (quote_id, realm_id),
    CONSTRAINT "quickbooks_invoice_links_status_check" CHECK (status IN ('pending', 'created', 'error')),
    CONSTRAINT "quickbooks_invoice_links_company_id_fkey" FOREIGN KEY (company_id)
        REFERENCES "public"."companies" (id) ON DELETE CASCADE,
    CONSTRAINT "quickbooks_invoice_links_quote_id_fkey" FOREIGN KEY (quote_id)
        REFERENCES "public"."quotes" (id) ON DELETE CASCADE,
    CONSTRAINT "quickbooks_invoice_links_job_id_fkey" FOREIGN KEY (job_id)
        REFERENCES "public"."jobs" (id) ON DELETE SET NULL,
    CONSTRAINT "quickbooks_invoice_links_pushed_by_fkey" FOREIGN KEY (pushed_by)
        REFERENCES "public"."user_company_access" (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_qb_invoice_links_quote
    ON public.quickbooks_invoice_links USING btree (quote_id);

ALTER TABLE "public"."quickbooks_invoice_links" ENABLE ROW LEVEL SECURITY;

-- Invoice ids are not secret -> members may read (for the "Pushed to QBO ✓" badge);
-- writes backend-only.
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."quickbooks_invoice_links" FROM "anon", "authenticated";

DROP POLICY IF EXISTS "Users can view their company's qb invoice links" ON "public"."quickbooks_invoice_links";
CREATE POLICY "Users can view their company's qb invoice links"
    ON "public"."quickbooks_invoice_links"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP TRIGGER IF EXISTS "quickbooks_invoice_links_updated_at" ON "public"."quickbooks_invoice_links";
CREATE TRIGGER quickbooks_invoice_links_updated_at BEFORE UPDATE ON public.quickbooks_invoice_links
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
