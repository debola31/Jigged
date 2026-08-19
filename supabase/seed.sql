-- =============================================================================
-- supabase/seed.sql — canonical development / preview-branch seed for Jigged.
--
-- Runs automatically on `supabase db reset` (local) and on every Supabase
-- preview-branch creation (config.toml [db.seed].sql_paths). Replaces the old
-- scripts/seed-dev.ts programmatic seeder.
--
-- Design:
--   * FIXED UUIDs        → deterministic identities, clean git diffs.
--   * DYNAMIC dates      → `now() - interval '…'`, so the shop is always in the
--                          same state relative to today however long ago the
--                          file was written. Late work and expired quotes are
--                          therefore INTENTIONALLY late rather than drifting
--                          there: seven jobs are overdue by design, spanning one
--                          day to five weeks, because the Overdue tile, the jobs
--                          list's overdue filter and the alert tone are all
--                          unreachable otherwise.
--   * REAL updated_at    → `jobs_updated_at` / `quotes_updated_at` stamp now()
--                          on every write, so everything here would otherwise
--                          read as "touched today" and the dashboard's Completed
--                          card would count the whole year as this week. One
--                          pass near the end suspends those triggers and stamps
--                          each row with its newest real event.
--   * App RPCs+triggers  → derived state (quote/job numbers, party snapshots,
--                          job operations, fulfillment cascade, status rollups)
--                          is produced by the same DB logic the app uses, so the
--                          seed stays correct as the schema evolves.
--
-- Logins after reset — all password `jigged-dev-1234`.
-- Vanguard Precision Works team:
--   dev@jigged.test         admin     (Dev Seed User)
--   admin2@jigged.test      admin     (Morgan Reyes)
--   user1@jigged.test       user      (Sam Carter)
--   user2@jigged.test       user      (Jamie Lin)
--   operator1@jigged.test   operator  (Diego Alvarez)
--   operator2@jigged.test   operator  (Priya Nair)
-- Platform-level system admin (spans all companies; only the /admin surface,
-- deliberately NOT a member of any company):
--   sysadmin@jigged.test    system admin  (System Admin)
--
-- LOCAL / PREVIEW ONLY — never run against production (it writes auth.users
-- directly). Designed for a fresh DB, which `supabase db reset` and preview-
-- branch creation both provide: catalog rows are ON CONFLICT-guarded, and the
-- transaction graph assumes an empty starting point (re-run via `db reset`,
-- not by re-executing this file on a populated DB).
-- =============================================================================

create extension if not exists pgcrypto;

-- ── Auth user ────────────────────────────────────────────────────────────────
-- Email/password sign-in needs a bcrypt encrypted_password, a confirmed email,
-- empty-string (not NULL) token columns, and a companion auth.identities row.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated', 'authenticated',
  'dev@jigged.test',
  crypt('jigged-dev-1234', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Dev Seed User"}'::jsonb,
  now() - interval '365 days', now(),
  '', '', '', ''
) on conflict (id) do nothing;

insert into auth.identities (
  provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values (
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  '{"sub":"11111111-1111-1111-1111-111111111111","email":"dev@jigged.test"}'::jsonb,
  'email', now(), now() - interval '365 days', now()
) on conflict do nothing;

-- ── Company + access ─────────────────────────────────────────────────────────
-- The address / phone / email / website columns are NOT decoration: every
-- generated document (job traveler, packing slip, quote, invoice) builds its
-- letterhead from them via buildShopHeaderLines(). Left null, each PDF prints a
-- company name floating over a block of empty paper, which reads as a layout bug
-- rather than as missing profile data — so dev and preview branches were tuning
-- print layouts against a shop that doesn't exist. Keep these populated.
insert into public.companies (
  id, name, address_line1, city, state, postal_code, country, phone, email, website, settings
) values
  ('22222222-2222-2222-2222-222222222222', 'Vanguard Precision Works',
   '1420 Rand Drive', 'Detroit', 'MI', '48211', 'USA',
   '(313) 555-0142', 'shop@vanguardprecision.test', 'vanguardprecision.test',
   -- Opt-in features are ON in dev + preview branches. A flag-gated feature that
   -- no preview deployment can display is a feature nobody can review — the
   -- reviewer sees an unchanged app and has to take the diff's word for it.
   -- Seed is local/preview-only, never prod, so this widens nothing real.
   --
   -- default_payment_terms is the shop-wide fallback used when a customer has
   -- no terms of their own. Seeded so both branches of the resolution chain are
   -- reachable by hand: quote Northwind (has its own terms) and the field
   -- credits the customer; quote Sierra Pump & Valve (has none) and it credits
   -- the shop default instead.
   '{"features": {"machine_maintenance": true, "quickbooks_desktop": true},
     "default_payment_terms": "2/10 Net 30"}'::jsonb)
on conflict (id) do nothing;

-- Billing cache: the grandfather backfill in the stripe_billing_cache migration
-- runs on an empty DB (before this seed), so the seeded company gets no row and
-- would be write-blocked once billing enforcement is on. Grandfather it here so
-- dev / preview / E2E have a fully writable company (entitlement = full, no
-- billing banner). Devs can still exercise Checkout in Stripe test mode.
insert into public.company_billing (company_id, billing_exempt) values
  ('22222222-2222-2222-2222-222222222222', true)
on conflict (company_id) do nothing;

insert into public.user_company_access (id, user_id, company_id, role, name) values
  ('23000000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222', 'admin', 'Dev Seed User')
on conflict do nothing;

-- ── Additional team members ──────────────────────────────────────────────────
-- A realistic roster so role-based behaviour can be exercised in dev: two admins
-- (incl. dev@jigged.test above), two users, two operators. Same password as the
-- primary dev user; the email prefix encodes the role for easy login. Same
-- auth.users / auth.identities / user_company_access shape as the dev user.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
) values
  ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111112','authenticated','authenticated','admin2@jigged.test',    crypt('jigged-dev-1234', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Morgan Reyes"}'::jsonb,   now() - interval '365 days', now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111113','authenticated','authenticated','user1@jigged.test',     crypt('jigged-dev-1234', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Sam Carter"}'::jsonb,     now() - interval '365 days', now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111114','authenticated','authenticated','user2@jigged.test',     crypt('jigged-dev-1234', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Jamie Lin"}'::jsonb,      now() - interval '365 days', now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111115','authenticated','authenticated','operator1@jigged.test', crypt('jigged-dev-1234', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Diego Alvarez"}'::jsonb,  now() - interval '365 days', now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111116','authenticated','authenticated','operator2@jigged.test', crypt('jigged-dev-1234', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Priya Nair"}'::jsonb,     now() - interval '365 days', now(), '', '', '', '')
on conflict (id) do nothing;

insert into auth.identities (
  provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values
  ('11111111-1111-1111-1111-111111111112','11111111-1111-1111-1111-111111111112','{"sub":"11111111-1111-1111-1111-111111111112","email":"admin2@jigged.test"}'::jsonb,    'email', now(), now() - interval '365 days', now()),
  ('11111111-1111-1111-1111-111111111113','11111111-1111-1111-1111-111111111113','{"sub":"11111111-1111-1111-1111-111111111113","email":"user1@jigged.test"}'::jsonb,     'email', now(), now() - interval '365 days', now()),
  ('11111111-1111-1111-1111-111111111114','11111111-1111-1111-1111-111111111114','{"sub":"11111111-1111-1111-1111-111111111114","email":"user2@jigged.test"}'::jsonb,     'email', now(), now() - interval '365 days', now()),
  ('11111111-1111-1111-1111-111111111115','11111111-1111-1111-1111-111111111115','{"sub":"11111111-1111-1111-1111-111111111115","email":"operator1@jigged.test"}'::jsonb, 'email', now(), now() - interval '365 days', now()),
  ('11111111-1111-1111-1111-111111111116','11111111-1111-1111-1111-111111111116','{"sub":"11111111-1111-1111-1111-111111111116","email":"operator2@jigged.test"}'::jsonb, 'email', now(), now() - interval '365 days', now())
on conflict do nothing;

insert into public.user_company_access (id, user_id, company_id, role, name) values
  ('23000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111112','22222222-2222-2222-2222-222222222222','admin',    'Morgan Reyes'),
  ('23000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111113','22222222-2222-2222-2222-222222222222','user',     'Sam Carter'),
  ('23000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111114','22222222-2222-2222-2222-222222222222','user',     'Jamie Lin'),
  ('23000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111115','22222222-2222-2222-2222-222222222222','operator', 'Diego Alvarez'),
  ('23000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111116','22222222-2222-2222-2222-222222222222','operator', 'Priya Nair')
on conflict do nothing;

-- ── Platform-level system admin ──────────────────────────────────────────────
-- A system administrator: platform-wide privileges spanning ALL companies, kept
-- deliberately separate from the per-company roles above (see public.system_admins
-- / is_system_admin() and the /admin surface behind SystemAdminGuard). Has NO
-- user_company_access row on purpose — it is a pure platform admin, not a member
-- of any company. created_by is self-referential (bootstrap; the column is
-- nullable precisely for this first-admin case).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
) values (
  '00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111117','authenticated','authenticated','sysadmin@jigged.test', crypt('jigged-dev-1234', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"System Admin"}'::jsonb, now() - interval '365 days', now(), '', '', '', ''
) on conflict (id) do nothing;

