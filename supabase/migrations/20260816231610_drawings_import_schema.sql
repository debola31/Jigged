-- Schema for "Add parts from drawings" — bulk part creation from a folder of
-- engineering drawings (PDF + DXF + STEP).
--
-- Two changes:
--   1. part_attachments.kind gains 'dxf'. The DXF is what the extractor reads,
--      so it must be attachable alongside the PDF it came with. `kind` is stored
--      (not derived at read time) so the Files tab can dispatch a viewer without
--      re-parsing filenames.
--   2. part_customer_references — a part's identity IN ITS CUSTOMER'S NUMBERING.
--
-- WHY (2) EXISTS, because the constraint it prevents is subtle. Part names are
-- unique per company and reusing one REVIVES an archived row rather than
-- duplicating it — correct when a shop re-imports its own catalogue. But drawings
-- arrive from a customer, and the number on them belongs to that customer: two
-- OEMs legitimately both use "1003308". Keying an import on part_name would merge
-- customer B's part onto customer A's, or revive A's archived one, with every
-- historical quote and job still pointing at the merged identity. The import is
-- also the ONLY moment the attribution reliably exists, so it is captured then.
--
-- One-to-many in both directions on purpose: one part can carry several customers'
-- numbers, and one customer's number can map to several parts. (Epicor's 1-1
-- version of this is the most-complained-about design found while researching it.)

-- ---------------------------------------------------------------------------
-- 1. part_attachments.kind gains 'dxf'
-- ---------------------------------------------------------------------------

ALTER TABLE public.part_attachments
    DROP CONSTRAINT IF EXISTS part_attachments_kind_check;

ALTER TABLE public.part_attachments
    ADD CONSTRAINT part_attachments_kind_check
    CHECK (kind IN (
        'pdf',
        'step',
        'dwg',
        'dxf',    -- the drawing the title-block extractor reads
        'other'
    ));

-- ---------------------------------------------------------------------------
-- 2. part_customer_references
-- ---------------------------------------------------------------------------

CREATE TABLE public.part_customer_references (
    id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
    company_id             uuid        NOT NULL,
    part_id                uuid        NOT NULL,
    customer_id            uuid        NOT NULL,
    -- The number as the CUSTOMER writes it. Never normalised, never folded into
    -- parts.part_name.
    customer_part_number   text        NOT NULL,
    customer_revision      text,
    customer_drawing_number text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT part_customer_references_pkey PRIMARY KEY (id),
    CONSTRAINT part_customer_references_company_fk
        FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT part_customer_references_part_fk
        FOREIGN KEY (part_id) REFERENCES public.parts(id) ON DELETE CASCADE,
    CONSTRAINT part_customer_references_customer_fk
        FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE,
    -- The import's identity key. NetSuite's constraint verbatim.
    CONSTRAINT part_customer_references_unique_number
        UNIQUE (company_id, customer_id, customer_part_number),
    CONSTRAINT part_customer_references_number_not_blank
        CHECK (length(btrim(customer_part_number)) > 0)
);

-- The import's hot path: "has this customer sent us this number before?"
CREATE INDEX idx_part_customer_references_lookup
    ON public.part_customer_references (company_id, customer_id, customer_part_number);
-- The part page's reverse read: "whose numbers does this part answer to?"
CREATE INDEX idx_part_customer_references_part
    ON public.part_customer_references (part_id);

COMMENT ON TABLE public.part_customer_references IS
    'A part''s identity in a customer''s own numbering. Written by the drawings import, which is the only moment the attribution reliably exists. Imports key on (customer_id, customer_part_number) — NEVER on parts.part_name, because two customers legitimately use the same number and name reuse revives an archived part rather than duplicating it.';

COMMENT ON COLUMN public.part_customer_references.customer_part_number IS
    'Exactly as the customer writes it. Never normalised and never encoded into parts.part_name.';

ALTER TABLE public.part_customer_references ENABLE ROW LEVEL SECURITY;

CREATE POLICY part_customer_references_select ON public.part_customer_references
    FOR SELECT TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY part_customer_references_insert ON public.part_customer_references
    FOR INSERT TO authenticated
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY part_customer_references_update ON public.part_customer_references
    FOR UPDATE TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()))
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY part_customer_references_delete ON public.part_customer_references
    FOR DELETE TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()));

-- No anon: this is office-side data behind a signed-in session.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.part_customer_references TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.part_customer_references TO service_role;

-- The AI read-only role has no business seeing customer part numbering.
REVOKE ALL ON TABLE public.part_customer_references FROM jigged_ai_readonly;

CREATE TRIGGER part_customer_references_updated_at
    BEFORE UPDATE ON public.part_customer_references
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Browser-writable tenant table, so it carries the billing write gate. Reads stay
-- open; writes require an entitled subscription.
SELECT public.apply_billing_write_gate('public.part_customer_references');
