-- ============================================================================
-- PURCHASING (1 of 5): the tables
-- ============================================================================
-- Jigged can buy things: vendor purchase orders for material, bought parts, outside
-- services and anything else (maintenance, tooling, freight); receiving into stock with
-- heat, lot and cert; an approved vendor list with price sheets; RFQs to several
-- vendors; and the QuickBooks tables an optional PO push writes. Issue #571, revived.
--
-- "PO" ALONE ALREADY MEANS THE CUSTOMER'S PO (jobs.customer_po_number), so every object
-- here says vendor or purchasing.
--
-- THE POSTURE, THE SAME FOR EVERY TABLE BELOW
--   * company_id -> companies ON DELETE CASCADE, so one company DELETE removes the graph.
--   * The browser gets SELECT and nothing else. Every write is a SECURITY DEFINER RPC
--     (migrations 3 and 4) that derives the company, asserts an office role
--     (assert_office_member, below), calls company_can_write by hand and scopes every id
--     to the document it is changing. Decision 3 needs the role enforced in the database,
--     and RLS has no role predicate.
--   * RLS on, one SELECT policy over get_user_company_ids(); the billing write-gate on
--     every table (it is never evaluated for a role with no write grant, but it is what
--     satisfies tenant_tables_missing_write_gate() without an exempt claim).
--   * Named revokes, not REVOKE ALL (CLAUDE.md): a new public table arrives with
--     TRUNCATE, REFERENCES, TRIGGER and MAINTAIN for anon and authenticated and SELECT for
--     the insights AI. Those are the privileges actually present, so those are revoked.
--   * Composite foreign keys keep every child on the same parent AND company, so a
--     mismatched id is unrepresentable rather than a rule an RPC must remember.
--   * Actor columns (*_by) reference auth.users ON DELETE SET NULL. The STATE is the *_at
--     column; each CHECK only says a *_by cannot exist without its *_at, so deleting a
--     login never breaks a row.
--
-- THE AI (query_shop_data) reads the documents column by column: actor columns, internal
-- notes, contact/address snapshots, terms and conditions, notes and reasons are withheld.
-- Child tables inherit their parent's deleted_at in a hand-written ai_readonly_select
-- policy. The revisions, the numbering series and the four QuickBooks tables are exempt.
-- ============================================================================


-- ============================================================================
-- 0. assert_office_member -- the role check every purchasing writer starts with
-- ============================================================================
-- No SQL helper checked for an office role before this; is_company_admin is admin-only.
-- INVOKER, and called only from SECURITY DEFINER bodies, so it runs as their owner and
-- reads user_company_access past RLS. The browser cannot execute it: a probe that says
-- "you are an operator here" is not something a caller needs.
--
-- It deliberately does NOT contain company_can_write. definer_writers_missing_write_gate()
-- matches that literal in the WRITER's own body, so hoisting it in here would turn the
-- guard red for a reason nobody could find from its output.
--
-- Not found and not a member are the SAME sentence (P0001), so the function cannot be used
-- to learn whether a record exists in someone else's company. An operator gets 42501: the
-- one refusal that is about who you are rather than what you asked for.
CREATE OR REPLACE FUNCTION public.assert_office_member(p_company_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_role text;
    v_found boolean := false;
BEGIN
    IF p_company_id IS NOT NULL AND auth.uid() IS NOT NULL THEN
        SELECT true, uca.role INTO v_found, v_role
          FROM public.user_company_access uca
         WHERE uca.company_id = p_company_id
           AND uca.user_id = auth.uid()
         ORDER BY CASE uca.role WHEN 'admin' THEN 0 WHEN 'user' THEN 1 ELSE 2 END
         LIMIT 1;
    END IF;

    IF NOT COALESCE(v_found, false) THEN
        RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
    END IF;

    IF v_role IS NULL OR v_role NOT IN ('admin', 'user') THEN
        RAISE EXCEPTION 'This is an office task: operators can''t change purchasing records.'
            USING ERRCODE = '42501';
    END IF;

    RETURN v_role;
END
$fn$;

COMMENT ON FUNCTION public.assert_office_member(uuid) IS
  'Purchasing writers call this first, with the company they derived from the row: P0001 "That record is not available." when the company is unknown or the caller is not a member (one sentence for both, so it cannot probe existence), 42501 for an operator. Returns the role (admin | user). Deliberately does not check billing: every writer calls company_can_write in its own body, because definer_writers_missing_write_gate() matches that literal there. Internal: no browser EXECUTE.';

REVOKE EXECUTE ON FUNCTION public.assert_office_member(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.assert_office_member(uuid) TO service_role;


-- ============================================================================
-- 1. vendors.default_payment_terms -- the vendor's standing terms
-- ============================================================================
-- Mirrors customers.default_payment_terms: free text from the same vocabulary as quotes,
-- written by the vendor page like any other vendor column, copied onto a NEW purchase
-- order when its create omits payment_terms, and never read by an existing one.
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS default_payment_terms text;

COMMENT ON COLUMN public.vendors.default_payment_terms IS
  'Standing payment terms with this vendor ("Net 30"), copied onto a new vendor purchase order when its create omits payment_terms, and editable there. Free text, the same vocabulary as customers.default_payment_terms. NULL means no standing agreement recorded. Never read at render time by an existing purchase order: a PO keeps the terms it was raised on.';


-- ============================================================================
-- 2. purchasing_document_series -- PO and RFQ numbering, plus their T&Cs
-- ============================================================================
-- Not next_order_number: that is the shared Q-/J- counter, browser-executable and with no
-- membership check. A row per (company, kind), locked FOR UPDATE by the mint, so two
-- creates serialise and a rolled-back create consumes nothing.
CREATE TABLE public.purchasing_document_series (
    company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    document_kind         text NOT NULL,
    prefix                text NOT NULL,
    next_number           bigint NOT NULL DEFAULT 1,
    min_digits            smallint NOT NULL DEFAULT 4,
    terms_and_conditions  text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,

    CONSTRAINT purchasing_document_series_pkey PRIMARY KEY (company_id, document_kind),
    CONSTRAINT purchasing_document_series_kind
        CHECK (document_kind IN ('vendor_purchase_order', 'vendor_rfq')),
    -- '' is allowed: a shop continuing its QuickBooks sequence "1043" has no prefix.
    CONSTRAINT purchasing_document_series_prefix_shape
        CHECK (prefix ~ '^[A-Za-z0-9-]{0,6}$'),
    CONSTRAINT purchasing_document_series_next_positive CHECK (next_number >= 1),
    CONSTRAINT purchasing_document_series_digits CHECK (min_digits BETWEEN 1 AND 8),
    CONSTRAINT purchasing_document_series_terms_length
        CHECK (terms_and_conditions IS NULL OR char_length(terms_and_conditions) <= 10000),
    -- QuickBooks Desktop's refNumber holds 11 characters. The mint also refuses a number
    -- that outgrows its min_digits past 11 (PO-99999999 is the last one under 'PO-').
    CONSTRAINT purchasing_document_series_po_fits_quickbooks
        CHECK (document_kind <> 'vendor_purchase_order' OR char_length(prefix) + min_digits <= 11)
);

COMMENT ON TABLE public.purchasing_document_series IS
  'Numbering and printed terms for vendor purchase orders (default PO-0001) and vendor RFQs (fixed RFQ-0001). One row per company and kind, created on first use. next_purchasing_document_number mints under a FOR UPDATE lock, skips a number that already exists and never reissues one; a rolled-back create consumes nothing. Settings are changed only through save_purchasing_document_settings (any office user).';
COMMENT ON COLUMN public.purchasing_document_series.prefix IS
  'Letters, digits and dashes, 0-6 characters. Empty is allowed so a shop can continue a QuickBooks sequence such as 1043.';
COMMENT ON COLUMN public.purchasing_document_series.next_number IS
  'The number the next document gets, before zero-padding to min_digits. Only ever moves forward: the settings RPC refuses a value at or below the highest number already issued under the prefix.';
COMMENT ON COLUMN public.purchasing_document_series.terms_and_conditions IS
  'Printed terms copied onto each new document of this kind at create. Editing them never changes a document already raised.';

CREATE TRIGGER purchasing_document_series_updated_at
    BEFORE UPDATE ON public.purchasing_document_series
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 3. RFQs: vendor_rfqs, vendor_rfq_lines, vendor_rfq_invitations
-- ============================================================================
-- Created before the purchase orders, which point back at the RFQ they were awarded from.
CREATE TABLE public.vendor_rfqs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    rfq_number            text NOT NULL,
    title                 text,
    needed_by_on          date,
    respond_by_on         date,
    notes_to_vendors      text,
    internal_notes        text,
    terms_and_conditions  text,
    -- Shop ship-to, frozen at create (company_address_block_snapshot).
    ship_to_name          text NOT NULL,
    ship_to_address       jsonb,
    closed_at             timestamptz,
    closed_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    closed_reason         text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    deleted_at            timestamptz,

    CONSTRAINT vendor_rfqs_number_shape
        CHECK (rfq_number = btrim(rfq_number) AND char_length(rfq_number) BETWEEN 1 AND 20),
    CONSTRAINT vendor_rfqs_number_unique UNIQUE (company_id, rfq_number),
    CONSTRAINT vendor_rfqs_identity UNIQUE (id, company_id),
    CONSTRAINT vendor_rfqs_title_shape
        CHECK (title IS NULL OR (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200)),
    CONSTRAINT vendor_rfqs_text_lengths CHECK (
        (notes_to_vendors IS NULL OR char_length(notes_to_vendors) <= 10000)
        AND (internal_notes IS NULL OR char_length(internal_notes) <= 10000)
        AND (terms_and_conditions IS NULL OR char_length(terms_and_conditions) <= 10000)),
    CONSTRAINT vendor_rfqs_closed_by_needs_closed_at
        CHECK (closed_by IS NULL OR closed_at IS NOT NULL)
);

COMMENT ON TABLE public.vendor_rfqs IS
  'A request for quotation sent to one or more vendors (vendor_rfq_invitations), for one or more lines each with up to four quantities. Numbered from the fixed RFQ- series. Derived status (draft / sent / quoted / awarded / closed) lives in the vendor_rfq_status view. Archived with deleted_at, never deleted. Written only through the RFQ RPCs.';

CREATE INDEX idx_vendor_rfqs_company_live
    ON public.vendor_rfqs (company_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER vendor_rfqs_updated_at
    BEFORE UPDATE ON public.vendor_rfqs
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


CREATE TABLE public.vendor_rfq_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vendor_rfq_id   uuid NOT NULL,
    line_number     integer NOT NULL,
    -- A part, or ad-hoc text. An awarded ad-hoc line becomes an "other" PO line.
    part_id         uuid REFERENCES public.parts(id) ON DELETE RESTRICT,
    part_name       text,
    description     text NOT NULL,
    unit            text NOT NULL,
    quantities      numeric[] NOT NULL,
    job_id          uuid REFERENCES public.jobs(id) ON DELETE RESTRICT,
    job_number      text,
    cert_required   boolean NOT NULL DEFAULT false,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendor_rfq_lines_rfq_fk
        FOREIGN KEY (vendor_rfq_id, company_id)
        REFERENCES public.vendor_rfqs (id, company_id) ON DELETE CASCADE,
    CONSTRAINT vendor_rfq_lines_number_positive CHECK (line_number > 0),
    CONSTRAINT vendor_rfq_lines_number_unique UNIQUE (vendor_rfq_id, line_number),
    -- The responses' composite FK target: a response cannot name another RFQ's line.
    CONSTRAINT vendor_rfq_lines_identity UNIQUE (id, company_id, vendor_rfq_id),
    CONSTRAINT vendor_rfq_lines_description_shape
        CHECK (btrim(description) <> '' AND char_length(description) <= 2000),
    CONSTRAINT vendor_rfq_lines_unit_shape
        CHECK (btrim(unit) <> '' AND char_length(unit) <= 40),
    CONSTRAINT vendor_rfq_lines_quantities
        CHECK (cardinality(quantities) BETWEEN 1 AND 4
               AND array_position(quantities, NULL) IS NULL
               AND 0 < ALL (quantities)),
    CONSTRAINT vendor_rfq_lines_part_snapshot
        CHECK (part_id IS NULL OR part_name IS NOT NULL),
    CONSTRAINT vendor_rfq_lines_job_snapshot
        CHECK (job_id IS NULL OR job_number IS NOT NULL)
);

COMMENT ON TABLE public.vendor_rfq_lines IS
  'What an RFQ asks prices for: a part (frozen part_name) or ad-hoc text, in one unit, at one to four quantities. Responses are priced per this unit at one of these quantities. A line with responses cannot be removed (the responses RESTRICT it).';
COMMENT ON COLUMN public.vendor_rfq_lines.quantities IS
  'One to four quantities, all > 0, in this line''s unit. A response must quote one of them.';

CREATE INDEX idx_vendor_rfq_lines_rfq ON public.vendor_rfq_lines (vendor_rfq_id);
CREATE INDEX idx_vendor_rfq_lines_part ON public.vendor_rfq_lines (part_id) WHERE part_id IS NOT NULL;
CREATE INDEX idx_vendor_rfq_lines_job ON public.vendor_rfq_lines (job_id) WHERE job_id IS NOT NULL;

CREATE TRIGGER vendor_rfq_lines_updated_at
    BEFORE UPDATE ON public.vendor_rfq_lines
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


CREATE TABLE public.vendor_rfq_invitations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vendor_rfq_id           uuid NOT NULL,
    vendor_id               uuid NOT NULL REFERENCES public.vendors(id) ON DELETE RESTRICT,
    vendor_name             text NOT NULL,
    vendor_contact_id       uuid REFERENCES public.vendor_contacts(id) ON DELETE SET NULL,
    vendor_contact          jsonb,
    sent_at                 timestamptz,
    sent_by                 uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    declined_at             timestamptz,
    declined_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    declined_reason         text,
    vendor_quote_reference  text,
    quoted_on               date,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendor_rfq_invitations_rfq_fk
        FOREIGN KEY (vendor_rfq_id, company_id)
        REFERENCES public.vendor_rfqs (id, company_id) ON DELETE CASCADE,
    CONSTRAINT vendor_rfq_invitations_one_per_vendor UNIQUE (vendor_rfq_id, vendor_id),
    CONSTRAINT vendor_rfq_invitations_identity UNIQUE (id, company_id, vendor_rfq_id),
    CONSTRAINT vendor_rfq_invitations_sent_by_needs_sent_at
        CHECK (sent_by IS NULL OR sent_at IS NOT NULL),
    CONSTRAINT vendor_rfq_invitations_declined_by_needs_declined_at
        CHECK (declined_by IS NULL OR declined_at IS NOT NULL),
    CONSTRAINT vendor_rfq_invitations_reference_shape
        CHECK (vendor_quote_reference IS NULL
               OR (vendor_quote_reference = btrim(vendor_quote_reference)
                   AND char_length(vendor_quote_reference) BETWEEN 1 AND 64))
);

