-- Customer contacts: archive instead of destroy, name the AP contact, and stop
-- a delete from failing outright.
--
-- Three problems, one grain.
--
-- 1. DELETING A CONTACT USED ON A QUOTE FAILED. quotes_contact_id_fkey carries
--    no ON DELETE clause at all, so it defaults to NO ACTION and the delete is
--    refused. jobs_contact_id_fkey has had ON DELETE SET NULL since the baseline.
--    Same relationship, two behaviours, and the stricter one is the accident:
--    both documents freeze the contact into contact_snapshot via
--    snapshot_document_party(), so the printed block survives either way and the
--    FK is only a link back to the live row.
--
-- 2. A CONTACT WHO LEAVES HAD NOWHERE TO GO. The only options were to keep a
--    stale person in every picker or destroy the row. customer_contacts had no
--    deleted_at, which also made it the one customer-family table outside the
--    archive standard (docs/architecture.md §16).
--
-- 3. THE AP CONTACT WAS UNNAMEABLE. is_primary answers "who do we call about
--    the work", which is rarely the person who pays. A shop had to put the AP
--    clerk in as primary and lose the buyer, or keep the buyer and have nowhere
--    to record AP. A default AP contact is the highest-voted customer request in
--    the JobBOSS ideas portal (102 votes, status Developed); contact
--    active/inactive is second at 88. Both are one column away here.
--
-- NOT DOING: adding a 'planner_scheduler' role. The plan called for it, but it
-- appears nowhere in this repo and no shop has asked for it — unlike the two
-- above, which carry vote counts. An enum value nobody requested is the kind of
-- speculative width this module refuses everywhere else.

-- ---------------------------------------------------------------------------
-- 1. Archive + the AP default.
-- ---------------------------------------------------------------------------
ALTER TABLE public.customer_contacts
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
    ADD COLUMN IF NOT EXISTS is_billing_default boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.customer_contacts.deleted_at IS
    'Archive marker. "Delete" on a contact stamps this instead of destroying the row, so a quote or job that named this person keeps resolving them and the shop keeps the history of who they dealt with. Lists, pickers and counts filter deleted_at IS NULL; by-id reads and a document''s retained contact_id deliberately do not. Also the answer to "this person left the company" — the row stops being offered without anything being lost.';

COMMENT ON COLUMN public.customer_contacts.is_billing_default IS
    'The person invoices and statements go to. Deliberately SEPARATE from is_primary, which answers "who do we call about the work" — at most shops those are two different people, and collapsing them forces the shop to lose one. At most one live row per customer (customer_contacts_one_billing_default). Nothing is inferred when it is unset: a customer with no billing default simply has none, rather than silently falling back to the primary.';

-- ---------------------------------------------------------------------------
-- 2. Both "at most one per customer" indexes become LIVE-SCOPED.
-- ---------------------------------------------------------------------------
-- The existing one-primary index has no deleted_at predicate, so an archived
-- contact would keep occupying the primary slot forever and the customer could
-- never name a new one. Archiving has to free the slot, which means the
-- predicate has to know about deleted_at.
DROP INDEX IF EXISTS public.customer_contacts_one_primary;
CREATE UNIQUE INDEX customer_contacts_one_primary
    ON public.customer_contacts (customer_id)
    WHERE is_primary AND deleted_at IS NULL;

CREATE UNIQUE INDEX customer_contacts_one_billing_default
    ON public.customer_contacts (customer_id)
    WHERE is_billing_default AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Make the quote FK behave like the job FK.
-- ---------------------------------------------------------------------------
-- With archive in place this should never fire through the UI. It is fixed
-- anyway: an asymmetric FK is a latent trap for a service-role script or a
-- future bulk operation, and this repo has already been bitten once by two
-- sibling objects disagreeing (the customer-match triggers' UPDATE OF lists).
-- Losing the link costs nothing that matters — quotes.contact_snapshot holds the
-- frozen name/email/phone the document was issued with.
ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_contact_id_fkey;
ALTER TABLE public.quotes
    ADD CONSTRAINT quotes_contact_id_fkey
    FOREIGN KEY (contact_id) REFERENCES public.customer_contacts(id) ON DELETE SET NULL;

-- Fail the migration rather than ship a silently-unfixed FK: DROP CONSTRAINT
-- IF EXISTS on a wrong name succeeds and does nothing, which is exactly how this
-- asymmetry survived this long.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'quotes_contact_id_fkey'
           AND conrelid = 'public.quotes'::regclass
           AND confdeltype = 'n'          -- 'n' = SET NULL
    ) THEN
        RAISE EXCEPTION
            'quotes_contact_id_fkey is not ON DELETE SET NULL after this migration';
    END IF;
END $$;
