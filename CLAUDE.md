# Jigged - Manufacturing Data Platform

## Project Overview

Jigged is a web-based data platform for small-scale precision manufacturing shops. It centralizes jobs, inventory tracking, and shop-floor status with AI-driven insights. The operator app is deliberately minimal — record what you finished, write down what you learned.

**There is no gamification, and that is a rule rather than a gap.** No operator-facing surface may reflect an operator's pace or standing back at them — no counts, streaks, averages, points, badges or leaderboards — asserted by test. See [operator-view.md](docs/modules/operator-view.md#surveillance-guardrail-non-negotiable).

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

**Why:** we once had a header alert badge calling `/api/insights/{id}/dashboard`, firing 5 Anthropic calls on every dashboard page load. Users never saw the AI summaries — the bell icon only read the raw metric arrays. Credits ran out in days. (Both the endpoint and the badge have since been removed, but the failure mode is what matters.) Every new AI feature must pass the "what user action triggered this?" test before merging.

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

### Observability: Sentry owns errors, and never lies about them

Full runbook — CLI recipes, triage steps, and the traps that cost real debugging time — is
in **[docs/observability.md](docs/observability.md)**. Read it before touching Sentry config
or triaging an issue. The rules that bind while writing code:

- **Sentry is the error tracker; PostHog is product analytics.** Never add a second error
  tracker — `capture_exceptions` stays `false` in `instrumentation-client.ts`. Vercel has no
  JS error tracking at all, so it substitutes for neither.
- **Vercel Web Analytics (`<Analytics />` in `app/layout.tsx`) is kept on purpose**, even
  though it overlaps PostHog. It's the free tier and costs one script tag: basic pageview
  counts and Web Vitals with zero per-feature instrumentation. PostHog owns the journeys,
  funnels and retention. Don't remove either as "redundant".
- **Never pass a raw Supabase error to `Sentry.captureException`.** It rejects with a plain
  object, which Sentry can't fingerprint — you get an issue titled `"e"` and the real
  message buried in a `__serialized__` extra. Wrap it: `captureException(toError(err, '…'))`
  from [`lib/supabaseErrors.ts`](lib/supabaseErrors.ts).
- **"Couldn't check" is never "denied."** An access check that *fails* must not render as a
  definitive negative. `verifyCompanyAccess` swallowing errors into `return false` is how one
  dropped request showed "You don't have access to this company" to a user who did. Return a
  definitive answer only for a definitive result; otherwise throw and give the UI a distinct
  retryable state.
- **Transient aborts are not failures.** `AbortError: Lock was stolen` is `@supabase/auth-js`
  recovering an orphaned token-refresh lock — it means *superseded*, not *failed*. Classify
  with `isTransientAbortError` and retry; never report it, never surface it as an error.
- **The SDKs are off outside a production build** (`enabled: NODE_ENV === "production"`, and
  a `"pytest" in sys.modules` guard on the backend). Don't remove those — 90% of the issue
  queue was once this repo's own test runs, which is why nobody read the alerts.
- **Every `ignoreErrors` entry needs a recorded reason** in `docs/observability.md`. A queue
  you don't trust is worse than no queue.

**Two gotchas worth knowing before you debug for an hour:** `sentry alert issues edit` is
broken for this org (alert rules moved to the Workflow Engine — the old `rules/` endpoint is
retired), and `--json` returns `{"data": [...]}`, so `jq 'length'` silently counts object
keys. Both are covered in the runbook.

---

### Deletion is archive (soft-delete), and never blocks

Every user-facing entity (`parts`, `customers`, `vendors`, `work_centers`, `jobs`, `quotes`) has a nullable `deleted_at`. The UI "Delete" action sets `deleted_at` — it must **never** issue a hard `DELETE` and **never** block on a foreign-key reference. The row survives so quotes/jobs/shipments/BOMs that reference it keep resolving. See `docs/architecture.md` §16 for the full standard.

