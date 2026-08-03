-- Per-customer standing quote terms: payment terms, lead time, FOB point.
--
-- Design-partner feedback (2026-07-31): "no way to set default quote terms per customer."
-- Today the ONLY per-customer defaulting anywhere in the product is
-- `QuoteForm.handleCustomerChange` prefilling billing address, shipping address and primary
-- contact. Payment terms and lead time are re-typed on every quote — a transcription tax with
-- a correctness risk attached: type Net 30 for the customer you agreed Net 60 with and you have
-- mis-stated a contract term on a document you already emailed as a PDF.
--
-- WHY THIS IS NOT `markup_rates` (removed 20260713011616, "a new part should not silently
-- inherit a company default"). That removal was about READ-TIME inheritance: a named shared
-- entity whose value was resolved every time the part was read, so editing the rate rewrote
-- history. These columns are resolved ONCE, at quote-create time, into the quote's own
-- `payment_terms` / `lead_time_text` / `fob_point` columns, where the user sees them in an
-- editable field with a helper line naming where the value came from. Editing a customer's
-- default afterwards never rewrites an existing quote — drift is surfaced as a chip and never
-- applied, matching how PricingBasisSnapshot already handles tier drift.
--
-- This is also exactly how the legacy systems these shops come from behave. E2's manual, on
-- its Terms Code: "This code is carried over to the terms code field on the order where it can
-- be changed, if necessary... The terms code on the Order then populates the Invoice." Copy
-- forward with a per-document override — i.e. Jigged's own Document Snapshot Standard.
--
-- FOB rides along because a quote header without it reads as incomplete to a shop owner, and
-- FOB is inseparable from the freight work in the next migration. It is deliberately FREE TEXT
-- naming a place ("FOB Cleveland, OH"), never an origin/destination enum: FOB governs when
-- title and risk transfer, while freight terms govern who pays, and collapsing the two axes is
-- the documented failure mode in this domain. The VICS Bill of Lading keeps the FOB checkbox
-- and the "Freight Charge Terms" box in different corners of the form for exactly this reason;
-- the UI must keep them visually separate too.
--
-- NO BACKFILL NEEDED. NULL is the correct and meaningful state for every existing row: this
-- shop has not told us their standing terms for this customer yet, so nothing is prefilled and
-- behaviour is byte-identical to today. That is a genuine absence, not a missing snapshot, so
-- the no-silent-fallback rule is satisfied without writing any data.
--
-- No new tables, so no GRANTs and no apply_billing_write_gate() call — `customers` and
-- `quotes` are both existing tenant tables that already carry the billing_gate_* policies.

-- ---------------------------------------------------------------------------
-- 1. Customer standing defaults.
-- ---------------------------------------------------------------------------
ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS default_payment_terms  text,
    ADD COLUMN IF NOT EXISTS default_lead_time_text text,
    ADD COLUMN IF NOT EXISTS default_fob_point      text;

COMMENT ON COLUMN public.customers.default_payment_terms IS
    'Standing payment terms for this customer, copied onto a new quote at create time and editable there. Free text drawn from the same vocabulary as quotes.payment_terms (PAYMENT_TERM_PRESETS plus companies.settings.custom_payment_terms) — deliberately not an enum, because shops negotiate terms we cannot enumerate. NULL means "no standing agreement recorded"; the quote field is then left empty rather than guessed. Never read at render time by an existing quote — see the header note on read-time inheritance.';

COMMENT ON COLUMN public.customers.default_lead_time_text IS
    'Standing lead-time phrase for this customer (e.g. "4-6 weeks ARO"), copied onto a new quote at create time and editable there. Mirrors quotes.lead_time_text, which is free text because shops quote lead time in prose, not days. NULL means unset. Weakest of the three defaults on the merits — lead time is a function of shop load and the specific part, so a standing value can become a stale promise; if it is routinely cleared on the quote, replace it with a value derived from recent quote history rather than a stored default.';

COMMENT ON COLUMN public.customers.default_fob_point IS
    'Standing FOB point for this customer, copied onto a new quote at create time. Free text naming a PLACE ("FOB Cleveland, OH"), never an origin/destination enum. FOB governs where title and risk transfer; who PAYS the freight is a separate axis carried on jobs/shipments as freight_terms. Keep the two apart in the UI as well as the schema — conflating them is the classic error in this domain.';

-- ---------------------------------------------------------------------------
-- 2. Quote-level FOB point (the document the default resolves onto).
--    payment_terms and lead_time_text already exist on quotes.
-- ---------------------------------------------------------------------------
ALTER TABLE public.quotes
    ADD COLUMN IF NOT EXISTS fob_point text;

COMMENT ON COLUMN public.quotes.fob_point IS
    'FOB point as agreed on THIS quote — where title and risk transfer, e.g. "FOB Cleveland, OH". Resolved from customers.default_fob_point at create time and then owned by the quote: editing the customer default never rewrites it. Free text, never an enum. Distinct from freight payment terms (who pays), which live on the job and shipment.';
