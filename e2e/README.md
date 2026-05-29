# E2E Tests

End-to-end Playwright specs for Jigged. The suite runs against an
**ephemeral local Supabase stack** (Postgres + Auth + Storage + Realtime,
all booted via the Supabase CLI), a locally-running Next.js dev server,
the FastAPI backend, and a small Node HTTP mock for the Anthropic
Messages API. All four services are orchestrated by
[`e2e/run-stack.mjs`](./run-stack.mjs); see the `test:e2e:local` script
in `package.json`.

The CI workflow ([.github/workflows/e2e-tests.yml](../.github/workflows/e2e-tests.yml))
mirrors the local stack — no cloud preview required. Vercel preview
deploys still exist (created automatically by the Vercel-GitHub
integration) and remain useful for **manual** exploratory QA, but they
are no longer the substrate for any automated test.

## Prerequisites (once per machine)

```bash
# Supabase CLI + Docker (Docker Desktop must be running)
brew install supabase/tap/supabase
docker --version

# Playwright browsers
pnpm exec playwright install chromium
```

Python 3.12 with the API requirements installed (`cd api && pip install
-r requirements.txt`) — needed because `start-server-and-test` will
boot the FastAPI server.

## Running locally

```bash
# 1. Start Supabase in a separate terminal (replays migrations onto a
#    fresh local DB; takes ~30s the first time, ~5s after).
supabase start

# 2. Export the URLs + keys that Playwright + the dev server need.
#    The same exports the CI workflow performs.
eval "$(supabase status -o env)"
export TEST_SUPABASE_URL=$API_URL
export TEST_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY
export TEST_SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY
export NEXT_PUBLIC_SUPABASE_URL=$API_URL
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY
export SUPABASE_URL=$API_URL
export SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY
export ANTHROPIC_API_KEY=sk-mock-for-e2e
export ANTHROPIC_BASE_URL=http://localhost:9876

# 3. Run the suite (start-server-and-test handles the four-service dance).
pnpm test:e2e:local

# When done:
supabase stop
```

To debug a single spec interactively:

```bash
pnpm test:e2e:ui
```

To run one file directly (assumes you've already started Supabase + the
dev server + FastAPI + the mock yourself):

```bash
pnpm exec playwright test e2e/parts-and-routing.spec.ts --reporter=list
```

## Env contract

All env vars are exported per the **Running locally** snippet above. The
key ones, by consumer:

| Consumer | Vars |
|---|---|
| `e2e/global-setup.ts` | `TEST_SUPABASE_URL`, `TEST_SUPABASE_SECRET_KEY` — exits 1 if missing |
| Next.js dev server | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| FastAPI backend | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |
| Playwright auth.setup.ts | `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` (optional — defaults in `fixtures/test-data.ts` work for local Supabase) |

There is no longer an `E2E_TEST_COMPANY_ID` — the seed generates a fresh
company per local-Supabase boot. There is no longer a Vercel bypass
secret — local stack, no Vercel.

## What gets seeded

`e2e/global-setup.ts` runs against the local Supabase stack and (in
order):

1. Creates the test auth user (deterministic email/password from
   `fixtures/test-data.ts`).
2. Creates the test company (`E2E Test Company`).
3. Links the user to the company via `user_company_access` (role=admin).
4. Seeds the per-spec data graph:
   - 1 vendor — `E2E Test Vendor`
   - 2 work centers — `E2E Internal WC` (internal, labor_rate=100) and
     `E2E External WC` (external, vendor=above)
   - 1 customer — `E2E Test Customer`
   - 3 parts — `E2E-MFG-001` (manufacturable), `E2E-RAW-001` (stocked
     raw), `E2E-SUB-001` (BOM child)
   - 1 routing on `E2E-MFG-001` with one op at `E2E Internal WC`
   - 1 BOM edge: `E2E-MFG-001` → `E2E-SUB-001`
   - 2 pricing tiers on `E2E-MFG-001` so the quote spec resolves a tier

Every helper is find-or-insert, so re-running the seed against the same
local Supabase (without `supabase db reset`) is safe.

The seed shape covers what each spec needs:

| Spec | Needs |
|------|------|
| `parts-and-routing.spec.ts` | ≥1 work center (Autocomplete) |
| `quote-to-job.spec.ts` | ≥1 customer + ≥1 part with routing + pricing tier |
| `csv-import.spec.ts` | none (uploads its own CSV; AI provider is mocked) |
| `smoke.spec.ts` | none (login + dashboard render) |

## Anthropic API mock

`e2e/mocks/anthropic-server.cjs` is a tiny standalone Node HTTP server
on port 9876 that responds to `POST /v1/messages` with a canned
column-mapping JSON shaped for the `test-parts.csv` fixture. The Python
Anthropic SDK's client respects `ANTHROPIC_BASE_URL`, so setting it to
`http://localhost:9876` routes all FastAPI-side AI calls through the
mock. No real Anthropic credits consumed; no nondeterminism from a real
provider.

If the test CSV fixture changes column names, update the `MOCK_MAPPING`
in `anthropic-server.cjs` to match.

## Running against a non-local Supabase (advanced)

This used to be the default path; it's now an escape hatch. Set
`TEST_SUPABASE_URL` + `TEST_SUPABASE_SECRET_KEY` to a long-lived staging
project, set `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` to credentials for a
pre-provisioned user, and skip `supabase start`. Note that the seed
script creates a company and user-company-access link via service-role
— it will work against staging if you give it a real service-role key,
but the **CI workflow does not do this**; staging-running is a
developer-only debugging path. There is no automated test layer pointed
at cloud Supabase.
