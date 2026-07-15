-- =============================================================================
-- supabase/seed.sql — canonical development / preview-branch seed for Jigged.
--
-- Runs automatically on `supabase db reset` (local) and on every Supabase
-- preview-branch creation (config.toml [db.seed].sql_paths). Replaces the old
-- scripts/seed-dev.ts programmatic seeder.
--
-- Design:
--   * FIXED UUIDs        → deterministic identities, clean git diffs.
--   * DYNAMIC dates      → `now() - interval '…'` so jobs/quotes are always
--                          current (no perpetually-overdue jobs / expired quotes).
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
insert into public.companies (id, name) values
  ('22222222-2222-2222-2222-222222222222', 'Vanguard Precision Works')
on conflict (id) do nothing;

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
insert into public.customers (id, company_id, name) values
  ('50000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Northwind Hydraulics'),
  ('50000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','Cascade Robotics'),
  ('50000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','Meridian Aerospace'),
  ('50000000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','Granite Equipment Co'),
  ('50000000-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','BlueRidge Medical Devices'),
  ('50000000-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222','Sierra Pump & Valve')
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
  ('60000000-0000-0000-0000-000000000008','22222222-2222-2222-2222-222222222222','BUY-MOTOR-12V','12V DC gearmotor','bought',true,'ea',60,10,'30000000-0000-0000-0000-000000000005'),
  -- Machined sub-components (made, stocked).
  ('60000000-0000-0000-0000-000000000009','22222222-2222-2222-2222-222222222222','SUB-HOUSING','Pump housing, machined','made',true,'ea',25,10,null),
  ('60000000-0000-0000-0000-000000000010','22222222-2222-2222-2222-222222222222','SUB-SHAFT','Drive shaft, turned','made',true,'ea',40,10,null),
  ('60000000-0000-0000-0000-000000000011','22222222-2222-2222-2222-222222222222','SUB-COVER','End cover, anodized','made',true,'ea',30,10,null),
  ('60000000-0000-0000-0000-000000000012','22222222-2222-2222-2222-222222222222','SUB-BRACKET','Mounting bracket','made',true,'ea',35,10,null),
  -- Sub-assemblies (made, stocked).
  ('60000000-0000-0000-0000-000000000013','22222222-2222-2222-2222-222222222222','ASM-PUMPCORE','Pump core assembly','made',true,'ea',12,10,null),
  ('60000000-0000-0000-0000-000000000014','22222222-2222-2222-2222-222222222222','ASM-GEARBOX','Gearbox subassembly','made',true,'ea',8,10,null),
  -- Top-level sellable products (made, not stocked).
  ('60000000-0000-0000-0000-000000000015','22222222-2222-2222-2222-222222222222','PROD-PUMP-100','Hydraulic Pump P-100','made',false,'ea',0,null,null),
  ('60000000-0000-0000-0000-000000000016','22222222-2222-2222-2222-222222222222','PROD-ACTUATOR-200','Linear Actuator A-200','made',false,'ea',0,null,null),
  ('60000000-0000-0000-0000-000000000017','22222222-2222-2222-2222-222222222222','PROD-MANIFOLD-300','Valve Manifold M-300','made',false,'ea',0,null,null),
  ('60000000-0000-0000-0000-000000000018','22222222-2222-2222-2222-222222222222','PROD-RAIL-CUT','Cut-to-length guide rail (per inch)','made',false,'in',0,null,null)
