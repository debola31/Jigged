# E2E Tests

End-to-end Playwright specs for Jigged. Specs run against a deployed app
(local `pnpm dev` or a preview URL) and reuse one authenticated browser
session, seeded once per run via `global-setup.ts`.

## Env contract

Create `e2e/.env.test.local` (gitignored) with:

```bash
# Auth — used by e2e/auth.setup.ts to log in via the real UI AND by
# e2e/global-setup.ts to authenticate before seeding fixtures.
E2E_TEST_EMAIL=...
E2E_TEST_PASSWORD=...

# Seed config — global-setup.ts signs in as E2E_TEST_EMAIL and writes
# fixtures through RLS using the public anon key (no service-role
# secret in CI). The test user must have a user_company_access row for
# E2E_TEST_COMPANY_ID (any role — operator/user/admin all satisfy the
# RLS predicate).
SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ... (same value the browser uses)
E2E_TEST_COMPANY_ID=<uuid of the company E2E_TEST_EMAIL has access to>

# Optional — bypass Vercel Deployment Protection on preview URLs
VERCEL_AUTOMATION_BYPASS_SECRET=...
PLAYWRIGHT_TEST_BASE_URL=https://your-preview.vercel.app

# Optional — wipe seeded rows after the run (default: keep them so the
# next run is faster). Re-runs are always idempotent regardless.
E2E_TEARDOWN_SEEDED=1
```

If any of the seed-config variables are missing, `global-setup.ts`
prints the missing list and exits 1 — silent skipping left specs
failing with confusing "Autocomplete is empty" timeouts.

## What gets seeded

`e2e/global-setup.ts` find-or-inserts these rows into the test company
(every write tagged with `legacy_id = 'E2E_SEED_v1'` where the column
exists, otherwise matched by stable name):

- 1 vendor — `E2E Test Vendor`
- 2 work_centers — `E2E Internal WC` (kind=internal, labor_rate=100) and
  `E2E External WC` (kind=external, vendor=above)
- 1 customer — `E2E Test Customer`
- 3 parts — `E2E-MFG-001` (manufacturable), `E2E-RAW-001` (stockable raw),
  `E2E-SUB-001` (BOM child)
- 1 routing on `E2E-MFG-001` with 1 op at `E2E Internal WC`
- 1 BOM edge: `E2E-MFG-001` → `E2E-SUB-001`

The seed shape covers what each spec needs:

| Spec | Needs |
|------|------|
| `parts-and-routing.spec.ts` | ≥1 work center (Autocomplete) |
| `quote-to-job.spec.ts` | ≥1 customer + ≥1 part with routing |
| `csv-import.spec.ts` | none (uploads its own CSV) |
| `smoke.spec.ts` | none (login + dashboard render) |

## Running locally

```bash
# Install browsers (once)
pnpm exec playwright install chromium

# Run the full suite
pnpm test:e2e

# Open the UI for debugging a single spec
pnpm test:e2e:ui

# Run one file
pnpm exec playwright test e2e/parts-and-routing.spec.ts
```

The dev server (`pnpm dev`) is auto-launched by Playwright when not in
CI — see `playwright.config.ts`.

## Running against a Vercel preview

Set `PLAYWRIGHT_TEST_BASE_URL` to the preview URL and
`VERCEL_AUTOMATION_BYPASS_SECRET` to the bypass token from Vercel →
Settings → Deployment Protection → Automation Bypass. The spec headers
include both an `x-vercel-protection-bypass` HTTP header and a same-name
cookie for client-side navigations.
