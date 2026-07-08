# Jigged - Manufacturing Data Platform

## Project Overview

Jigged is a web-based data platform for small-scale precision manufacturing shops. It centralizes jobs, inventory tracking, and shop-floor status with AI-driven insights and gamification for operators.

## Tech Stack

- **Frontend:** Next.js 16+ with TypeScript, Material-UI (MUI) v7+
- **Backend:** FastAPI (Python)
- **Database:** PostgreSQL on Supabase
- **Authentication:** Supabase Auth
- **Hosting:** Vercel

## API Architecture Rule

**Supabase-first architecture.** All simple CRUD operations go through the Supabase client (`utils/*Access.ts` files). The FastAPI backend (`api/`) is ONLY for:
1. AI-powered operations (requires API keys not safe for browser)
2. Operations requiring Supabase service role key (`auth.admin.*`, `auth.users` access)
3. Complex multi-step business logic (import pipelines with conflict detection)

**Do NOT create new FastAPI endpoints for standard CRUD.** See `docs/architecture.md` Section 8 for the full standard and decision checklist.

### Typed Supabase client (incremental adoption)

`lib/supabase.ts` exposes two getters that share one singleton:

- `getSupabase()` — untyped. Existing `utils/*Access.ts` files use this. Schema mistakes compile silently (this is how the May 2026 `jobs.status` regression shipped).
- `getTypedSupabase()` — `<Database>`-generic. Every `.from('table').select('...')` chain is checked against [`types/database.ts`](types/database.ts), generated from the **local** Supabase stack (migrations replayed) — see the regen + CI-enforcement note below.

**Use `getTypedSupabase()` for any new access function.** When converting an existing file, expect `tsc` to surface real bugs (column drift, narrow-enum mismatches, missing NOT-NULL columns on inserts) — fix them rather than papering over with `as any`. The [`schemaEmbedCheck`](scripts/schemaEmbedCheck.ts) test catches the embed-string class of drift today; typed mode catches everything else.

Regenerate types after every migration that changes columns — run it against a
running local stack (`supabase start`), since it now reads the local DB (not a
remote project):

```bash
pnpm gen:db-types  # wraps: supabase gen types typescript --local
```