insert into auth.identities (
  provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values (
  '11111111-1111-1111-1111-111111111117','11111111-1111-1111-1111-111111111117','{"sub":"11111111-1111-1111-1111-111111111117","email":"sysadmin@jigged.test"}'::jsonb, 'email', now(), now() - interval '365 days', now()
) on conflict do nothing;

insert into public.system_admins (id, user_id, created_by) values
  ('24000000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111117',
   '11111111-1111-1111-1111-111111111117')
on conflict do nothing;

-- ── Vendors (+ one contact each) ─────────────────────────────────────────────
insert into public.vendors (id, company_id, name, city, state, country) values
  ('30000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Atlas Metals Supply','Cleveland','OH','USA'),
  ('30000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','FastenRight Hardware','Rockford','IL','USA'),
  ('30000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','ProFinish Coatings','Detroit','MI','USA'),
  ('30000000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','Precision Bearings Co','Charlotte','NC','USA'),
  ('30000000-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','VoltEdge Electronics','Austin','TX','USA')
on conflict (id) do nothing;

insert into public.vendor_contacts (vendor_id, name, role, email, phone, is_primary) values
  ('30000000-0000-0000-0000-000000000001','Atlas Sales','sales','sales@atlas.example','555-0100',true),
  ('30000000-0000-0000-0000-000000000002','FastenRight Sales','sales','sales@fasten.example','555-0100',true),
  ('30000000-0000-0000-0000-000000000003','ProFinish Sales','sales','sales@profinish.example','555-0100',true),
  ('30000000-0000-0000-0000-000000000004','Precision Sales','sales','sales@bearings.example','555-0100',true),
  ('30000000-0000-0000-0000-000000000005','VoltEdge Sales','sales','sales@voltedge.example','555-0100',true)
on conflict do nothing;

-- ── Work centers (6 internal + 1 external anodize → ProFinish) ────────────────
insert into public.work_centers (id, company_id, name, kind, vendor_id, labor_rate, description) values
  ('40000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Bandsaw','internal',null,75,'In-house work center'),
  ('40000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','CNC Mill (Haas VF-2)','internal',null,120,'In-house work center'),
  ('40000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','CNC Lathe (Okuma)','internal',null,110,'In-house work center'),
  ('40000000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','Manual Deburr','internal',null,65,'In-house work center'),
  ('40000000-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','Assembly Bench','internal',null,70,'In-house work center'),
  ('40000000-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222','Final Inspection','internal',null,85,'In-house work center'),
  ('40000000-0000-0000-0000-000000000007','22222222-2222-2222-2222-222222222222','Anodizing (ProFinish)','external','30000000-0000-0000-0000-000000000003',null,'Outside process')
on conflict (id) do nothing;

-- ── Customers (+ billing/shipping addresses + primary contact) ───────────────
-- Standing terms are set on SOME customers only, on purpose: a shop fills these
-- in as agreements are struck, so the realistic state is partial. It also makes
-- both branches reachable by hand — pick Northwind on a new quote and terms
-- prefill with a provenance line; pick Sierra and the fields stay empty.
-- Granite Equipment Co is seeded ON CREDIT HOLD so the warn-never-gate path is
-- reachable by hand: open a shipment for one of their jobs and the banner shows
-- while the Create button stays live. Everyone else is 'open' by column default.
insert into public.customers (id, company_id, name, default_payment_terms, credit_status, credit_hold_note) values
  ('50000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Northwind Hydraulics','Net 30','open',null),
  ('50000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','Cascade Robotics','Net 45','open',null),
  ('50000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','Meridian Aerospace','2/10 Net 30','open',null),
  ('50000000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','Granite Equipment Co','Net 30','hold','Two invoices past 60 days. Spoke to their AP 7/28 — check before shipping.'),
  ('50000000-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','BlueRidge Medical Devices','50% Deposit / Balance Net 30','open',null),
  ('50000000-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222','Sierra Pump & Valve',null,'open',null)
on conflict (id) do nothing;

-- billing addresses (default_shipping true when the customer has no separate ship-to)
insert into public.customer_addresses (id, customer_id, address_line1, city, state, postal_code, country, default_billing, default_shipping, attention_to) values
  ('51000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','1420 Industrial Pkwy','Milwaukee','WI','00000','USA',true,true,'Accounts Payable'),
  ('51000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002','88 Maker Way','Portland','OR','00000','USA',true,false,'Accounts Payable'),
  ('51000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000003','5 Falcon Loop','Wichita','KS','00000','USA',true,true,'Accounts Payable'),
  ('51000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004','310 Quarry St','Manchester','NH','00000','USA',true,true,'Accounts Payable'),
  ('51000000-0000-0000-0000-000000000005','50000000-0000-0000-0000-000000000005','47 Sterile Dr','Asheville','NC','00000','USA',true,true,'Accounts Payable'),
  ('51000000-0000-0000-0000-000000000006','50000000-0000-0000-0000-000000000006','900 Basin Ave','Reno','NV','00000','USA',true,false,'Accounts Payable')
on conflict (id) do nothing;

-- separate shipping addresses (Cascade, Sierra)
insert into public.customer_addresses (id, customer_id, address_line1, city, state, postal_code, country, default_billing, default_shipping, attention_to) values
  ('52000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002','Dock 7, 200 Fab Rd','Hillsboro','OR','00000','USA',false,true,'Receiving'),
  ('52000000-0000-0000-0000-000000000006','50000000-0000-0000-0000-000000000006','Whse B, 12 Flow Ct','Sparks','NV','00000','USA',false,true,'Receiving')
on conflict (id) do nothing;

insert into public.customer_contacts (id, customer_id, name, role, email, phone, is_primary) values
  ('53000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','Dana Reyes','buyer','dana@northwind.example','555-0123',true),
  ('53000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002','Sam Okafor','engineering','sam@cascade.example','555-0123',true),
  ('53000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000003','Priya Menon','quality','priya@meridian.example','555-0123',true),
  ('53000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004','Tom Beck','buyer','tom@granite.example','555-0123',true),
  ('53000000-0000-0000-0000-000000000005','50000000-0000-0000-0000-000000000005','Lena Park','accounts_payable','ap@blueridge.example','555-0123',true),
  ('53000000-0000-0000-0000-000000000006','50000000-0000-0000-0000-000000000006','Marco Diaz','shipping_receiving','recv@sierrapump.example','555-0123',true)
on conflict (id) do nothing;

-- Carrier accounts: the customer's own account, so their freight bills to them.
-- Two customers only, and deliberately covering both shapes —
--   Northwind: third_party, so the account number is REQUIRED and present.
--   Meridian:  recipient with NO account number, the LTL / Ground Collect case
--              the nullable column exists for.
-- Everyone else has none, which is the majority state and must render as a
-- plain "no carrier accounts" rather than anything that looks unfinished.
-- Exactly one account each, so pickCarrierAccount resolves; add a second to a
-- customer by hand to see the "which account?" prompt.
insert into public.customer_carrier_accounts
  (id, company_id, customer_id, carrier, bill_to_party, account_number, account_postal_code, account_country_code, notes) values
  ('54000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','50000000-0000-0000-0000-000000000001',
   'UPS','third_party','4A72W9','53202','US','Ground only. They query anything air-freighted.'),
  ('54000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','50000000-0000-0000-0000-000000000003',
   'R+L Carriers','recipient',null,null,'US','LTL — billed to them on the BOL, no account number needed.')
on conflict (id) do nothing;

-- ── Three more customers, so the book is not concentrated in six names ───────
-- No standing terms and no carrier accounts on any of them: that is the state
-- most customers are actually in, and the six above already cover the filled-in
-- branches. Ironclad and Summit both carry a separate ship-to.
insert into public.customers (id, company_id, name, default_payment_terms, credit_status, credit_hold_note) values
  ('50000000-0000-0000-0000-000000000007','22222222-2222-2222-2222-222222222222','Ironclad Fabrication',null,'open',null),
  ('50000000-0000-0000-0000-000000000008','22222222-2222-2222-2222-222222222222','Summit Instruments','Net 60','open',null),
  ('50000000-0000-0000-0000-000000000009','22222222-2222-2222-2222-222222222222','Delta Marine Systems','Net 30','open',null)
on conflict (id) do nothing;

insert into public.customer_addresses (id, customer_id, address_line1, city, state, postal_code, country, default_billing, default_shipping, attention_to) values
  ('51000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000007','2200 Forge Rd','Erie','PA','00000','USA',true,false,'Accounts Payable'),
  ('51000000-0000-0000-0000-000000000008','50000000-0000-0000-0000-000000000008','14 Summit Ridge','Boulder','CO','00000','USA',true,false,'Accounts Payable'),
  ('51000000-0000-0000-0000-000000000009','50000000-0000-0000-0000-000000000009','700 Harbor Blvd','Mobile','AL','00000','USA',true,true,'Accounts Payable')
on conflict (id) do nothing;

insert into public.customer_addresses (id, customer_id, address_line1, city, state, postal_code, country, default_billing, default_shipping, attention_to) values
  ('52000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000007','Gate 3, 2260 Forge Rd','Erie','PA','00000','USA',false,true,'Receiving'),
  ('52000000-0000-0000-0000-000000000008','50000000-0000-0000-0000-000000000008','Dock A, 18 Summit Ridge','Boulder','CO','00000','USA',false,true,'Receiving')
on conflict (id) do nothing;

insert into public.customer_contacts (id, customer_id, name, role, email, phone, is_primary) values
  ('53000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000007','Ruth Kelleher','buyer','ruth@ironclad.example','555-0123',true),
  ('53000000-0000-0000-0000-000000000008','50000000-0000-0000-0000-000000000008','Ben Osei','engineering','ben@summitinst.example','555-0123',true),
  ('53000000-0000-0000-0000-000000000009','50000000-0000-0000-0000-000000000009','Carla Nunes','buyer','carla@deltamarine.example','555-0123',true)
on conflict (id) do nothing;

-- ── Parts ────────────────────────────────────────────────────────────────────
-- part uuid: 60000000-…-0000000000NN  (NN 01..18). Made-part routing uuid: 70000000-…-NN.
-- Bought parts (raw blanks + components), stocked, with a preferred vendor.
insert into public.parts (id, company_id, part_name, description, source, is_stocked, primary_unit, quantity, reorder_point, preferred_vendor_id) values
  ('60000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','RAW-AL6061-BLANK','Aluminum 6061 machining blank','bought',true,'ea',240,10,'30000000-0000-0000-0000-000000000001'),
  ('60000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','RAW-STEEL-BLANK','Steel A36 plate blank','bought',true,'ea',180,10,'30000000-0000-0000-0000-000000000001'),
  ('60000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','RAW-SS304-BLANK','Stainless 304 rod blank','bought',true,'ea',120,10,'30000000-0000-0000-0000-000000000001'),
  ('60000000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','BUY-BEARING-608ZZ','Ball bearing 608ZZ','bought',true,'ea',600,10,'30000000-0000-0000-0000-000000000004'),
  ('60000000-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','BUY-ORING-214','O-ring #214 Buna-N','bought',true,'ea',1500,10,'30000000-0000-0000-0000-000000000002'),
  ('60000000-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222','BUY-SHCS-M5x16','M5x16 socket head cap screw','bought',true,'ea',5000,10,'30000000-0000-0000-0000-000000000002'),
  ('60000000-0000-0000-0000-000000000007','22222222-2222-2222-2222-222222222222','BUY-DOWEL-3MM','Dowel pin 3mm x 16','bought',true,'ea',2200,10,'30000000-0000-0000-0000-000000000002'),
  -- reorder_point 75 against 60 on hand, so this part sits in the LOW band. Deliberate: see the
  -- note below the insert.
  ('60000000-0000-0000-0000-000000000008','22222222-2222-2222-2222-222222222222','BUY-MOTOR-12V','12V DC gearmotor','bought',true,'ea',60,75,'30000000-0000-0000-0000-000000000005'),
  -- Machined sub-components (made, stocked).
  ('60000000-0000-0000-0000-000000000009','22222222-2222-2222-2222-222222222222','SUB-HOUSING','Pump housing, machined','made',true,'ea',25,10,null),
  ('60000000-0000-0000-0000-000000000010','22222222-2222-2222-2222-222222222222','SUB-SHAFT','Drive shaft, turned','made',true,'ea',40,10,null),
  ('60000000-0000-0000-0000-000000000011','22222222-2222-2222-2222-222222222222','SUB-COVER','End cover, anodized','made',true,'ea',30,10,null),
  -- Second LOW-band part (35 on hand, reorder at 50), so the filter shows a list rather than a
  -- single row.
  ('60000000-0000-0000-0000-000000000012','22222222-2222-2222-2222-222222222222','SUB-BRACKET','Mounting bracket','made',true,'ea',35,50,null),
  -- Sub-assemblies (made, stocked).
  ('60000000-0000-0000-0000-000000000013','22222222-2222-2222-2222-222222222222','ASM-PUMPCORE','Pump core assembly','made',true,'ea',12,10,null),
  ('60000000-0000-0000-0000-000000000014','22222222-2222-2222-2222-222222222222','ASM-GEARBOX','Gearbox subassembly','made',true,'ea',8,10,null),
  -- Top-level sellable products (made, not stocked).
  ('60000000-0000-0000-0000-000000000015','22222222-2222-2222-2222-222222222222','PROD-PUMP-100','Hydraulic Pump P-100','made',false,'ea',0,null,null),
  ('60000000-0000-0000-0000-000000000016','22222222-2222-2222-2222-222222222222','PROD-ACTUATOR-200','Linear Actuator A-200','made',false,'ea',0,null,null),
  ('60000000-0000-0000-0000-000000000017','22222222-2222-2222-2222-222222222222','PROD-MANIFOLD-300','Valve Manifold M-300','made',false,'ea',0,null,null),
  ('60000000-0000-0000-0000-000000000018','22222222-2222-2222-2222-222222222222','PROD-RAIL-CUT','Cut-to-length guide rail (per inch)','made',false,'in',0,null,null)
on conflict (id) do nothing;

-- Why two parts carry a reorder_point ABOVE their quantity
-- ────────────────────────────────────────────────────────
-- Stock status is derived at render: 0 ⇒ out, 0 < qty <= reorder_point ⇒ low, else in stock
-- (`components/inventory/StockStatusChip.tsx`). Before this, the seed could not produce a single
-- `low` part, so the "Low" chip and the `/parts?status=low` filter — which is the shop-wide
-- shortage view — were invisible in every dev and preview environment.
--
-- It wasn't simply missing data. Job material consumption below ran
-- `set quantity = greatest(0, quantity - used)`, which drove ASM-GEARBOX, ASM-PUMPCORE,
-- SUB-HOUSING and SUB-COVER from healthy quantities **straight to 0** — skipping the low band
-- entirely — while everything else stayed at twice its reorder point or more. Measured on a
-- reset stack: 10 in-stock, 8 out, **0 low**, with the nearest part at 20 against a reorder of 10.
-- (Since 20260802144310 those four lose their balance ROW rather than holding a zero; the derived
-- status is unchanged — no row and a zero row both read as `out` — but the count sheet reaches
-- them through `resolveFallbackPlace` now instead of through a row.)
--
-- So the fix raises `reorder_point` on two parts rather than lowering `quantity`. reorder_point is
-- read only by the status derivation and the low-stock alert lists — never by cost or inventory
-- math — so it cannot perturb BOM costs, count worksheets or put-away balances. Both chosen parts
-- are ones job consumption does **not** touch, so the low band stays reachable even if the
-- consumption above changes.
--
-- If you add a `low`-dependent spec, assert against these two (BUY-MOTOR-12V, SUB-BRACKET) rather
-- than runtime-skipping when the list is empty — a skipped spec masked the May 2026 `jobs.status`
-- regression.

-- Part-level procurement tiers for bought parts (so compute_part_cost_at_qty
-- resolves a cost). Vendor is a supplier label on the part
-- (parts.preferred_vendor_id, set above), not a dimension of the cost tiers.
insert into public.part_procurement_tiers (part_id, min_quantity, cost_per_unit) values
  ('60000000-0000-0000-0000-000000000001',1,6.4),
  ('60000000-0000-0000-0000-000000000002',1,4.1),
  ('60000000-0000-0000-0000-000000000003',1,7.85),
  ('60000000-0000-0000-0000-000000000004',1,1.25),
  ('60000000-0000-0000-0000-000000000005',1,0.18),
  ('60000000-0000-0000-0000-000000000006',1,0.07),
  ('60000000-0000-0000-0000-000000000007',1,0.09),
  ('60000000-0000-0000-0000-000000000008',1,14.5)
on conflict do nothing;

-- BOM edges (parent_part_id → child_part_id, qty, sequence 10/20/…; unit 'ea').
insert into public.parts_bom (parent_part_id, child_part_id, quantity, unit, sequence) values
  ('60000000-0000-0000-0000-000000000009','60000000-0000-0000-0000-000000000001',1,'ea',10),
  ('60000000-0000-0000-0000-000000000010','60000000-0000-0000-0000-000000000003',1,'ea',10),
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000002',1,'ea',10),
  ('60000000-0000-0000-0000-000000000012','60000000-0000-0000-0000-000000000002',1,'ea',10),
  ('60000000-0000-0000-0000-000000000013','60000000-0000-0000-0000-000000000009',1,'ea',10),
  ('60000000-0000-0000-0000-000000000013','60000000-0000-0000-0000-000000000010',1,'ea',20),
  ('60000000-0000-0000-0000-000000000013','60000000-0000-0000-0000-000000000004',2,'ea',30),
  ('60000000-0000-0000-0000-000000000013','60000000-0000-0000-0000-000000000005',2,'ea',40),
  ('60000000-0000-0000-0000-000000000014','60000000-0000-0000-0000-000000000012',1,'ea',10),
  ('60000000-0000-0000-0000-000000000014','60000000-0000-0000-0000-000000000008',1,'ea',20),
  ('60000000-0000-0000-0000-000000000014','60000000-0000-0000-0000-000000000006',4,'ea',30),
  ('60000000-0000-0000-0000-000000000015','60000000-0000-0000-0000-000000000013',1,'ea',10),
  ('60000000-0000-0000-0000-000000000015','60000000-0000-0000-0000-000000000011',2,'ea',20),
  ('60000000-0000-0000-0000-000000000015','60000000-0000-0000-0000-000000000006',8,'ea',30),
  ('60000000-0000-0000-0000-000000000015','60000000-0000-0000-0000-000000000007',4,'ea',40),
  ('60000000-0000-0000-0000-000000000016','60000000-0000-0000-0000-000000000014',1,'ea',10),
  ('60000000-0000-0000-0000-000000000016','60000000-0000-0000-0000-000000000010',1,'ea',20),
  ('60000000-0000-0000-0000-000000000016','60000000-0000-0000-0000-000000000004',1,'ea',30),
  ('60000000-0000-0000-0000-000000000017','60000000-0000-0000-0000-000000000009',1,'ea',10),
  ('60000000-0000-0000-0000-000000000017','60000000-0000-0000-0000-000000000011',1,'ea',20),
  ('60000000-0000-0000-0000-000000000017','60000000-0000-0000-0000-000000000005',4,'ea',30),
  ('60000000-0000-0000-0000-000000000017','60000000-0000-0000-0000-000000000006',6,'ea',40)
on conflict do nothing;

-- Routings + operations for made parts.
insert into public.routings (id, company_id, part_id, name, description) values
  ('70000000-0000-0000-0000-000000000009','22222222-2222-2222-2222-222222222222','60000000-0000-0000-0000-000000000009','SUB-HOUSING routing','Standard routing'),
  ('70000000-0000-0000-0000-000000000010','22222222-2222-2222-2222-222222222222','60000000-0000-0000-0000-000000000010','SUB-SHAFT routing','Standard routing'),
  ('70000000-0000-0000-0000-000000000011','22222222-2222-2222-2222-222222222222','60000000-0000-0000-0000-000000000011','SUB-COVER routing','Standard routing'),
  ('70000000-0000-0000-0000-000000000012','22222222-2222-2222-2222-222222222222','60000000-0000-0000-0000-000000000012','SUB-BRACKET routing','Standard routing'),
  ('70000000-0000-0000-0000-000000000013','22222222-2222-2222-2222-222222222222','60000000-0000-0000-0000-000000000013','ASM-PUMPCORE routing','Standard routing'),
  ('70000000-0000-0000-0000-000000000014','22222222-2222-2222-2222-222222222222','60000000-0000-0000-0000-000000000014','ASM-GEARBOX routing','Standard routing'),
  ('70000000-0000-0000-0000-000000000015','22222222-2222-2222-2222-222222222222','60000000-0000-0000-0000-000000000015','PROD-PUMP-100 routing','Standard routing'),
  ('70000000-0000-0000-0000-000000000016','22222222-2222-2222-2222-222222222222','60000000-0000-0000-0000-000000000016','PROD-ACTUATOR-200 routing','Standard routing'),
  ('70000000-0000-0000-0000-000000000017','22222222-2222-2222-2222-222222222222','60000000-0000-0000-0000-000000000017','PROD-MANIFOLD-300 routing','Standard routing'),
  ('70000000-0000-0000-0000-000000000018','22222222-2222-2222-2222-222222222222','60000000-0000-0000-0000-000000000018','PROD-RAIL-CUT routing','Standard routing')
on conflict (id) do nothing;

-- routing_operations: internal = setup 15 / cycle 3 / no external price; external (anodize) = 0/0 + external_unit_price 4.5.
--
-- INSTRUCTIONS ARE MOSTLY NULL, ON PURPOSE. Every step used to carry
-- '<WorkCenter> operation' — a string that restates the work center already shown
-- in the operator's header and says nothing. The operation page renders the
-- Instructions box only when the column is non-empty, so junk here made the box
-- appear on EVERY step in every demo and preview, which teaches an operator that
-- the box is noise. They then skip it on the day it says "torque to 40, not 45".
--
-- A handful of steps get real shop instructions and the rest get NULL, so the
-- seed shows both states honestly — and a usability session tells us something
-- about the design rather than about our test data.
insert into public.routing_operations (routing_id, work_center_id, sequence, setup_minutes, cycle_minutes_per_unit, labor_rate_override, external_unit_price, instructions) values
  -- housing: saw, mill, deburr
  ('70000000-0000-0000-0000-000000000009','40000000-0000-0000-0000-000000000001',10,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000009','40000000-0000-0000-0000-000000000002',20,15,3,null,null,'Indicate the fixture to 0.001 before the first bore — the pattern walks otherwise.'),
  ('70000000-0000-0000-0000-000000000009','40000000-0000-0000-0000-000000000004',30,15,3,null,null,null),
  -- shaft: saw, lathe, deburr
  ('70000000-0000-0000-0000-000000000010','40000000-0000-0000-0000-000000000001',10,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000010','40000000-0000-0000-0000-000000000003',20,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000010','40000000-0000-0000-0000-000000000004',30,15,3,null,null,null),
  -- cover: mill, deburr, anodize(external)
  ('70000000-0000-0000-0000-000000000011','40000000-0000-0000-0000-000000000002',10,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000011','40000000-0000-0000-0000-000000000004',20,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000011','40000000-0000-0000-0000-000000000007',30,0,0,null,4.5,'Mask the bore before it goes out. ProFinish will not mask it for us.'),
  -- bracket: mill, deburr
  ('70000000-0000-0000-0000-000000000012','40000000-0000-0000-0000-000000000002',10,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000012','40000000-0000-0000-0000-000000000004',20,15,3,null,null,null),
  -- pumpcore: assembly, inspect
  ('70000000-0000-0000-0000-000000000013','40000000-0000-0000-0000-000000000005',10,15,3,null,null,'Press the bearings with the arbor fixture. Seat fully BEFORE pinning or the shaft binds.'),
  ('70000000-0000-0000-0000-000000000013','40000000-0000-0000-0000-000000000006',20,15,3,null,null,'Seal-face flatness within 0.0005 TIR. Anything over, set it aside — do not rework on the bench.'),
  -- gearbox: assembly, inspect
  ('70000000-0000-0000-0000-000000000014','40000000-0000-0000-0000-000000000005',10,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000014','40000000-0000-0000-0000-000000000006',20,15,3,null,null,null),
  -- pump: assembly, inspect
  ('70000000-0000-0000-0000-000000000015','40000000-0000-0000-0000-000000000005',10,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000015','40000000-0000-0000-0000-000000000006',20,15,3,null,null,null),
  -- actuator: assembly, inspect
  ('70000000-0000-0000-0000-000000000016','40000000-0000-0000-0000-000000000005',10,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000016','40000000-0000-0000-0000-000000000006',20,15,3,null,null,null),
  -- manifold: mill, assembly, inspect
  ('70000000-0000-0000-0000-000000000017','40000000-0000-0000-0000-000000000002',10,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000017','40000000-0000-0000-0000-000000000005',20,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000017','40000000-0000-0000-0000-000000000006',30,15,3,null,null,null),
  -- rail: saw, deburr
  ('70000000-0000-0000-0000-000000000018','40000000-0000-0000-0000-000000000001',10,15,3,null,null,null),
  ('70000000-0000-0000-0000-000000000018','40000000-0000-0000-0000-000000000004',20,15,3,null,null,null)
on conflict do nothing;

-- Pricing tiers for sellable products (sequence 1/2/3…; markup %).
insert into public.part_pricing_tiers (part_id, company_id, sequence, quantity, markup_percent) values
  ('60000000-0000-0000-0000-000000000015','22222222-2222-2222-2222-222222222222',1,1,60),
  ('60000000-0000-0000-0000-000000000015','22222222-2222-2222-2222-222222222222',2,10,50),
  ('60000000-0000-0000-0000-000000000015','22222222-2222-2222-2222-222222222222',3,25,42),
  ('60000000-0000-0000-0000-000000000016','22222222-2222-2222-2222-222222222222',1,1,65),
  ('60000000-0000-0000-0000-000000000016','22222222-2222-2222-2222-222222222222',2,5,55),
  ('60000000-0000-0000-0000-000000000016','22222222-2222-2222-2222-222222222222',3,20,48),
  ('60000000-0000-0000-0000-000000000017','22222222-2222-2222-2222-222222222222',1,1,58),
  ('60000000-0000-0000-0000-000000000017','22222222-2222-2222-2222-222222222222',2,10,47),
  ('60000000-0000-0000-0000-000000000018','22222222-2222-2222-2222-222222222222',1,1,70),
  ('60000000-0000-0000-0000-000000000018','22222222-2222-2222-2222-222222222222',2,36,55)
on conflict do nothing;

-- Every part in a BOM tree needs its own markup to be quotable (each part owns
-- its markup — the company-wide default-rate layer was removed in
-- 20260713011616, and get_priceable_part_ids/compute_part_cost_explain now
-- require a non-null markup_percent). Give the bought parts and sub-assemblies
-- a single default tier so the sellable products above resolve as priceable.
insert into public.part_pricing_tiers (part_id, company_id, sequence, quantity, markup_percent) values
  -- Bought parts (sold on directly at times, and required for tree priceability).
  ('60000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',1,1,35),
  ('60000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222',1,1,35),
  ('60000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222',1,1,35),
  ('60000000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222',1,1,35),
  ('60000000-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222',1,1,40),
  ('60000000-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222',1,1,40),
  ('60000000-0000-0000-0000-000000000007','22222222-2222-2222-2222-222222222222',1,1,40),
  ('60000000-0000-0000-0000-000000000008','22222222-2222-2222-2222-222222222222',1,1,35),
  -- Sub-assemblies / made intermediates.
  ('60000000-0000-0000-0000-000000000009','22222222-2222-2222-2222-222222222222',1,1,45),
  ('60000000-0000-0000-0000-000000000010','22222222-2222-2222-2222-222222222222',1,1,45),
  ('60000000-0000-0000-0000-000000000011','22222222-2222-2222-2222-222222222222',1,1,45),
  ('60000000-0000-0000-0000-000000000012','22222222-2222-2222-2222-222222222222',1,1,45),
  ('60000000-0000-0000-0000-000000000013','22222222-2222-2222-2222-222222222222',1,1,45),
  ('60000000-0000-0000-0000-000000000014','22222222-2222-2222-2222-222222222222',1,1,45)
on conflict do nothing;

-- ── Inventory receipts (one dated addition per stocked part, ~120 days ago) ──
-- Live on-hand is already set on parts.quantity above; these give the ledger a
-- receipt row so the inventory history view isn't empty.
insert into public.inventory_transactions (company_id, part_id, item_name, type, quantity, unit, converted_quantity, notes, created_by, created_at)
select '22222222-2222-2222-2222-222222222222', p.id, p.part_name, 'addition', p.quantity, p.primary_unit, p.quantity,
       'Opening stock receipt', '11111111-1111-1111-1111-111111111111', now() - interval '120 days'
from public.parts p
where p.company_id = '22222222-2222-2222-2222-222222222222'
  and p.is_stocked = true and p.quantity > 0
on conflict do nothing;

-- =============================================================================
-- Transaction graph: quotes → jobs → operations → shipments → notes/invoices.
-- Uses pg_temp helper functions (auto-dropped at session end) so the repeated
-- pricing / RPC / status logic lives in one place and mirrors the app. Quote
-- and job IDs are minted by defaults (not referenced across runs), so only the
-- SQL text is committed — dates are `now()`-relative so data is always current.
-- =============================================================================

-- Resolved pricing tier for an order qty: highest tier whose quantity <= qty,
-- else the lowest tier (mirrors resolveTier in the old seed).
create function pg_temp.resolve_tier(p_part uuid, p_qty numeric)
returns public.part_pricing_tiers language plpgsql stable as $$
declare r public.part_pricing_tiers;
begin
  select * into r from public.part_pricing_tiers
   where part_id = p_part and quantity <= p_qty order by quantity desc limit 1;
  if not found then
    select * into r from public.part_pricing_tiers
     where part_id = p_part order by quantity asc limit 1;
  end if;
  return r;
end $$;

-- pricing_basis_snapshot JSON: every tier's computed price + the resolved tier.
create function pg_temp.snapshot(p_part uuid, p_resolved uuid, p_qty numeric)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'tiers', coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'quantity', t.quantity,
        'unit_price', round(public.compute_part_cost_at_qty(p_part, t.quantity) * (1 + t.markup_percent/100.0), 2),
        'markup_percent', t.markup_percent) order by t.quantity), '[]'::jsonb),
    'resolved_tier_id', p_resolved, 'resolved_quantity', p_qty, 'captured_at', now())
  from public.part_pricing_tiers t
  where t.part_id = p_part and t.markup_percent is not null;
$$;

-- Insert a quote line with tier-resolved (or override) pricing + snapshot.
create function pg_temp.add_quote_line(p_quote uuid, p_part uuid, p_seq int, p_qty numeric, p_override numeric default null)
returns void language plpgsql as $$
declare rt public.part_pricing_tiers; v_unit numeric; v_base numeric;
begin
  rt := pg_temp.resolve_tier(p_part, p_qty);
  v_unit := coalesce(p_override, round(public.compute_part_cost_at_qty(p_part, rt.quantity) * (1 + rt.markup_percent/100.0), 2));
  v_base := round(public.compute_part_cost_at_qty(p_part, p_qty), 2);
  insert into public.quote_line_items (quote_id, company_id, part_id, source_tier_id, sequence, quantity,
    unit_price, total_price, markup_percent, base_cost_per_unit, is_quote_override, pricing_basis_snapshot, basis_unknown, created_at)
  values (p_quote, '22222222-2222-2222-2222-222222222222', p_part, rt.id, p_seq, p_qty,
    v_unit, round(v_unit * p_qty, 2), null, v_base, p_override is not null, pg_temp.snapshot(p_part, rt.id, p_qty), false,
    (select created_at from public.quotes where id = p_quote));
end $$;

-- Insert a job_part and generate its operations from the part's routing (RPC).
create function pg_temp.add_job_part(p_job uuid, p_part uuid, p_seq int, p_qty numeric, p_unit numeric, p_src uuid, p_created timestamptz)
returns uuid language plpgsql as $$
declare v_jp uuid; v_routing uuid;
begin
  insert into public.job_parts (job_id, company_id, part_id, source_quote_line_item_id, sequence, quantity,
    unit_price, total_price, production_status, fulfillment_status, created_at)
  values (p_job, '22222222-2222-2222-2222-222222222222', p_part, p_src, p_seq, p_qty,
    p_unit, round(p_unit * p_qty, 4), 'not_started', 'unshipped', p_created)
  returning id into v_jp;
  select id into v_routing from public.routings where part_id = p_part limit 1;
  if v_routing is not null then
    perform public.create_job_part_operations_from_routing(v_jp, v_routing);
  end if;
  return v_jp;
end $$;

-- Record the completion event behind an advanced operation. Outside
-- (external-vendor) ops are skipped: compute_job_operation_status() returns their
-- stored status untouched because they move through the send/receive lifecycle,
-- so a quantity event there would be meaningless noise. (The seeded routings are
-- all-internal today; the guard keeps this correct if an outside step is added.)
create function pg_temp.record_completion(
  p_op uuid, p_jp uuid, p_qty numeric, p_at timestamptz, p_note text)
returns void language plpgsql as $$
begin
  if exists (
    select 1 from public.job_operations o
    join public.work_centers wc on wc.id = o.work_center_id
    where o.id = p_op and wc.kind = 'external'
  ) then
    return;
  end if;
  insert into public.job_operation_completions
    (company_id, job_operation_id, job_part_id, quantity_good, completed_by, completed_at, created_at, note)
  values ('22222222-2222-2222-2222-222222222222', p_op, p_jp, p_qty,
          '11111111-1111-1111-1111-111111111111', p_at, p_at, p_note);
end $$;

-- Progress a job's parts + operations (job status rolls up via trigger).
--
-- job_operations.status is DERIVED, not authoritative: job_operation_completions
-- is the append-only source of truth and
-- recompute_job_operation_status_from_completion() computes the status from
-- SUM(quantity_good) vs the ordered qty. So every op this helper advances also
-- gets the completion event the app itself would have written. Without it the
-- seed shipped "completed" ops with no history behind them — the operator
-- completion feed was empty, and completeJobOperation() would compute
-- `remaining = quantity - 0` and offer to re-complete the whole order as though
-- the work had never happened.
--
-- ORDERING IS LOAD-BEARING: the status UPDATE comes first, the event second. The
-- recompute trigger only writes when the computed status differs from the stored
-- one, so seeding the status first makes the event a no-op transition and the
-- backdated completed_at / completed_by survive. Insert the event first and the
-- trigger stamps both with now(), flattening the seed's dated history.
create function pg_temp.progress_job(p_job uuid, p_status text, p_anchor int)
returns void language plpgsql as $$
declare jp record; op record; n int; i int; v_at timestamptz;
begin
  for jp in select id, quantity from public.job_parts where job_id = p_job loop
    if p_status = 'cancelled' then
      update public.job_parts set production_status='cancelled', status_changed_at = now() - (p_anchor||' days')::interval where id = jp.id;
      continue;
    end if;
    select count(*) into n from public.job_operations where job_part_id = jp.id;
    i := 0;
    for op in select id from public.job_operations where job_part_id = jp.id order by sequence loop
      i := i + 1;
      if p_status = 'completed' then
        v_at := now() - ((p_anchor + (n - i + 1)*2 - 1)||' days')::interval;
        update public.job_operations set status='completed',
          completed_at = v_at,
          completed_by = '11111111-1111-1111-1111-111111111111' where id = op.id;
        perform pg_temp.record_completion(op.id, jp.id, jp.quantity, v_at, 'Seed: full run complete');
      elsif p_status = 'in_progress' then
        if i = 1 then
          v_at := now() - ((p_anchor+2)||' days')::interval;
          update public.job_operations set status='completed',
            completed_at = v_at,
            completed_by='11111111-1111-1111-1111-111111111111' where id = op.id;
          perform pg_temp.record_completion(op.id, jp.id, jp.quantity, v_at, 'Seed: full run complete');
        elsif i = 2 then
          update public.job_operations set status='in_progress' where id = op.id;
          -- Half the order booked: 0 < good < target is exactly what
          -- compute_job_operation_status() reads back as 'in_progress', so the
          -- derived status agrees with the one set above and the op carries a
          -- real good-piece count for the partial-completion UI to show.
          -- Floor it so a discrete part reads as whole pieces (2 of 5, not 2.5);
          -- only fall back to the raw half when flooring would hit 0 and the
          -- status would collapse to 'pending'.
          perform pg_temp.record_completion(
            op.id, jp.id,
            case when floor(jp.quantity / 2) >= 1 then floor(jp.quantity / 2)
                 else jp.quantity / 2 end,
            now() - ((p_anchor+1)||' days')::interval, 'Seed: partial run');
        end if;
      end if;
    end loop;
    if p_status = 'completed' then
      update public.job_parts set production_status='completed',
        started_at = now() - ((p_anchor + n*2)||' days')::interval, completed_at = now() - (p_anchor||' days')::interval,
        status_changed_at = now() - (p_anchor||' days')::interval where id = jp.id;
    elsif p_status = 'in_progress' then
      update public.job_parts set production_status='in_progress',
        started_at = now() - ((p_anchor+3)||' days')::interval, status_changed_at = now() - ((p_anchor+1)||' days')::interval where id = jp.id;
    end if;
  end loop;
end $$;

-- Issue stocked BOM children to a job (depletion ledger + on-hand decrement).
create function pg_temp.deplete_job(p_job uuid, p_when int)
returns void language plpgsql as $$
declare jp record; e record; v_num text; used numeric;
begin
  select job_number into v_num from public.jobs where id = p_job;
  for jp in select id, part_id, quantity from public.job_parts where job_id = p_job loop
    for e in select b.child_part_id, b.quantity q, b.unit, p.part_name, p.is_stocked
             from public.parts_bom b join public.parts p on p.id = b.child_part_id
             where b.parent_part_id = jp.part_id loop
      if not e.is_stocked then continue; end if;
      used := e.q * jp.quantity;
      insert into public.inventory_transactions (company_id, part_id, item_name, type, quantity, unit, converted_quantity, job_id, notes, created_by, created_at)
      values ('22222222-2222-2222-2222-222222222222', e.child_part_id, e.part_name, 'depletion', used, e.unit, used, p_job,
              'Issued to '||v_num, '11111111-1111-1111-1111-111111111111', now() - (p_when||' days')::interval);
      -- Decrement the BALANCE, not `parts.quantity`. As of 20260802015837 that column is
      -- maintained solely by `recompute_part_quantity_from_locations`, and a direct write
      -- raises — which is the point: the seed now has to move stock the way the app does.
      -- Everything is still in Unassigned at this stage; the put-away block runs later.
      -- Split, because `part_location_stock` now CHECKs `quantity > 0` (20260802144310): a bin
      -- emptied by consumption loses its row rather than parking a zero there. `greatest(0, ...)`
      -- used to leave exactly that residue, and is where four of the seed's zero rows came from.
      delete from public.part_location_stock s
       using public.inventory_locations l
       where s.part_id = e.child_part_id
         and s.location_id = l.id
         and l.company_id = '22222222-2222-2222-2222-222222222222'
         and l.kind = 'system'
         and s.quantity <= used;
      update public.part_location_stock s
         set quantity = s.quantity - used
        from public.inventory_locations l
       where s.part_id = e.child_part_id
         and s.location_id = l.id
         and l.company_id = '22222222-2222-2222-2222-222222222222'
         and l.kind = 'system'
         and s.quantity > used;
    end loop;
  end loop;
end $$;

-- Ship a job (packing slip + line items; fulfillment cascades via trigger).
create function pg_temp.ship_job(p_job uuid, p_customer uuid, p_fraction numeric, p_days int, p_voided boolean default false)
returns void language plpgsql as $$
declare v_ship uuid; v_num text; v_base text; v_n int; jp record; v_ship_addr uuid;
begin
  select job_number into v_num from public.jobs where id = p_job;
  v_base := regexp_replace(v_num, '^[A-Za-z]+-', '');
  select count(*) into v_n from public.shipments where job_id = p_job;
  select id into v_ship_addr from public.customer_addresses where customer_id = p_customer and default_shipping limit 1;
  insert into public.shipments (company_id, customer_id, shipping_address_id, packing_slip_number, ship_date, carrier, shipping_method, job_id, created_by, created_at)
  values ('22222222-2222-2222-2222-222222222222', p_customer, v_ship_addr, 'PS-'||v_base||'-'||(v_n+1),
          (now() - (p_days||' days')::interval)::date, 'UPS Ground', 'shipment', p_job, '11111111-1111-1111-1111-111111111111', now() - (p_days||' days')::interval)
  returning id into v_ship;
  for jp in select id, quantity from public.job_parts where job_id = p_job loop
    insert into public.shipment_line_items (shipment_id, job_part_id, quantity)
    values (v_ship, jp.id, case when p_fraction >= 1 then jp.quantity else greatest(round(jp.quantity * p_fraction, 2), 1) end);
  end loop;
  if p_voided then
    update public.shipments set voided_at = now() - ((p_days-1)||' days')::interval, voided_by = '11111111-1111-1111-1111-111111111111' where id = v_ship;
  end if;
end $$;

-- Job-level note: genuinely about this run, so subject_kind stays 'job'.
create function pg_temp.add_note(p_job uuid, p_body text, p_type text, p_days int)
returns void language plpgsql as $$
begin
  insert into public.notes (company_id, subject_kind, job_id, author_id, body, note_type, created_at)
  values ('22222222-2222-2222-2222-222222222222', 'job', p_job, '23000000-0000-0000-0000-000000000001', p_body, p_type, now() - (p_days||' days')::interval);
end $$;

-- Step note captured on the floor. Mirrors what addJobNote() does in the app: if
-- the job's step has a routing link, the note's SUBJECT is the durable
-- (part, routing step) and the job is recorded only as provenance — so the next
-- run of this part surfaces it with no prior-job traversal. Falls back to a
-- job-subject note for an ad-hoc step with no routing link.
--
-- Keeping the seed on the same branch as the app matters: E2E specs assert
-- against this shape, and a seed that only ever wrote job-subject notes would
-- leave the durable read-back path untested.
create function pg_temp.add_op_note(p_job uuid, p_seq int, p_author uuid, p_body text, p_days int)
returns void language plpgsql as $$
declare v_jp uuid; v_op uuid; v_part uuid; v_ro uuid;
begin
  select id, part_id into v_jp, v_part
    from public.job_parts where job_id = p_job order by sequence limit 1;
  select id, routing_operation_id into v_op, v_ro
    from public.job_operations where job_part_id = v_jp and sequence = p_seq limit 1;

  if v_ro is not null and v_part is not null then
    insert into public.notes (company_id, subject_kind, part_id, routing_operation_id,
                              captured_job_id, captured_job_operation_id,
                              author_id, body, note_type, created_at)
    values ('22222222-2222-2222-2222-222222222222', 'part', v_part, v_ro,
            p_job, v_op, p_author, p_body, 'user', now() - (p_days||' days')::interval);
  else
    insert into public.notes (company_id, subject_kind, job_id, job_part_id, job_operation_id,
                              author_id, body, note_type, created_at)
    values ('22222222-2222-2222-2222-222222222222', 'job', p_job, v_jp, v_op,
            p_author, p_body, 'user', now() - (p_days||' days')::interval);
  end if;
end $$;

create function pg_temp.add_invoice(p_job uuid, p_quote uuid, p_doc text, p_days int)
returns void language plpgsql as $$
begin
  insert into public.quickbooks_invoice_links (company_id, job_id, quote_id, realm_id, qb_request_id, qb_invoice_id, qb_invoice_doc_number, qb_invoice_url, status, created_at)
  values ('22222222-2222-2222-2222-222222222222', p_job, p_quote, '9130350000000000', gen_random_uuid(),
          'INV-'||p_doc, p_doc, 'https://app.qbo.intuit.com/app/invoice?txnId='||p_doc, 'created', now() - (p_days||' days')::interval);
end $$;

-- Convenience: create a quote for a customer (addresses/contact looked up),
-- returning its id. quote_number is filled by the set_quote_number trigger.
create function pg_temp.new_quote(p_customer uuid, p_created int, p_status text, p_exp int, p_lead int)
returns uuid language plpgsql as $$
declare v_id uuid; v_bill uuid; v_ship uuid; v_contact uuid; v_created timestamptz;
begin
  select id into v_bill from public.customer_addresses where customer_id = p_customer and default_billing limit 1;
  select id into v_ship from public.customer_addresses where customer_id = p_customer and default_shipping limit 1;
  select id into v_contact from public.customer_contacts where customer_id = p_customer and is_primary limit 1;
  v_created := now() - (p_created||' days')::interval;
  insert into public.quotes (company_id, quote_number, customer_id, billing_address_id, shipping_address_id, contact_id,
    status, lead_time_text, payment_terms, expiration_date, created_by, created_at, status_changed_at)
  values ('22222222-2222-2222-2222-222222222222', '', p_customer, v_bill, v_ship, v_contact,
    p_status, p_lead || ' days', 'Net 30', (now() + (p_exp||' days')::interval)::date,
    '11111111-1111-1111-1111-111111111111', v_created, v_created)
  returning id into v_id;
  return v_id;
end $$;

-- ── Scenario 1: Northwind — pump x10 — converted → completed → shipped → invoiced
do $$
declare q uuid; j uuid; v_num text; v_created timestamptz;
begin
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000001', 178, 'active', 30, 21);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000015', 10, 10);
  select quote_number into v_num from public.quotes where id = q;
  v_created := now() - interval '172 days';
  insert into public.jobs (company_id, quote_id, customer_id, job_number, production_status, fulfillment_status, due_date, customer_po_number, billing_address_id, shipping_address_id, contact_id, created_by, created_at)
  select '22222222-2222-2222-2222-222222222222', q, '50000000-0000-0000-0000-000000000001', replace(v_num,'Q-','J-'), 'not_started', 'unshipped',
         (now() - interval '130 days')::date, 'PO-NW-44120', billing_address_id, shipping_address_id, contact_id, '11111111-1111-1111-1111-111111111111', v_created
  from public.quotes where id = q
  returning id into j;
  perform pg_temp.add_job_part(j, ql.part_id, 10, ql.quantity, ql.unit_price, ql.id, v_created)
  from public.quote_line_items ql where ql.quote_id = q;
  update public.quotes set converted_at = v_created, status_changed_at = v_created where id = q;
  perform pg_temp.progress_job(j, 'completed', 150);
  perform pg_temp.deplete_job(j, 158);
  perform pg_temp.ship_job(j, '50000000-0000-0000-0000-000000000001', 1, 148);
  perform pg_temp.add_invoice(j, q, '1001', 147);
  perform pg_temp.add_note(j, 'First article approved by customer QA. Released full lot.', 'user', 165);
  perform pg_temp.add_note(j, 'Lot complete, packed and shipped via UPS.', 'user', 148);
  -- Step-tagged operator notes (Diego = Assembly, Priya = Inspection) so a later
  -- pump job's operator sees "Previous notes" for this part, scoped to the step.
  perform pg_temp.add_op_note(j, 10, '23000000-0000-0000-0000-000000000005',
    'Press the bearings in with the arbor fixture — seat fully before pinning or the shaft binds.', 160);
  perform pg_temp.add_op_note(j, 20, '23000000-0000-0000-0000-000000000006',
    'Final inspection: seal-face flatness within 0.0005 TIR. Clean lot, no rework.', 152);
end $$;

-- ── Standalone quotes (active + expired) to exercise the quotes list ──────────
do $$
declare q uuid;
begin
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000005', 9, 'active', 21, 21);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000017', 10, 10);

  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000003', 120, 'expired', -30, 35);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000015', 50, 50);
