# Divergence report — Jobs (#343)

Audit under [#332](https://github.com/debola31/Jigged/issues/332) / [#343](https://github.com/debola31/Jigged/issues/343).
Compared `docs/modules/jobs.md` + `docs/prd.md` (FR-6, FR-8, FR-9, FR-3b) against
`utils/jobsAccess.ts`, `components/jobs/*`, `app/dashboard/[companyId]/jobs/*`,
`__tests__/utils/jobsAccess.test.ts`, the jobs E2E specs, and `supabase/schema.prod.sql`.

Policy: clear-cut, code-confirmed doc bugs were **fixed in this PR**; genuine judgment
calls are left as **decision needed** for the module owner to resolve on the issue.

## Fixed in this PR

1. **`jobs.status` no longer exists — split into three columns.** The Data Model documented a single `status` column "DERIVED from `job_parts.status` via `compute_job_status()`". The schema actually carries `production_status`, `fulfillment_status`, and `invoicing_status` on both `jobs` and `job_parts` (`supabase/schema.prod.sql`; `compute_job_production_status` / `_fulfillment_` / `_invoicing_`). → Data Model rows and the derivation prose rewritten to the three columns.
2. **"Status Transition Rules" table was stale.** It listed manual "Start Job" / "Mark Complete" / "Mark Shipped" clicks and a "Complete → In Progress (Reopen)" row — none of which exist (`jobsAccess.ts` has no `startJob`/`completeJob`/`shipJob`; `reopenJob` reverses a *cancelled* job). → Replaced with the real trigger-derived transitions.
3. **"Actions" table listed "Mark Shipped" and omitted Delete/Reopen.** → Rewritten to the real actions (Edit / Cancel / Reopen / Delete / Create shipment / Create invoice), with a note that shipping is a shipment-record side effect.
4. **Job Status Workflow diagram treated "Shipped" as a production state.** `production_status` is `not_started/in_progress/completed/cancelled` — shipping lives on `fulfillment_status`. → Diagram + definitions rewritten around the three axes.

## Decision needed

1. **Material consumption — file reference + capability mismatch.** `docs/modules/jobs.md` §Material Tracking references `components/jobs/JobMaterialsCard.tsx` and states operators mark materials consumed/skipped and record an actual quantity **on the job page**. In code the job-detail component is `components/jobs/JobPartMaterialsCard.tsx` (different name) and appears **read-only** (materials shown live from the part BOM); there is **no** material-consumption mutation in `utils/jobsAccess.ts`. *(Left unfixed because the filename correction can't be cleanly separated from the false capability claim.)*
   - **Question:** Is operator consumption capture actually shipped, and if so where — the operator view? the inventory depletion flow? Once you rule, I'll reconcile the file reference + narrative and add or omit a Jobs consumption AC. Cross-refs: #341 Inventory, #342 Operator View.
2. **Order-quantity edit UI prose.** jobs.md describes editing order quantity via "an edit icon next to the 'Order qty' chip". The current edit surface is a unified `components/jobs/JobEditForm.tsx` (Edit button → full-page form) covering quantity, unit price, PO #, due date, and billing/shipping/contact.
   - **Question:** Is the inline chip editor gone (replaced by JobEditForm), or does it still exist alongside? Confirm, and I'll update the prose.

## Informational / aligned

- **PRD FR-8 three-axis status** — fully realized; `invoicing_status` is a first-class column (not implicit/QB-only). No action.
- **Job numbering** — old AC "auto-generates (J-0001 format)" implied a trigger; reality is quote-mirroring + the shared per-company order counter (`generate_direct_job_number`). Corrected in the new ACs.