COMMENT ON TABLE public.vendor_rfq_invitations IS
  'One vendor asked to quote an RFQ, with the contact frozen at invite time (sales contact, else the primary). sent_at is stamped by Mark sent (PDF plus mailto, no server email); declined_at by Declined, which refuses that vendor''s responses until undone.';

CREATE INDEX idx_vendor_rfq_invitations_rfq ON public.vendor_rfq_invitations (vendor_rfq_id);
CREATE INDEX idx_vendor_rfq_invitations_vendor ON public.vendor_rfq_invitations (vendor_id);

CREATE TRIGGER vendor_rfq_invitations_updated_at
    BEFORE UPDATE ON public.vendor_rfq_invitations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 4. vendor_purchase_orders -- the header
-- ============================================================================
CREATE TABLE public.vendor_purchase_orders (
    id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    po_number                     text NOT NULL,

    -- The vendor, and the party block frozen from it (Document Snapshot Standard).
    vendor_id                     uuid NOT NULL REFERENCES public.vendors(id) ON DELETE RESTRICT,
    vendor_name                   text NOT NULL,
    vendor_address_id             uuid REFERENCES public.vendor_addresses(id) ON DELETE SET NULL,
    vendor_address                jsonb,
    vendor_contact_id             uuid REFERENCES public.vendor_contacts(id) ON DELETE SET NULL,
    vendor_contact                jsonb,

    -- Where it ships: our shop, another vendor (drop-ship to the plater) or a customer.
    ship_to_kind                  text NOT NULL DEFAULT 'shop',
    ship_to_vendor_id             uuid REFERENCES public.vendors(id) ON DELETE SET NULL,
    ship_to_vendor_address_id     uuid REFERENCES public.vendor_addresses(id) ON DELETE SET NULL,
    ship_to_customer_id           uuid REFERENCES public.customers(id) ON DELETE SET NULL,
    ship_to_customer_address_id   uuid REFERENCES public.customer_addresses(id) ON DELETE SET NULL,
    ship_to_name                  text NOT NULL,
    ship_to_address               jsonb,

    -- Promises are dates; ordered_on is the BROWSER's local date (QuickBooks TxnDate).
    ordered_on                    date NOT NULL,
    need_by_on                    date,
    payment_terms                 text,
    ship_via                      text,

    notes_to_vendor               text,
    internal_notes                text,
    terms_and_conditions          text,

    -- Send state. revision bumps at most once per send cycle (see the RPCs);
    -- sent_revision is the one the vendor last received.
    revision                      integer NOT NULL DEFAULT 0,
    sent_revision                 integer,
    issued_at                     timestamptz,
    issued_by                     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    last_sent_at                  timestamptz,
    -- Bumped whenever a field the QuickBooks push sends changes; content_hash is the md5 of
    -- that projection at this version (vendor_purchase_order_settle_versions compares them).
    content_version               integer NOT NULL DEFAULT 0,
    content_hash                  text,
    -- Line numbers are printed and never reused, so the counter lives here.
    last_line_number              integer NOT NULL DEFAULT 0,

    closed_at                     timestamptz,
    closed_by                     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    closed_reason                 text,
    vendor_rfq_id                 uuid REFERENCES public.vendor_rfqs(id) ON DELETE SET NULL,

    created_at                    timestamptz NOT NULL DEFAULT now(),
    created_by                    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_at                    timestamptz NOT NULL DEFAULT now(),
    deleted_at                    timestamptz,

    -- 11 characters: QuickBooks Desktop's refNumber.
    CONSTRAINT vendor_purchase_orders_number_shape
        CHECK (po_number = btrim(po_number) AND char_length(po_number) BETWEEN 1 AND 11),
    -- FULL, not partial: an archived PO keeps its number and it is never reissued.
    CONSTRAINT vendor_purchase_orders_number_unique UNIQUE (company_id, po_number),
    CONSTRAINT vendor_purchase_orders_identity UNIQUE (id, company_id),
    CONSTRAINT vendor_purchase_orders_ship_to_kind
        CHECK (ship_to_kind IN ('shop', 'vendor', 'customer')),
    -- The ids on the side the kind does not name stay empty. SET NULL may clear the ids on
    -- the named side later (a hard-deleted address); the frozen name and address remain.
    CONSTRAINT vendor_purchase_orders_ship_to_side CHECK (
        (ship_to_kind = 'shop'
            AND ship_to_vendor_id IS NULL AND ship_to_vendor_address_id IS NULL
            AND ship_to_customer_id IS NULL AND ship_to_customer_address_id IS NULL)
        OR (ship_to_kind = 'vendor'
            AND ship_to_customer_id IS NULL AND ship_to_customer_address_id IS NULL)
        OR (ship_to_kind = 'customer'
            AND ship_to_vendor_id IS NULL AND ship_to_vendor_address_id IS NULL)),
    CONSTRAINT vendor_purchase_orders_ship_to_name
        CHECK (btrim(ship_to_name) <> '' AND char_length(ship_to_name) <= 200),
    CONSTRAINT vendor_purchase_orders_revision_non_negative CHECK (revision >= 0),
    CONSTRAINT vendor_purchase_orders_sent_revision_range
        CHECK (sent_revision IS NULL OR (sent_revision >= 0 AND sent_revision <= revision)),
    -- Sent is one fact in three columns.
    CONSTRAINT vendor_purchase_orders_sent_state
        CHECK ((issued_at IS NULL) = (sent_revision IS NULL)
               AND (issued_at IS NULL) = (last_sent_at IS NULL)),
    CONSTRAINT vendor_purchase_orders_issued_by_needs_issued_at
        CHECK (issued_by IS NULL OR issued_at IS NOT NULL),
    -- A draft cannot be closed: archive it instead.
    CONSTRAINT vendor_purchase_orders_closed_needs_sent
        CHECK (closed_at IS NULL OR issued_at IS NOT NULL),
    CONSTRAINT vendor_purchase_orders_closed_by_needs_closed_at
        CHECK (closed_by IS NULL OR closed_at IS NOT NULL),
    CONSTRAINT vendor_purchase_orders_content_version_non_negative CHECK (content_version >= 0),
    CONSTRAINT vendor_purchase_orders_last_line_number_non_negative CHECK (last_line_number >= 0),
    CONSTRAINT vendor_purchase_orders_text_lengths CHECK (
        (payment_terms IS NULL OR char_length(payment_terms) <= 100)
        AND (ship_via IS NULL OR char_length(ship_via) <= 100)
        AND (notes_to_vendor IS NULL OR char_length(notes_to_vendor) <= 10000)
        AND (internal_notes IS NULL OR char_length(internal_notes) <= 10000)
        AND (terms_and_conditions IS NULL OR char_length(terms_and_conditions) <= 10000)
        AND (closed_reason IS NULL OR char_length(closed_reason) <= 1000))
);