end $$;

-- Convert a quote to a job (job_parts from the quote lines + ops via RPC).
create function pg_temp.convert_job(p_quote uuid, p_po text, p_due int, p_created int)
returns uuid language plpgsql as $$
declare v_job uuid; v_num text; v_created timestamptz; ql record;
begin
  v_created := now() - (p_created||' days')::interval;
  select 'J-'||regexp_replace(quote_number,'^Q-','') into v_num from public.quotes where id = p_quote;
  insert into public.jobs (company_id, quote_id, customer_id, job_number, production_status, fulfillment_status, due_date, customer_po_number, billing_address_id, shipping_address_id, contact_id, created_by, created_at)
  select '22222222-2222-2222-2222-222222222222', p_quote, customer_id, v_num, 'not_started', 'unshipped',
         (now() + (p_due||' days')::interval)::date, p_po, billing_address_id, shipping_address_id, contact_id, '11111111-1111-1111-1111-111111111111', v_created
  from public.quotes where id = p_quote
  returning id into v_job;
  for ql in select id, part_id, quantity, unit_price, sequence from public.quote_line_items where quote_id = p_quote order by sequence loop
    perform pg_temp.add_job_part(v_job, ql.part_id, ql.sequence, ql.quantity, ql.unit_price, ql.id, v_created);
  end loop;
  update public.quotes set converted_at = v_created, status_changed_at = v_created where id = p_quote;
  return v_job;
