-- ============================================================================
-- Customer multi-contact: extract contacts to customer_contacts table
-- ============================================================================
--
-- Context. Customers carried embedded contact_name / contact_email /
-- contact_phone columns from iteration 1. The vendor side moved to a
-- multi-contact pattern in 20260504_vendor_contacts_and_drop_notes (referenced
-- there as the "customer parallel follow-up"). This is that follow-up.
--
-- Real-shop usage: a customer at a manufacturing client almost always involves
-- multiple people — a buyer/purchasing contact for POs, an AP contact for
-- invoices, an engineer for technical revisions. The single embedded contact
-- couldn't model that. We now mirror the vendor_contacts shape: a separate
-- customer_contacts table with a role enum + role_label override + is_primary.
--
-- The role enum is customer-flavored — 'buyer' replaces vendor's 'sales' since
-- the relationship inverts (we're selling TO them, so their primary contact
-- is usually a buyer/purchasing manager, not a salesperson).
--
-- IDEMPOTENT. Every step uses IF [NOT] EXISTS so the migration can be
-- re-applied against partial state (e.g. an earlier run that succeeded at
-- table creation but errored later). The backfill skips customers that
-- already have a contact row, so re-running won't duplicate.
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;

-- ============================================================================
-- Phase 1: Create customer_contacts table (idempotent)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.customer_contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    name text NOT NULL,
    role text NOT NULL CHECK (role IN (
        'buyer',
        'accounts_payable',
        'engineering',
        'quality',
        'shipping_receiving',
        'other'
    )),
    role_label text,
    email text,
    phone text,
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customer_contacts_role_label_required
        CHECK (role <> 'other' OR (role_label IS NOT NULL AND length(role_label) > 0))
);

COMMENT ON TABLE public.customer_contacts
    IS 'People at a customer. Replaces the single embedded contact_name/email/phone columns on customers. Each row is one person with a role + optional email/phone. At most one row per customer can have is_primary=true (enforced by the customer_contacts_one_primary partial unique index).';

COMMENT ON COLUMN public.customer_contacts.role_label
    IS 'Free-text label used when role=''other''. Lets the UI render "Other (Production Buyer)" without inventing a new enum value for every customer-specific role.';

COMMENT ON COLUMN public.customer_contacts.is_primary
    IS 'True for the contact treated as the customer''s primary point of contact. Surfaced on the customers list page and as a star badge on the customer detail page. Enforced unique-per-customer by the customer_contacts_one_primary partial index.';

CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer
    ON public.customer_contacts (customer_id);


-- ============================================================================
-- Phase 2: Partial unique index for the one-primary-per-customer invariant
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS customer_contacts_one_primary
    ON public.customer_contacts (customer_id) WHERE is_primary;


-- ============================================================================
-- Phase 3: Backfill from the existing single-contact columns (idempotent)
-- ============================================================================
--
-- Same rule as vendor_contacts: only insert rows where contact_name IS NOT NULL.
-- Wrapped in a column-existence check so re-running after Phase 5 has already
-- dropped the source columns is a no-op. We also skip customers that already
-- have a contact row, so the backfill is safe to re-run mid-state.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'customers'
           AND column_name = 'contact_name'
    ) THEN
        EXECUTE $sql$
            INSERT INTO public.customer_contacts (
                customer_id, name, role, email, phone, is_primary
            )
            SELECT c.id, c.contact_name, 'buyer', c.contact_email, c.contact_phone, true
              FROM public.customers c
             WHERE c.contact_name IS NOT NULL
               AND length(trim(c.contact_name)) > 0
               AND NOT EXISTS (
                   SELECT 1
                     FROM public.customer_contacts cc
                    WHERE cc.customer_id = c.id
               )
        $sql$;
    END IF;
END $$;


-- ============================================================================
-- Phase 4: Data-quality report — customers with email/phone but no name
-- ============================================================================
--
-- Same column-existence guard as Phase 3 so re-runs after Phase 5 stay quiet.