COMMENT ON TABLE public.vendor_purchase_orders IS
  'A purchase order TO A VENDOR (never the customer''s PO, which is jobs.customer_po_number). Jigged-numbered from purchasing_document_series. The vendor, contact, address, ship-to and terms & conditions are frozen at create; master-record edits never change them. Status is derived (vendor_purchase_order_status view), never stored. Archived with deleted_at, never deleted; a number is never reissued. Written only through the vendor purchase order RPCs.';
COMMENT ON COLUMN public.vendor_purchase_orders.ordered_on IS
  'The order date as the BROWSER saw it (the caller''s local date, never CURRENT_DATE). Editable while a draft. QuickBooks TxnDate / transactionDate.';
COMMENT ON COLUMN public.vendor_purchase_orders.revision IS
  'Rev N on the document. Drafts never bump it. After a send, the first save that changes the vendor-visible document (md5 of vendor_purchase_order_document) bumps it exactly once until the next send. Internal notes, promised dates and closing never bump it.';
COMMENT ON COLUMN public.vendor_purchase_orders.sent_revision IS
  'The revision the vendor last received (Mark as sent). revision > sent_revision means "Rev N not sent". NULL while a draft.';
COMMENT ON COLUMN public.vendor_purchase_orders.content_version IS
  'Bumped whenever a field the QuickBooks push sends changes (vendor_purchase_order_pushed_projection), including close and reopen, at the PO and at a line. "Closed" there is the DERIVED status, the one the push acts on, so a receipt or a void that moves the PO into or out of closed (nothing outstanding while a line was closed short) bumps it, whether it is a PO receipt or a receipt on a linked vendor packing slip. An ordinary receipt, internal notes and promised dates never bump it. "Out of date in QuickBooks" is content_version > the link''s pushed_content_version, which needs no QuickBooks call.';
COMMENT ON COLUMN public.vendor_purchase_orders.content_hash IS
  'md5 of vendor_purchase_order_pushed_projection() at the current content_version: every writer ends with vendor_purchase_order_settle_versions, which bumps content_version exactly when the projection no longer hashes to this, so a change is counted whichever writer, trigger or transaction made it. NULL only between the header insert and the end of the RPC that creates the PO (create_vendor_purchase_order, award_vendor_rfq), whose settle records the first value without a bump. A migration that changes what the projection contains must re-record it for every PO in the same migration, deciding on purpose whether existing POs should read out of date. Internal: not AI-readable.';
COMMENT ON COLUMN public.vendor_purchase_orders.last_line_number IS
  'The highest line number ever issued on this PO. Line numbers are printed and never reused, so a removed line 3 is not given to the next line.';
COMMENT ON COLUMN public.vendor_purchase_orders.internal_notes IS
  'Never printed, never sent to QuickBooks, never bumps the revision. Editable on a closed or archived PO. Withheld from the insights AI.';