end $$;

-- Create a direct (no-quote) job; caller adds job_parts explicitly.
create function pg_temp.direct_job(p_customer uuid, p_po text, p_due int, p_created int)
returns uuid language plpgsql as $$
declare v_job uuid; v_num text; v_created timestamptz; v_bill uuid; v_ship uuid; v_contact uuid;
begin
  v_created := now() - (p_created||' days')::interval;
  select public.generate_direct_job_number('22222222-2222-2222-2222-222222222222') into v_num;
  select id into v_bill from public.customer_addresses where customer_id = p_customer and default_billing limit 1;
  select id into v_ship from public.customer_addresses where customer_id = p_customer and default_shipping limit 1;
  select id into v_contact from public.customer_contacts where customer_id = p_customer and is_primary limit 1;
  insert into public.jobs (company_id, quote_id, customer_id, job_number, production_status, fulfillment_status, due_date, customer_po_number, billing_address_id, shipping_address_id, contact_id, created_by, created_at)
  values ('22222222-2222-2222-2222-222222222222', null, p_customer, v_num, 'not_started', 'unshipped', (now() + (p_due||' days')::interval)::date, p_po, v_bill, v_ship, v_contact, '11111111-1111-1111-1111-111111111111', v_created)
  returning id into v_job;
  return v_job;
