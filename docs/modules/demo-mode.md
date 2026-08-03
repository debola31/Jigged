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
> data in the demo company". **Reset does not delete all the data, and on a demo company that has
> shipped anything it deletes none of it and throws** — see
> [#675](https://github.com/debola31/Jigged/issues/675). Function bodies are now linked, not
> pasted: a copy of SQL in a doc is a second source that drifts silently, which is exactly what
> happened here.

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
  every `user_company_access` row, and navigates to it. **Later entries** go straight there,
  lazy-syncing access for team members added since.
- Navigation **preserves page context** both ways — on `/parts` in real, land on `/parts` in
  demo, and back again. Browser history works normally.
- **Full CRUD.** It is a real company that happens to be pre-populated; users can quote, convert,
  edit routings and adjust inventory freely. The operator view works the same way — operators
  already have mirrored access, so they enter via Settings like everyone else. There is no
  separate operator toggle.
- **Reset** restores the demo to its template state, keeping the company row and the access rows —
  only data is meant to be wiped.
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

*(The full JSONB example this doc used to carry has been dropped: the active row is authored in
prod and is **not committed**, so the example could never be checked against anything.)*

## What the demo contains

Whatever `seed_demo_data()` inserts from the active template — vendors and their contacts, work
centers (internal, or external linked to a vendor), parts with procurement tiers, multi-level
`parts_bom` links, routings with a **linear** operations array, customers, quotes with line
items, and jobs with parts. Job operations are **generated from the routing**, not listed in the
template.

The seeder inserts **no** `inventory_items` (no such table on the template path), and there are
no `operation_types` or routing nodes/edges — superseded by `work_centers` and linear
`routing_operations`.

## Functions

Bodies live in [`supabase/migrations/`](../../supabase/migrations/); this is what they
are for.

| Function | Does |
|---|---|
| `seed_demo_data(company_id, template)` | The shared seeding helper — resolves `_ref` keys to UUIDs and inserts the graph |
| `create_demo_company(source_company_id, user_id)` | Creates the hidden company, seeds it, mirrors `user_company_access`, sets `demo_company_id` on the real company. Raises **"No active demo template found"** when none is active |
| `reset_demo_company(source_company_id, user_id)` | Deletes the demo company's data and re-seeds. **Broken — see below** |
| `sync_demo_access(source_company_id, demo_company_id)` | Lazy role mirroring on entry |

`sync_demo_access` inserts missing members copying both `role` **and** `name`, then `UPDATE`s
only the roles that changed — so it stays correct without triggers.

Access layer is Supabase-first, no FastAPI: `getDemoStatus`, `createDemoCompany`,
`resetDemoCompany`, `syncDemoAccess` in [`utils/demoAccess.ts`](../../utils/demoAccess.ts),
each an `rpc(...)` call.

### ⚠ Reset is broken — [#675](https://github.com/debola31/Jigged/issues/675)

`reset_demo_company()` deletes 19 tables and **never deletes `shipments` or
`shipment_line_items`.** The FK actions do not save it: `shipment_line_items.job_part_id` blocks
the `DELETE FROM job_parts`, and `part_location_stock.part_id` / `work_center_attachments
.work_center_id` are `RESTRICT` against `parts` / `work_centers`. Because the function is one
plpgsql body, **the exception aborts the whole transaction: nothing is deleted and Reset is
permanently broken for that demo company.** Verified by replaying the function's own statements
against a company with shipments.

Separately, **15 `company_id` tables are outside the reset's scope** (asked of Postgres directly,
following the real `ON DELETE CASCADE` graph):

```
ai_config · auth_audit_log · company_billing · company_custom_units · company_order_counters
feedback · inventory_locations · invitations · operator_events · part_location_stock
quickbooks_connections · saved_insights · shipments · user_company_access · work_center_attachments
```

Several of those are **correct** to keep — `user_company_access` (the membership Reset is
documented to preserve), `company_billing`, `invitations`, `quickbooks_connections`, the counters
and config. But `shipments`, `inventory_locations`, `part_location_stock`, `operator_events`,
`saved_insights` and `work_center_attachments` are demo data a reset should clear and does not.

*(This doc previously pasted a body containing `DELETE FROM operator_sessions`, a table dropped by
[`20260621132129`](../../supabase/migrations/20260621132129_drop_operator_time_tracking.sql). The
real function has never contained that line.)*

## Template management

Templates are authored as JSON by system admins and inserted directly — a low-frequency operation
with no admin UI. Update by inserting a new version with `is_active = TRUE` and deactivating the
old one. Before inserting, check that every `_ref` is unique, every `*_ref` resolves to a `_ref`
defined earlier, required fields are present, and `schema_version` matches the schema.

> **Known gap (#550).** There is no committed template: no `scripts/seed-demo-template.sql`, and
> no `demo_data_templates` row in `supabase/seed.sql`. **So on a fresh local or preview stack
> there is no active template and `create_demo_company` raises "No active demo template found" —
> demo mode cannot be exercised there at all.** The only tooling is
> [`scripts/sync_demo_template.py`](../../scripts/sync_demo_template.py), which copies the active
> row from prod. The intended direction is to source the demo from `supabase/seed.sql` — the same
> graph the tests seed, differing only by company name — and delete that script. Planned, not
> shipped.

## Coverage — stated, not implied

**The demo lifecycle has no automated coverage.** Nothing tests `create_demo_company`,
`reset_demo_company`, `sync_demo_access`, `seed_demo_data`, or entering/exiting demo mode —
`git grep` over `__tests__/`, `e2e/` and `api/tests/` finds no caller of any of them. That gap is
why #675 went unnoticed.

What *is* covered is the **exclusion** behaviour, which is the part with money attached:

| Behaviour | Enforced by |
|---|---|
| A demo company short-circuits the entitlement check regardless of billing state | `__tests__/lib/entitlement.test.ts` > `demo short-circuits regardless of billing state` |
| Stripe checkout refuses a demo company | `api/tests/unit/test_stripe_routes.py` > `test_checkout_rejects_demo_company` |

Untested and worth naming: the reset path (**#675**), first-entry creation, access mirroring on
re-entry, and the "no active template" failure a fresh stack always hits (#550).

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