CI enforces that the committed `types/database.ts` matches the migrations: the
backend job in [`.github/workflows/test.yml`](.github/workflows/test.yml)
regenerates types from the migration-replayed local stack and fails on any diff
(issue #406) — so a schema change without a regen, or a hand-edited types file,
goes red.

Because that check diffs a `--local` regen, the **generator version is pinned in
the `gen:db-types` script itself** (`npx supabase@<version>`), so your globally
installed `supabase` CLI can auto-update freely without ever affecting type
generation. The same version is pinned in the two CI workflows' `setup-cli`. To
move to a newer CLI, bump the version in **three places together** —
`package.json` (`gen:db-types`), `.github/workflows/test.yml`, and
`.github/workflows/e2e-tests.yml` — then `pnpm gen:db-types` and commit. Treat
`types/database.ts` like a lockfile.

---

## Engineering principles

### AI calls require an explicit user action

Anthropic calls cost real credits. Never invoke an AI endpoint (Claude, OpenAI, Gemini — anything that bills per token) from a `useEffect`, page load, route mount, auto-refresh, or polling loop. The user must have taken a deliberate action — clicked a button, submitted a question, explicitly requested a refresh.

This applies to every layer:
- Frontend: no `getDashboardInsights`-style fetches on mount. A bell icon, a dashboard page, a header component — none of them should trigger AI work just by rendering.
- Backend: no endpoint that generates AI summaries "on read" as a side effect. If an endpoint is called by a mounting component, it must not be able to reach a paid AI provider.
- Background jobs: fine, but must be infrequent (e.g. hourly or daily) and rate-limited per company. Never wire a background job to "on user login" or "on page view".

**Why:** we previously had `AlertBadge` → `/api/insights/{id}/dashboard` firing 5 Anthropic calls on every dashboard page load. Users never saw the AI summaries — the bell icon only read the raw metric arrays. Credits ran out in days. Every new AI feature must pass the "what user action triggered this?" test before merging.

**How to apply:** when adding an AI feature, the entry point must be a button, form submit, or explicit refresh gesture — not a lifecycle hook. If you need fresh data for a passive UI (badge counts, dashboards), compute it from Supabase without AI, or cache it in a dedicated table populated by a scheduled job. If you're unsure whether a code path can fire on mount, grep for `useEffect`/`onMount` callers and trace up from the AI call site.

---

### No silent runtime fallbacks for data-at-rest issues

If a schema change leaves existing rows in an inconsistent state (e.g. a new snapshot table that's empty for pre-existing records), **fix the data at rest** with a backfill migration. Do NOT paper over it with a "if empty, compute live" fallback in the access layer or UI. Fallbacks:

- Hide data-quality problems — you stop seeing the cases where the invariant was broken.
- Multiply sources of truth — two code paths to the same answer that can silently diverge.
- Accumulate as tech debt — each one "works" alone but they compound over time.

**The rule:** after a schema change, every existing row must satisfy the new invariant by the time the migration finishes. The read path should have a single clean shape with no branching on "what if the snapshot is missing."

If a backfill is genuinely impossible (truly lost history), prefer an explicit "no data available" UI state over a silent recomputation — it surfaces the gap rather than hiding it.

---

### Never make changes directly on the main branch

Always create a new feature branch before modifying code, schema, or configuration. No exceptions for "small fixes" or "hotfixes."

**Why:** Direct edits to main bypass code review, make rollbacks harder, and can clobber teammates' in-progress work. Feature branches keep history linear and reviewable.

**How to apply:** Before touching files, run `git checkout -b feature/<short-description>` (e.g., `feature/pricing-tiers-and-markup`). Commit with clear messages, push with `-u origin`, and open a PR for merge. If you're ever uncertain what branch you're on, check `git branch --show-current` before editing.

---

### Creating new database migrations

Always create migration files with `supabase migration new <slug>` (NOT by writing files into `supabase/migrations/` directly). The CLI generates a unique 14-digit timestamp (`YYYYMMDDHHMMSS`); writing files by hand with date-only prefixes can collide with same-day migrations and break `schema_migrations` tracking.

**Why:** the CLI tracks migrations by `(version, name)` in `supabase_migrations.schema_migrations`. Two files sharing a version collapse to one row, leaving the rest invisible to the tracker — `db push` then sees them as pending and tries to re-run them. We hit exactly this when legacy 8-digit date-prefixed files (`20260313_…`) accumulated multiple migrations per date.

**How to apply (workflow per change):**
1. `supabase migration new <slug>` — creates the file with a fresh 14-digit timestamp.
2. Write the SQL into the new file.
3. **Verify locally:** `supabase db reset` replays the baseline + migrations + `supabase/seed.sql` on a fresh local DB — run it plus the relevant tests. This is the deterministic check; there is **no staging project to push to anymore** (we run on Supabase Branching now).
4. **Open a PR.** Supabase Branching auto-creates a preview branch, applies the migration to it, and reports the **required migration status check**; the Vercel preview points at that branch's DB. If the check is red, fix the migration — it blocks merge.
5. **Merge to `main` deploys to production.** The merge *is* the deploy — Supabase auto-applies new migrations to prod. Do NOT run `supabase db push` (or `supabase link`) against prod manually; the branching pipeline owns it. The human still owns clicking merge.
6. After the merge has deployed, optionally run `python scripts/export_schema.py` to refresh the `supabase/schema.prod.sql` snapshot.

The remaining handful of 8-digit-prefixed legacy files (e.g. `20260314_grant_anon_waitlist.sql`) are grandfathered — leave them alone. Never reuse the 8-digit pattern for new files.

### Schema source-of-truth

Two artifacts describe the database schema. They serve different purposes:

- `supabase/migrations/<timestamp>_baseline.sql` (and any migrations on top of it) is the source of truth for what *gets applied* to a fresh database — via `supabase start` / `db reset` locally, on every preview branch, and to prod on merge to `main`. This is the executable history. New schema changes land here as new migration files.
- `supabase/schema.prod.sql` is a *cached snapshot* of the live prod database at the time `scripts/export_schema.py` last ran. Regenerate after a merge has deployed to prod so the snapshot tracks reality. Never edit by hand — it gets clobbered on the next export.

Use the schema files for "what does column X look like today" lookups without spinning up Postgres. Use the baseline + migrations for "what should the schema be" answers and for any code path that actually creates the DB. They should match; if they don't, regenerate the schema file (don't edit the migration).

---

## Design System: Jigged Manufacturing Data Platform (Material-UI)

> **Source of Truth:** `lib/theme.ts` contains all design values with inline documentation.
> **Detailed Reference:** `docs/design-system.md` explains principles and rationale.

**Framework:** Material-UI (MUI) v7+ with Material Design 3 principles

### Design Principles

1. **Professional, Not Trendy** - Must appeal to 50-60 year old shop owners. Focus on clarity and function.
2. **Substantial, Not Playful** - Industrial aesthetic. Cards should feel solid and grounded.
3. **Readable in Bright Environments** - Ensure sufficient contrast for use under bright fluorescent lighting on tablets.
4. **Single Dark Theme** - Optimized for shop floor environments with consistent dark UI.

### Quick Reference

| Element | Approach |
|---------|----------|
| Colors | Use theme palette (`color="primary"`) - never hardcode |
| Spacing | Use `theme.spacing(n)` - never hardcode pixels |
| Cards | Use default `<Card elevation={2}>` - theme handles glassmorphism |
| Touch targets | Minimum 48px (theme enforces this) |

### Component Guidelines

**Always use MUI components:**
- `Button`, `TextField`, `Card`, `Paper`, `Box`, `Typography`
- `List`, `ListItem`, `ListItemButton`, `ListItemText`
- `Alert`, `CircularProgress`, `Chip`
- `Container`, `Grid`, `Stack`

**Styling approach:**
- Use MUI's `sx` prop for component-level styles
- Let cards use theme defaults - don't override backgrounds unless necessary
- Never use external CSS files for MUI components
- Never use plain HTML elements when MUI equivalents exist

**Standard elevation values:**
- `2`: Standard cards (default)
- `3`: Auth cards, modals
- `4`: App bar, floating elements

### Page Layout Patterns

**IMPORTANT:** All dashboard pages must follow consistent layout patterns. The page title is displayed in the top Header component, so pages should NOT include redundant inline titles.

**List Pages (e.g., Parts, Customers, Resources):**
```tsx
<Box>
  {/* Toolbar - single row */}
  <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
    <TextField placeholder="Search..." size="small" sx={{ width: 300 }} />
    <Box sx={{ flex: 1 }} />  {/* Spacer */}
    <Button variant="outlined">Import</Button>
    <Button variant="contained">New Item</Button>
  </Box>
  {/* Content (cards, tables, etc.) */}
</Box>
```

**Create/Edit Pages:**
- Use `<Box>` container with NO padding (layout provides padding)
- Do NOT add inline page titles - the Header component displays the title
- Render the form component directly

**Import Pages:**
- Use `<Box>` container with NO padding
- Include a simple "Back" button at top left (no redundant page title)
- Content follows below

### Mobile/Shop Floor Requirements

1. **Large Touch Targets:** Minimum 48px height for buttons/inputs
2. **Readable Text:** Minimum 16px font size for body text
3. **Simple Navigation:** Use bottom navigation for primary actions on mobile
4. **QR Code Scanning:** Design with large scanning area
5. **Landscape Support:** Ensure job details are usable in landscape mode

### Accessibility (WCAG 2.1 Level A)

- Color contrast: Text on background minimum 4.5:1
- Large text (18pt+): Minimum 3:1
- All elements keyboard accessible with visible focus indicators
- Touch targets: Minimum 48px x 48px
- Use semantic HTML and proper ARIA labels

---

## Multi-Tenancy Model

Jigged is a multi-tenant SaaS application where each company's data is isolated, but a single user can have access to multiple companies.

### Database Schema

```sql
-- Companies table
companies (id, name, created_at, updated_at)

-- User-Company access junction table
user_company_access (id, user_id, company_id, role, created_at)

-- User preferences
user_preferences (id, user_id, last_company_id, created_at, updated_at)
```

### URL Structure

All app routes include a `companyId` to ensure data isolation:
- `/dashboard/{companyId}`
- `/dashboard/{companyId}/parts`
- `/dashboard/{companyId}/parts/{partId}` -- Part detail; routing (operations + materials) is edited inline on this page
- `/dashboard/{companyId}/quotes`
- `/dashboard/{companyId}/jobs`
- `/dashboard/{companyId}/operations`

### Auth Flow

1. User logs in
2. System checks companies user has access to
3. If 1 company: Direct to `/dashboard/{companyId}`
4. If multiple companies + has last_company_id: Direct to that dashboard
5. If multiple companies + no preference: Show company selector
6. If no companies: Show no-access page

---

## Project Structure

```
/
├── app/                      # Next.js App Router pages
│   ├── layout.tsx           # Root layout with providers
│   ├── page.tsx             # Home page (redirects)
│   ├── login/               # Login page
│   ├── signup/              # Sign up page
│   ├── select-company/      # Company selector
│   ├── no-access/           # No access page
│   └── dashboard/[companyId]/ # Dashboard (protected)
│       ├── parts/                 # Routing edited inline on the part detail page
│       ├── quotes/
│       ├── jobs/
│       └── operations/
├── components/
│   ├── auth/                # Auth-related components
│   ├── providers/           # Context providers
│   ├── parts/
│   │   ├── PartRoutingPanel.tsx       # Inline auto-save routing editor on the part page
│   │   └── ...                        # PartForm, etc.
│   ├── routings/            # Linear routing builder (no React Flow, no DAG)
│   │   ├── RoutingBuilder.tsx         # Side-by-side operations + materials lists
│   │   ├── RoutingOperationsList.tsx  # Reorder-by-arrow list of operation rows
│   │   ├── RoutingOperationRow.tsx    # Compact one-line row with modal-edit
│   │   ├── RoutingMaterialsList.tsx   # Modal-driven list of routing-level materials
│   │   ├── RoutingMaterialRow.tsx     # Compact one-line material row
│   │   ├── RoutingViewer.tsx          # Read-only routing display (used by ViewRoutingModal)
│   │   ├── AddOperationModal.tsx      # Operation picker + setup/run time inputs
│   │   └── AddMaterialModal.tsx       # Inventory item picker + qty/unit inputs
│   └── jobs/
│       ├── JobMaterialsCard.tsx  # Job-level materials (expected + actual consumption)
│       └── ...                   # OperationsPanel, OperationCard, etc.
├── lib/
│   ├── theme.ts            # MUI theme configuration
│   ├── agGridTheme.ts      # AG Grid theme (matches MUI theme)
│   └── supabase.ts         # Supabase client
├── utils/
│   └── companyAccess.ts    # Company access helpers
└── api/                     # FastAPI backend
    └── index.py
```

Routings are a linear, reorderable list of operations. They live **inline on the part detail page** — there is no separate `/routing/new` or `/routing/edit` page or wizard. The `PartRoutingPanel` component embeds Operations + Materials cards side-by-side and auto-saves every change via `saveRoutingWithOperationsAndMaterials`. Reordering uses up/down arrow buttons (no drag-and-drop). Operation add/edit goes through `AddOperationModal` (operation + setup + run time on one screen). Materials are routing-level (`routing_materials` table) and snapshot into `job_materials` when a job is created.

---

## Environment Variables

```bash
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

---

## Development Commands

> **Backend Python runs in the `jigged` conda environment.** Always use it
> (`conda run -n jigged <cmd>` or activate it) for `python index.py`, `pytest`,
> and backend scripts — the system `python3` lacks the API deps. Never create
> per-repo venvs.

```bash
# Install dependencies
pnpm install

# Run frontend dev server
pnpm dev

# Run backend dev server (separate terminal) — jigged conda env
cd api && conda run -n jigged python index.py

# Build for production
pnpm build
```

### Local dev data (seeding)

`supabase/seed.sql` is the canonical dev / preview seed — a rich "Vanguard
Precision Works" company (parts + multi-level BOMs, inventory, customers,
quotes → jobs → operations → shipments, activity) with **dynamic dates** (jobs
and quotes are always current, computed via `now() - interval`) and fixed
UUIDs. It runs automatically on `supabase db reset` and on every Supabase
preview-branch creation:

```bash
supabase db reset   # replays migrations + supabase/seed.sql   (alias: pnpm seed)
```

Login: `dev@jigged.test` / `jigged-dev-1234`. It writes `auth.users` directly,
so it is **local / preview only** — never run against prod. (Replaced the old
`scripts/seed-dev.ts`.)

---

## Running tests

The repo has three test runners. Use these directly — don't invent
new harness commands.

```bash
# Frontend unit / component tests (Vitest, watch mode)
pnpm test

# Vitest: run once (CI-style), with coverage, or via UI
pnpm exec vitest run
pnpm test:coverage
pnpm test:ui

# Backend API tests (pytest; from /api)
# ALWAYS use the "jigged" conda env — it has all backend deps. Do NOT create a new
# venv (python -m venv / virtualenv); use `conda run -n jigged <cmd>` or activate it.
cd api && conda run -n jigged pytest                      # full suite
cd api && conda run -n jigged pytest tests/unit/          # only unit tests
cd api && conda run -n jigged pytest -m integration       # integration marker (needs DB)

# Type-check the whole frontend (no emit)
pnpm exec tsc --noEmit -p tsconfig.json

# Lint
pnpm lint

# E2E (Playwright)
pnpm test:e2e                                                 # full suite
pnpm test:e2e:ui                                              # interactive UI mode
pnpm exec playwright test e2e/<spec>.spec.ts --reporter=list  # one spec, clean output
pnpm exec playwright test e2e/<spec>.spec.ts --headed --debug # step-through
```

### Pre-PR validation (smart-scope)

Don't run "everything" before every PR. `next build` (which Vercel runs on
every preview) already type-checks and lints, so re-running those locally
is mostly redundant. The actual local-vs-CI gap is **tests** — Vitest,
pytest, and Playwright run only in the CI workflows ([test.yml](.github/workflows/test.yml),
[e2e-tests.yml](.github/workflows/e2e-tests.yml)). Match the local check
to what the change actually risks breaking. CI remains the authoritative
gate; this is just to shorten the feedback loop before push.

| Change | Run before opening PR |
|---|---|
| Component / page / logic in `app/`, `components/`, or `lib/` | `pnpm test --run __tests__/<path>.test.ts` (file-scoped). Fall back to full `pnpm test --run` if the change is to a widely-imported helper. |
| `utils/*Access.ts` or other Supabase access | `pnpm exec tsc --noEmit -p tsconfig.json` + matching `pnpm test --run __tests__/utils/<file>.test.ts`. |
| Backend (`api/**/*.py`) | `cd api && pytest tests/unit/test_<area>.py` (or `pytest -m unit` for the fast suite). |
| `supabase/migrations/*` schema work | `supabase db reset` (replays the migration + seed on a fresh local DB) and skim for errors; the PR's preview branch is the real gate. Spot-check any access layer that touched the changed columns/tables. |
| `e2e/*.spec.ts`, or UI on a path a spec exercises (parts page, routing builder, auth flow) | Run the affected spec only: `pnpm exec playwright test e2e/<spec>.spec.ts --reporter=list`. |
| Doc / config / CI YAML / `.gitignore` / `scripts/` | Skip pre-PR validation. CI is the right gate. |

Use **copy-pasteable, file-scoped** commands — `pnpm test --run __tests__/utils/partsAccess.test.ts`,
not "run the tests". File-scoped runs in seconds; project-wide takes minutes
and trains everyone to ignore the result.

Anti-patterns to skip:

- **Running the full E2E suite before every PR.** `next build` already
  covers what's deterministic, and the failures you'd find are usually
  env drift you can't fix from this side. The `csv-import` spec also
  needs the FastAPI backend running locally — see E2E gotchas below.
- **Re-running tsc / lint for doc-only PRs.** The build catches them
  anyway, and the runs add nothing.
- **Treating "local pass + CI fail" as a code bug.** That's expected env
  drift (cache state, machine differences, parallelism). Read the CI log
  and fix the actual failure; don't try to make local mirror CI exactly.

If unsure what the change touches: tsc is the universally-cheap default
(~15s, runs on the whole frontend). Backend changes get one
`pytest -m unit` (~few seconds). Anything beyond that should be motivated
by the specific change.

### E2E setup (only needed once per machine)

```bash
# Install the Chromium build Playwright uses
pnpm exec playwright install chromium
```

E2E runs against an **ephemeral local Supabase** (`supabase start`), not
staging. `e2e/global-setup.ts` provisions the test user, company, and the
whole data graph itself (find-or-insert) with the local **service-role** key
— so no committed login is needed, only two env vars taken from the running
local stack:

- `TEST_SUPABASE_URL` = `API_URL` from `supabase status`
- `TEST_SUPABASE_SECRET_KEY` = `SERVICE_ROLE_KEY` from `supabase status`

These are the local stack's keys and **rotate every `supabase start`** — fetch
them fresh via the CLI, never hardcode. Standard local run (what
`.github/workflows/e2e-tests.yml` does in CI):

```bash
supabase start                        # one local Postgres + Supabase stack
eval "$(supabase status -o env)"      # exports API_URL / ANON_KEY / SERVICE_ROLE_KEY
export TEST_SUPABASE_URL=$API_URL
export TEST_SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY
export NEXT_PUBLIC_SUPABASE_URL=$API_URL          # point the app at the same stack
export NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
pnpm exec playwright test --grep-invert "CSV Import"
```

Playwright auto-launches `pnpm dev` on `localhost:3000` when not in CI
(see `playwright.config.ts`); reuses an existing dev server if one is
already running.

### Running E2E (or `pnpm dev`) from a git worktree

Git worktrees do **not** inherit gitignored files, so a fresh worktree has no
`.env.local` (or any `.env*`). `pnpm dev` and anything that reads Supabase
creds will fail until you pull them from the **primary checkout** (the first
entry in `git worktree list`). Do this once at the top of a worktree session:

```bash
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
cp "$PRIMARY/.env.local" .                   # dev-server Supabase creds
[ -f "$PRIMARY/.env.test.local" ] && cp "$PRIMARY/.env.test.local" .
[ -f "$PRIMARY/e2e/.env.test.local" ] && cp "$PRIMARY/e2e/.env.test.local" e2e/
```

They land gitignored in the worktree, so they're never committed. Note the
**E2E local-Supabase vars are *not* copied** — `TEST_SUPABASE_URL` /
`TEST_SUPABASE_SECRET_KEY` come from `supabase status -o env` of the running
local stack (above), so they're correct in any worktree without copying.
(Claude can run `supabase status -o env`, and `supabase start` if the stack
isn't up, to fetch them — they're local-only, not secrets.)

**Node deps + Python env in a worktree.** `node_modules` is gitignored too, so
a fresh worktree has none — run `pnpm install` **inside the worktree** (fast:
pnpm hardlinks from its global store, so it's correct for that branch's exact
deps and costs almost no extra disk). Do **not** symlink the primary's
`node_modules` — it silently breaks when a branch's deps differ, and a stray
`pnpm install` would mutate the primary. Backend Python uses the shared
`jigged` conda env (`conda run -n jigged …`) — nothing to install per worktree.

```bash
pnpm install                                       # node deps for THIS worktree
conda run -n jigged python -m pytest tests/unit/   # backend tests, jigged env
```

**The local Supabase stack follows the _primary_ checkout's branch, not your
worktree.** `supabase start` / `supabase db reset` replay the migrations on the
branch checked out in the **primary** working tree (the first entry in
`git worktree list`) — a linked worktree's un-merged migrations are **not** on
the local stack. So when working from a worktree:

- **No migration changes in your branch?** The local stack is a valid substrate
  — run `pnpm dev`, unit tests, and E2E against it from the worktree normally.
  This is why a UI/logic-only change can be fully verified locally from a
  worktree (the schema it needs already exists).
- **Your branch adds or edits migrations?** Verify them on the PR's Supabase
  **preview branch**, which applies the migration to its own isolated DB —
  that's the gate. Do **not** try to reproduce them on the local stack from a
  worktree: checking the branch out in the primary tree or `db reset`-ing to
  pick them up just confuses what the local stack represents (and mutates the
  primary's checkout). Keep migration verification on the preview branch.

### E2E gotchas

- **`csv-import` spec skips in CI** via `test.skip(!!process.env.CI)`.
  Locally it requires the FastAPI backend (`cd api && python index.py`)
  for AI column analysis — without it, the spec fails with
  `Failed to fetch (localhost:8000)`. Filter with
  `--grep-invert "CSV Import"` if you don't want to run it.
- **CI mirror locally:** `pnpm exec playwright test --grep-invert "CSV Import"`
  reproduces the CI-equivalent outcome (5 passing).
- Don't pass `CI=1` to simulate CI locally — `playwright.config.ts`
  disables the auto-launched dev server in CI mode, so nothing serves
  on `localhost:3000`.
- **Seed contract:** any new spec that depends on a particular data
  shape (pricing tiers, routings, BOM rows, addresses, …) should
  extend `e2e/global-setup.ts` rather than runtime-skipping. Skips
  hide real regressions — see the `jobs.status` prod incident
  (May 2026) where a runtime-skipped spec masked a broken SELECT.

### Where the detailed docs live

- [docs/testing/](docs/testing/) — strategy + guides per layer
  ([README](docs/testing/README.md), [e2e.md](docs/testing/e2e.md),
  [frontend-setup.md](docs/testing/frontend-setup.md),
  [backend-setup.md](docs/testing/backend-setup.md),
  [cicd.md](docs/testing/cicd.md))
- [e2e/README.md](e2e/README.md) — env contract + what the seed creates

---

## Documentation

Product documentation is version-controlled in the `/docs` folder.

### Key Documents

| Document | Path |
|----------|------|
| Product Requirements | [docs/prd.md](docs/prd.md) |
| System Architecture | [docs/architecture.md](docs/architecture.md) |
| Design System | [docs/design-system.md](docs/design-system.md) |
| Build Sequence | [docs/build-sequence.md](docs/build-sequence.md) |

### Module Specifications

See [docs/modules/](docs/modules/) for detailed module specs:
- [Customers](docs/modules/customers.md)
- [Parts](docs/modules/parts.md)
- [Quotes](docs/modules/quotes.md)
- [Jobs](docs/modules/jobs.md)
- [Invoicing](docs/modules/invoicing.md)
- [Work Centers](docs/modules/work-centers.md) (formerly Operations)
- [Dashboard](docs/modules/dashboard.md)
- [Routings](docs/modules/routings.md)
- [Inventory](docs/modules/inventory.md)
- [Operator View](docs/modules/operator-view.md)
- [Invitation System](docs/modules/invitation-system.md)

### Testing Documentation

See [docs/testing/](docs/testing/) for testing strategy and guides.

### Guidelines

- **Consult PRD** before implementing new features
- **Check module specs** for detailed requirements
- **Keep docs in sync** - update docs if implementation diverges