end $$;

-- ── Scenario 2: Meridian — manifold x25 — completed → shipped → invoiced ──────
do $$ declare q uuid; j uuid; begin
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000003', 140, 'active', 30, 28);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000017', 10, 25);
  j := pg_temp.convert_job(q, 'PO-MER-7781', -60, 134);
  perform pg_temp.progress_job(j, 'completed', 90);
  perform pg_temp.deplete_job(j, 100);
  perform pg_temp.ship_job(j, '50000000-0000-0000-0000-000000000003', 1, 88);
  perform pg_temp.add_invoice(j, q, '1002', 86);
  perform pg_temp.add_note(j, 'Anodize batch returned from ProFinish, within spec.', 'user', 96);
  perform pg_temp.add_op_note(j, 10, '23000000-0000-0000-0000-000000000005',
    'Manifold: indicate the fixture to 0.001 before the first bore — the pattern walks otherwise.', 100);
end $$;

-- ── Scenario 3: Cascade — actuator x20 — in_progress → partial ship ───────────
do $$ declare q uuid; j uuid; begin
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000002', 60, 'active', 30, 21);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000016', 10, 20);
  j := pg_temp.convert_job(q, 'PO-CAS-2207', 12, 52);
  perform pg_temp.progress_job(j, 'in_progress', 20);
  perform pg_temp.deplete_job(j, 18);
  perform pg_temp.ship_job(j, '50000000-0000-0000-0000-000000000002', 0.5, 8);
  perform pg_temp.add_note(j, 'Customer requested 10 ship early; partial slip cut.', 'user', 8);