**How to apply when writing new code:**
- **Every list / search / picker / count / dashboard query must filter `deleted_at IS NULL`.** A missing filter silently leaks archived rows — the classic soft-delete bug. By-id reads (a detail page, a document's retained FK) intentionally do *not* filter.
- **Name is the identity: reuse revives, never duplicates.** Keep the `(company_id, name)` unique constraints FULL (not partial) — the importers upsert on them. A re-import (`deleted_at = None` in the payload) or a manual re-create (revive on `23505`) un-archives the existing row; only a collision with a *live* row is a duplicate error.
- **Don't re-introduce records-of-value delete guards.** Archiving preserves the record, so an invoiced/shipped job archives like anything else; money-record protection belongs only at a future permanent-purge step.

**Why:** the old model blocked deleting anything referenced (`ON DELETE RESTRICT`), trapping users (e.g. the "Delete (8395)" parts bulk-delete that refused every referenced part). Archive makes delete always work while keeping history intact.

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
3. **If the migration creates a table in `public`, grant it explicitly** — in the same migration, alongside `ENABLE ROW LEVEL SECURITY` and the policies. See "Data API grants" below. Without a `GRANT` the table is invisible to PostgREST/supabase-js and the FastAPI backend.
4. **Verify locally:** `supabase db reset` replays the baseline + migrations + `supabase/seed.sql` on a fresh local DB — run it plus the relevant tests. This is the deterministic check; there is **no staging project to push to anymore** (we run on Supabase Branching now).
5. **Open a PR.** Supabase Branching auto-creates a preview branch, applies the migration to it, and reports the **required migration status check**; the Vercel preview points at that branch's DB. If the check is red, fix the migration — it blocks merge.
6. **Merge to `main` deploys to production.** The merge *is* the deploy — Supabase auto-applies new migrations to prod. Do NOT run `supabase db push` (or `supabase link`) against prod manually; the branching pipeline owns it. The human still owns clicking merge.
7. After the merge has deployed, optionally run `python scripts/export_schema.py` to refresh the `supabase/schema.prod.sql` snapshot.

Never use the 8-digit date-only prefix for new files — always let the CLI generate the timestamp.

### Data API grants (new tables in `public`)

**Every new table in `public` needs explicit grants in its own migration.** Nothing is exposed to the Data API automatically any more — [`20260716025048_align_data_api_default_privileges.sql`](supabase/migrations/20260716025048_align_data_api_default_privileges.sql) revoked the default privileges that used to do it for you, matching what Supabase enforces on all projects from 2026-10-30 ([changelog #45329](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)).

Bundle the grants with the RLS + policy block, in the same migration as the `CREATE TABLE`:

```sql
CREATE TABLE public.your_table (...);
ALTER TABLE public.your_table ENABLE ROW LEVEL SECURITY;
CREATE POLICY ... ON public.your_table ...;

GRANT SELECT ON public.your_table TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO service_role;
```

**Grants and RLS are different layers.** A grant decides whether a role can touch the table *at all*; RLS decides *which rows*. RLS with no matching grant is unreachable, and a grant with no RLS policy is denied — you need both. Tailor the roles to the table:

- Most tables are member-scoped by RLS, and `anon` rarely needs more than `SELECT` (often nothing at all — drop the `anon` line if the table is never read logged-out).
- Backend-only tables (secrets, tokens) should grant `service_role` **only**, and explicitly `REVOKE` from `anon`/`authenticated` — see [`quickbooks_connections`](supabase/migrations/20260620122700_quickbooks_integration.sql#L50-L51).
- Do **not** write `REVOKE`-down-from-`ALL` to express intent. That idiom relied on the old permissive default having granted everything first; under the current default it revokes privileges that were never granted, leaving the table exposed to nobody.

**Symptom of a missing grant:** PostgREST returns `42501 permission denied`, and its error hint names the grant to add. Because local now matches prod, this fails in dev rather than only in production.

### Function EXECUTE grants (new functions in `public`)

**A new function is browser-callable unless you revoke it.** Postgres grants `EXECUTE` to `PUBLIC` on every function it creates, and `authenticated` is a member of `PUBLIC`. So a `SECURITY DEFINER` helper you intend as backend-only is reachable from the browser the moment it exists — and because that function bypasses RLS by definition, the grant is the *only* thing between a caller and the data.

To make one service-role-only, **name the roles**:

```sql
REVOKE EXECUTE ON FUNCTION public.your_function(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.your_function(uuid) TO service_role;
```

**Why the roles are named explicitly**, when `FROM PUBLIC` looks sufficient: until [`20260801024552`](supabase/migrations/20260801024552_revoke_function_execute_from_browser_roles.sql) the schema also carried `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon, authenticated`, so every new function landed with **explicit** browser grants on top of PUBLIC's. `REVOKE ... FROM PUBLIC` removed only PUBLIC's and left the rest, which meant eight migrations claimed "service-role only" in their comments and none of them were ([#640](https://github.com/debola31/Jigged/issues/640)). That default is now revoked, so `FROM PUBLIC` alone *is* enough today — the explicit form is kept because it is correct under either state and costs nothing.

Three cases need **no** grant at all, and revoking from them is free:

- **Trigger functions** — permission is checked when the trigger is created, not each time it fires.
- **Event-trigger functions** — same.
- **Helpers called only from `SECURITY DEFINER` parents** — the parent body runs as the function owner, so the caller's privileges are irrelevant.

Both non-obvious claims above are asserted behaviourally in [`test_function_execute_grants.py`](api/tests/integration/test_function_execute_grants.py), because getting them wrong breaks writes in production rather than failing loudly.

**Enforced in CI:** `function_execute_leaks()` lists any `SECURITY DEFINER` function in `public` a browser role can execute that is not on its reviewed allowlist, and a test asserts it is empty. Adding a function to that allowlist should come with a sentence in the PR saying why the browser needs to call it. **This guard exists because over-granting is silent** — it produces no error, no broken page, no symptom; `part_playbook_notes` was left `anon`-executable by a `DROP FUNCTION` for three days and nothing noticed. A `DROP FUNCTION` destroys a function's ACL *and* its `COMMENT`, so any migration that drops and recreates one must re-issue both.

### Billing write-gate (new tenant tables)

Entitlement is enforced at the DB layer: every browser-writable tenant table carries `billing_gate_*` restrictive RLS policies that call `company_can_write(company_id)`, so a lapsed/unsubscribed shop can't write (reads stay open). RLS is per-table — **a new `company_id` table without the gate silently bypasses billing.** When you add a tenant table:

- Gate it in the same migration (direct-`company_id` tables): `SELECT public.apply_billing_write_gate('public.your_table');` (parent-resolved child tables need hand-written policies resolving the parent's company — see the `stripe_write_enforcement` migration).
- Or, if it's genuinely exempt (identity/bootstrap or service-role-only), add it to the exempt list in `tenant_tables_missing_write_gate()`.

The CI test [`test_no_tenant_table_left_ungated`](api/tests/integration/test_billing_enforcement.py) fails if any `company_id` table is neither gated nor exempt — so a forgotten gate is a red build, not silent tech debt. Full standard: [docs/modules/billing.md](docs/modules/billing.md) §4. If you change the entitlement rule, change **both** `lib/entitlement.ts` `getEntitlement` and the SQL `company_can_write` (parity is tested).

### Schema source-of-truth

Two artifacts describe the database schema. They serve different purposes:

- `supabase/migrations/<timestamp>_baseline.sql` (and any migrations on top of it) is the source of truth for what *gets applied* to a fresh database — via `supabase start` / `db reset` locally, on every preview branch, and to prod on merge to `main`. This is the executable history. New schema changes land here as new migration files.
- `supabase/schema.prod.sql` is a *cached snapshot* of the live prod database at the time `scripts/export_schema.py` last ran. Regenerate after a merge has deployed to prod so the snapshot tracks reality. Never edit by hand — it gets clobbered on the next export.

Use the schema files for "what does column X look like today" lookups without spinning up Postgres. Use the baseline + migrations for "what should the schema be" answers and for any code path that actually creates the DB. They should match; if they don't, regenerate the schema file (don't edit the migration).

---

### Minimize unnecessary approval prompts (shell command hygiene)

Claude Code's permission allowlist matches on command **names/prefixes**, not on arbitrary code payloads. Two command shapes defeat the allowlist and force a manual approval even when every tool involved is already allowed — avoid them:

1. **Inline-code execution** — `python3 -c "…"`, `python -c`, `node -e "…"`, `psql … -c "<SQL>"`, `agent-browser eval`. These hand the shell an arbitrary code/query payload, which the permission system **always** confirms by design; no allow rule generalizes across payloads (each dialog only offers to allow that one exact snippet). Don't reach for them for routine work:
   - To inspect a file, use the `Read` tool, or `jq`/`grep`/`cat` — not `python3 -c "import json…"`.
   - **Never re-validate a file right after `Edit`/`Write`** — the tool already confirmed the write succeeded. That redundant `python3 -c` JSON check is the most common self-inflicted prompt.
   - For DB reads, prefer `psql "postgresql://…" -f <file.sql>` (a committed query file) over an inline `-c "<SQL>"`; keep any inline query to a single standalone command you accept will prompt once.

2. **Compound commands** — chaining with `&&`, `;`, `|`, or heredocs. Approval requires **every** segment to match an allow rule, so one un-allowable segment (e.g. an inline `eval`) forces the whole block to prompt — including the innocent `cd`/`echo` in front. Prefer single-purpose commands; never bury an inline-code step inside a chain.

Plain allowlisted single commands (`grep`, `cat`, `ls`, `find`, `awk`, `curl`, `git …`, `pnpm …`, `psql … -f`, etc.) run without prompting. Working in a **git worktree has no effect** on this — prompts are about command *shape*, not location.

---

## Design System: Jigged Manufacturing Data Platform (Material-UI)

> **Source of Truth:** `lib/theme.ts` contains all design values with inline documentation.
> **Detailed Reference:** `docs/design-system.md` explains principles and rationale.

**Framework:** Material-UI (MUI) v7+ with Material Design 3 principles

### Who uses what, on what — the device model

**There is no single "primary device". There are three surfaces, and two of them are ours.**
Corrected 2026-07-31 from founder observation: *"no one used a shop tablet in Contour or any
shop I've seen."* The docs had assumed shop-floor tablets throughout, and that was wrong.

| Surface | Who | Device | What follows from it |
|---|---|---|---|
| **Admin & User** — Storage, Parts, Quotes, Jobs, all data setup | owner, salesperson, scheduler | **Office computer**, mouse + keyboard | Hover is available. Drag is viable. Bundle weight is cheap (office wifi). Dense tables are fine. |
| **Operator** — jobs, scan, notes | shop floor | **Their own phone** | Touch only, no hover. Bundle weight is expensive (cellular). One-handed reach. Bright ambient light. |
| **Machine control** | machinist at the machine | The machine's own **HMI** (Haas, Fanuc, …) | **Not a Jigged surface at all.** We never render here; don't design for it. |

**How to apply:** decide which surface a change lands on before reasoning about its
interaction. The two mistakes this table exists to prevent are (a) rejecting a mouse
interaction on an admin screen because "touch is unreliable", and (b) treating a phone on
cellular as though it had an office connection.

Most existing touch rules survive the correction unchanged, because **a phone is at least as
constrained as a tablet** — the 48px floor, no hover-dependent UI, and high contrast all still
hold on the operator surface, and more strongly than before.

### Design Principles

1. **Professional, Not Trendy** - Must appeal to 50-60 year old shop owners. Focus on clarity and function.
2. **Substantial, Not Playful** - Industrial aesthetic. Cards should feel solid and grounded.
3. **Readable in Bright Environments** - Ensure sufficient contrast for use under bright fluorescent lighting, on a phone held on the shop floor.
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

### Runbooks — E2E, worktrees, previews

Those procedures live in **[docs/runbooks/local-dev-and-testing.md](docs/runbooks/local-dev-and-testing.md)**:
one-time E2E setup, running E2E or `pnpm dev` from a git worktree, visual verification on a
protected Vercel preview, and the E2E gotchas (the CI-skipped `csv-import` spec, why not to pass
`CI=1` locally, and how a worktree can silently test the *wrong branch*).

They moved out of this file on 2026-08-03: they are runbook rather than rule, and they cost every
session — including the many that never run E2E — about 4,300 tokens.
### Where the detailed docs live

- [docs/testing/README.md](docs/testing/README.md) — where each layer lives, the invariant
  guards, the local-Supabase JWT fixtures, conventions and known holes
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
| Observability (Sentry / PostHog / Vercel) | [docs/observability.md](docs/observability.md) |

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
- [Operator View](docs/modules/operator-view.md) — carries the operator journeys too
- [Machine Maintenance](docs/modules/machine-maintenance.md) (operator-logged machine logbook; flag-gated pilot with a written kill criterion)
- [Invitation System](docs/modules/invitation-system.md)
- [Data Import](docs/modules/data-import.md) (guided onboarding import — PRD + technical design in one doc)
- [Billing & Subscriptions](docs/modules/billing.md) (Stripe-hosted checkout/portal; DB-enforced entitlement)
- [Shipments](docs/modules/shipments.md)
- [Vendors](docs/modules/vendors.md)
- [AI Insights](docs/modules/ai-insights.md) (text-to-SQL chat; the table allow/denylist is a security boundary)
- [Demo Mode](docs/modules/demo-mode.md) (hidden per-company demo behind a mode toggle)

### Testing Documentation

See [docs/testing/](docs/testing/) for testing strategy and guides.

### Guidelines

- **Consult PRD** before implementing new features
- **Check module specs** for detailed requirements
- **Keep docs in sync** — update docs if implementation diverges

### Writing docs: the concision standard

Established by the [#634](https://github.com/debola31/Jigged/issues/634) condensation, which took
`docs/` from ~166,000 words to roughly half that. **Most information in the fewest words, losing
none of it.** The test is whether a reader gets the same decisions and constraints in a fraction
of the reading.

**The core rule: a claim no build can falsify will rot.** That is not a slogan, it is what the
audit measured. Update frequency did not predict accuracy — the two most-edited module docs both
rotted while the two least-edited stayed correct. Being edited in the same commit as the code did
not predict it either. What predicted it was whether a red build would have caught the claim
being wrong.

**What earns its tokens:** pitfalls; rationale; conventions that differ from tool defaults;
**withdrawn arguments**; measured numbers; "why not the obvious alternative"; named gaps.

**What does not:** anything derivable by reading the code — directory layouts, dependency lists,
architecture overviews, file-by-file descriptions, prose restating a function — and **counts of
anything**. Put a count next to the thing that enforces it, or do not write it. Every count in
`docs/testing/` was wrong by 3–6× for ten weeks while `vitest.config.ts` carried the true numbers
on the same line as the enforcement.

**Form.** Decision plus a one-line why. Superseded reasoning becomes one line
(`**Withdrawn:** <claim> — wrong because <reason>`) — never deleted, never expanded, because
recording that a reason was *wrong* is what stops the next person rebuilding on it. Prose becomes
a table when the content is really rows. Say it once and link the rest. Cite migration IDs and
file paths, never test titles. Use as-built framing with a verification date. **If you are
tempted to add length, add it as a table row.**

**Cite tests as file + `describe`, with an `it` count — never a nested `describe > 'it title'`
string, and never truncated with an ellipsis.** A title is free text nothing checks; one audited
section had 15 of 23 citations dangling. Every path a doc cites must exist.

**The failure mode to hunt for**, found in five of six docs condensed by hand: **a superseded
mechanic left standing beside its replacement**, usually within 100 lines, with nothing saying the
first one is dead. Deleting the dead half is the cheapest, highest-value edit available.

**Deletion is a first-class edit.** Every doc PR should say what it removes; an add-only change
needs a reason. Context files grow by accretion and are almost never pruned — that is how this
got to 166,000 words.

**Exemplars:** [inventory.md](docs/modules/inventory.md) (journey/decision),
[customers.md](docs/modules/customers.md) (reference), [billing.md](docs/modules/billing.md)
(invariant — as-built framing, a truth table, the load-bearing *why*, and an invariant named
against the CI test that enforces it).

**Not yet mechanical, and it should be.** Nothing checks that a cited path exists, that a link
resolves, or that a doc's copy of a list still matches the code — `ai-insights.md` drifted to
"20 tables" against a 19-element frozenset with one denylist entry missing. A link check plus a
cited-path check would catch that class; they belong with the guards this repo already runs
(`function_execute_leaks()`, `tenant_tables_missing_write_gate()`, `schemaEmbedCheck`).