CREATE INDEX idx_vendor_purchase_orders_company_live
    ON public.vendor_purchase_orders (company_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_vendor_purchase_orders_vendor_live
    ON public.vendor_purchase_orders (company_id, vendor_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_vendor_purchase_orders_vendor ON public.vendor_purchase_orders (vendor_id);
CREATE INDEX idx_vendor_purchase_orders_rfq
    ON public.vendor_purchase_orders (vendor_rfq_id) WHERE vendor_rfq_id IS NOT NULL;

CREATE TRIGGER vendor_purchase_orders_updated_at
    BEFORE UPDATE ON public.vendor_purchase_orders
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 5. vendor_purchase_order_lines
-- ============================================================================
CREATE TABLE public.vendor_purchase_order_lines (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                 uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vendor_purchase_order_id   uuid NOT NULL,
    line_number                integer NOT NULL,
    line_kind                  text NOT NULL,

    -- What it buys. part_name is the frozen parts.part_name (the shop's part number).
    part_id                    uuid REFERENCES public.parts(id) ON DELETE RESTRICT,
    part_name                  text,
    description                text NOT NULL,
    vendor_part_number         text,

    -- Quantity in the PURCHASE unit. Part lines freeze the stock unit and factor at
    -- insert: stock = quantity x stock_factor, exactly. Later conversion edits never
    -- change a line.
    quantity                   numeric NOT NULL,
    unit                       text NOT NULL,
    stock_unit                 text,
    stock_factor               numeric,

    -- Per purchase unit. NULL = "price to be confirmed" (prints TBC; a push is refused).
    unit_price                 numeric(16,5),
    price_source               text,

    need_by_on                 date,
    -- What the vendor promised, internal only: never printed, never bumps the revision.
    -- Part and other lines only: an outside line waits on its slips' due-back dates.
    promised_on                date,
    cert_required              boolean NOT NULL DEFAULT false,
    -- False only on an "other" line that never arrives (freight, a fee).
    expects_receipt            boolean NOT NULL DEFAULT true,

    -- Links. RESTRICT on the job side: a line the vendor has seen must not vanish with a
    -- job, part or operation (all three archive in the app; only fixtures hard-delete).
    job_id                     uuid REFERENCES public.jobs(id) ON DELETE RESTRICT,
    job_number                 text,
    job_part_id                uuid REFERENCES public.job_parts(id) ON DELETE RESTRICT,
    job_operation_id           uuid REFERENCES public.job_operations(id) ON DELETE RESTRICT,
    operation_label            text,
    vendor_service_id          uuid REFERENCES public.vendor_services(id) ON DELETE SET NULL,
    service_name               text,
    work_center_id             uuid REFERENCES public.work_centers(id) ON DELETE SET NULL,
    work_center_name           text,

    closed_at                  timestamptz,
    closed_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    closed_reason              text,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    created_by                 uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_at                 timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendor_purchase_order_lines_po_fk
        FOREIGN KEY (vendor_purchase_order_id, company_id)
        REFERENCES public.vendor_purchase_orders (id, company_id) ON DELETE CASCADE,
    CONSTRAINT vendor_purchase_order_lines_number_positive CHECK (line_number > 0),
    CONSTRAINT vendor_purchase_order_lines_number_unique UNIQUE (vendor_purchase_order_id, line_number),
    CONSTRAINT vendor_purchase_order_lines_identity UNIQUE (id, company_id),
    -- The receipts' composite FK target: a receipt cannot name another PO's line, or
    -- exist at all for an outside-service line.
    CONSTRAINT vendor_purchase_order_lines_receipt_target
        UNIQUE (id, company_id, vendor_purchase_order_id, line_kind),
    CONSTRAINT vendor_purchase_order_lines_kind
        CHECK (line_kind IN ('part', 'outside_service', 'other')),
    CONSTRAINT vendor_purchase_order_lines_description_shape
        CHECK (btrim(description) <> '' AND char_length(description) <= 2000),
    CONSTRAINT vendor_purchase_order_lines_vendor_part_number_shape
        CHECK (vendor_part_number IS NULL
               OR (vendor_part_number = btrim(vendor_part_number)
                   AND char_length(vendor_part_number) BETWEEN 1 AND 64)),
    CONSTRAINT vendor_purchase_order_lines_quantity_positive CHECK (quantity > 0),
    CONSTRAINT vendor_purchase_order_lines_unit_shape
        CHECK (btrim(unit) <> '' AND char_length(unit) <= 40),
    CONSTRAINT vendor_purchase_order_lines_factor_positive
        CHECK (stock_factor IS NULL OR stock_factor > 0),
    CONSTRAINT vendor_purchase_order_lines_price_non_negative
        CHECK (unit_price IS NULL OR unit_price >= 0),
    CONSTRAINT vendor_purchase_order_lines_price_source
        CHECK (price_source IS NULL
               OR price_source IN ('price_sheet', 'last_po', 'estimate', 'vendor_service', 'rfq', 'manual')),
    -- A price has a source; "to be confirmed" has none.
    CONSTRAINT vendor_purchase_order_lines_price_has_source
        CHECK ((unit_price IS NULL) = (price_source IS NULL)),
    CONSTRAINT vendor_purchase_order_lines_no_receipt_is_other
        CHECK (expects_receipt OR line_kind = 'other'),
    CONSTRAINT vendor_purchase_order_lines_outside_has_no_promise
        CHECK (promised_on IS NULL OR line_kind <> 'outside_service'),
    CONSTRAINT vendor_purchase_order_lines_job_part_needs_job
        CHECK (job_part_id IS NULL OR job_id IS NOT NULL),
    CONSTRAINT vendor_purchase_order_lines_operation_needs_job_part
        CHECK (job_operation_id IS NULL OR job_part_id IS NOT NULL),
    CONSTRAINT vendor_purchase_order_lines_snapshots CHECK (
        (part_id IS NULL OR part_name IS NOT NULL)
        AND (job_id IS NULL OR job_number IS NOT NULL)
        AND (job_operation_id IS NULL OR operation_label IS NOT NULL)
        AND (work_center_id IS NULL OR work_center_name IS NOT NULL)),
    -- What each kind needs, and what it may not carry.
    CONSTRAINT vendor_purchase_order_lines_kind_shape CHECK (
        (line_kind = 'part'
            AND part_id IS NOT NULL AND stock_unit IS NOT NULL AND stock_factor IS NOT NULL
            AND job_operation_id IS NULL AND vendor_service_id IS NULL AND work_center_id IS NULL)
        OR (line_kind = 'outside_service'
            AND job_operation_id IS NOT NULL AND part_id IS NOT NULL
            AND stock_unit IS NULL AND stock_factor IS NULL AND work_center_id IS NULL)
        OR (line_kind = 'other'
            AND part_id IS NULL AND job_operation_id IS NULL AND vendor_service_id IS NULL
            AND stock_unit IS NULL AND stock_factor IS NULL)),
    CONSTRAINT vendor_purchase_order_lines_closed_by_needs_closed_at
        CHECK (closed_by IS NULL OR closed_at IS NOT NULL),
    CONSTRAINT vendor_purchase_order_lines_closed_reason_length
        CHECK (closed_reason IS NULL OR char_length(closed_reason) <= 1000)
);

COMMENT ON TABLE public.vendor_purchase_order_lines IS
  'One line of a vendor purchase order. line_kind part (a part, made or bought, received into stock), outside_service (one job operation''s outside work, received on its vendor packing slips, never here) or other (maintenance, tooling, freight: quantity only, optionally on a work centre and/or a job). Line numbers are never reused. Snapshots (part_name, job_number, operation_label, service_name, work_center_name) freeze at insert. Progress and status are derived in vendor_purchase_order_line_status.';
COMMENT ON COLUMN public.vendor_purchase_order_lines.stock_factor IS
  'Stock units per purchase unit, frozen at insert from the part''s single conversion for this unit (1 when the unit is the stock unit). Part lines only. Later edits to parts_unit_conversions never change a line.';
COMMENT ON COLUMN public.vendor_purchase_order_lines.unit_price IS
  'Per purchase unit, numeric(16,5). A frozen term of the document, never a cost record: nothing writes part_pricing_tiers from it except the explicit apply_part_cost_from_vendor. NULL means "to be confirmed".';
COMMENT ON COLUMN public.vendor_purchase_order_lines.price_source IS
  'Where the price came from when it was entered: price_sheet, last_po, estimate, vendor_service, rfq or manual. Chosen in TypeScript (lib/purchasing/priceDefault.ts) and persisted. NULL exactly when unit_price is NULL.';
COMMENT ON COLUMN public.vendor_purchase_order_lines.promised_on IS
  'The date the vendor promised, internal only (never printed, never pushed, never bumps the revision). Part and other lines only.';

CREATE INDEX idx_vendor_purchase_order_lines_po ON public.vendor_purchase_order_lines (vendor_purchase_order_id);
CREATE INDEX idx_vendor_purchase_order_lines_part
    ON public.vendor_purchase_order_lines (part_id) WHERE part_id IS NOT NULL;
CREATE INDEX idx_vendor_purchase_order_lines_job
    ON public.vendor_purchase_order_lines (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_vendor_purchase_order_lines_job_part
    ON public.vendor_purchase_order_lines (job_part_id) WHERE job_part_id IS NOT NULL;
CREATE INDEX idx_vendor_purchase_order_lines_operation
    ON public.vendor_purchase_order_lines (job_operation_id) WHERE job_operation_id IS NOT NULL;
CREATE INDEX idx_vendor_purchase_order_lines_work_center
    ON public.vendor_purchase_order_lines (work_center_id) WHERE work_center_id IS NOT NULL;
CREATE INDEX idx_vendor_purchase_order_lines_service
    ON public.vendor_purchase_order_lines (vendor_service_id) WHERE vendor_service_id IS NOT NULL;

CREATE TRIGGER vendor_purchase_order_lines_updated_at
    BEFORE UPDATE ON public.vendor_purchase_order_lines
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 6. vendor_rfq_responses -- a vendor's price for one line at one quantity
-- ============================================================================
CREATE TABLE public.vendor_rfq_responses (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vendor_rfq_id                   uuid NOT NULL,
    vendor_rfq_invitation_id        uuid NOT NULL,
    vendor_rfq_line_id              uuid NOT NULL,
    quantity                        numeric NOT NULL,
    -- Per the RFQ LINE's unit. NULL exactly when no_bid.
    unit_price                      numeric(16,5),
    no_bid                          boolean NOT NULL DEFAULT false,
    lead_time_days                  integer,
    minimum_order_quantity          numeric,
    valid_until                     date,
    vendor_part_number              text,
    notes                           text,
    awarded_at                      timestamptz,
    awarded_by                      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    vendor_purchase_order_line_id   uuid REFERENCES public.vendor_purchase_order_lines(id) ON DELETE SET NULL,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now(),

    -- Both halves on the SAME RFQ, structurally.
    CONSTRAINT vendor_rfq_responses_invitation_fk
        FOREIGN KEY (vendor_rfq_invitation_id, company_id, vendor_rfq_id)
        REFERENCES public.vendor_rfq_invitations (id, company_id, vendor_rfq_id) ON DELETE RESTRICT,
    CONSTRAINT vendor_rfq_responses_line_fk
        FOREIGN KEY (vendor_rfq_line_id, company_id, vendor_rfq_id)
        REFERENCES public.vendor_rfq_lines (id, company_id, vendor_rfq_id) ON DELETE RESTRICT,
    CONSTRAINT vendor_rfq_responses_one_per_quantity
        UNIQUE (vendor_rfq_invitation_id, vendor_rfq_line_id, quantity),
    CONSTRAINT vendor_rfq_responses_quantity_positive CHECK (quantity > 0),
    CONSTRAINT vendor_rfq_responses_price_or_no_bid CHECK (no_bid = (unit_price IS NULL)),
    CONSTRAINT vendor_rfq_responses_price_non_negative CHECK (unit_price IS NULL OR unit_price >= 0),
    CONSTRAINT vendor_rfq_responses_lead_time CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 730),
    CONSTRAINT vendor_rfq_responses_moq_positive
        CHECK (minimum_order_quantity IS NULL OR minimum_order_quantity > 0),
    CONSTRAINT vendor_rfq_responses_vendor_part_number_shape
        CHECK (vendor_part_number IS NULL
               OR (vendor_part_number = btrim(vendor_part_number)
                   AND char_length(vendor_part_number) BETWEEN 1 AND 64)),
    CONSTRAINT vendor_rfq_responses_awarded_by_needs_awarded_at
        CHECK (awarded_by IS NULL OR awarded_at IS NOT NULL),
    CONSTRAINT vendor_rfq_responses_no_bid_is_never_awarded
        CHECK (awarded_at IS NULL OR NOT no_bid)
);

COMMENT ON TABLE public.vendor_rfq_responses IS
  'One vendor''s answer for one RFQ line at one of its quantities: a price per the line''s unit, or No bid. Both composite FKs point into the same RFQ, so a response cannot name another RFQ''s line. Editable until awarded; an awarded response is frozen and links the PO line it became.';

CREATE INDEX idx_vendor_rfq_responses_line ON public.vendor_rfq_responses (vendor_rfq_line_id);
CREATE INDEX idx_vendor_rfq_responses_invitation ON public.vendor_rfq_responses (vendor_rfq_invitation_id);
CREATE INDEX idx_vendor_rfq_responses_po_line
    ON public.vendor_rfq_responses (vendor_purchase_order_line_id) WHERE vendor_purchase_order_line_id IS NOT NULL;

CREATE TRIGGER vendor_rfq_responses_updated_at
    BEFORE UPDATE ON public.vendor_rfq_responses
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 7. part_vendors (the approved vendor list) and part_vendor_price_breaks
-- ============================================================================
CREATE TABLE public.part_vendors (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    part_id                 uuid NOT NULL REFERENCES public.parts(id) ON DELETE CASCADE,
    vendor_id               uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    status                  text NOT NULL DEFAULT 'approved',
    status_note             text,
    vendor_part_number      text,
    -- The unit the sheet is in. Its factor is NOT stored here: it lives in
    -- parts_unit_conversions, one factor per (part, unit), or the unit is the stock unit.
    purchase_unit           text NOT NULL,
    lead_time_days          integer,
    minimum_order_quantity  numeric,
    -- Per SHEET, not per break.
    quoted_on               date,
    valid_until             date,
    notes                   text,
    created_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    deleted_at              timestamptz,

    -- Identity, FULL: adding the same vendor again revives the archived row.
    CONSTRAINT part_vendors_one_per_vendor UNIQUE (part_id, vendor_id),
    CONSTRAINT part_vendors_identity UNIQUE (id, company_id),
    CONSTRAINT part_vendors_status CHECK (status IN ('approved', 'conditional', 'disapproved')),
    CONSTRAINT part_vendors_vendor_part_number_shape
        CHECK (vendor_part_number IS NULL
               OR (vendor_part_number = btrim(vendor_part_number)
                   AND char_length(vendor_part_number) BETWEEN 1 AND 64)),
    CONSTRAINT part_vendors_purchase_unit_shape
        CHECK (btrim(purchase_unit) <> '' AND char_length(purchase_unit) <= 40),
    CONSTRAINT part_vendors_lead_time CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 730),
    CONSTRAINT part_vendors_moq_positive CHECK (minimum_order_quantity IS NULL OR minimum_order_quantity > 0),
    CONSTRAINT part_vendors_validity CHECK (valid_until IS NULL OR quoted_on IS NULL OR valid_until >= quoted_on),
    CONSTRAINT part_vendors_text_lengths CHECK (
        (status_note IS NULL OR char_length(status_note) <= 1000)
        AND (notes IS NULL OR char_length(notes) <= 10000))
);

COMMENT ON TABLE public.part_vendors IS
  'The approved vendor list: which vendors a part may be bought from, with status approved / conditional / disapproved (shown Approved / Conditional / Do not use; Do not use blocks new PO lines), the vendor''s part number, the sheet''s purchase unit, lead time, minimum order and quote dates. parts.preferred_vendor_id stays the only "preferred" marker, and ensure_preferred_vendor_is_listed keeps a live row here for it. Archived with deleted_at; adding the vendor again revives the same row. Written only through save_part_vendor / archive_part_vendor and that trigger.';
COMMENT ON COLUMN public.part_vendors.purchase_unit IS
  'The unit the price sheet and minimum order are in. Either the part''s stock unit or a unit with exactly one parts_unit_conversions row: the factor lives there, never here, so one unit name cannot mean two amounts on one part.';
COMMENT ON COLUMN public.part_vendors.valid_until IS
  'When the whole sheet expires. An expired sheet is named but never used as a price default or as a part cost.';

CREATE INDEX idx_part_vendors_vendor ON public.part_vendors (vendor_id);
CREATE INDEX idx_part_vendors_company_live ON public.part_vendors (company_id) WHERE deleted_at IS NULL;

CREATE TRIGGER part_vendors_updated_at
    BEFORE UPDATE ON public.part_vendors
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


CREATE TABLE public.part_vendor_price_breaks (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    part_vendor_id           uuid NOT NULL,
    -- In the sheet's purchase unit.
    min_quantity             numeric NOT NULL,
    unit_price               numeric(16,5) NOT NULL,
    source                   text NOT NULL DEFAULT 'manual',
    vendor_rfq_response_id   uuid REFERENCES public.vendor_rfq_responses(id) ON DELETE SET NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT part_vendor_price_breaks_sheet_fk
        FOREIGN KEY (part_vendor_id, company_id)
        REFERENCES public.part_vendors (id, company_id) ON DELETE CASCADE,
    CONSTRAINT part_vendor_price_breaks_one_per_quantity UNIQUE (part_vendor_id, min_quantity),
    CONSTRAINT part_vendor_price_breaks_quantity_positive CHECK (min_quantity > 0),
    CONSTRAINT part_vendor_price_breaks_price_positive CHECK (unit_price > 0),
    CONSTRAINT part_vendor_price_breaks_source CHECK (source IN ('manual', 'rfq'))
);

COMMENT ON TABLE public.part_vendor_price_breaks IS
  'A vendor''s price sheet for one part: price per purchase unit at or above min_quantity purchase units. A save replaces the whole sheet. source rfq rows came from an awarded RFQ saved to the sheet.';

CREATE TRIGGER part_vendor_price_breaks_updated_at
    BEFORE UPDATE ON public.part_vendor_price_breaks
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 8. vendor_purchase_order_receipts -- append-only, corrected by void
-- ============================================================================
CREATE TABLE public.vendor_purchase_order_receipts (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vendor_purchase_order_id        uuid NOT NULL,
    vendor_purchase_order_line_id   uuid NOT NULL,
    -- 'outside_service' is absent ON PURPOSE: outside work is received on its vendor
    -- packing slip, so an outside receipt cannot be represented here at all.
    line_kind                       text NOT NULL,
    -- One delivery = one call. Replaying the same group id writes nothing new.
    receipt_group_id                uuid NOT NULL,
    entry_index                     integer NOT NULL,

    -- Exactly as typed, in the purchase or the stock unit.
    quantity                        numeric NOT NULL,
    unit                            text NOT NULL,
    -- Part lines: quantity x the line's frozen factor (or the quantity itself when typed
    -- in the stock unit). Exact, so there is no round-trip drift.
    stock_quantity                  numeric,
    stock_unit                      text,

    part_id                         uuid REFERENCES public.parts(id) ON DELETE RESTRICT,
    location_id                     uuid REFERENCES public.inventory_locations(id) ON DELETE SET NULL,
    location_name                   text,
    lot_id                          uuid REFERENCES public.material_lots(id) ON DELETE SET NULL,
    lot_code                        text,
    heat_number                     text,
    started_tracking                boolean NOT NULL DEFAULT false,

    -- The ledger rows: the addition this receipt wrote, and the depletion its void wrote.
    inventory_transaction_id        uuid REFERENCES public.inventory_transactions(id) ON DELETE SET NULL,
    void_transaction_id             uuid REFERENCES public.inventory_transactions(id) ON DELETE SET NULL,

    vendor_packing_slip             text,
    notes                           text,
    received_at                     timestamptz NOT NULL DEFAULT now(),
    received_by                     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    voided_at                       timestamptz,
    voided_by                       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    void_reason                     text,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendor_purchase_order_receipts_line_fk
        FOREIGN KEY (vendor_purchase_order_line_id, company_id, vendor_purchase_order_id, line_kind)
        REFERENCES public.vendor_purchase_order_lines (id, company_id, vendor_purchase_order_id, line_kind)
        ON DELETE RESTRICT,
    CONSTRAINT vendor_purchase_order_receipts_kind CHECK (line_kind IN ('part', 'other')),
    CONSTRAINT vendor_purchase_order_receipts_group_entry UNIQUE (receipt_group_id, entry_index),
    CONSTRAINT vendor_purchase_order_receipts_entry_index CHECK (entry_index >= 0),
    CONSTRAINT vendor_purchase_order_receipts_quantity_positive CHECK (quantity > 0),
    CONSTRAINT vendor_purchase_order_receipts_unit_shape CHECK (btrim(unit) <> '' AND char_length(unit) <= 40),
    CONSTRAINT vendor_purchase_order_receipts_stock_positive CHECK (stock_quantity IS NULL OR stock_quantity > 0),
    CONSTRAINT vendor_purchase_order_receipts_kind_shape CHECK (
        (line_kind = 'part'
            AND part_id IS NOT NULL AND stock_quantity IS NOT NULL AND stock_unit IS NOT NULL
            AND location_name IS NOT NULL)
        OR (line_kind = 'other'
            AND part_id IS NULL AND stock_quantity IS NULL AND stock_unit IS NULL
            AND location_id IS NULL AND location_name IS NULL
            AND lot_id IS NULL AND lot_code IS NULL AND heat_number IS NULL
            AND NOT started_tracking
            AND inventory_transaction_id IS NULL AND void_transaction_id IS NULL)),
    CONSTRAINT vendor_purchase_order_receipts_packing_slip_shape
        CHECK (vendor_packing_slip IS NULL
               OR (vendor_packing_slip = btrim(vendor_packing_slip)
                   AND char_length(vendor_packing_slip) BETWEEN 1 AND 64)),
    CONSTRAINT vendor_purchase_order_receipts_voided_by_needs_voided_at
        CHECK (voided_by IS NULL OR voided_at IS NOT NULL),
    CONSTRAINT vendor_purchase_order_receipts_void_reason_needs_void
        CHECK (void_reason IS NULL OR voided_at IS NOT NULL),
    CONSTRAINT vendor_purchase_order_receipts_void_txn_needs_void
        CHECK (void_transaction_id IS NULL OR voided_at IS NOT NULL),
    CONSTRAINT vendor_purchase_order_receipts_text_lengths CHECK (
        (notes IS NULL OR char_length(notes) <= 2000)
        AND (void_reason IS NULL OR char_length(void_reason) <= 1000))
);

COMMENT ON TABLE public.vendor_purchase_order_receipts IS
  'What arrived against a part or other line of a vendor purchase order. Append-only: a correction is a void (which reverses the stock through deplete_stock_at_location) plus a new receipt. A part receipt links the ledger addition it wrote; receipt_group_id + entry_index make a replayed delivery write nothing new. Outside-service lines cannot be received here: they are received on their vendor packing slips. Filter voided_at IS NULL for any count.';
COMMENT ON COLUMN public.vendor_purchase_order_receipts.stock_quantity IS
  'Part lines: the stock-unit quantity added to stock. quantity x the line''s frozen stock_factor when typed in the purchase unit, the quantity itself when typed in the stock unit. Exact.';
COMMENT ON COLUMN public.vendor_purchase_order_receipts.started_tracking IS
  'True when this receipt''s heat number was the first on an untracked part, which turns heat tracking on for that part for good.';

CREATE INDEX idx_vendor_purchase_order_receipts_line ON public.vendor_purchase_order_receipts (vendor_purchase_order_line_id);
CREATE INDEX idx_vendor_purchase_order_receipts_po ON public.vendor_purchase_order_receipts (vendor_purchase_order_id);
CREATE INDEX idx_vendor_purchase_order_receipts_company_recent
    ON public.vendor_purchase_order_receipts (company_id, received_at DESC);
CREATE INDEX idx_vendor_purchase_order_receipts_part
    ON public.vendor_purchase_order_receipts (part_id) WHERE part_id IS NOT NULL;
CREATE INDEX idx_vendor_purchase_order_receipts_location
    ON public.vendor_purchase_order_receipts (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX idx_vendor_purchase_order_receipts_lot
    ON public.vendor_purchase_order_receipts (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX idx_vendor_purchase_order_receipts_txn
    ON public.vendor_purchase_order_receipts (inventory_transaction_id) WHERE inventory_transaction_id IS NOT NULL;
CREATE INDEX idx_vendor_purchase_order_receipts_void_txn
    ON public.vendor_purchase_order_receipts (void_transaction_id) WHERE void_transaction_id IS NOT NULL;

CREATE TRIGGER vendor_purchase_order_receipts_updated_at
    BEFORE UPDATE ON public.vendor_purchase_order_receipts
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 9. vendor_purchase_order_revisions -- exactly what each revision sent
-- ============================================================================
CREATE TABLE public.vendor_purchase_order_revisions (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                 uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vendor_purchase_order_id   uuid NOT NULL,
    revision                   integer NOT NULL,
    -- vendor_purchase_order_document() at the moment of Mark as sent, and its md5.
    document                   jsonb NOT NULL,
    document_hash              text NOT NULL,
    sent_at                    timestamptz NOT NULL,
    sent_by                    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendor_purchase_order_revisions_po_fk
        FOREIGN KEY (vendor_purchase_order_id, company_id)
        REFERENCES public.vendor_purchase_orders (id, company_id) ON DELETE CASCADE,
    CONSTRAINT vendor_purchase_order_revisions_one_per_revision UNIQUE (vendor_purchase_order_id, revision),
    CONSTRAINT vendor_purchase_order_revisions_revision_non_negative CHECK (revision >= 0),
    CONSTRAINT vendor_purchase_order_revisions_hash_shape CHECK (document_hash ~ '^[0-9a-f]{32}$')
);

COMMENT ON TABLE public.vendor_purchase_order_revisions IS
  'The vendor-visible document of each revision as it was marked sent, append-only. The save RPC compares the live document''s md5 with the sent revision''s document_hash to decide whether the next vendor-visible change bumps the revision. Not readable by the insights AI: superseded prices would read as current.';

CREATE TRIGGER vendor_purchase_order_revisions_updated_at
    BEFORE UPDATE ON public.vendor_purchase_order_revisions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 10. outside_shipments.vendor_purchase_order_line_id -- the slip names its PO line
-- ============================================================================
-- The PO is an optional commercial layer over outside work. The slip stays the only record
-- of movement: an outside line's sent / at-vendor / received figures are derived from the
-- slips linked here, and nothing on a PO table writes a slip or a receipt.
--
-- NOT in any status trigger's UPDATE OF list (20260906005725 section 4 lists quantity,
-- voided_at, closed_at, shipped_at, created_by, job_operation_id), so linking changes no
-- status and fires nothing in the operation -> part -> job cascade.
ALTER TABLE public.outside_shipments
    ADD COLUMN vendor_purchase_order_line_id uuid
        REFERENCES public.vendor_purchase_order_lines(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.outside_shipments.vendor_purchase_order_line_id IS
  'The outside-service line of a vendor purchase order this slip ships against, or NULL. Set by create_outside_shipment (the single open line for this operation and vendor, draft or sent), by the line''s insert (existing live unlinked slips), or by set_outside_shipment_vendor_purchase_order_line; cleared when the PO is archived or the line removed. A BEFORE trigger refuses a link to a line of another company, another kind, another operation or another vendor. Changing it changes no status.';

CREATE INDEX idx_outside_shipments_vendor_po_line
    ON public.outside_shipments (vendor_purchase_order_line_id)
    WHERE vendor_purchase_order_line_id IS NOT NULL;

-- Read-only: it raises or it returns NEW, and writes nothing.
CREATE OR REPLACE FUNCTION public.assert_outside_shipment_line_matches()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_line record;
BEGIN
    SELECT l.company_id, l.line_kind, l.job_operation_id, h.vendor_id
      INTO v_line
      FROM public.vendor_purchase_order_lines l
      JOIN public.vendor_purchase_orders h ON h.id = l.vendor_purchase_order_id
     WHERE l.id = NEW.vendor_purchase_order_line_id;

    IF NOT FOUND
       OR v_line.company_id IS DISTINCT FROM NEW.company_id
       OR v_line.line_kind <> 'outside_service'
       OR v_line.job_operation_id IS DISTINCT FROM NEW.job_operation_id
       OR v_line.vendor_id IS DISTINCT FROM NEW.vendor_id THEN
        RAISE EXCEPTION
          'Slip % cannot ship against that purchase order line: it must be an outside-service line of the same company, for the same operation, on a PO to the same vendor.',
          NEW.slip_number USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.assert_outside_shipment_line_matches() IS
  'BEFORE trigger on outside_shipments: a slip may name a vendor purchase order line only when the line is an outside_service line of the same company, for the same job operation, on a PO to the slip''s vendor (23514 otherwise). Read-only. Makes a mismatched link unrepresentable whoever writes it, the service role included.';

REVOKE EXECUTE ON FUNCTION public.assert_outside_shipment_line_matches() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER outside_shipments_vendor_po_line_matches
    BEFORE INSERT OR UPDATE OF vendor_purchase_order_line_id, job_operation_id, vendor_id, company_id
    ON public.outside_shipments
    FOR EACH ROW
    WHEN (NEW.vendor_purchase_order_line_id IS NOT NULL)
    EXECUTE FUNCTION public.assert_outside_shipment_line_matches();

-- The insights AI could read outside_shipments by column since 20260903203741, but that
-- grant predates closed_at (20260906005725), so the model could not tell a short-closed slip
-- from one still at the vendor. Both columns, now.
GRANT SELECT (closed_at, vendor_purchase_order_line_id) ON public.outside_shipments TO jigged_ai_readonly;


-- ============================================================================
-- 11. The QuickBooks tables: members read, only the service role writes
-- ============================================================================
-- The PO push (api/routes/quickbooks_purchasing_routes.py) is the only writer. Members may
-- read them (the PO page shows "In QuickBooks as 1043"). Not readable by the insights AI
-- (third-party ids, next to the invoice links) and named in SENSITIVE_TABLES.
CREATE TABLE public.quickbooks_vendor_map (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vendor_id        uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    realm_id         text NOT NULL,
    qb_vendor_id     text NOT NULL,
    qb_display_name  text,
    provider         text NOT NULL DEFAULT 'qbo',
    linked_by        uuid REFERENCES public.user_company_access(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT quickbooks_vendor_map_unique UNIQUE (company_id, vendor_id, realm_id),
    CONSTRAINT quickbooks_vendor_map_provider CHECK (provider IN ('qbo', 'qbd'))
);

COMMENT ON TABLE public.quickbooks_vendor_map IS
  'Durable Jigged vendor -> QuickBooks vendor id per company file (realm_id: the QBO realm, or the Conductor end user for Desktop). A clone of quickbooks_customer_map. Resolved once (a mapped vendor, an exact name match, an explicit choice or a create) and reused on every PO push. Kept on disconnect, like the customer map. Service-role writes only.';

CREATE INDEX idx_quickbooks_vendor_map_vendor ON public.quickbooks_vendor_map (vendor_id);

CREATE TRIGGER quickbooks_vendor_map_updated_at
    BEFORE UPDATE ON public.quickbooks_vendor_map
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


CREATE TABLE public.quickbooks_purchasing_setup (
    id                                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    provider                           text NOT NULL,
    realm_id                           text NOT NULL,
    -- Exactly one of these, matching provider. CASCADE: disconnecting clears the setup.
    quickbooks_connection_id           uuid REFERENCES public.quickbooks_connections(id) ON DELETE CASCADE,
    quickbooks_desktop_connection_id   uuid REFERENCES public.quickbooks_desktop_connections(id) ON DELETE CASCADE,
    setup_key                          text NOT NULL,
    qb_id                              text,
    qb_name                            text,
    posting_account_id                 text,
    posting_account_name               text,
    details                            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_in_quickbooks              boolean NOT NULL DEFAULT false,
    chosen_by                          uuid REFERENCES public.user_company_access(id) ON DELETE SET NULL,
    created_at                         timestamptz NOT NULL DEFAULT now(),
    updated_at                         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT quickbooks_purchasing_setup_unique UNIQUE (company_id, realm_id, setup_key),
    CONSTRAINT quickbooks_purchasing_setup_provider CHECK (provider IN ('qbo', 'qbd')),
    CONSTRAINT quickbooks_purchasing_setup_one_connection CHECK (
        num_nonnulls(quickbooks_connection_id, quickbooks_desktop_connection_id) = 1
        AND (provider = 'qbo') = (quickbooks_connection_id IS NOT NULL)),
    CONSTRAINT quickbooks_purchasing_setup_key CHECK (
        setup_key IN ('item:part', 'item:outside_service', 'item:other', 'ap_account', 'qbo_preferences')),
    -- Every key but the preferences answer names a QuickBooks object.
    CONSTRAINT quickbooks_purchasing_setup_names_an_object
        CHECK (setup_key = 'qbo_preferences' OR qb_id IS NOT NULL),
    CONSTRAINT quickbooks_purchasing_setup_details_object CHECK (jsonb_typeof(details) = 'object')
);

COMMENT ON TABLE public.quickbooks_purchasing_setup IS
  'The PO push''s choices for one QuickBooks company file: the item for each line kind (item:part / item:outside_service / item:other; the panel defaults to one general purchases item that fills all three), the QBO AP account, and the "Check QuickBooks" answers (qbo_preferences: POs enabled, custom transaction numbers). Rows hang off the connection row ON DELETE CASCADE, so disconnecting clears them. Service-role writes only.';

CREATE INDEX idx_quickbooks_purchasing_setup_qbo
    ON public.quickbooks_purchasing_setup (quickbooks_connection_id) WHERE quickbooks_connection_id IS NOT NULL;
CREATE INDEX idx_quickbooks_purchasing_setup_qbd
    ON public.quickbooks_purchasing_setup (quickbooks_desktop_connection_id) WHERE quickbooks_desktop_connection_id IS NOT NULL;

CREATE TRIGGER quickbooks_purchasing_setup_updated_at
    BEFORE UPDATE ON public.quickbooks_purchasing_setup
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


CREATE TABLE public.quickbooks_purchase_order_links (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                 uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vendor_purchase_order_id   uuid NOT NULL,
    provider                   text NOT NULL DEFAULT 'qbo',
    realm_id                   text NOT NULL,
    operation                  text NOT NULL DEFAULT 'create',
    status                     text NOT NULL DEFAULT 'pending',
    -- The current attempt's id: QBO requestid / QBD externalId. Server-minted.
    qb_request_id              uuid NOT NULL,
    last_failure               text,
    qb_vendor_id               text,
    transaction_date           date,
    qb_po_id                   text,
    qb_doc_number              text,
    qb_sync_token              text,
    qb_url                     text,
    qb_closed                  boolean NOT NULL DEFAULT false,
    attempt_content_version    integer,
    pushed_content_version     integer,
    pushed_revision            integer,
    pushed_payload_hash        text,
    pushed_at                  timestamptz,
    pushed_by                  uuid REFERENCES public.user_company_access(id) ON DELETE SET NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT quickbooks_purchase_order_links_po_fk
        FOREIGN KEY (vendor_purchase_order_id, company_id)
        REFERENCES public.vendor_purchase_orders (id, company_id) ON DELETE CASCADE,
    -- One QuickBooks PO per Jigged PO per company file, under double-clicks.
    CONSTRAINT quickbooks_purchase_order_links_one_per_realm UNIQUE (vendor_purchase_order_id, realm_id),
    CONSTRAINT quickbooks_purchase_order_links_request_unique UNIQUE (realm_id, qb_request_id),
    CONSTRAINT quickbooks_purchase_order_links_identity UNIQUE (id, company_id),
    CONSTRAINT quickbooks_purchase_order_links_provider CHECK (provider IN ('qbo', 'qbd')),
    CONSTRAINT quickbooks_purchase_order_links_operation
        CHECK (operation IN ('create', 'update', 'close', 'reopen')),
    CONSTRAINT quickbooks_purchase_order_links_status
        CHECK (status IN ('pending', 'created', 'error', 'needs_verification')),
    CONSTRAINT quickbooks_purchase_order_links_last_failure
        CHECK (last_failure IS NULL OR last_failure IN ('ambiguous', 'rejected'))
);

COMMENT ON TABLE public.quickbooks_purchase_order_links IS
  'The four-state link (pending / created / error / needs_verification) between a vendor purchase order and the QuickBooks PO it was pushed as, per company file, with the compare-and-set latch the invoice push uses. "Out of date" is vendor_purchase_orders.content_version > pushed_content_version. Service-role writes only; members read; not AI-readable.';

CREATE TRIGGER quickbooks_purchase_order_links_updated_at
    BEFORE UPDATE ON public.quickbooks_purchase_order_links
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


CREATE TABLE public.quickbooks_purchase_order_line_links (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    link_id                         uuid NOT NULL,
    -- NULL once the Jigged line is removed: save_vendor_purchase_order hard-deletes an
    -- unreceived line, but QuickBooks still holds the line the push put there. The row keeps
    -- that QuickBooks line id, so the next push drops the line instead of refusing it as one
    -- the bookkeeper added (qb_foreign_lines); that push then deletes the row.
    vendor_purchase_order_line_id   uuid,
    qb_line_id                      text NOT NULL,
    -- The item the line was first pushed with; an update keeps it.
    qb_item_id                      text,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT quickbooks_purchase_order_line_links_link_fk
        FOREIGN KEY (link_id, company_id)
        REFERENCES public.quickbooks_purchase_order_links (id, company_id) ON DELETE CASCADE,
    -- The column list (Postgres 15+) clears the line alone: company_id stays, NOT NULL.
    CONSTRAINT quickbooks_purchase_order_line_links_line_fk
        FOREIGN KEY (vendor_purchase_order_line_id, company_id)
        REFERENCES public.vendor_purchase_order_lines (id, company_id)
        ON DELETE SET NULL (vendor_purchase_order_line_id),
    -- One row per Jigged line per link. NULLs are distinct, so every removed line keeps a row.
    CONSTRAINT quickbooks_purchase_order_line_links_unique UNIQUE (link_id, vendor_purchase_order_line_id)
);

COMMENT ON TABLE public.quickbooks_purchase_order_line_links IS
  'The QuickBooks line id (and the item it was first pushed with) of each Jigged PO line on a pushed QuickBooks PO, so an update sends the right line ids. vendor_purchase_order_line_id is NULL for a line removed from the PO since the push (ON DELETE SET NULL): QuickBooks still holds that line, and the row is what tells the next push it is Jigged''s to drop rather than one the bookkeeper added; the push deletes the row once the line is gone from QuickBooks. Service-role writes only; members read; not AI-readable.';

CREATE INDEX idx_quickbooks_purchase_order_line_links_line
    ON public.quickbooks_purchase_order_line_links (vendor_purchase_order_line_id);

CREATE TRIGGER quickbooks_purchase_order_line_links_updated_at
    BEFORE UPDATE ON public.quickbooks_purchase_order_line_links
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 12. Grants, RLS, the billing gate -- every table
-- ============================================================================
-- Named revokes (CLAUDE.md). SELECT is revoked from jigged_ai_readonly on EVERY table here
-- first: the baseline's default privileges hand it a TABLE-level SELECT, which would
-- supersede the column lists in section 13 and silently make them decorative.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE
    public.purchasing_document_series,
    public.vendor_rfqs, public.vendor_rfq_lines, public.vendor_rfq_invitations, public.vendor_rfq_responses,
    public.vendor_purchase_orders, public.vendor_purchase_order_lines,
    public.vendor_purchase_order_receipts, public.vendor_purchase_order_revisions,
    public.part_vendors, public.part_vendor_price_breaks,
    public.quickbooks_vendor_map, public.quickbooks_purchasing_setup,
    public.quickbooks_purchase_order_links, public.quickbooks_purchase_order_line_links
FROM anon, authenticated;

REVOKE SELECT ON TABLE
    public.purchasing_document_series,
    public.vendor_rfqs, public.vendor_rfq_lines, public.vendor_rfq_invitations, public.vendor_rfq_responses,
    public.vendor_purchase_orders, public.vendor_purchase_order_lines,
    public.vendor_purchase_order_receipts, public.vendor_purchase_order_revisions,
    public.part_vendors, public.part_vendor_price_breaks,
    public.quickbooks_vendor_map, public.quickbooks_purchasing_setup,
    public.quickbooks_purchase_order_links, public.quickbooks_purchase_order_line_links
FROM jigged_ai_readonly;

-- The browser reads; it never writes a purchasing table directly.
GRANT SELECT ON TABLE
    public.purchasing_document_series,
    public.vendor_rfqs, public.vendor_rfq_lines, public.vendor_rfq_invitations, public.vendor_rfq_responses,
    public.vendor_purchase_orders, public.vendor_purchase_order_lines,
    public.vendor_purchase_order_receipts, public.vendor_purchase_order_revisions,
    public.part_vendors, public.part_vendor_price_breaks,
    public.quickbooks_vendor_map, public.quickbooks_purchasing_setup,
    public.quickbooks_purchase_order_links, public.quickbooks_purchase_order_line_links
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.purchasing_document_series,
    public.vendor_rfqs, public.vendor_rfq_lines, public.vendor_rfq_invitations, public.vendor_rfq_responses,
    public.vendor_purchase_orders, public.vendor_purchase_order_lines,
    public.vendor_purchase_order_receipts, public.vendor_purchase_order_revisions,
    public.part_vendors, public.part_vendor_price_breaks,
    public.quickbooks_vendor_map, public.quickbooks_purchasing_setup,
    public.quickbooks_purchase_order_links, public.quickbooks_purchase_order_line_links
TO service_role;

-- Explicit: rls_auto_enable() exists locally and on preview but never in production.
ALTER TABLE public.purchasing_document_series            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_rfqs                           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_rfq_lines                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_rfq_invitations                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_rfq_responses                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_purchase_orders                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_purchase_order_lines           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_purchase_order_receipts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_purchase_order_revisions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.part_vendors                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.part_vendor_price_breaks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quickbooks_vendor_map                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quickbooks_purchasing_setup           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quickbooks_purchase_order_links       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quickbooks_purchase_order_line_links  ENABLE ROW LEVEL SECURITY;

-- Members read their companies' rows. Nothing else: with no write grant there is no
-- write policy to write.
CREATE POLICY purchasing_document_series_select ON public.purchasing_document_series
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_rfqs_select ON public.vendor_rfqs
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_rfq_lines_select ON public.vendor_rfq_lines
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_rfq_invitations_select ON public.vendor_rfq_invitations
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_rfq_responses_select ON public.vendor_rfq_responses
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_purchase_orders_select ON public.vendor_purchase_orders
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_purchase_order_lines_select ON public.vendor_purchase_order_lines
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_purchase_order_receipts_select ON public.vendor_purchase_order_receipts
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_purchase_order_revisions_select ON public.vendor_purchase_order_revisions
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY part_vendors_select ON public.part_vendors
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY part_vendor_price_breaks_select ON public.part_vendor_price_breaks
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY quickbooks_vendor_map_select ON public.quickbooks_vendor_map
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY quickbooks_purchasing_setup_select ON public.quickbooks_purchasing_setup
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY quickbooks_purchase_order_links_select ON public.quickbooks_purchase_order_links
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY quickbooks_purchase_order_line_links_select ON public.quickbooks_purchase_order_line_links
    FOR SELECT TO authenticated USING (company_id IN (SELECT public.get_user_company_ids()));

-- The billing write-gate on every table, service-role-only ones included: it is what
-- satisfies tenant_tables_missing_write_gate() without an exempt claim a reviewer has to
-- re-check. The writers call company_can_write BY HAND, because SECURITY DEFINER bypasses
-- RLS and these restrictive policies with it.
SELECT public.apply_billing_write_gate('public.purchasing_document_series');
SELECT public.apply_billing_write_gate('public.vendor_rfqs');
SELECT public.apply_billing_write_gate('public.vendor_rfq_lines');
SELECT public.apply_billing_write_gate('public.vendor_rfq_invitations');
SELECT public.apply_billing_write_gate('public.vendor_rfq_responses');
SELECT public.apply_billing_write_gate('public.vendor_purchase_orders');
SELECT public.apply_billing_write_gate('public.vendor_purchase_order_lines');
SELECT public.apply_billing_write_gate('public.vendor_purchase_order_receipts');
SELECT public.apply_billing_write_gate('public.vendor_purchase_order_revisions');
SELECT public.apply_billing_write_gate('public.part_vendors');
SELECT public.apply_billing_write_gate('public.part_vendor_price_breaks');
SELECT public.apply_billing_write_gate('public.quickbooks_vendor_map');
SELECT public.apply_billing_write_gate('public.quickbooks_purchasing_setup');
SELECT public.apply_billing_write_gate('public.quickbooks_purchase_order_links');
SELECT public.apply_billing_write_gate('public.quickbooks_purchase_order_line_links');


-- ============================================================================
-- 13. The insights AI: column by column, archived rows invisible
-- ============================================================================
-- Headers with a direct deleted_at go through the helper, which adds the filter itself.
-- Children scope through their parent and so inherit the parent's deleted_at in a
-- hand-written policy (the job_parts precedent). Withheld everywhere: actor columns,
-- internal notes, contact and address snapshots, terms and conditions, notes, reasons.
-- The views in migration 2 read only columns granted here, so SELECT * on every one of them
-- works for the AI role.
SELECT public.apply_ai_read_access('public.vendor_purchase_orders', ARRAY[
    'id', 'company_id', 'po_number', 'vendor_id', 'vendor_name',
    'ship_to_kind', 'ship_to_vendor_id', 'ship_to_customer_id', 'ship_to_name',
    'ordered_on', 'need_by_on', 'payment_terms', 'ship_via',
    'revision', 'sent_revision', 'issued_at', 'last_sent_at', 'content_version',
    'closed_at', 'vendor_rfq_id', 'created_at', 'updated_at', 'deleted_at']);

SELECT public.apply_ai_read_access('public.part_vendors', ARRAY[
    'id', 'company_id', 'part_id', 'vendor_id', 'status', 'vendor_part_number', 'purchase_unit',
    'lead_time_days', 'minimum_order_quantity', 'quoted_on', 'valid_until',
    'created_at', 'updated_at', 'deleted_at']);

SELECT public.apply_ai_read_access('public.vendor_rfqs', ARRAY[
    'id', 'company_id', 'rfq_number', 'title', 'needed_by_on', 'respond_by_on', 'ship_to_name',
    'closed_at', 'created_at', 'updated_at', 'deleted_at']);

GRANT SELECT (id, company_id, vendor_purchase_order_id, line_number, line_kind,
              part_id, part_name, description, vendor_part_number,
              quantity, unit, stock_unit, stock_factor, unit_price, price_source,
              need_by_on, promised_on, cert_required, expects_receipt,
              job_id, job_number, job_part_id, job_operation_id, operation_label,
              vendor_service_id, service_name, work_center_id, work_center_name,
              closed_at, created_at, updated_at)
    ON public.vendor_purchase_order_lines TO jigged_ai_readonly;
CREATE POLICY ai_readonly_select ON public.vendor_purchase_order_lines
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid
           AND EXISTS (SELECT 1 FROM public.vendor_purchase_orders h
                        WHERE h.id = vendor_purchase_order_lines.vendor_purchase_order_id
                          AND h.deleted_at IS NULL));

GRANT SELECT (id, company_id, vendor_purchase_order_id, vendor_purchase_order_line_id, line_kind,
              quantity, unit, stock_quantity, stock_unit, part_id, location_id, location_name,
              lot_id, lot_code, heat_number, started_tracking,
              inventory_transaction_id, void_transaction_id, vendor_packing_slip,
              received_at, voided_at, created_at, updated_at)
    ON public.vendor_purchase_order_receipts TO jigged_ai_readonly;
CREATE POLICY ai_readonly_select ON public.vendor_purchase_order_receipts
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid
           AND EXISTS (SELECT 1 FROM public.vendor_purchase_orders h
                        WHERE h.id = vendor_purchase_order_receipts.vendor_purchase_order_id
                          AND h.deleted_at IS NULL));

GRANT SELECT (id, company_id, part_vendor_id, min_quantity, unit_price, source,
              vendor_rfq_response_id, created_at, updated_at)
    ON public.part_vendor_price_breaks TO jigged_ai_readonly;
CREATE POLICY ai_readonly_select ON public.part_vendor_price_breaks
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid
           AND EXISTS (SELECT 1 FROM public.part_vendors pv
                        WHERE pv.id = part_vendor_price_breaks.part_vendor_id
                          AND pv.deleted_at IS NULL));

GRANT SELECT (id, company_id, vendor_rfq_id, line_number, part_id, part_name, description, unit,
              quantities, job_id, job_number, cert_required, created_at, updated_at)
    ON public.vendor_rfq_lines TO jigged_ai_readonly;
CREATE POLICY ai_readonly_select ON public.vendor_rfq_lines
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid
           AND EXISTS (SELECT 1 FROM public.vendor_rfqs r
                        WHERE r.id = vendor_rfq_lines.vendor_rfq_id AND r.deleted_at IS NULL));