end $$;

-- ── Scenario 4: Sierra — pump x10 + manifold x5 — in_progress ─────────────────
do $$ declare q uuid; j uuid; begin
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000006', 40, 'active', 30, 30);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000015', 10, 10);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000017', 20, 5);
  j := pg_temp.convert_job(q, 'PO-SPV-9912', 25, 33);
  perform pg_temp.progress_job(j, 'in_progress', 10);
  perform pg_temp.deplete_job(j, 9);
  perform pg_temp.add_note(j, 'Housing op running on the Haas, on schedule.', 'user', 6);
end $$;

-- ── Scenario 5: Granite — actuator x5 — not_started ──────────────────────────
do $$ declare q uuid; j uuid; begin
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000004', 18, 'active', 30, 21);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000016', 10, 5);
  j := pg_temp.convert_job(q, 'PO-GRA-330', 30, 12);
  perform pg_temp.add_note(j, 'Released to the floor; awaiting saw availability.', 'event', 12);
end $$;

-- ── Scenario 6: BlueRidge — pump x2 — cancelled ──────────────────────────────
do $$ declare q uuid; j uuid; begin
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000005', 70, 'active', 30, 14);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000015', 10, 2);
  j := pg_temp.convert_job(q, 'PO-BR-5521', -10, 64);
  perform pg_temp.progress_job(j, 'cancelled', 50);
  perform pg_temp.add_note(j, 'Customer cancelled order; design change on their end.', 'user', 50);
end $$;

-- ── Scenario 7: Granite — DIRECT rail x48.5 — completed → shipped ────────────
do $$ declare j uuid; begin
  j := pg_temp.direct_job('50000000-0000-0000-0000-000000000004', 'PO-GRA-401', -40, 95);
  perform pg_temp.add_job_part(j, '60000000-0000-0000-0000-000000000018', 10, 48.5, 71.4, null, now() - interval '95 days');
  perform pg_temp.progress_job(j, 'completed', 70);
  perform pg_temp.ship_job(j, '50000000-0000-0000-0000-000000000004', 1, 66);
  perform pg_temp.add_note(j, 'Cut to 48.5 in per print, deburred and shipped.', 'user', 66);
end $$;

-- ── Scenario 8: Cascade — DIRECT pump x4 — in_progress → voided ship ─────────
do $$ declare j uuid; begin
  j := pg_temp.direct_job('50000000-0000-0000-0000-000000000002', 'PO-CAS-2250', 20, 25);
  perform pg_temp.add_job_part(j, '60000000-0000-0000-0000-000000000015', 10, 4, 540, null, now() - interval '25 days');
  perform pg_temp.progress_job(j, 'in_progress', 8);
  perform pg_temp.deplete_job(j, 7);
  perform pg_temp.ship_job(j, '50000000-0000-0000-0000-000000000002', 0.5, 4, true);
  perform pg_temp.add_note(j, 'Slip voided — wrong carrier selected, re-cutting.', 'event', 3);
end $$;

-- ── Remaining standalone quotes (active opportunities + expired + price drift) ─
do $$ declare q uuid; begin
  -- Sierra: actuator x12 + pump x6 (active)
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000006', 5, 'active', 28, 28);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000016', 10, 12);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000015', 20, 6);
  -- Northwind: pump x3, custom-price override 525 (active)
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000001', 14, 'active', 30, 14);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000015', 10, 3, 525);
  -- Granite: manifold x8 (expired)
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000004', 100, 'expired', -20, 21);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000017', 10, 8);
  -- Cascade: actuator x8 (active), then bump the actuator tier markup so the
  -- quote detail page shows PRICE DRIFT (live tier price > snapshot).
  q := pg_temp.new_quote('50000000-0000-0000-0000-000000000002', 7, 'active', 30, 21);
  perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000016', 10, 8);
  update public.part_pricing_tiers set markup_percent = 72
   where part_id = '60000000-0000-0000-0000-000000000016' and quantity >= 5;
end $$;

-- ═══ The read-back loop: who has actually read these notes ═══════════════════
-- A note means nothing until somebody reads it, so the seed logs reads. Without
-- these rows every note renders 0 views, the login banner never fires, and
-- My Work looks like a feature that does not work — which is exactly how the
-- seeded app presented before this block existed.
--
-- Inserted directly rather than through log_note_views(): that RPC derives the
-- viewer from auth.uid(), which has no meaning in a seed. The counter trigger on
-- note_views still fires, so notes.viewer_count / usage_count are maintained by
-- the same code path the app uses — nothing here hand-sets a counter.
--
-- Two rules the app enforces in SQL that the seed must not break: a view is
-- never logged for the note's own author, and there is one row per
-- (note, viewer, job).
do $$
declare
  v_co   uuid := '22222222-2222-2222-2222-222222222222';
  v_pool uuid[] := array[
    '23000000-0000-0000-0000-000000000005',   -- Diego Alvarez  (operator)
    '23000000-0000-0000-0000-000000000006',   -- Priya Nair     (operator)
    '23000000-0000-0000-0000-000000000003',   -- Sam Carter     (user)
    '23000000-0000-0000-0000-000000000004'    -- Jamie Lin      (user)
  ];
  n        record;
  v_reader uuid;
  v_take   int;
  i        int;
begin
  for n in
    select id, author_id, coalesce(job_id, captured_job_id) as ctx_job,
           (row_number() over (order by created_at, id))::int as rn
    from public.notes
    where company_id = v_co and note_type = 'user' and author_id is not null
  loop
    -- 0, 1, 2 or 3 readers, rotating. Every fourth note is left unread on
    -- purpose: a seed in which everything has been read hides the zero state,
    -- and the zero state is the one a real operator sees most often.
    v_take := n.rn % 4;
    for i in 1 .. v_take loop
      v_reader := v_pool[1 + ((n.rn + i) % array_length(v_pool, 1))];
      continue when v_reader = n.author_id;
      -- Kept within a few hours of now so the reads land inside the current
      -- ISO week and the login banner ("N people used your notes this week")
      -- actually appears. Read times are never displayed anywhere — by design —
      -- so the spread is only here to avoid a wall of identical timestamps.
      insert into public.note_views (company_id, note_id, viewer_id, job_id, created_at)
      values (v_co, n.id, v_reader, n.ctx_job, now() - ((n.rn % 4) || ' hours')::interval)
      on conflict do nothing;
    end loop;
  end loop;
end $$;

-- One note consulted across several jobs — the load-bearing signal, and the only
-- way usage_count is ever non-zero. Deliberately uses the durable part-subject
-- notes, because those are the ones a later run of the same part surfaces
-- without any prior-job traversal. This is the whole thesis in one query: the
-- knowledge outlived the job it was written on.
do $$
declare
  v_co uuid := '22222222-2222-2222-2222-222222222222';
  n record;
  j record;
  v_reader uuid;
begin
  for n in
    select id, author_id, part_id, captured_job_id
    from public.notes
    where company_id = v_co and subject_kind = 'part' and note_type = 'user'
      and part_id is not null
  loop
    -- Anyone but the author; the two operators cover each other's notes.
    v_reader := case
      when n.author_id = '23000000-0000-0000-0000-000000000006'
        then '23000000-0000-0000-0000-000000000005'
      else '23000000-0000-0000-0000-000000000006'
    end;
    for j in
      select distinct jp.job_id
      from public.job_parts jp
      where jp.part_id = n.part_id
        and jp.job_id is distinct from n.captured_job_id
      order by jp.job_id
      limit 3
    loop
      insert into public.note_views (company_id, note_id, viewer_id, job_id, created_at)
      values (v_co, n.id, v_reader, j.job_id, now() - interval '2 hours')
      on conflict do nothing;
    end loop;
  end loop;
end $$;

-- ═══ Endorsements ════════════════════════════════════════════════════════════
-- The voluntary half of the loop. Without these every note reads as unendorsed
-- and the thumbs-up looks like a feature nobody uses — the same reason the seed
-- logs reads above.
--
-- Two rules the app enforces in SQL and the seed must not break: never your own
-- note (self-endorsement is noise, and the INSERT policy refuses it), and one row
-- per (note, reactor, kind).
--
-- Only 'helpful' is written. 'confirmed' remains in the CHECK constraint with no
-- UI and nothing that writes it; seeding it would put rows on screen that no
-- operator could have produced.
do $$
declare
  v_co   uuid := '22222222-2222-2222-2222-222222222222';
  v_pool uuid[] := array[
    '23000000-0000-0000-0000-000000000005',   -- Diego Alvarez  (operator)
    '23000000-0000-0000-0000-000000000006',   -- Priya Nair     (operator)
    '23000000-0000-0000-0000-000000000003'    -- Sam Carter     (user)
  ];
  n        record;
  v_reactor uuid;
  v_take   int;
  i        int;
begin
  for n in
    select id, author_id,
           (row_number() over (order by created_at, id))::int as rn
    from public.notes
    where company_id = v_co and note_type = 'user' and author_id is not null
  loop
    -- Endorsement is rarer than reading, and deliberately so: most notes carry
    -- none. A seed where everything is endorsed would make the signal worthless
    -- and hide the ordinary state.
    v_take := case when n.rn % 3 = 0 then 2 when n.rn % 3 = 1 then 1 else 0 end;
    for i in 1 .. v_take loop
      v_reactor := v_pool[1 + ((n.rn + i) % array_length(v_pool, 1))];
      continue when v_reactor = n.author_id;
      insert into public.note_reactions (company_id, note_id, reactor_id, kind, created_at)
      values (v_co, n.id, v_reactor, 'helpful', now() - ((n.rn % 6) || ' days')::interval)
      on conflict do nothing;
    end loop;
  end loop;
end $$;

-- The durable part-subject notes are the ones people actually consult on a later
-- run, so endorsement follows reading: give each at least one. The rotation above
-- is a modulo lottery and left both of them at zero, which would have made the
-- read-back surface — the Playbook and "previous notes" — look like the one place
-- nobody found anything useful.
do $$
declare
  v_co uuid := '22222222-2222-2222-2222-222222222222';
  n record;
  v_reactor uuid;
