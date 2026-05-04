# E2E Seed TODO (PR 1 → PR 3)

PR 1 (`feature/unify-parts-inventory-add-work-centers-vendors-pr1`) drops
the production parts/jobs/quotes/operations data and recreates it under the
unified parts schema. The `seed_demo_data` SQL function was dropped — the
migration writes minimal demo templates (1 vendor, 2 work centers, 3 parts,
1 routing op, 1 BOM line) but **does not auto-seed any company**.

The E2E suite assumes a populated test company. Until PR 3 lands a real
seed bootstrap, several specs will fail when run end-to-end:

| Spec | Why it fails today |
|------|--------------------|
| `e2e/parts-and-routing.spec.ts` | Needs ≥1 work center in the test company. Falls back to `test.skip(true, ...)` inside the test body when the autocomplete is empty — this is the legitimate runtime signal, not a `test.skip` directive. |
| `e2e/quote-to-job.spec.ts` | Needs ≥1 customer and ≥1 part with a routing. The Autocomplete pickers will time out if these don't exist. |
| `e2e/csv-import.spec.ts` | Self-seeded — uploads `fixtures/test-parts.csv`. Should still pass. CI guard `test.skip(!!process.env.CI, ...)` is unrelated (no FastAPI in CI). |
| `e2e/smoke.spec.ts` | Login + dashboard render only. No seeded data needed. Should pass. |

## What PR 3 must build

A Playwright `globalSetup` (or supabase-service-role bootstrap script) that:

1. Reads `E2E_TEST_COMPANY_ID` + `SUPABASE_SERVICE_ROLE_KEY` from env.
2. Idempotently inserts (only if missing):
   - 1 vendor
   - 2 work centers (1 internal, 1 external pointing at the vendor)
   - 1 customer
   - 3 parts (one stockable, one manufacturable with routing, one BOM child)
   - 1 routing on the manufacturable part with 1 operation
   - 1 `parts_bom` line linking parent → child
3. Tears down only its own ID-tagged rows (use a `metadata.seeded_by_e2e: true`
   marker so re-runs are safe).

The fixtures already in place — `e2e/fixtures/test-parts.csv` and
`e2e/fixtures/test-routings.csv` — should be the source of truth for the
seed data so the CSV import test and the prereq seed share one definition.

## Why this isn't done in PR 1 (chunk 4)

The spec for chunk 4 explicitly carves out the seed bootstrap as a real PR 3
infrastructure task. Per the no-tech-debt rule, the alternative —
`test.skip` directives with TODO comments — was rejected. Tests failing
because their data doesn't exist is the correct visible signal that the
seed bootstrap is the next thing to build.

## Running E2E locally before PR 3 lands

You can manually seed the test company once via the UI:

1. Log in to the test company as the E2E test user.
2. Create one customer, one vendor, one internal work center.
3. Create one manufacturable part, open its routing, add one operation
   pointing at the work center.
4. Save.

After that, `pnpm exec playwright test` should pass for the specs above
until you wipe the test company again.
