# Testing Status & Checklist

**Last updated:** 2026-05-27 (sub-PR 3a of the testing infrastructure overhaul).

## Current state

| Suite | Files | Tests | Skipped | Notes |
|---|---|---|---|---|
| Frontend (Vitest) | 25 | 348 | 9 | `quotesAccess.test.ts` skips 9 cases across `createQuote`, `convertQuoteToJob`, and the `pending_approval` flow. Resolved by sub-PR 3c. |
| Backend (pytest) | 13 | 151 | varies | Several integration tests skip when `TEST_SUPABASE_URL` is unset (correct behavior post sub-PR #305). Local Supabase wires up in 3c. |
| E2E (Playwright) | 4 | 5 | 2 | `parts-and-routing.spec.ts:95` always-skips on seed gap; `csv-import.spec.ts:13` skips in CI (FastAPI requirement). Resolved by sub-PR 3g (deterministic local seed + Anthropic mock). |

## Coverage

Measured 2026-05-27 via `pnpm test --run --coverage`:

| Metric | Threshold (vitest.config.ts) | Actual |
|---|---|---|
| Statements | 45% | 47.4% ✅ |
| Branches | 45% | 42.3% ❌ |
| Functions | 45% | 43.44% ❌ |
| Lines | 45% | 48.64% ✅ |

Two metrics are currently below the configured threshold. Sub-PR 3e (CI hardening) makes `pnpm test --run --coverage` a CI gate — when that lands, every PR has to keep all four metrics green. Sub-PR 3f+ closes specific component gaps that bring branches/functions back above 45%.

Backend coverage is unmeasured. Sub-PR 3e adds `pytest --cov` to the workflow; the first commit of 3e measures, the second sets the enforced floor (measured-minus-5).

## Sub-PR sequence (PR 3 series)

| Sub-PR | Status |
|---|---|
| [3-pre](https://github.com/debola31/Jigged/pull/305) — Kill `conftest.py` prod fallback | ✅ Merged |
| **3a** — Docs hygiene + DB COMMENT cleanup migration | **In progress** |
| 3b — Migration rebaseline | Planned |
| 3c — Local Supabase via the CLI + RLS-fixture scaffolding + fix `quotesAccess.test.ts` skips | Planned |
| 3d — RLS policy tests | Planned |
| 3e — CI hardening (tsc + lint + enforced coverage thresholds) | Planned |
| 3f+ — Component coverage gaps (one PR per cluster) | Planned |
| 3g — E2E migrates to local Supabase + Anthropic mock | Planned |

The full plan lives in [`.claude/plans/i-d-like-to-do-radiant-token.md`](../../.claude/plans/i-d-like-to-do-radiant-token.md) (local-only; not committed).

## Coverage targets per module

| Module | Target | Current |
|---|---|---|
| Customers (`customerAccess`, `CustomerForm`) | 80% | `customerAccess` 31.81%, `CustomerForm` 51.11% |
| Parts (`partsAccess`, `PartForm`, `UnitOfMeasurementSelect`) | 80% | `partsAccess` 24.11%, `PartForm` 46.42%, `UnitOfMeasurementSelect` 79.59% |
| Quotes (`quotesAccess`, `quotePdf`, `quotePricingResolver`) | 80% | `quotesAccess` 33.33%, `quotePdf` 91.66%, `quotePricingResolver` not directly measured |
| Operator (`operatorAccess`) | 70% | not directly measured |
| Import (AI mapping, `csvParser`) | 70% | `csvParser` not directly measured |
| RLS Policies | 100% | 0% — sub-PR 3d |

These targets are aspirational. The enforced thresholds in [vitest.config.ts](../../vitest.config.ts) are the floor; per-module targets are how we drive 3f+ priorities.

## Quick reference

```bash
# Frontend
pnpm test                          # watch mode
pnpm test --run                    # one-shot
pnpm test --run --coverage         # coverage report (enforces thresholds in 3e)
pnpm test --run __tests__/<path>   # file-scoped

# Backend (requires TEST_SUPABASE_URL + TEST_SUPABASE_SECRET_KEY for integration tests)
cd api && pytest                   # all (unit tests + skipped integration if env unset)
cd api && pytest tests/unit/       # unit only
cd api && pytest -m integration    # integration marker

# E2E (Playwright)
pnpm test:e2e                      # full suite
pnpm exec playwright test e2e/<spec>.spec.ts --reporter=list
```

## Naming conventions

```
__tests__/components/{module}/{Component}.test.tsx
__tests__/utils/{util}.test.ts
__tests__/lib/{lib}.test.ts
api/tests/unit/test_{module}.py
api/tests/integration/test_{module}_api.py
api/tests/database/test_{topic}.py   # added in sub-PR 3d
e2e/{feature}.spec.ts
```

## When to write tests

Always: new API endpoints; form validation; business logic (status transitions, calculations); RLS policies; critical user flows (quote-to-job, parts-and-routing).

Optional: pure presentation components; third-party-library wrappers; one-off admin scripts.

## Known gaps (resolved in subsequent sub-PRs)

- **No RLS policy coverage.** Multi-tenant data isolation has zero automated tests. → 3d.
- **No backend coverage measurement in CI.** `pytest --cov` not yet wired. → 3e.
- **No tsc / lint in PR-time CI.** `next build` catches them on Vercel preview, but later than PR review. → 3e.
- **`quotesAccess.test.ts` skips.** 9 tests skipped across `createQuote`, `convertQuoteToJob`, and pending-approval flow. → 3c.
- **`parts-and-routing.spec.ts:95` always-skip.** Always-true skip on the cloud-staging seed gap. → 3g (deterministic local seed).
- **`csv-import.spec.ts:13` CI-skip.** Needs the FastAPI backend running, which CI doesn't provide. → 3g (Anthropic mock + start-server-and-test orchestration).
- **Untested components.** `QuoteForm`, `OperationForm`, `Login`, `SignUp`, `CompanySelector`, import UI (`MappingReviewTable`, `ConflictDialog`, `ConfidenceChip`), `VendorAutocomplete` — zero coverage today. → 3f+.
- **Untested access files.** 17 of 24 `utils/*Access.ts` files have zero test coverage. → 3f+.