on conflict (id) do nothing;

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
insert into public.routing_operations (routing_id, work_center_id, sequence, setup_minutes, cycle_minutes_per_unit, labor_rate_override, external_unit_price, instructions) values
  -- housing: saw, mill, deburr
  ('70000000-0000-0000-0000-000000000009','40000000-0000-0000-0000-000000000001',10,15,3,null,null,'Bandsaw operation'),
  ('70000000-0000-0000-0000-000000000009','40000000-0000-0000-0000-000000000002',20,15,3,null,null,'CNC Mill (Haas VF-2) operation'),
  ('70000000-0000-0000-0000-000000000009','40000000-0000-0000-0000-000000000004',30,15,3,null,null,'Manual Deburr operation'),
  -- shaft: saw, lathe, deburr
  ('70000000-0000-0000-0000-000000000010','40000000-0000-0000-0000-000000000001',10,15,3,null,null,'Bandsaw operation'),
  ('70000000-0000-0000-0000-000000000010','40000000-0000-0000-0000-000000000003',20,15,3,null,null,'CNC Lathe (Okuma) operation'),
  ('70000000-0000-0000-0000-000000000010','40000000-0000-0000-0000-000000000004',30,15,3,null,null,'Manual Deburr operation'),
  -- cover: mill, deburr, anodize(external)
  ('70000000-0000-0000-0000-000000000011','40000000-0000-0000-0000-000000000002',10,15,3,null,null,'CNC Mill (Haas VF-2) operation'),
  ('70000000-0000-0000-0000-000000000011','40000000-0000-0000-0000-000000000004',20,15,3,null,null,'Manual Deburr operation'),
  ('70000000-0000-0000-0000-000000000011','40000000-0000-0000-0000-000000000007',30,0,0,null,4.5,'Anodizing (ProFinish) operation'),
  -- bracket: mill, deburr
  ('70000000-0000-0000-0000-000000000012','40000000-0000-0000-0000-000000000002',10,15,3,null,null,'CNC Mill (Haas VF-2) operation'),
  ('70000000-0000-0000-0000-000000000012','40000000-0000-0000-0000-000000000004',20,15,3,null,null,'Manual Deburr operation'),
  -- pumpcore: assembly, inspect
  ('70000000-0000-0000-0000-000000000013','40000000-0000-0000-0000-000000000005',10,15,3,null,null,'Assembly Bench operation'),
  ('70000000-0000-0000-0000-000000000013','40000000-0000-0000-0000-000000000006',20,15,3,null,null,'Final Inspection operation'),
  -- gearbox: assembly, inspect
  ('70000000-0000-0000-0000-000000000014','40000000-0000-0000-0000-000000000005',10,15,3,null,null,'Assembly Bench operation'),
  ('70000000-0000-0000-0000-000000000014','40000000-0000-0000-0000-000000000006',20,15,3,null,null,'Final Inspection operation'),
  -- pump: assembly, inspect
  ('70000000-0000-0000-0000-000000000015','40000000-0000-0000-0000-000000000005',10,15,3,null,null,'Assembly Bench operation'),
  ('70000000-0000-0000-0000-000000000015','40000000-0000-0000-0000-000000000006',20,15,3,null,null,'Final Inspection operation'),
  -- actuator: assembly, inspect
  ('70000000-0000-0000-0000-000000000016','40000000-0000-0000-0000-000000000005',10,15,3,null,null,'Assembly Bench operation'),
  ('70000000-0000-0000-0000-000000000016','40000000-0000-0000-0000-000000000006',20,15,3,null,null,'Final Inspection operation'),
  -- manifold: mill, assembly, inspect
  ('70000000-0000-0000-0000-000000000017','40000000-0000-0000-0000-000000000002',10,15,3,null,null,'CNC Mill (Haas VF-2) operation'),
  ('70000000-0000-0000-0000-000000000017','40000000-0000-0000-0000-000000000005',20,15,3,null,null,'Assembly Bench operation'),
  ('70000000-0000-0000-0000-000000000017','40000000-0000-0000-0000-000000000006',30,15,3,null,null,'Final Inspection operation'),
  -- rail: saw, deburr
  ('70000000-0000-0000-0000-000000000018','40000000-0000-0000-0000-000000000001',10,15,3,null,null,'Bandsaw operation'),
  ('70000000-0000-0000-0000-000000000018','40000000-0000-0000-0000-000000000004',20,15,3,null,null,'Manual Deburr operation')
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

-- Progress a job's parts + operations (job status rolls up via trigger).
create function pg_temp.progress_job(p_job uuid, p_status text, p_anchor int)
returns void language plpgsql as $$
declare jp record; op record; n int; i int;
begin
  for jp in select id from public.job_parts where job_id = p_job loop
    if p_status = 'cancelled' then
      update public.job_parts set production_status='cancelled', status_changed_at = now() - (p_anchor||' days')::interval where id = jp.id;
      continue;
    end if;
    select count(*) into n from public.job_operations where job_part_id = jp.id;
    i := 0;
    for op in select id from public.job_operations where job_part_id = jp.id order by sequence loop
      i := i + 1;
      if p_status = 'completed' then
        update public.job_operations set status='completed',
          completed_at = now() - ((p_anchor + (n - i + 1)*2 - 1)||' days')::interval,
          completed_by = '11111111-1111-1111-1111-111111111111' where id = op.id;
      elsif p_status = 'in_progress' then
        if i = 1 then
          update public.job_operations set status='completed',
            completed_at = now() - ((p_anchor+2)||' days')::interval,
            completed_by='11111111-1111-1111-1111-111111111111' where id = op.id;
        elsif i = 2 then
          update public.job_operations set status='in_progress' where id = op.id;
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
      update public.parts set quantity = greatest(0, quantity - used) where id = e.child_part_id;
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

create function pg_temp.add_note(p_job uuid, p_body text, p_type text, p_days int)
returns void language plpgsql as $$
begin
  insert into public.job_notes (company_id, job_id, author_id, body, note_type, created_at)
  values ('22222222-2222-2222-2222-222222222222', p_job, '23000000-0000-0000-0000-000000000001', p_body, p_type, now() - (p_days||' days')::interval);
end $$;

-- Step-tagged operator note: ties a note to a specific operation (by sequence)
-- on the job's part, so the operator "Previous notes" view surfaces it for later
-- runs of the same part and can filter to "this step". Author is an operator's
-- user_company_access id (operators write these on the floor).
create function pg_temp.add_op_note(p_job uuid, p_seq int, p_author uuid, p_body text, p_days int)
returns void language plpgsql as $$
declare v_jp uuid; v_op uuid;
begin
  select id into v_jp from public.job_parts where job_id = p_job order by sequence limit 1;
  select id into v_op from public.job_operations where job_part_id = v_jp and sequence = p_seq limit 1;
  insert into public.job_notes (company_id, job_id, author_id, job_part_id, job_operation_id, body, note_type, created_at)
  values ('22222222-2222-2222-2222-222222222222', p_job, p_author, v_jp, v_op, p_body, 'user', now() - (p_days||' days')::interval);
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
