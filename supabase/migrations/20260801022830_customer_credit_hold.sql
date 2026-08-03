-- Customer credit hold: a manual flag the office sets when a customer is past due.
--
-- Raised and confirmed by the design partner on 2026-07-31. E2 had three states;
-- two suffice — Johnny could not explain the third, and a state nobody can define
-- is a state nobody will set correctly.
--
-- THIS IS NOT THE REFUSED "CREDIT LIMIT" FEATURE, and the distinction is worth
-- keeping sharp because the names are close. A numeric credit limit was refused
-- because QuickBooks Online has no CreditLimit field to sync against (Intuit
-- marks it Desktop-only, and its own documented workaround is to type the number
-- into a Notes field), and because a limit implies a balance to compare it to,
-- which implies the AR subledger docs/modules/invoicing.md deliberately does not
-- build. This column is the opposite: a human decision, set by a human, with no
-- balance, no automation and no integration behind it. If it ever grows a
-- threshold it has become the refused feature and should be reconsidered whole.
--
-- WARN, NEVER GATE. Nothing in the app blocks on this value. Shipping to a held
-- customer shows a banner and proceeds — consistent with the archive standard
-- ("delete never blocks"), with the operator rule that an out-of-sequence
-- operation start never blocks, and with docs/interaction-standards.md, which
-- argues against confirmation friction by name. The enforcement point for a
-- credit hold is a person deciding, not software refusing.
--
-- NO BACKFILL NEEDED, and specifically: `NOT NULL DEFAULT 'open'` means every
-- existing row satisfies the invariant the moment this migration finishes. There
-- is no nullable window and therefore no "if null, assume open" branch anywhere
-- in the read path — the no-silent-fallback rule is satisfied by construction
-- rather than by a follow-up UPDATE.
--
-- No new table, so no GRANTs and no apply_billing_write_gate() call — `customers`
-- is an existing tenant table already carrying the billing_gate_* policies.

ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS credit_status    text NOT NULL DEFAULT 'open',
    ADD COLUMN IF NOT EXISTS credit_hold_note text;

ALTER TABLE public.customers
    DROP CONSTRAINT IF EXISTS customers_credit_status_check;
ALTER TABLE public.customers
    ADD CONSTRAINT customers_credit_status_check
    CHECK (credit_status = ANY (ARRAY['open'::text, 'hold'::text]));

COMMENT ON COLUMN public.customers.credit_status IS
    'Manual credit standing: open | hold. Set by the office when a customer is past due; never computed, never synced from QuickBooks, never derived from a balance. Enum-via-CHECK. WARN-ONLY — no code path may block on this value: a held customer''s quote, job and shipment all proceed, showing a banner. Distinct from the deliberately-refused numeric credit limit (see the migration header).';

COMMENT ON COLUMN public.customers.credit_hold_note IS
    'Free-text reason shown alongside the hold ("2 invoices >60 days, spoke to Dana 7/28"). Optional, and meaningful only while credit_status = ''hold'' — deliberately NOT cleared when the hold is lifted, so the next person to put them on hold can see what happened last time.';
