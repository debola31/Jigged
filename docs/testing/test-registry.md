# Test Registry

**Last updated:** 2026-05-27. Counts measured directly from `pnpm exec vitest --run --reporter=json` and `cd api && pytest --collect-only`.

## Coverage dashboard

| Metric | Threshold | Current |
|---|---|---|
| Statements | 45% | 47.4% |
| Branches | 45% | 42.3% (under threshold) |
| Functions | 45% | 43.44% (under threshold) |
| Lines | 45% | 48.64% |

Two metrics are under the configured floor. Sub-PR 3e (CI hardening) makes this a PR-blocking check; sub-PR 3f+ closes the gaps. See [checklist.md](checklist.md) for the sequence.

Coverage roadmap: 45% → 50% → 55% → 60%. Each 3f sub-PR raises the floor in lockstep with the tests it adds (ratchet, not target).

## Mutation testing (Stryker)

Coverage tells you what's executed; mutation testing tells you what's actually asserted. Stryker (configured in [`stryker.conf.mjs`](../../stryker.conf.mjs)) mutates `utils/**/*.ts` and `lib/**/*.ts`, runs the Vitest Node-mode suite per mutant, and reports survivors — production code patterns the tests don't notice when broken.

```bash
# Full run (slow — minutes to hours depending on hardware)
pnpm test:mutation
# OR
pnpm exec stryker run

# Targeted run — much faster, useful when iterating
pnpm exec stryker run --mutate utils/quotesAccess.ts

# View the HTML report
open reports/mutation/index.html
```

Reading the report:
- **Killed** mutants are good — at least one test failed when the mutation was applied.
- **Survived** mutants are red flags — the production code can be silently broken in that location and every test still passes. Each survivor names the file, line, and the mutation operator (`EqualityOperator`, `ConditionalExpression`, etc.).
- **No coverage** mutants mean no test ran the line — usually a coverage gap before a test-strength gap.
- **Timeout** mutants usually indicate infinite loops introduced by the mutation; Stryker counts them as killed.

Playwright specs (`e2e/**`) are intentionally excluded from mutation testing — it's a unit/integration concept; running it across E2E would blow up runtime without surfacing useful signal.

Baseline scores are recorded in issue #323 after the quote-edit fix (#324) ships — Stryker validates the reconcile block first.

## Frontend test files (25 files, 348 tests + 9 skipped)

### Utilities

| File | Tests | Coverage notes |
|---|---|---|
| `__tests__/utils/quotesAccess.test.ts` | 29 (+9 skipped) | `quotesAccess.ts` 33.33%. Skips: `createQuote`, `convertQuoteToJob`, pending-approval — fixed in sub-PR 3c. |
| `__tests__/utils/storageHelpers.test.ts` | 31 | `storageHelpers.ts` 93.18%. |
| `__tests__/utils/csvParser.test.ts` | 28 | `csvParser.ts` covered indirectly via import flows. |
| `__tests__/utils/companyAccess.test.ts` | 25 | `companyAccess.ts` 64.04%. |
| `__tests__/utils/routingCostCalculation.test.ts` | 22 | `routingCostCalculation.ts` 85.45%. |
| `__tests__/utils/procurementTiersAccess.test.ts` | 20 | `partPricingTiersAccess.ts` 95.83% (related). |
| `__tests__/utils/quotePdf.test.ts` | 18 | `quotePdf.ts` 91.66%. |
| `__tests__/utils/partsAccess.test.ts` | 16 | `partsAccess.ts` 24.11%. |
| `__tests__/utils/customerAccess.test.ts` | 11 | `customerAccess.ts` 31.81%. |
| `__tests__/utils/quotePricingResolver.test.ts` | 9 | Embedded in `quotesAccess`. |
| `__tests__/utils/operatorAccess.test.ts` | 6 | `operatorAccess.ts` not separately reported. |
| `__tests__/utils/shipmentsAccess.test.ts` | 6 | `shipmentsAccess.ts` 15.26%. |

### Components

| File | Tests | Coverage |
|---|---|---|
| `__tests__/components/auth/AuthGuard.test.tsx` | 17 | `AuthGuard.tsx` 95%. |
| `__tests__/components/inventory/StockStatusChip.test.tsx` | 8 | `StockStatusChip.tsx` covered indirectly. |
| `__tests__/components/parts/UnitOfMeasurementSelect.test.tsx` | 7 | `UnitOfMeasurementSelect.tsx` 79.59%. |
| `__tests__/components/auth/AdminGuard.test.tsx` | 6 | `AdminGuard.tsx` 90%. |
| `__tests__/components/auth/ChangePassword.test.tsx` | 6 | `ChangePassword.tsx` 83.14%. |
| `__tests__/components/layout/Sidebar.test.tsx` | 6 | `Sidebar.tsx` 95.23%. |
| `__tests__/components/parts/PartForm.test.tsx` | 5 | `PartForm.tsx` 46.42%. |
| `__tests__/components/customers/CustomerForm.test.tsx` | 4 | `CustomerForm.tsx` 51.11%. |