begin
  for n in
    select id, author_id
    from public.notes
    where company_id = v_co and subject_kind = 'part' and note_type = 'user'
      and author_id is not null
  loop
    -- Anyone but the author; the two operators cover each other's notes.
    v_reactor := case
      when n.author_id = '23000000-0000-0000-0000-000000000006'
        then '23000000-0000-0000-0000-000000000005'
      else '23000000-0000-0000-0000-000000000006'
    end;
    insert into public.note_reactions (company_id, note_id, reactor_id, kind, created_at)
    values (v_co, n.id, v_reactor, 'helpful', now() - interval '3 days')
    on conflict do nothing;
  end loop;
end $$;


-- =============================================================================
-- Volume: a shop mid-year, not a demo with four jobs.
--
-- The eight scenarios above each exist to make ONE path reachable by hand — a
-- voided shipment, a credit hold, a cancelled job, a fractional direct job. They
-- are deliberate and hand-written. What they do not give you is a shop: four
-- open jobs and three shipped ones make every list fit on one screen, every
-- total look like a rounding error, and half the surfaces impossible to judge
-- (does the jobs list sort sensibly? does the revenue trend have a shape? is
-- the dashboard's money legible at four figures or six?).
--
-- This block is the bulk, generated from a table rather than written out, so
-- adding a row is one line. Nothing here is load-bearing for a specific
-- feature — delete any row and only the volume changes.
--
-- Two things it fixes beyond count:
--
--   OVERDUE WORK EXISTS. There was none, so the Overdue tile, the jobs list's
--   overdue filter and the alert tone were all unreachable without editing a
--   due date by hand. Dates stay `now()`-relative, so these are permanently and
--   INTENTIONALLY late rather than drifting there.
--
--   HISTORY IS BACKDATED. Every seeded job used to carry updated_at = the seed
--   run, because that is what the row was last written. The dashboard's
--   Completed card buckets on updated_at, so all-time revenue landed in "this
--   week" and the Today / This Week toggle could not differ. Each job below is
--   stamped to when it actually last moved.
-- =============================================================================

do $$
declare
  s record;
  rt public.part_pricing_tiers;
  q uuid;
  j uuid;
  v_ship_at int;
  v_unit numeric;
begin
  for s in
    select * from (values
      -- customer, part, qty, due(+future/-late), created, status, ship, last_moved, po
      -- ── Overdue: late, unshipped, both production states, 1 to 34 days over ──
      ('50000000-0000-0000-0000-000000000001'::uuid,'60000000-0000-0000-0000-000000000015'::uuid, 6::numeric,  -3, 41,'in_progress',0::numeric, 4,'PO-NW-44231'),
      ('50000000-0000-0000-0000-000000000003'::uuid,'60000000-0000-0000-0000-000000000017'::uuid,12::numeric,  -1, 24,'not_started',0::numeric,21,'PO-MER-7781'),
      ('50000000-0000-0000-0000-000000000002'::uuid,'60000000-0000-0000-0000-000000000016'::uuid, 8::numeric, -12, 58,'in_progress',0::numeric, 9,'PO-CR-3390'),
      ('50000000-0000-0000-0000-000000000004'::uuid,'60000000-0000-0000-0000-000000000018'::uuid,96::numeric, -22, 66,'not_started',0::numeric,60,'PO-GRA-1188'),
      ('50000000-0000-0000-0000-000000000006'::uuid,'60000000-0000-0000-0000-000000000015'::uuid, 4::numeric,  -6, 35,'in_progress',0::numeric, 7,'PO-SPV-2044'),
      ('50000000-0000-0000-0000-000000000007'::uuid,'60000000-0000-0000-0000-000000000017'::uuid,15::numeric, -34, 79,'not_started',0::numeric,72,'PO-IRN-5510'),

      -- ── On time and open: the healthy majority ───────────────────────────────
      ('50000000-0000-0000-0000-000000000008'::uuid,'60000000-0000-0000-0000-000000000016'::uuid,10::numeric,   4, 18,'in_progress',0::numeric, 2,'PO-SUM-0912'),
      ('50000000-0000-0000-0000-000000000009'::uuid,'60000000-0000-0000-0000-000000000015'::uuid,20::numeric,  11, 26,'in_progress',0::numeric, 3,'PO-DMS-4417'),
      ('50000000-0000-0000-0000-000000000001'::uuid,'60000000-0000-0000-0000-000000000017'::uuid, 8::numeric,  17, 12,'not_started',0::numeric,12,'PO-NW-44248'),
      ('50000000-0000-0000-0000-000000000002'::uuid,'60000000-0000-0000-0000-000000000018'::uuid,48::numeric,  23, 9,'not_started',0::numeric, 9,'PO-CR-3402'),
      ('50000000-0000-0000-0000-000000000005'::uuid,'60000000-0000-0000-0000-000000000016'::uuid, 5::numeric,  30, 7,'not_started',0::numeric, 7,'PO-BRM-8801'),
      ('50000000-0000-0000-0000-000000000003'::uuid,'60000000-0000-0000-0000-000000000014'::uuid, 3::numeric,  38, 5,'not_started',0::numeric, 5,'PO-MER-7802'),
      ('50000000-0000-0000-0000-000000000008'::uuid,'60000000-0000-0000-0000-000000000015'::uuid,14::numeric,  45, 4,'not_started',0::numeric, 4,'PO-SUM-0925'),

      -- ── Shipped, spread across the year so a revenue trend has a shape ───────
      ('50000000-0000-0000-0000-000000000001'::uuid,'60000000-0000-0000-0000-000000000015'::uuid,12::numeric, -140,158,'completed',1::numeric,141,'PO-NW-43880'),
      ('50000000-0000-0000-0000-000000000003'::uuid,'60000000-0000-0000-0000-000000000017'::uuid,30::numeric, -118,134,'completed',1::numeric,119,'PO-MER-7602'),
      ('50000000-0000-0000-0000-000000000002'::uuid,'60000000-0000-0000-0000-000000000016'::uuid,16::numeric,  -96,112,'completed',1::numeric, 97,'PO-CR-3201'),
      ('50000000-0000-0000-0000-000000000009'::uuid,'60000000-0000-0000-0000-000000000015'::uuid, 8::numeric,  -82, 97,'completed',1::numeric, 83,'PO-DMS-4302'),
      ('50000000-0000-0000-0000-000000000004'::uuid,'60000000-0000-0000-0000-000000000018'::uuid,120::numeric, -74, 88,'completed',1::numeric, 75,'PO-GRA-1102'),
      ('50000000-0000-0000-0000-000000000006'::uuid,'60000000-0000-0000-0000-000000000017'::uuid,22::numeric,  -61, 74,'completed',1::numeric, 62,'PO-SPV-1988'),
      ('50000000-0000-0000-0000-000000000007'::uuid,'60000000-0000-0000-0000-000000000015'::uuid, 9::numeric,  -47, 60,'completed',1::numeric, 48,'PO-IRN-5402'),
      ('50000000-0000-0000-0000-000000000005'::uuid,'60000000-0000-0000-0000-000000000016'::uuid, 6::numeric,  -33, 45,'completed',1::numeric, 34,'PO-BRM-8702'),
      ('50000000-0000-0000-0000-000000000008'::uuid,'60000000-0000-0000-0000-000000000017'::uuid,18::numeric,  -19, 31,'completed',1::numeric, 20,'PO-SUM-0844'),
      ('50000000-0000-0000-0000-000000000002'::uuid,'60000000-0000-0000-0000-000000000015'::uuid,10::numeric,  -11, 22,'completed',1::numeric, 12,'PO-CR-3355'),
      ('50000000-0000-0000-0000-000000000001'::uuid,'60000000-0000-0000-0000-000000000016'::uuid, 7::numeric,   -5, 16,'completed',1::numeric,  5,'PO-NW-44190'),
      -- Two inside the current week, so Completed and its delta are non-zero and
      -- Today / This Week actually differ.
      ('50000000-0000-0000-0000-000000000003'::uuid,'60000000-0000-0000-0000-000000000015'::uuid,11::numeric,   -2, 13,'completed',1::numeric,  2,'PO-MER-7790'),
      ('50000000-0000-0000-0000-000000000009'::uuid,'60000000-0000-0000-0000-000000000017'::uuid, 9::numeric,   -1, 10,'completed',1::numeric,  0,'PO-DMS-4460'),

      -- ── Part-shipped, so partially_shipped is not a one-off ──────────────────
      ('50000000-0000-0000-0000-000000000006'::uuid,'60000000-0000-0000-0000-000000000016'::uuid,24::numeric,   6, 29,'in_progress',0.5::numeric, 6,'PO-SPV-2051'),
      ('50000000-0000-0000-0000-000000000007'::uuid,'60000000-0000-0000-0000-000000000015'::uuid,16::numeric,  -8, 37,'in_progress',0.5::numeric, 9,'PO-IRN-5488')
    ) as t(customer, part, qty, due_days, created_days, status, ship_fraction, moved_days, po)
  loop
    -- Ironclad and Delta Marine send a PO without asking for a quote first, so
    -- their jobs have no quote_id at all. Not a curiosity: 37 of 128 jobs in
    -- production have none, and a job that never had a quote is the case every
    -- quote-derived read has to survive.
    if s.customer in ('50000000-0000-0000-0000-000000000007',
                      '50000000-0000-0000-0000-000000000009') then
      j := pg_temp.direct_job(s.customer, s.po, s.due_days, s.created_days);
      rt := pg_temp.resolve_tier(s.part, s.qty);
      v_unit := round(public.compute_part_cost_at_qty(s.part, rt.quantity)
                      * (1 + rt.markup_percent / 100.0), 2);
      perform pg_temp.add_job_part(j, s.part, 10, s.qty, v_unit, null,
                                   now() - (s.created_days||' days')::interval);
    else
      -- Quoted a week before the job, on the terms the rest of the seed uses.
      q := pg_temp.new_quote(s.customer, s.created_days + 7, 'active', 30, 21);
      perform pg_temp.add_quote_line(q, s.part, 10, s.qty);
      j := pg_temp.convert_job(q, s.po, s.due_days, s.created_days);
    end if;

    if s.status <> 'not_started' then
      -- Anchor the run a few days after the job opened; progress_job walks the
      -- operations backwards from there.
      perform pg_temp.progress_job(j, s.status, greatest(s.created_days - 6, 1));
    end if;

    if s.ship_fraction > 0 then
      v_ship_at := greatest(s.moved_days, 1);
      perform pg_temp.deplete_job(j, least(s.created_days - 2, v_ship_at + 3));
      perform pg_temp.ship_job(j, s.customer, s.ship_fraction, v_ship_at);
    end if;

  end loop;
end $$;



-- ── More quotes, so the pipeline is not six rows ─────────────────────────────
-- A mix of live opportunities and expired ones, on parts and customers that
-- already exist. Two carry a second line so multi-line quotes are represented.
do $$
declare
  s record;
  q uuid;
begin
  for s in
    select * from (values
      ('50000000-0000-0000-0000-000000000007'::uuid,'60000000-0000-0000-0000-000000000015'::uuid,18::numeric,'active',  3, 24),
      ('50000000-0000-0000-0000-000000000008'::uuid,'60000000-0000-0000-0000-000000000017'::uuid,40::numeric,'active',  6, 30),
      ('50000000-0000-0000-0000-000000000009'::uuid,'60000000-0000-0000-0000-000000000016'::uuid,12::numeric,'active', 11, 19),
      ('50000000-0000-0000-0000-000000000001'::uuid,'60000000-0000-0000-0000-000000000018'::uuid,240::numeric,'active',14, 16),
      ('50000000-0000-0000-0000-000000000002'::uuid,'60000000-0000-0000-0000-000000000014'::uuid, 5::numeric,'active', 18, 45),
      ('50000000-0000-0000-0000-000000000003'::uuid,'60000000-0000-0000-0000-000000000015'::uuid,25::numeric,'active', 22, 12),
      ('50000000-0000-0000-0000-000000000005'::uuid,'60000000-0000-0000-0000-000000000017'::uuid, 9::numeric,'active', 27, 8),
      ('50000000-0000-0000-0000-000000000006'::uuid,'60000000-0000-0000-0000-000000000016'::uuid,14::numeric,'active', 33, 5),
      ('50000000-0000-0000-0000-000000000004'::uuid,'60000000-0000-0000-0000-000000000015'::uuid, 7::numeric,'expired',-9, 68),
      ('50000000-0000-0000-0000-000000000007'::uuid,'60000000-0000-0000-0000-000000000016'::uuid,11::numeric,'expired',-21, 92),
      ('50000000-0000-0000-0000-000000000009'::uuid,'60000000-0000-0000-0000-000000000018'::uuid,60::numeric,'expired',-40,124),
      ('50000000-0000-0000-0000-000000000008'::uuid,'60000000-0000-0000-0000-000000000015'::uuid,13::numeric,'expired',-57,151)
    ) as t(customer, part, qty, status, exp_days, created_days)
  loop
    q := pg_temp.new_quote(s.customer, s.created_days, s.status, s.exp_days, 21);
    perform pg_temp.add_quote_line(q, s.part, 10, s.qty);
    -- Two of them quote a second part on the same sheet.
    if s.qty > 20 then
      perform pg_temp.add_quote_line(q, '60000000-0000-0000-0000-000000000016', 20, 4);
    end if;
  end loop;
end $$;

-- ── When each job and quote last actually moved ──────────────────────────────
--
-- Every seeded row carried updated_at = the seed run, and not by oversight: the
-- `jobs_updated_at` / `quotes_updated_at` triggers stamp now() on every write,
-- which is exactly what they are for. So a job created in February, run in
-- March and shipped in April still read as "touched today".
--
-- That is not cosmetic. The dashboard's Completed card buckets on updated_at, so
-- ALL-TIME revenue landed inside "this week" and the Today / This Week toggle
-- could not differ no matter what the data said. Anything else that reasons
-- about recency was reading the same lie.
--
-- Suspend the triggers for one pass and stamp each row with its newest real
-- event: the last shipment, else the last completed operation, else creation.
-- Derived rather than assigned, so it stays true if the scenarios above change.
-- This runs for the whole company, so the eight hand-written scenarios are
-- corrected along with the generated ones.
alter table public.jobs   disable trigger jobs_updated_at;
alter table public.quotes disable trigger quotes_updated_at;

update public.jobs j
   set updated_at = greatest(
         j.created_at,
         coalesce((select max(s.ship_date::timestamptz) from public.shipments s where s.job_id = j.id), j.created_at),
         coalesce((select max(o.completed_at) from public.job_operations o where o.job_id = j.id), j.created_at))
 where j.company_id = '22222222-2222-2222-2222-222222222222';

-- A quote last moved when it converted, else when it was raised.
update public.quotes q
   set updated_at = coalesce(q.converted_at, q.created_at)
 where q.company_id = '22222222-2222-2222-2222-222222222222';

alter table public.jobs   enable trigger jobs_updated_at;
alter table public.quotes enable trigger quotes_updated_at;

-- ── Recognition cursor: some of the praise has already been read ─────────────
-- Without this every member's reactions_seen_at is NULL, which the read path treats as
-- "never dismissed" and answers with the whole 56-day window. That is a real state — it
-- is what a brand-new member sees — but it is the ONLY state the seed could otherwise
-- represent, and it is the least interesting one: everything is new, nothing has been
-- acknowledged, and the "already seen marks stay on their notes below" half of the
-- design is invisible.
--
-- It also makes the seed single-use. `mark_reactions_seen` is deliberately forward-only
-- and the read filter is strictly-greater, so the FIRST person to tap "Got it" on a
-- shared dev or preview database empties the block for that account permanently, with no
-- in-app way back (no browser role can write this column — only the SECURITY DEFINER RPC,
-- which never moves the cursor backwards). Restoring it means re-seeding, or another
-- member marking something helpful. Worth knowing before demoing from one account.
--
-- Pin the cursor to the THIRD-newest helpful mark on the member's own notes, so exactly
-- the two newest stay unseen by construction. A flat `now() - interval '2 days'` would
-- work today but its "how many are new" is an output of the rn % 6 lottery above, and
-- that lottery has already misfired once in this file — the top-up block immediately
-- above exists because it left both durable part notes at zero. Ranking is stable no
-- matter how the notes get reshuffled later.
--
-- Members with fewer than three stay NULL: that is the honest first-run state, and it
-- keeps both operator accounts (two marks each) as the untouched demo of the surface —
-- which matters, because this is an OPERATOR feature and the dev login is an admin.
update public.user_company_access uca
set reactions_seen_at = (
  select r.created_at
  from public.note_reactions r
  join public.notes n on n.id = r.note_id
  where n.author_id = uca.id and r.kind = 'helpful'
  order by r.created_at desc
  offset 2 limit 1
)
where uca.company_id = '22222222-2222-2222-2222-222222222222'
  and (
    select count(*)
    from public.note_reactions r
    join public.notes n on n.id = r.note_id
    where n.author_id = uca.id and r.kind = 'helpful'
  ) >= 3;

-- ── Inventory locations (feature-flagged) ────────────────────────────────────
-- Turned on for the seeded company so the location-tracked half of inventory is
-- exercised in dev, preview branches and manual testing — not just the aggregate
-- path. Names follow the vocabulary in Contour's legacy export (CABINET / SHELF /
-- YARD), so the dev data looks like a real shop rather than "Location 1".
--
-- ORDER MATTERS, and this block must stay LAST. Tracking a part makes
-- `enforce_tracked_part_quantity` reject any direct write to parts.quantity, and
-- pg_temp.deplete_job() above does exactly that. Flip the flag before the
-- transaction graph is built and the seed dies mid-way. Everything here runs
-- after the last quantity write.

