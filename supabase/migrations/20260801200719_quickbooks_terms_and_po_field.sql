-- Carry payment terms to the invoice, and give the PO number somewhere it prints.
--
-- TWO LIVE DEFECTS, both confirmed against the connected sandbox rather than
-- inferred from documentation:
--
-- 1. THE TERMS JIGGED COLLECTS NEVER REACH THE INVOICE. The push payload
--    (api/services/quickbooks.py) sends CustomerRef, Line, PrivateNote and
--    BillAddr — no SalesTermRef and no DueDate. Reading the five most recent
--    real invoices in the sandbox: every one has SalesTermRef = None and a
--    DueDate of exactly TxnDate + 30. No customer in that company has terms set
--    either (SalesTermRef null on all ten), so the 30 days comes from a QBO
--    company default. Every invoice the shop has ever sent carried a due date
--    nobody in Jigged chose or could see. Note this contradicts Intuit's own
--    docs, which say the fallback is the transaction date — observed behaviour
--    is +30.
--
-- 2. THE PO NUMBER IS HALF-INVISIBLE. It goes to the line Description (prints,
--    and AP pays from it — keep it) and to PrivateNote, which Intuit documents
--    as "does not appear on the invoice to the customer". Half of the current
--    stamping does nothing for the people it is aimed at.
--
-- WHY jobs.payment_terms EXISTS AT ALL. Terms live on `quotes`, invoices are
-- pushed from `jobs`, and nothing carried the value across. A job is where a
-- quote's commercial promise becomes an order, so that is where the term has to
-- land to survive to the invoice. Backfilled from the originating quote below,
-- in this migration — not resolved live at push time, which would re-read a
-- quote that may since have been edited.
--
-- WHY THE PO CUSTOM FIELD IS DISCOVERED, NOT CREATED. Verified live, both paths:
--   * Legacy REST Preferences write: returns HTTP 200 and SILENTLY DOES NOTHING.
--     Three body shapes tried; CustomField came back null each time and a re-read
--     showed UseSalesCustom1/2/3 still false with no name entries. Intuit's
--     capability matrix says "Create custom field names | UI: Yes | API: No" and
--     the sandbox agrees.
--   * GraphQL Custom Fields API: HTTP 403 with our credentials (Silver partner
--     tier, US$300/mo), and sandbox-qb.api.intuit.com does not resolve at all.
--   So the field can only be created by a human in the QBO UI. Jigged discovers
--   whether one exists and writes to it if so; it must never guess a slot,
--   because writing to an unmatched DefinitionId overwrites whatever the shop
--   put there (commonly "Sales Rep" or "Job #") and the slot mapping is
--   immutable.

-- ---------------------------------------------------------------------------
-- 1. jobs.payment_terms — the term this order was sold on.
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS payment_terms text;

COMMENT ON COLUMN public.jobs.payment_terms IS
    'Payment terms this order was sold on, copied from the originating quote at conversion and editable on the job. Pushed to QuickBooks as SalesTermRef when the invoice is created. Distinct from customers.default_payment_terms (the standing agreement, which only seeds a NEW quote) — a job keeps what it was converted with.';

-- BACKFILL, in this migration, so no row is left in a state the read path has to
-- branch on. A job converted from a quote inherits that quote's terms; a job
-- with no quote (or a quote with no terms) stays NULL, which is a real absence
-- rather than a missing value.
UPDATE public.jobs j
   SET payment_terms = q.payment_terms
  FROM public.quotes q
 WHERE j.quote_id = q.id
   AND j.payment_terms IS NULL
   AND q.payment_terms IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Per-connection QuickBooks facts Jigged has to discover and remember.
-- ---------------------------------------------------------------------------
ALTER TABLE public.quickbooks_connections
    ADD COLUMN IF NOT EXISTS term_map jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS po_custom_field_id text,
    ADD COLUMN IF NOT EXISTS po_custom_field_name text,
    ADD COLUMN IF NOT EXISTS qb_settings_checked_at timestamptz;

COMMENT ON COLUMN public.quickbooks_connections.term_map IS
    'Jigged payment-term string -> QuickBooks Term Id, e.g. {"Net 30": "3"}. Populated by syncing QBO''s Term list on connect and lazily creating any term the shop uses that QBO lacks. Needed because SalesTermRef is a reference to a Term entity — you cannot push the string "Net 30". Match case-insensitively when resolving: QBO ships "Due on receipt" (lowercase r) and Jigged''s preset is "Due on Receipt", and a naive compare creates a near-duplicate. Verified live: POSTing a Term whose name already exists is REJECTED with HTTP 400, so resolve-then-create is required, not optional.';

COMMENT ON COLUMN public.quickbooks_connections.po_custom_field_id IS
    'DefinitionId (1-3) of the sales custom field this shop uses for the customer PO number, discovered by reading Preferences.SalesFormsPrefs.CustomField and matching the field''s LABEL — never by position, since Intuit states definitions "may not appear in numeric order". NULL means the shop has not created one, which is the default state and must degrade silently: send no CustomField at all rather than guessing a slot. Jigged cannot create the field (verified: REST no-ops, GraphQL 403).';

COMMENT ON COLUMN public.quickbooks_connections.qb_settings_checked_at IS
    'When Preferences was last read for custom-field discovery. Lets the settings UI show staleness and offer a re-check after the shop configures a field in QuickBooks, without re-reading Preferences on every invoice push.';
