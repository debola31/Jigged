# Testing

> **Consolidated 2026-08-03: 12 files, 12,461 words → this one, for [#634](https://github.com/debola31/Jigged/issues/634).**
> Six of the deleted files were **99–100% verbatim inside the old README** (measured line by
> line). The other four were a coverage dashboard whose every figure had been wrong for ten
> weeks — it claimed 25 frontend test files against 143, and 4 E2E specs against 14 — and an
> essay diagnosing five gaps that have all since closed.
>
> **The lesson, kept because it is the whole reason this directory rotted: never write a count
> here.** A number lives next to the thing that enforces it, or it does not get written down.
> `vitest.config.ts` has carried true thresholds with a dated ratchet log the entire time these
> docs were wrong about them.

This page holds only what nothing else owns. Everything else is a pointer, on purpose.

| You want | It lives in |
|---|---|
| Commands — run tests, pre-PR scope, E2E setup, worktree recipes, Vercel preview | **[CLAUDE.md](../../CLAUDE.md)** — "Running tests", "Pre-PR validation", "E2E gotchas" |
| Enforced coverage floors + the dated ratchet log | **[`vitest.config.ts`](../../vitest.config.ts)**, and `--cov-fail-under` in **[`test.yml`](../../.github/workflows/test.yml)** |
| What CI actually runs, in what order | **[`test.yml`](../../.github/workflows/test.yml)** and **[`e2e-tests.yml`](../../.github/workflows/e2e-tests.yml)** |
| E2E env contract and what the seed creates | **[`e2e/README.md`](../../e2e/README.md)** |
| What a module's tests are supposed to prove | that module's doc in **[`docs/modules/`](../modules/)** — each carries its own acceptance criteria |

---

## Where each layer lives

| Layer | Location | Runner | What belongs here |
|---|---|---|---|
| Frontend unit + component | `__tests__/`, mirroring the source tree (`app/`, `components/`, `hooks/`, `lib/`, `utils/`) | Vitest + Testing Library, jsdom | Pure logic, access-layer query shapes, component behaviour with the network mocked |
| Backend unit | `api/tests/unit/` | pytest | Pure functions, validators, service logic with no DB |
| Backend integration | `api/tests/integration/` | pytest, needs a local Supabase | Route behaviour, RLS, grants, billing gates — anything whose truth lives in Postgres |
| Database invariants | `api/tests/database/` | pytest, needs a local Supabase | RPC contracts and schema guards asserted directly |
| End-to-end | `e2e/` | Playwright against local Supabase | One real browser path per journey, including a reload to prove persistence |

Two directories under `__tests__/` are not mirrors and are worth knowing about:

- **`__tests__/schema/`** — parses `types/database.ts` and migration *text*, so drift that
  TypeScript cannot see still fails a build. **Withdrawn (2026-08-07):** that this is because
  "supabase-js's typed client stops resolving the largest nested selects and silently widens
  instead of erroring". It does not widen — it resolves them and emits `SelectQueryError`. What
  `tsc` genuinely cannot see is a **wrong foreign-key hint** (`notes!made_up_fk(…)` infers a
  plausible type and PostgREST 400s at runtime), and any drift at a site that casts the row or
  never reads the affected field. [architecture.md §6.1](../architecture.md) has the measurement.
- **`__tests__/standards/`** — scans component source for house-rule violations (see
  [interaction-standards.md](../interaction-standards.md)).

## The invariant guards

The strongest tests here do not pin one past behaviour — they **fail on any future violation**.
That shape is this repo's main defence against silent breakage, and it is the one worth copying:

| Guard | Asserts |
|---|---|
| `function_execute_leaks()` | No `SECURITY DEFINER` function in `public` is browser-executable unless allowlisted |
| `tenant_tables_missing_write_gate()` | Every `company_id` table is billing-gated or explicitly exempt |
| `definer_writers_missing_write_gate()` | A definer function writing a gated table calls `company_can_write` |
| `note_counter_write_leaks()` | Only `notes.body` is browser-updatable; the view counters are not |
| [`legalDocumentsCheck.ts`](../../scripts/legalDocumentsCheck.ts) | A published legal document's bytes AND its metadata are frozen; every file under `public/legal` is declared; the frozen text says the same words as the vendor export it came from |
| `terms_acceptance_write_leaks()` | No browser role can write `terms_acceptances`, and only `authenticated` can read it |
| `ai_call_write_leaks()` | Nothing but `service_role` and the AI worker can reach `ai_calls`; `service_role` cannot edit it; no permissive policy reaches a browser or AI-SQL role; **both append-only triggers actually exist**; RLS is on |
| `ai_job_write_leaks()` | The browser can read `ai_jobs` and never write it; `anon` and `jigged_ai_readonly` reach none of the three AI tables; the worker role holds nothing beyond claim/report; the billing write-gate is still applied |
| [`schemaEmbedCheck.ts`](../../scripts/schemaEmbedCheck.ts) | Every PostgREST `.select()` embed matches the real schema |
| [`interactionStandardsCheck.ts`](../../scripts/interactionStandardsCheck.ts) | No value-like placeholders, grey delete icons, or off-theme contained buttons |
| `types/database.ts` regen diff (in `test.yml`) | The committed types match what the migrations produce |

`ai_call_write_leaks()` also checks `pg_trigger` directly, which its ancestor does not:
`test_terms_acceptances_rls.py::test_the_append_only_trigger_exists_behind_the_grant` is named for
its triggers but asserts a guard that only inspects grants and policies, so it stays green whether
or not those triggers exist. A guard that cannot fail is worse than no guard, because it reads as
coverage.

Each keeps its allowlist **inside the guard**, so widening one is a reviewable diff rather than a
comment edit. Two habits are worth copying with it: an allowlist keyed `path::snippet` rather than
`path:line`, because line numbers shift; and a self-check asserting the scanner actually scanned
something, so it can never pass by finding nothing.

The rationale is stated best in `api/tests/integration/test_function_execute_grants.py`:
*"over-granting is completely silent. It raises no error, breaks no page… The only way this class
of defect is ever caught is by asserting it."*

## Backend tests against a local Supabase

Integration and database tests run against an **ephemeral local stack**. They never touch prod.

```bash
supabase start                      # Postgres + Auth + Storage, locally
eval "$(supabase status -o env)"    # exports API_URL / ANON_KEY / SERVICE_ROLE_KEY

TEST_SUPABASE_URL=$API_URL \
TEST_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY \
TEST_SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY \
  conda run -n jigged pytest -m integration
```

The local service-role key is a **fixed development default and publicly known** — not the prod
one — so using it for test setup is safe. CI does the same dance automatically.

### The JWT fixtures

[`api/tests/conftest.py`](../../api/tests/conftest.py) exposes three session-scoped fixtures every
tenancy test builds on. They exist because RLS can only be tested by a client that actually
carries a user's JWT — a service-role client bypasses the thing under test.

| Fixture | Yields |
|---|---|
| `seeded_user_a` | A user + company (member of A only), signed in: `{user, user_id, access_token, company_id, client}`, where `client` is an **anon-key** client carrying that user's JWT |
| `seeded_user_b` | The same, symmetric, on company B |
| `seeded_company_b_graph` | A parent-child object graph in company B — vendor, internal work center, customer, made part, routing + one operation — so cross-tenant tests have something real to fail to read |

[`api/tests/database/test_jwt_fixtures_smoke.py`](../../api/tests/database/test_jwt_fixtures_smoke.py)
proves the wiring. If it passes, the fixtures are sound and a failure elsewhere is a real one.

## Conventions

- **Name the behaviour, not the function.** `'throws when the readiness RPC fails, instead of
  returning []'` survives a rename and explains itself in a CI log; `'test getOperatorJobs'` does
  neither.
- **Every editable entity gets one `edit → save → reload → persists` path** — in E2E where one
  exists, otherwise the write path is unit-tested and the reload assertion is tagged
  `automation-pending` against [#367](https://github.com/debola31/Jigged/issues/367).
- **An error must surface, never collapse into an empty result.** A read that fails and renders
  "no rows" is the shape of the May 2026 `jobs.status` regression; assert the failure path, not
  only the happy one.
- **Docs cite a test file and its `describe`, with an `it` count — never a nested test title.** A
  title is a free-text string nothing checks, and an audit found up to two-thirds of such
  citations dangling. `docs/modules/customers.md` shows the compliant form.
- **Fix a flake by finding its cause.** The 2026-08 `InventoryCountPage` failure looked flaky and
  was a real race — a mount-time debounce resetting the page — reproducible only under CI load.
  Prove a fix in both directions: the test must fail without it.

## Known holes

Stated rather than implied, and deliberately without counts:

- **No E2E covers CSV import at all.** The one spec that did drove the retired per-entity
  `/parts/import` wizard and was deleted with it; the guided importer at `/import` has never had
  one — it is the `automation-pending (#367)` case below, and now the largest of them. *(This entry
  previously said the spec was CI-skipped for want of a FastAPI backend; it ran in CI from the point
  `e2e/run-stack.mjs` landed until the wizard was removed.)*
- **Reload-persistence E2E coverage is partial.** Many write paths cite a unit test plus an
  `automation-pending (#367)` tag instead; #367 is open and is the tracking issue.
- **Operator login and QR post-login routing have no automated coverage** (`postLoginPath`).
- **Nothing asserts the soft-delete rule** — that every list, search, picker and count filters
  `deleted_at IS NULL` while by-id reads deliberately do not. It has been stated in prose in ten
  places and enforced in none, and one of those copies was wrong for two weeks. This is the
  highest-value gap in the list.