GRANT SELECT (id, company_id, vendor_rfq_id, vendor_id, vendor_name, sent_at, declined_at,
              vendor_quote_reference, quoted_on, created_at, updated_at)
    ON public.vendor_rfq_invitations TO jigged_ai_readonly;
CREATE POLICY ai_readonly_select ON public.vendor_rfq_invitations
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid
           AND EXISTS (SELECT 1 FROM public.vendor_rfqs r
                        WHERE r.id = vendor_rfq_invitations.vendor_rfq_id AND r.deleted_at IS NULL));

GRANT SELECT (id, company_id, vendor_rfq_id, vendor_rfq_invitation_id, vendor_rfq_line_id,
              quantity, unit_price, no_bid, lead_time_days, minimum_order_quantity, valid_until,
              vendor_part_number, awarded_at, vendor_purchase_order_line_id, created_at, updated_at)
    ON public.vendor_rfq_responses TO jigged_ai_readonly;
CREATE POLICY ai_readonly_select ON public.vendor_rfq_responses
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid
           AND EXISTS (SELECT 1 FROM public.vendor_rfqs r
                        WHERE r.id = vendor_rfq_responses.vendor_rfq_id AND r.deleted_at IS NULL));


-- ============================================================================
-- 14. ensure_preferred_vendor_is_listed -- a preferred vendor is always on the list
-- ============================================================================
-- parts.preferred_vendor_id stays the ONLY preferred marker: it already has four writers
-- (the part form, the importer, MCP's partsWrites and seed_demo_data), and a second flag
-- would need two-way sync. So the invariant "a preferred vendor has a live part_vendors row"
-- is held at rest by this trigger, the backfill below, and archive_part_vendor (which clears
-- the preference when it archives the preferred row).
--
-- It also closes a latent hole: nothing stopped a part naming another company's vendor.
--
-- SECURITY DEFINER because the browser cannot write part_vendors. The parts write that
-- fires it was itself gated, which is why definer_writers_missing_write_gate() lists it in
-- its triggers group (section 15).
CREATE OR REPLACE FUNCTION public.ensure_preferred_vendor_is_listed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_vendor_company uuid;
    v_vendor_name    text;
    v_status         text;
    v_deleted        timestamptz;
BEGIN
    SELECT company_id, name INTO v_vendor_company, v_vendor_name
      FROM public.vendors WHERE id = NEW.preferred_vendor_id;

    IF v_vendor_company IS DISTINCT FROM NEW.company_id THEN
        RAISE EXCEPTION 'The preferred vendor must be one of this company''s vendors.'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT status, deleted_at INTO v_status, v_deleted
      FROM public.part_vendors
     WHERE part_id = NEW.id AND vendor_id = NEW.preferred_vendor_id;

    IF v_status = 'disapproved' THEN
        RAISE EXCEPTION '% is marked Do not use for %, so it can''t be the preferred vendor.',
            v_vendor_name, NEW.part_name USING ERRCODE = 'P0001';
    END IF;

    IF v_status IS NULL THEN
        INSERT INTO public.part_vendors (company_id, part_id, vendor_id, status, purchase_unit, created_by)
        VALUES (NEW.company_id, NEW.id, NEW.preferred_vendor_id, 'approved',
                COALESCE(NULLIF(btrim(NEW.primary_unit), ''), 'each'), auth.uid())
        ON CONFLICT (part_id, vendor_id) DO UPDATE
            SET deleted_at = NULL
          WHERE public.part_vendors.deleted_at IS NOT NULL;
    ELSIF v_deleted IS NOT NULL THEN
        UPDATE public.part_vendors SET deleted_at = NULL
         WHERE part_id = NEW.id AND vendor_id = NEW.preferred_vendor_id;
    END IF;

    RETURN NULL;   -- AFTER trigger
END
$fn$;

COMMENT ON FUNCTION public.ensure_preferred_vendor_is_listed() IS
  'AFTER INSERT / UPDATE OF preferred_vendor_id on parts: a preferred vendor always has a live part_vendors row (inserted as approved in the stock unit, or revived). Refuses a vendor from another company and one marked Do not use (P0001). Trigger function; no EXECUTE grant.';

REVOKE EXECUTE ON FUNCTION public.ensure_preferred_vendor_is_listed() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER parts_preferred_vendor_is_listed_ins
    AFTER INSERT ON public.parts
    FOR EACH ROW
    WHEN (NEW.preferred_vendor_id IS NOT NULL)
    EXECUTE FUNCTION public.ensure_preferred_vendor_is_listed();

CREATE TRIGGER parts_preferred_vendor_is_listed_upd
    AFTER UPDATE OF preferred_vendor_id ON public.parts
    FOR EACH ROW
    WHEN (NEW.preferred_vendor_id IS NOT NULL
          AND NEW.preferred_vendor_id IS DISTINCT FROM OLD.preferred_vendor_id)
    EXECUTE FUNCTION public.ensure_preferred_vendor_is_listed();

-- The backfill: every existing preferred vendor gets its row, at rest, now. Only same-company
-- pairs; a cross-company pair is corrupt data and the assertion below fails loudly on it
-- rather than this migration quietly picking an answer.
INSERT INTO public.part_vendors (company_id, part_id, vendor_id, status, purchase_unit)
SELECT p.company_id, p.id, p.preferred_vendor_id, 'approved',
       COALESCE(NULLIF(btrim(p.primary_unit), ''), 'each')
  FROM public.parts p
  JOIN public.vendors v ON v.id = p.preferred_vendor_id AND v.company_id = p.company_id
ON CONFLICT (part_id, vendor_id) DO NOTHING;

DO $check$
DECLARE
    v_cross   integer;
    v_missing integer;
BEGIN
    SELECT count(*) INTO v_cross
      FROM public.parts p JOIN public.vendors v ON v.id = p.preferred_vendor_id
     WHERE v.company_id <> p.company_id;
    IF v_cross > 0 THEN
        RAISE EXCEPTION '% part(s) name a preferred vendor from another company. Fix those rows before this migration (the trigger it adds refuses them).', v_cross;
    END IF;

    SELECT count(*) INTO v_missing
      FROM public.parts p
     WHERE p.preferred_vendor_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.part_vendors pv
                        WHERE pv.part_id = p.id AND pv.vendor_id = p.preferred_vendor_id
                          AND pv.deleted_at IS NULL);
    IF v_missing > 0 THEN
        RAISE EXCEPTION '% part(s) have a preferred vendor with no live part_vendors row after the backfill.', v_missing;
    END IF;
