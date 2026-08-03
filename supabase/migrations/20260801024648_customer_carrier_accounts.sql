-- The customer's own carrier account: ship it on their UPS number, not ours.
--
-- Design-partner feedback (2026-07-31): "no way to store a customer's UPS collect
-- information." Concretely — the buyer says "ship it on our UPS account, 4A72W9",
-- and today that lives on a sticky note. If the shipper misses it we ship
-- prepaid, eat the freight, and usually cannot re-bill it.
--
-- THIS IS NOT CATCHING UP TO JOBBOSS. JobBOSS has no first-class field for this
-- either: idea JBCORE-I-1267 ("Add a Shipping tab to Customers") has 69 votes,
-- has been open since Nov 2020, is still "Future Consideration", and its users
-- say verbatim that they "currently have to put that in one of the Custom tab
-- fields". E2 is the same — its Shipping Codes carry "the company's account
-- number with this shipper", i.e. the SHOP's account, and its documented
-- workaround is to proliferate global Ship Via codes. The walkthrough on
-- 2026-07-31 confirmed the pilot shop did exactly that: the number lived inside
-- E2's free-text Ship Via field on the shipping-address screen, as
-- "ship via UPS ... 241576". Two vendors, same workaround, five years of votes.
--
-- WHY A TABLE AND NOT A COLUMN. Three reasons, in order of how quickly they bite:
--   1. It is a tuple, not a string. Every carrier system converges on the same
--      minimum payload for billing a third party — account number, the account's
--      postal code, and its country. UPS rejects a third-party bill without the
--      postal code (error 120412); FedEx Ship Manager asks for "Account no." plus
--      "Payer Postal Code"; ShipEngine and EasyPost both require party, account,
--      postal code and country. A lone `customers.ups_account text` is a field
--      that cannot complete a shipment.
--   2. One customer can need more than one. Parcel and LTL to the same customer
--      is ordinary, and they bill through different accounts and different
--      systems. Rows are free here; a scalar column would have to be widened.
--   3. It is the customer's shared secret. In a child table it is outside the
--      AI's reach by construction — `customers` IS in the SQL-generation
--      allowlist and this table is not (see api/tools/schema_context.py).
--
-- WHAT THIS IS NOT: the per-customer shipping defaults dropped in June 2026
-- (20260621161856). Those failed for a diagnosable reason rather than bad luck.
-- `default_shipping_arrangement` mixed two orthogonal axes — who PAYS (prepaid /
-- collect / third party) and HOW IT LEFT (pickup / customer-arranged) — and the
-- June migration correctly split the second axis out into shipping_method, then
-- dropped the first entirely instead of keeping it. Worse, its `third_party_account`
-- value had nowhere to put an account number: an enum value naming a mechanism
-- the schema could not execute. That is a field you select once and never again.
-- This table is the missing instrument; the companion migration restores the
-- payment axis alongside it.
--
-- GRAIN. E2 put this on the shipping ADDRESS, and a real supplier routing guide
-- (Collins Aerospace) discriminates billing party purely by destination: bill the
-- recipient when shipping to their facility, bill third party on a drop-ship.
-- So the address is arguably the right grain. It is deliberately NOT modelled
-- here: the walkthrough found exactly ONE account at the pilot shop, and an
-- address FK plus a scope enum would be columns nobody fills. Adding
-- customer_address_id later is purely additive — the gate is whether any real
-- customer turns out to have more than one ship-to plant.

