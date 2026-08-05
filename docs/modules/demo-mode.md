# Demo Mode

**As-built reference.** A pre-populated sandbox a user can explore inside their own company
context, without mixing demo data with real data or exposing multi-company complexity.

> **Condensed 2026-08-03: two files of 10,801 words → one of ~1,780 (−84%), for
> [#634](https://github.com/debola31/Jigged/issues/634).**
>
> `demo-company.md` described a v1 design that was **never built** — `clone_demo_company`,
> `_populate_demo_company`, `demo_template_id`, `demo_owner_id`, `DemoBanner`, `DemoResetButton`
> and all five `/api/demo/*` routes are absent from the codebase. Its own header, this doc's
> §Supersedes, and its divergence report all said so; it survived anyway, carrying 1,173 words of
> SQL for functions that do not exist.
>
> **Corrected against the code.** This doc pasted a `reset_demo_company()` body containing
> `DELETE FROM operator_sessions` — a table dropped in June 2026 — and claimed Reset "deletes all
> data in the demo company". Function bodies are now linked, not pasted: a copy of SQL in a doc is
> a second source that drifts silently, which is exactly what happened here.

> **2026-08-05: demo mode was rebuilt.** [#675](https://github.com/debola31/Jigged/issues/675)
> (Reset broken) and [#550](https://github.com/debola31/Jigged/issues/550) (no committed template)
> are both closed by
> [`20260805011938`](../../supabase/migrations/20260805011938_rebuild_demo_seed_for_current_schema.sql).
> The failure was larger than either issue described — see [What went wrong](#what-went-wrong).

---

## Why a hidden demo company

The demo company is architecturally separate (its own `company_id`, full RLS isolation) but
invisible to the user, who sees their own company name with a **DEMO** badge. That buys:

- **Zero query overhead** — every query already filters `company_id` via RLS. No extra filters,
  now or for any future module.
- **Zero maintenance** — a new entity table needs no demo-infrastructure change.
- **Dashboards and AI Insights work for free** — they scope to the active `company_id`.
- **Simple cleanup** — reset is "wipe the demo company's data and re-seed". *(In principle. See
  the correction above.)*

**Withdrawn — an `is_sample BOOLEAN` column on every data table**, filtered in the application
layer. Rejected because every query, dropdown, KPI and future module would need
`.eq('is_sample', …)` — a permanent tax on every developer; **a missed filter leaks demo data
into the real view with no visible symptom**; load/clear helpers would need updating for each new
table; and it pushes isolation into the application layer, working against the RLS the database
already enforces.

**Withdrawn — a visible demo company per user** (the original `demo-company.md` design): a
separate company in the switcher with its own lifecycle. It put multi-company mechanics in front
of a user who has one company, which is the confusion this feature exists to avoid.

Lineage: **Demo Company** (visible, per user) → **Sample Data** (`is_sample` column) → **Demo
Mode** (hidden company, presented as a toggle) — the architectural simplicity of a separate
company with the UX of a mode switch.

## Behaviour

Entered from Settings or the onboarding card; exited from Settings or the banner shown on every
page while in demo mode.

- **First entry** creates the hidden demo company, seeds it from the active template, mirrors
  every `user_company_access` row and the source's feature flags, and navigates to it. **Later
  entries** go straight there, lazy-syncing both for changes made since.
- Navigation **preserves page context** both ways — on `/parts` in real, land on `/parts` in
  demo, and back again. Browser history works normally.
- **Full CRUD.** It is a real company that happens to be pre-populated; users can quote, convert,
  edit routings and adjust inventory freely. The operator view works the same way — operators
  already have mirrored access, so they enter via Settings like everyone else. There is no
  separate operator toggle.
- **Reset** restores the demo to its template state, keeping the company row and the access rows.
  It also clears `company_order_counters`, so a re-seeded demo reads `Q-0001` again instead of
  climbing every time someone resets.
- **There is no delete action.** The demo is hidden from the company switcher, the login redirect
  and billing, and costs on the order of 50 rows; Reset covers "start fresh", and keeping the
  company means re-entry is instant. A delete would be trivial to add later (CASCADE on the
  company row) if it were ever wanted.

**Isolation is automatic and needs no application-layer filtering.** Demo records reference demo
records, real reference real, and the two graphs never connect because they are different
companies. Demo data must be excluded from *non-data* queries — the company selector, the login
redirect, and billing — by filtering `companies.is_demo = FALSE`.

## Data model

| Object | Notes |
|---|---|
| `companies.demo_company_id` | On the **real** company, pointing at its demo. NULL ⇒ no demo exists. `ON DELETE SET NULL` |
| `companies.is_demo` | On the **demo** company. The flag every selector / login / billing query filters on |
| `demo_data_templates` | `(name, version)` unique, one row `is_active`. System admins manage it; **all authenticated users can read the active row**, which is what lets a normal user seed their own demo |
| `system_admins` + `is_system_admin(uuid)` | Platform-level privilege backing the template RLS |

**`is_system_admin()` is `SECURITY DEFINER` for a specific reason:** RLS on `system_admins`
restricts reads to system admins, but the function must read that table to decide whether the
caller *is* one — a chicken-and-egg. Running as the definer bypasses RLS and breaks the cycle.
The first system admin is inserted directly via SQL; there is no bootstrap UI.

`template_data` is a JSONB graph using `_ref` string keys for intra-template foreign keys
(`vendor_ref`, `work_center_ref`, `parent_ref` → `child_ref`, `routing_ref`), resolved to real
UUIDs as `seed_demo_data()` inserts. It carries a date-based `schema_version`, and the seeder
`COALESCE`s every optional field so a template missing a newly-added column still loads.

**The active template is committed**, in the migration that created it — read it there rather
than querying prod.

## What the demo contains

The `default` v3 graph, all of it written by `seed_demo_data()` in this order:

| | |
|---|---|
| 19 storage locations, 3 levels deep | 45 parts (24 bought, 21 made) |
| 6 vendors + 13 contacts | 28 per-location stock balances |
| 12 work centers (9 internal, 3 outside) | 26 procurement + 71 pricing tiers |
| 21 routings / 69 operations | 38 BOM edges, 3 levels deep |
| 8 customers + 13 contacts + 11 addresses | 10 quotes / 17 line items |
| 16 jobs / 24 job parts / 27 completions | 6 shipments |
| 29 notes across job, part and machine subjects | 21 inventory transactions |

Jobs span every status the app can show — `not_started`, `in_progress` and `completed`
production; `unshipped`, `partially_shipped` and `fully_shipped` fulfillment — plus two hot jobs,
several overdue, one customer on credit hold, one resold bought part, and outside operations both
sent and received. Dates are **relative** (`days_ago`, `due_in_days`), so the demo reads as
current whenever it is seeded rather than ageing into a museum.

**Every part is priceable — no part in the demo shows a setup warning.** The Parts page marks a
part "Incomplete — needs setup before it can be quoted" from
[`get_priceable_part_ids`](../../supabase/migrations/), which is a *two*-part test: **costable**
(a bought part with a non-expired procurement tier, or a made part whose routing ops are all
priced and whose BOM children are all costable) **and** carrying its own `part_pricing_tiers` row
with a non-null `markup_percent`. Template v3 satisfied the first half everywhere and the second
for only 14 of 45 parts, so two thirds of the catalogue rendered as unfinished. v4 gives every
part a tier — which is also what the real companies carry (630/630 bought and 7816/7816 made at
Contour; median markup 25%), so seeding raw stock without one was the anomaly. Asserted by
`test_every_seeded_part_is_priceable` against the same RPC the page calls.

*(The legend under the toolbar names only the costable half — "routing/materials, or a vendor
cost" — which is why a missing markup reads as a seeding bug. That wording is an app-side
inaccuracy, not a template one.)*

**Statuses and quantities are derived, never asserted.** The seeder inserts every job as
`not_started` / `unshipped` and writes `job_operation_completions` and `shipment_line_items`; the
existing triggers compute the rest. Likewise it writes `part_location_stock` and lets
`recompute_part_quantity_from_locations` set `parts.quantity`. That is deliberate: a template
cannot then express a state the app itself cannot produce, and it cannot double-count stock.
Job operations and `job_materials` are still **generated from the routing**
(`create_job_part_operations_from_routing`), not listed in the template.

Two actor columns are easy to confuse, and the seeder handles both:
`notes.author_id` / `note_reactions.reactor_id` reference **`user_company_access.id`** (the
membership row), while `job_operation_completions.completed_by`, `inventory_transactions
.created_by` and every `created_by` reference **`auth.users.id`**.

## Functions

Bodies live in [`supabase/migrations/`](../../supabase/migrations/); this is what they
are for.

| Function | Does |
|---|---|
| `seed_demo_data(company_id, template)` | The shared seeding helper — resolves `_ref` keys to UUIDs and inserts the graph |
| `create_demo_company(source_company_id, user_id)` | Creates the hidden company, seeds it, mirrors `user_company_access`, sets `demo_company_id` on the real company. Raises **"No active demo template found"** when none is active |
| `reset_demo_company(source_company_id, user_id)` | Deletes the demo company's data and re-seeds |
| `sync_demo_access(source_company_id, demo_company_id)` | Lazy convergence on entry — roles **and** feature flags |
| `sync_demo_features(source_company_id, demo_company_id)` | Copies `settings.features` onto the demo. Backend-only; called by the three above |

`sync_demo_access` inserts missing members copying both `role` **and** `name`, then `UPDATE`s
only the roles that changed — so it stays correct without triggers. Its name still says "access"
only; broadening it beat renaming, which would churn the RPC, `utils/demoAccess.ts`, the provider
and the `function_execute_leaks()` allowlist for no behavioural gain.

### Feature flags mirror the source company

**A demo company shows the same product surface as the company it stands in for**, copied from
`settings.features` at creation, on every entry, and on reset.

It has to come from somewhere, because it cannot be set: the flag editor is `/admin/companies`,
and [`admin_routes.py`](../../api/routes/admin_routes.py) lists companies with
`.eq("is_demo", False)` — demo companies are invisible there, as they are to the company switcher
and the login redirect. Before mirroring, every demo sat at `settings = '{}'`, so **every opt-in
flag read off regardless of what the real company had enabled**, with no way to change it.

**Withdrawn — turning every flag on in demos.** It would make the demo a sales showcase, which is
a different product from an onboarding sandbox presented as *your* company. Three concrete
failures: entering and leaving preserves page context, so a feature on in demo and off in real is
a page that vanishes on exit; `machine_maintenance` is a one-pilot-shop-at-a-time experiment with
a written kill criterion, and all-on puts it in front of shops outside the pilot and pollutes the
measurement; and `ai_insights` is opt-**out**, so all-on re-exposes to a tenant exactly the thing
they turned off.

The block is copied **verbatim**, not key-by-key: an omitted key resolves to the descriptor's
`defaultEnabled` while a stored `false` does not, and squashing that distinction is how an
opt-out kill switch quietly stops killing.

Two deliberate exclusions:

| Not mirrored | Why |
|---|---|
| `settings.ai_limits` | Admin-only like `features`, but it caps Anthropic spend per company — copying a raised cap onto a second `company_id` doubles the exposure. Demos keep the default 20/hour |
| `settings.defaults`, `default_payment_terms`, `custom_payment_terms` | Editable from the Settings page **inside** demo mode, where full CRUD is the point. Re-mirroring on every entry would silently revert the user's own edits |

Access layer is Supabase-first, no FastAPI: `getDemoStatus`, `createDemoCompany`,
`resetDemoCompany`, `syncDemoAccess` in [`utils/demoAccess.ts`](../../utils/demoAccess.ts),
each an `rpc(...)` call.

### What went wrong

Two independent failures, fixed together in
[`20260805011938`](../../supabase/migrations/20260805011938_rebuild_demo_seed_for_current_schema.sql)
because a new template under the old seeder is as broken as the old template under the new one.

**1. The seeder drifted off the schema and nothing noticed for five months.** The active template
was authored in the prod console on 2026-03-03 and `seed_demo_data()` was written to match. By
August the function referenced **five columns that no longer existed** —
`customers.contact_name` (with `contact_email` / `contact_phone` / `address_*` / `website`, all
dropped when `customer_contacts` and `customer_addresses` landed), `quotes.lead_time_days`
(now `lead_time_text`), `jobs.status` and `job_parts.status` (both split into
`production_` / `fulfillment_` / `invoicing_status`) — and the template still spoke the
pre-unification `is_stockable` / `is_manufacturable` vocabulary instead of `source`, so every part
seeded as `made` and every template `cost_per_unit` was silently dropped.

The user-visible symptom was the *first* wall it hit: `parts_requires_unit`, because the template
omitted `primary_unit` on four of its eight parts. **This was not a degraded demo — it was an
unenterable one.** `create_demo_company` calls the same seeder, so any company without a demo
could not create one either.

**2. Reset was RESTRICT-blocked by its own output** ([#675](https://github.com/debola31/Jigged/issues/675)).
The function deleted 19 tables and never touched `shipments`, `shipment_line_items` or
`part_location_stock`, and the FK actions did not save it: `shipment_line_items.job_part_id`
blocks `DELETE FROM job_parts`, and `part_location_stock.part_id` /
`work_center_attachments.work_center_id` are `RESTRICT` against `parts` / `work_centers`. Because
the body is one plpgsql transaction, the exception **aborted the whole reset — nothing was
deleted, permanently, for any demo that had shipped anything.**

Reset now deletes leaves-first across every table the demo owns. It deliberately **keeps**
`user_company_access` (the membership it is documented to preserve), `company_billing`,
`invitations`, `quickbooks_connections`, `ai_config`, `auth_audit_log` and `feedback`.

**Why one reset was not enough to catch it.** The first reset of a demo runs against whatever the
old seeder managed to write; only the *second* runs against a demo the seeder itself produced,
which is the state holding shipments and per-location stock. That is why
`test_reset_is_repeatable` resets twice.

## Template management

**A new template version ships as a migration, not a console INSERT** — deactivate the old row and
insert the new one with `is_active = TRUE` in the same file. This is the direct lesson of #550:
the v2 row was authored in the prod console and existed nowhere else, so it could not be reviewed,
could not be replayed onto a fresh stack (`create_demo_company` raised *"No active demo template
found"* on every local and preview database), and drifted out of step with the schema for five
months with nothing to compare it against.

Before shipping one, check that every `_ref` is unique, every `*_ref` resolves to a `_ref` defined
**earlier in seed order**, required fields are present, and `schema_version` matches. The seeding
order is fixed by `seed_demo_data()` and is listed in its `COMMENT`; parents must precede children
within `locations` too.

## Coverage

[`api/tests/integration/test_demo_lifecycle.py`](../../api/tests/integration/test_demo_lifecycle.py)
covers the lifecycle end to end, against a local Supabase. It was written after the fact — this
had **no** coverage at all before 2026-08-05, which is why both failures above survived so long.

| Behaviour | Test |
|---|---|
| First entry creates the hidden company and populates every seeded table | `test_create_demo_company_seeds_the_graph` |
| `parts.quantity` equals `SUM(part_location_stock)` — the seeder must not write both | `test_seeded_part_quantities_are_derived_not_asserted` |
| Job statuses are trigger-derived and agree with the rows underneath | `test_seeded_job_statuses_come_from_the_triggers` |
| Reset survives a demo holding shipments and stock — **#675** | `test_reset_is_repeatable` |
| Reset clears the tables that used to be out of scope | `test_reset_clears_the_tables_that_were_out_of_scope` |
| Reset keeps membership and never reaches the real company | `test_reset_preserves_membership_and_leaves_the_real_company_alone` |
| `auth.uid()` check rejects resetting someone else's demo | `test_reset_rejects_a_caller_who_is_not_the_user` |
| Creation copies the source's flags verbatim, explicit `false` included | `test_create_mirrors_source_feature_flags` |
| `ai_limits` is *not* copied | `test_ai_limits_are_deliberately_not_mirrored` |
| A flag flipped after creation converges on the next entry | `test_entry_sync_propagates_a_flag_flipped_after_creation` |
| Mirroring never reverts settings edited inside demo mode | `test_mirror_leaves_the_demo_editable_settings_blocks_alone` |
| Reset re-mirrors flags | `test_reset_re_mirrors_flags` |
| `sync_demo_features` is unreachable from the browser | `test_sync_demo_features_is_not_reachable_from_the_browser` |
| Every seeded part is priceable — the demo shows zero setup warnings | `test_every_seeded_part_is_priceable` |

The tests assert **derived** state and **lower-bound** counts, not the template's own numbers —
asserting the template back at itself would pass with every trigger broken, and equalities would
break the suite each time the template grows.

Separately covered, and the part with money attached:

| Behaviour | Enforced by |
|---|---|
| A demo company short-circuits the entitlement check regardless of billing state | `__tests__/lib/entitlement.test.ts` > `demo short-circuits regardless of billing state` |
| Stripe checkout refuses a demo company | `api/tests/unit/test_stripe_routes.py` > `test_checkout_rejects_demo_company` |

Still untested and worth naming: `sync_demo_access`'s *role* mirroring on re-entry (its flag
mirroring is covered), and the frontend enter/exit navigation.

## Resolved questions

| Question | Answer |
|---|---|
| Do demo rows count toward usage limits or billing? | **No** — filter `is_demo = FALSE` |
| Should demo mode be read-only? | **No.** Full CRUD; Reset is the undo |
| JSONB template or a programmatic seeder? | JSONB with `_ref` mapping |
| Separate company or an `is_sample` column? | Separate company — see the withdrawal above |
| One demo per user, or per company? | **Per company**, shared by the whole team |
| How does access stay in sync? | Lazy `sync_demo_access()` on entry — no triggers |
| Can the demo be deleted? | Not built, deliberately |

**Depends on:** `system_admins` / `is_system_admin()` for template RLS, and the Settings page
layout from [invitation-system.md](invitation-system.md). It is otherwise independent of
invitations — they only share that layout.