### Library / schema / types / smoke

| File | Tests |
|---|---|
| `__tests__/types/quote.test.ts` | 23 |
| `__tests__/lib/supabaseErrors.test.ts` | 21 |
| `__tests__/lib/partNavStack.test.ts` | 20 |
| `__tests__/schema/embedCheck.test.ts` | 9 |
| `__tests__/smoke.test.ts` | 4 |

## Backend test files (13 files, 151 tests)

### Unit

| File | Description |
|---|---|
| `api/tests/unit/test_email.py` | Email-sending helpers and templates |
| `api/tests/unit/test_sql_validator.py` | SQL grammar validation for the read-only insights endpoint |

### Integration (require `TEST_SUPABASE_URL` + `TEST_SUPABASE_SECRET_KEY`)

| File | Description |
|---|---|
| `api/tests/integration/test_import_api.py` | 3-phase customer import flow (analyze / validate / execute) |
| `api/tests/integration/test_parts_import_api.py` | Parts CSV import with AI mapping |
| `api/tests/integration/test_bom_import_api.py` | BOM structure import |
| `api/tests/integration/test_vendors_import_api.py` | Vendor CSV import (analyze / validate / execute) |
| `api/tests/integration/test_work_centers_import_api.py` | Work-center CSV import |
| `api/tests/integration/test_routings_import_api.py` | Routing CSV import |
| `api/tests/integration/test_shipment_customer_consistency.py` | Triggers reject cross-customer line items |
| `api/tests/integration/test_shipment_void_permutations.py` | Shipment void state-machine edge cases |
| `api/tests/integration/test_insights_chat.py` | AI insights endpoint (skips when `AI_READONLY_DATABASE_URL` unset) |
| `api/tests/integration/test_sql_executor.py` | Safe SQL execution for insights queries |

### Smoke

| File | Description |
|---|---|
| `api/tests/test_smoke.py` | Pytest-infrastructure sanity (collection, async, markers, exceptions) |

## E2E specs (4 files, 5 tests, 2 skipped)

| File | Tests | Status |
|---|---|---|
| `e2e/smoke.spec.ts` | 2 | Passing — dashboard load + login page accessibility |
| `e2e/quote-to-job.spec.ts` | 1 | Passing — quote create → job conversion (covers the May 2026 `jobs.status` regression path) |
| `e2e/parts-and-routing.spec.ts` | 1 | **Always-skipped** at line 95 (`test.skip(true, …)`); resolved by sub-PR 3g |
| `e2e/csv-import.spec.ts` | 1 | **CI-skipped** (`test.skip(!!process.env.CI, …)`); resolved by sub-PR 3g (Anthropic mock) |

## Known gaps (unchanged from [checklist.md](checklist.md))

### Untested components — sub-PR 3f+ targets

- `components/quotes/QuoteForm.tsx`
- `components/operations/OperationForm.tsx`
- `components/auth/Login.tsx`, `components/auth/SignUp.tsx`, `components/auth/CompanySelector.tsx`
- Import UI: `MappingReviewTable`, `ConflictDialog`, `ConfidenceChip`
- `components/vendors/VendorAutocomplete.tsx`

### Untested access files — sub-PR 3f+ targets

17 of 24 `utils/*Access.ts` files have no test file. Highest-impact:
- `bomAccess.ts` (2.67% coverage)
- `customerContactsAccess.ts` (1.78%)
- `markupRatesAccess.ts` (6.29%)
- `quoteLineItemsAccess.ts` (0%)
- `routingsAccess.ts` (1.34%)
- `partPricingTiersAccess.ts` (0%)

### Backend gaps

- `api/routes/operations_import_routes.py` (no direct test file)
- AI provider unit tests (`api/services/ai/*`)
- Import framework service unit tests
- RLS policies — sub-PR 3d

### E2E gaps

- Authentication flow (Login, SignUp, password reset, company selector)
- Quote lifecycle beyond the convert-to-job happy path
- Import workflows (csv-import covered only when 3g lands)

## How to run

```bash
# Frontend
pnpm test                                    # watch mode
pnpm test --run                              # one-shot
pnpm test --run --coverage                   # with coverage
pnpm test --run __tests__/<path>             # file-scoped

# Backend
cd api && pytest                             # all (with TEST_SUPABASE_URL set)
cd api && pytest tests/unit/                 # unit only
cd api && pytest -m integration              # integration marker

# E2E
pnpm test:e2e                                # full suite
pnpm exec playwright test e2e/<spec>.spec.ts --reporter=list
```