END
$check$;


-- ============================================================================
-- 15. The guards, redefined from their newest bodies with the purchasing entries
-- ============================================================================
-- tenant_tables_missing_ai_decision: rebuilt from 20261110021756 (chat_action_grants) word
-- for word, plus six exempt entries. CREATE OR REPLACE keeps the ACL and COMMENT.
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
      -- The purchasing push's QuickBooks plumbing, 20261110043600: vendor ids, item and
      -- account choices, PO links and sync tokens. Third-party ids next to the invoice
      -- links above, and the status views already say "in QuickBooks / out of date". Never.
      'quickbooks_vendor_map', 'quickbooks_purchasing_setup',
      'quickbooks_purchase_order_links', 'quickbooks_purchase_order_line_links',
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
      -- Superseded documents, 20261110043600: each row is what a PO said when an earlier
      -- revision was sent. A model reading them would quote a superseded price or quantity
      -- as current; the live document is vendor_purchase_orders and its lines.
      'vendor_purchase_order_revisions',
      -- Closed today with no objection known. Opening one is a single
      -- apply_ai_read_access call plus a schema_context.py entry, so that the
      -- model is also told the table exists.
      -- `purchasing_document_series` (20261110043600) is numbering plumbing, the
      -- purchasing twin of company_order_counters beside it.
      'company_custom_units', 'company_order_counters', 'feedback',
      'inventory_locations', 'part_location_stock', 'part_customer_references',
      'job_fulfillment_audit', 'purchasing_document_series'
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