-- Move a share of whatever a part currently holds at one location into another.
-- Fraction of the *live* balance, floored to a whole unit (these are all 'each').
create function pg_temp.put_away(p_part uuid, p_from uuid, p_to uuid, p_share numeric, p_name text)
returns void language plpgsql as $$
declare v_have numeric; v_move numeric;
begin
  select quantity into v_have from public.part_location_stock
   where part_id = p_part and location_id = p_from;
  v_move := floor(coalesce(v_have, 0) * p_share);
  if v_move <= 0 then return; end if;
  perform public.transfer_stock(p_part, p_from, p_to, v_move, 'each', v_move,
                                'Put away to ' || p_name);
end $$;

do $$
declare
  v_unassigned uuid;
  v_shelf_a    constant uuid := '71000000-0000-0000-0000-000000000002';
  v_shelf_b    constant uuid := '71000000-0000-0000-0000-000000000003';
  v_yard       constant uuid := '71000000-0000-0000-0000-000000000004';
  v_company    constant uuid := '22222222-2222-2222-2222-222222222222';
begin
  -- transfer_stock authorises against get_user_company_ids(), i.e. auth.uid(), which is
  -- null in a seed. Impersonate the dev user for this block so the put-aways go through
  -- the real RPC — which also writes the paired transfer rows to inventory_transactions.
  -- Transaction-local (the `true`), so it expires with this DO block.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', '11111111-1111-1111-1111-111111111111',
                      'role', 'authenticated')::text,
    true);

  update public.companies
     set settings = jsonb_set(coalesce(settings, '{}'::jsonb),
                              '{features,inventory_locations}', 'true')
   where id = v_company;

  -- No backfill needed any more. `enable_location_tracking_for_company` was dropped in
  -- 20260802015837: every part is seeded into Unassigned by `auto_track_stocked_part` the
  -- moment it is inserted, for every company, flag or no flag. All this block needs is the
  -- bucket's id — and note the flag write above now governs only whether this shop MANAGES
  -- places, not whether its stock has one.
  v_unassigned := public.inv_get_or_create_unassigned(v_company);

  -- No is_stockable / is_qr_anchor: both were dropped in
  -- 20260623031347_drop_location_display_flags.sql. Every node is stockable and
  -- every node can carry a QR now.
  -- No `code` and no `kind`: the column went in 20260803034616 and the user-facing kind field in
  -- e2e2f5e. `kind` survives in the schema only for the auto-managed `Unassigned` pile, which
  -- `inv_get_or_create_unassigned` creates — never a hand-written row like these.
  insert into public.inventory_locations (id, company_id, parent_id, name, sort_order) values
    ('71000000-0000-0000-0000-000000000001', v_company, null, 'Cabinet 3', 1),
    (v_shelf_a, v_company, '71000000-0000-0000-0000-000000000001', 'Shelf A', 1),
    (v_shelf_b, v_company, '71000000-0000-0000-0000-000000000001', 'Shelf B', 2),
    (v_yard,    v_company, null, 'Yard', 2)
  on conflict (id) do nothing;

  -- Spread stock so all three count-sheet write targets exist in dev data. The
  -- count resolves a part's target by how many locations hold stock, so without
  -- this every part sits at Unassigned and only one branch is ever reachable.
  --   BUY-BEARING-608ZZ  -> Shelf A only        : counts to a named bin
  --   RAW-STEEL-BLANK    -> Yard only           : counts to a named bin
  --   BUY-ORING-214      -> Shelf A + Shelf B   : EXCLUDED from the sheet ("count it at its locations")
  --   everything else    -> Unassigned          : counts to the system bucket
  --
  -- Quantities are read from the balance rather than hardcoded: pg_temp.deplete_job()
  -- above has already consumed against these parts, so the seeded insert figures are
  -- stale by now and transfer_stock rejects an overdraw.
  perform pg_temp.put_away('60000000-0000-0000-0000-000000000004', v_unassigned, v_shelf_a, 1.0, 'Shelf A');
  perform pg_temp.put_away('60000000-0000-0000-0000-000000000002', v_unassigned, v_yard,    1.0, 'Yard');
  -- Split one part over two bins so the "count it at its locations" exclusion has a
  -- live example: 60% to A, then everything still loose to B.
  perform pg_temp.put_away('60000000-0000-0000-0000-000000000005', v_unassigned, v_shelf_a, 0.6, 'Shelf A');
  perform pg_temp.put_away('60000000-0000-0000-0000-000000000005', v_unassigned, v_shelf_b, 1.0, 'Shelf B');
end $$;

-- ---------------------------------------------------------------------------
-- Clickwrap acceptances for every seeded login
-- ---------------------------------------------------------------------------
-- Without these, TermsGate raises a blocking modal over the first page a seeded
-- user opens, and `pnpm dev` against a local stack is gated before you can look
-- at anything. Same reasoning as the billing exemption: a seed's job is to hand
-- you a shop that is already set up, not to make you re-enact onboarding.
--
-- The hash MUST match public/legal/manifest.json. scripts/legalDocumentsCheck.ts
-- guards the manifest against the files, but nothing ties this file to either --
-- so on a version bump, update these two rows. A stale hash here is harmless
-- (the gate compares the VERSION, not the hash) but it is a lie in a table whose
-- whole point is not lying, so keep it right.
insert into public.terms_acceptances
  (user_id, company_id, document_type, version, document_sha256, accepted_via, ip_source)
select
  u.id,
  null,
  d.document_type,
  d.version,
  d.sha256,
  'invite_accept',
  'unavailable'
from auth.users u
cross join (values
  ('tos',     1, '26824e1103f9b8178e402f3417edf35e2be88151f86b29f48b9f321af1a2ca44'),
  ('privacy', 1, 'b9b7420fa888b52d1426412bfb3e701b8ed8814fc2a4da29f1292ee459f1f0ed')
) as d(document_type, version, sha256)
where not exists (
  select 1 from public.terms_acceptances t
  where t.user_id = u.id
    and t.document_type = d.document_type
    and t.version = d.version
);