CREATE TABLE public.customer_carrier_accounts (
    id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id           uuid NOT NULL,
    customer_id          uuid NOT NULL,
    -- Free text, matching shipments.carrier. E2's own help says to "enter the
    -- method for shipment here such as UPS", and QuickBooks' Ship via field has
    -- no dropdown at all. The UI offers UPS/FedEx/USPS plus an "Other" escape;
    -- a strict enum here would be a regression the first time a shop uses a
    -- regional LTL carrier.
    carrier              text NOT NULL,
    -- Who the carrier bills. NOT cosmetic: UPS levies a third-party billing
    -- surcharge (~5% of the total charge, base plus accessorials) that billing
    -- the receiver does not carry. Collapsing both into "collect" would leave a
    -- shop unable to pick the cheaper of two legal options.
    bill_to_party        text NOT NULL,
    -- NULLABLE ON PURPOSE. Two common cases legitimately have no account number:
    -- LTL freight identifies the payer by NAME AND ADDRESS on the bill of lading,
    -- and FedEx Ground Collect requires none at all. A NOT NULL here is how the
    -- column gets poisoned with "N/A" and "000000" in week one.
    account_number       text,
    -- The postal code OF THE ACCOUNT, not of any address on the shipment. UPS
    -- validates the pair and rejects a mismatch.
    account_postal_code  text,
    account_country_code text NOT NULL DEFAULT 'US',
    notes                text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    deleted_at           timestamptz,

    CONSTRAINT customer_carrier_accounts_pkey PRIMARY KEY (id),
    CONSTRAINT customer_carrier_accounts_company_fk FOREIGN KEY (company_id)
      REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT customer_carrier_accounts_customer_fk FOREIGN KEY (customer_id)
      REFERENCES public.customers(id) ON DELETE CASCADE,
    CONSTRAINT customer_carrier_accounts_bill_to_party_check
      CHECK (bill_to_party = ANY (ARRAY['recipient'::text, 'third_party'::text])),
    CONSTRAINT customer_carrier_accounts_carrier_not_blank
      CHECK (length(btrim(carrier)) > 0),
    -- Require the account number only where it is genuinely load-bearing.
    -- Third-party billing cannot execute without one; billing the recipient can
    -- (see the account_number comment above).
    CONSTRAINT customer_carrier_accounts_account_required
      CHECK (bill_to_party <> 'third_party'
             OR (account_number IS NOT NULL AND length(btrim(account_number)) > 0))
);

-- Live rows only: the access layer reads by customer and filters archived rows,
-- so the predicate keeps the index the same shape as the query.
CREATE INDEX idx_customer_carrier_accounts_customer
  ON public.customer_carrier_accounts (customer_id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.customer_carrier_accounts IS
  'A customer''s own carrier account, so their freight bills to them instead of to the shop. Optional: a customer with none ships prepaid exactly as before. Holds the account tuple every carrier system requires (party, account, postal code, country) rather than a bare number, which cannot complete a third-party shipment.';

COMMENT ON COLUMN public.customer_carrier_accounts.bill_to_party IS
  'recipient = bill the receiver''s account (freight collect). third_party = bill a nominated third party''s account. Distinct on purpose: UPS charges a third-party billing surcharge that bill-receiver does not, so a shop that stores only "collect" cannot choose the cheaper legal option.';

COMMENT ON COLUMN public.customer_carrier_accounts.account_number IS
  'The CUSTOMER''s account with the carrier — never the shop''s. Nullable: LTL bills the payer by name and address on the BOL, and FedEx Ground Collect needs no account, so requiring one here would force "N/A" into the field. Required only when bill_to_party = third_party (customer_carrier_accounts_account_required). Treated as the customer''s shared secret: shown in full to the packer keying it into WorldShip, redacted to the last 4 on the printed slip and in the shipment snapshot, and kept out of the AI SQL surface entirely.';

ALTER TABLE public.customer_carrier_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_carrier_accounts_select ON public.customer_carrier_accounts
    FOR SELECT TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY customer_carrier_accounts_insert ON public.customer_carrier_accounts
    FOR INSERT TO authenticated
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY customer_carrier_accounts_update ON public.customer_carrier_accounts
    FOR UPDATE TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()))
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY customer_carrier_accounts_delete ON public.customer_carrier_accounts
    FOR DELETE TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()));

-- Data API grants. UPDATE is granted (unlike the attachment tables): an account
-- number gets corrected in place, and archiving is an UPDATE of deleted_at.
-- NO anon: this is the customer's account number, and nothing about it is
-- readable logged-out.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_carrier_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_carrier_accounts TO service_role;

-- REVOKE FROM THE AI READ ROLE — and this one is NOT redundant, which is why it
-- is written out rather than assumed.
--
-- The baseline sets `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
-- GRANT SELECT ON TABLES TO jigged_ai_readonly` (baseline.sql ~6431), so EVERY
-- new table in public is granted SELECT to the SQL-generating AI's role the
-- moment it is created. Nothing above did that; it happened by default.
--
-- In practice RLS would still block every row, because this table has no
-- `ai_readonly_select` policy and RLS denies what no policy allows. But that
-- safety is an absence — it holds only until someone adds a policy here for
-- convenience and doesn't realise what the table contains. For a customer's
-- carrier account number, "safe because we forgot to write a policy" is not a
-- control. Revoke the grant so the intent is recorded in the schema itself.
--
-- This is the third of four independent layers, alongside: absence from
-- ALLOWED_TABLES (the primary boundary), presence in SENSITIVE_TABLES (the
-- whole-word backstop, both in api/tools/), and RLS.
REVOKE ALL ON public.customer_carrier_accounts FROM jigged_ai_readonly;

SELECT public.apply_billing_write_gate('public.customer_carrier_accounts');