-- definer_writers_missing_write_gate: rebuilt from 20260907234149 word for word, plus the
-- preferred-vendor trigger in the triggers group. Every purchasing RPC carries the
-- company_can_write literal in its own body and needs no entry.
CREATE OR REPLACE FUNCTION public.definer_writers_missing_write_gate()
RETURNS TABLE(function_name text)
LANGUAGE sql
STABLE
AS $$
  WITH gated AS (
    SELECT DISTINCT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'billing_gate_insert'
  )
  SELECT p.proname::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND p.prosecdef
    AND EXISTS (
      SELECT 1 FROM gated g
      WHERE pg_get_functiondef(p.oid) ~* ('(insert into|update)\s+(public\.)?' || g.tablename)
    )
    AND pg_get_functiondef(p.oid) NOT LIKE '%company_can_write%'
    AND pg_get_functiondef(p.oid) NOT LIKE '%inv_assert_can_write%'
    AND p.proname NOT IN (
      -- triggers: the statement that fired them was gated
      'seed_new_part_balance', 'note_views_bump_counts',
      'void_intervals_with_completion',
      -- Added 20260903203741: recompute_job_operation_status_from_completion
      -- became SECURITY DEFINER so the guard trigger on job_operations can tell
      -- a derived write from a hand-written one by current_user alone. It writes
      -- job_parts (gated), but it only ever runs FROM a trigger, so the
      -- statement that fired it was itself gated.
      'recompute_job_operation_status_from_completion',
      -- Added 20260907234149: materialises a chat turn from a job the worker
      -- reports; the job was gated when the route enqueued it.
      'ai_jobs_materialize_chat_turn',
      -- Added 20261110043600: lists a part's preferred vendor in part_vendors. It runs
      -- only FROM the INSERT / UPDATE OF preferred_vendor_id on parts that fired it, and
      -- that write was gated (the browser through parts' billing_gate_* policies; the
      -- importer and seed_demo_data as their own callers).
      'ensure_preferred_vendor_is_listed',
      -- internal helpers: no browser EXECUTE, always called post-assertion
      'inv_get_or_create_unassigned', 'recompute_part_quantity_from_locations',
      -- demo bootstrap: company_can_write() is true for is_demo by design
      'seed_demo_data',
      -- known gap, filed separately: browser-callable, genuinely ungated
      'create_shipment_with_line_items'
    )
  ORDER BY 1;
$$;