DO $$
DECLARE
    v_orphan_count integer;
    v_row record;
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'customers'
           AND column_name = 'contact_name'
    ) THEN
        RETURN;
    END IF;

    EXECUTE $sql$
        SELECT count(*)
          FROM public.customers
         WHERE (contact_name IS NULL OR length(trim(contact_name)) = 0)
           AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL)
    $sql$ INTO v_orphan_count;

    IF v_orphan_count > 0 THEN
        RAISE NOTICE
            'customer_contacts backfill: % customer(s) had email/phone but no contact_name. They have no contact row yet — add real contacts via the new Contacts UI on each customer detail page:',
            v_orphan_count;
        FOR v_row IN
            EXECUTE $sql$
                SELECT id, name, contact_email, contact_phone
                  FROM public.customers
                 WHERE (contact_name IS NULL OR length(trim(contact_name)) = 0)
                   AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL)
                 ORDER BY name
            $sql$
        LOOP
            RAISE NOTICE '  customer %: % | email=% | phone=%',
                v_row.id, v_row.name,
                COALESCE(v_row.contact_email, '—'),
                COALESCE(v_row.contact_phone, '—');
        END LOOP;
    END IF;
END $$;


-- ============================================================================
-- Phase 5: Drop the old single-contact columns (idempotent)
-- ============================================================================

ALTER TABLE public.customers
    DROP COLUMN IF EXISTS contact_name,
    DROP COLUMN IF EXISTS contact_email,
    DROP COLUMN IF EXISTS contact_phone;


-- ============================================================================
-- Phase 6: RLS policies on customer_contacts
-- ============================================================================

ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view customer_contacts" ON public.customer_contacts;
CREATE POLICY "Users can view customer_contacts"
    ON public.customer_contacts
    FOR SELECT
    USING (
        customer_id IN (
            SELECT c.id
              FROM public.customers c
             WHERE c.company_id IN (SELECT get_user_company_ids())
        )
    );

DROP POLICY IF EXISTS "Users can insert customer_contacts" ON public.customer_contacts;
CREATE POLICY "Users can insert customer_contacts"
    ON public.customer_contacts
    FOR INSERT
    WITH CHECK (
        customer_id IN (
            SELECT c.id
              FROM public.customers c
             WHERE c.company_id IN (SELECT get_user_company_ids())
        )
    );

DROP POLICY IF EXISTS "Users can update customer_contacts" ON public.customer_contacts;
CREATE POLICY "Users can update customer_contacts"
    ON public.customer_contacts
    FOR UPDATE
    USING (
        customer_id IN (
            SELECT c.id
              FROM public.customers c
             WHERE c.company_id IN (SELECT get_user_company_ids())
        )
    );

DROP POLICY IF EXISTS "Users can delete customer_contacts" ON public.customer_contacts;
CREATE POLICY "Users can delete customer_contacts"
    ON public.customer_contacts
    FOR DELETE
    USING (
        customer_id IN (
            SELECT c.id
              FROM public.customers c
             WHERE c.company_id IN (SELECT get_user_company_ids())
        )
    );

DROP POLICY IF EXISTS "ai_readonly_select" ON public.customer_contacts;
CREATE POLICY "ai_readonly_select"
    ON public.customer_contacts
    FOR SELECT
    TO jigged_ai_readonly
    USING (
        customer_id IN (
            SELECT c.id
              FROM public.customers c
             WHERE c.company_id = (current_setting('jigged.company_id', true))::uuid
        )
    );

GRANT SELECT ON public.customer_contacts TO jigged_ai_readonly;


-- ============================================================================
-- Phase 7: updated_at trigger
-- ============================================================================

DROP TRIGGER IF EXISTS customer_contacts_updated_at ON public.customer_contacts;
CREATE TRIGGER customer_contacts_updated_at
    BEFORE UPDATE ON public.customer_contacts
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


COMMIT;
