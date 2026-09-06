# Jigged — Manufacturing Data Platform

Web platform for small precision manufacturing shops: jobs, inventory, and shop-floor status.
Next.js 16 + TypeScript + MUI v7 · FastAPI · Postgres on Supabase · Vercel. Versions live in
`package.json`, the system picture in [docs/architecture.md](docs/architecture.md), the doc index in
[docs/README.md](docs/README.md), the doc-writing standard in
[docs/writing-docs.md](docs/writing-docs.md), enforced in CI by
[`scripts/docLinkCheck.ts`](scripts/docLinkCheck.ts).

**There is no gamification, and that is a rule rather than a gap.** No operator-facing surface may
reflect an operator's pace or standing back at them — no counts, streaks, averages, points, badges
or leaderboards. Tests assert this only on surfaces that already exist, so a new operator page with
a counter ships green — apply it as a design constraint, don't wait to be caught. Why:
[operator-view.md](docs/modules/operator-view.md#surveillance-guardrail-non-negotiable).

## API and data access

**Supabase-first.** Simple CRUD goes through the Supabase client (`utils/*Access.ts`); the FastAPI
backend (`api/`) is only for the four criteria in
[architecture.md §8.1](docs/architecture.md#81-when-to-use-fastapi-backend) — AI operations,
service-role work (`auth.admin.*`), complex multi-step logic, third-party secrets or inbound
webhooks. **Do not add a FastAPI endpoint for standard CRUD.**

**Every app route is company-scoped** (`/dashboard/{companyId}/…`) but isolation is enforced by RLS
over `user_company_access`, not by the URL. A user may hold several companies, with roles
`admin | user | operator`; operators land on `/operator/{companyId}`
([`homePathForRole`](utils/companyAccess.ts) · [architecture.md §3](docs/architecture.md)).

**`getSupabase()` is the only client getter, and it is always typed** against
[`types/database.ts`](types/database.ts). **Never reintroduce an untyped view of it, and never
launder a row through `as unknown as`** — both erase the query result, which is how the May 2026
`jobs.status` regression shipped. **Regenerate types after any migration that changes columns**
(`pnpm gen:db-types`; CI fails on a diff). [architecture.md §6](docs/architecture.md).

### AI calls require an explicit user action

Anthropic calls cost real credits, and **nothing enforces this** — it is prose and a code review.
**Never invoke an AI endpoint from a `useEffect`, page load, route mount, auto-refresh or polling
loop**; the entry point must be a button, form submit or explicit refresh; background jobs only if
infrequent and rate-limited per company. For passive UI (badges, dashboards) compute from Supabase
without AI, or cache in a table a scheduled job fills. **The job-queue carve-out (2026-08-25)**
added two polling loops, so the boundary is that **a poll may DISCOVER work, never CREATE it.** Only
an authenticated handler acting on a user action creates an `ai_jobs` row, after the flag and the
rate limit; the worker's claim poll calls no model on an empty queue. **A new poller that can
enqueue is the thing to refuse.**

### No silent runtime fallbacks for data-at-rest issues

If a schema change leaves existing rows inconsistent, **fix the data at rest** with a backfill
migration — never an "if empty, compute live" fallback in the access layer or UI, which hides the
problem behind two code paths that can diverge. Every row must satisfy the new invariant when the
migration finishes, and the read path should have one shape with no "what if it's missing" branch;
where a backfill is truly impossible, say "no data available".

### Telemetry: Sentry owns errors, PostHog owns behaviour, and neither lies

**[docs/telemetry.md](docs/telemetry.md) owns this** — the registry, what reports itself versus what
you capture by hand, `toError`, retryable access checks, transient aborts and the production-only
SDK guards. Three rules bind everywhere:

- **Sentry is the error tracker; PostHog is product analytics.** Never add a second error tracker,
  and **keep Vercel Web Analytics (`<Analytics />`)** despite the PostHog overlap.
- **Every `posthog.capture()` needs a row in the event registry, and CI enforces it both ways** — a
  capture with no row fails, a row nothing sends fails too. Names are `[object] [verb]` (`quote
  created`); properties are `snake_case` and describe the interaction's *shape* (counts, booleans,
  enums), **never the customer's business data**. Guard:
  [`scripts/analyticsEventsCheck.ts`](scripts/analyticsEventsCheck.ts).
- **That check cannot tell you that you forgot to instrument** — a feature in neither code nor
  registry passes green, which is how one shipped unmeasured for months. A PR adding a user-facing
  write adds a row or says why not.

### Deletion is archive (soft-delete), and never blocks

Every user-facing entity has a nullable `deleted_at`. "Delete" sets it — **never** a hard `DELETE`,
**never** blocked by a foreign key; referencing documents keep resolving, and an invoiced job
archives like anything else ([architecture.md §16](docs/architecture.md)).

- **Every list / search / picker / count / dashboard query must filter `deleted_at IS NULL`.** By-id
  reads intentionally must **not**.
- **Name is identity, and its constraints stay FULL, not partial** (importers upsert on them), so a
  `23505` differs by entity: customers, vendors and work centres **revive** the archived row;
  **parts do not** — the namesake is renamed `<name> (archived)` on the collision, never on archive,
  and a NEW part takes it
  ([`reclaim_part_name`](supabase/migrations/20260818141141_reclaim_archived_part_name.sql)).

**Nothing enforces this for app code** ([#687](https://github.com/debola31/Jigged/issues/687)) and
it is the most-violated rule in the repo — a missing filter is silent (live: #682, #684). **The
insights AI is exempt because RLS enforces it there**: `ai_readonly_select` policies carry the
filter and `ai_policies_missing_soft_delete_filter()` fails CI without it, so **don't add it in
`semantics.md` or `SCHEMA_CONTEXT`**.

### Never make changes directly on the main branch

Branch before modifying code, schema or config — no exceptions for "small fixes". `git checkout -b
<prefix>/<short-description>`, using `feature/`, `fix/`, `docs/` or `chore/`. **`main` is not
branch-protected**, so this rule is the only barrier; check `git branch --show-current`.

## Database changes

Procedure, pipeline and the 2026-08-03 outage:
**[docs/runbooks/database-migrations.md](docs/runbooks/database-migrations.md)**. **Always create
the file with `supabase migration new <slug>`** — hand-written date-only prefixes collide and break
`schema_migrations` tracking. Verify with `supabase db reset` before the PR.

### Grants for new tables and functions in `public`

**Grants and RLS are different layers**: RLS with no grant is unreachable, a grant with no policy is
denied — you need both. **A new table in `public` needs explicit grants in its own migration** — the
permissive defaults were revoked — bundled with the RLS + policy block:

```sql
GRANT SELECT ON public.your_table TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO service_role;
```

`anon` often needs nothing, and backend-only tables grant `service_role` only — but never write
`REVOKE`-down-from-`ALL` to express that, as it now revokes privileges never granted. **Symptom of a
missing grant:** PostgREST `42501`. Conversely **a new function is browser-callable unless you
revoke it**: `EXECUTE` goes to `PUBLIC`, which includes `authenticated`, and a `SECURITY DEFINER`
helper bypasses RLS — so that grant is the *only* thing between a caller and the data. Make one
service-role-only by **naming the roles**:

```sql
REVOKE EXECUTE ON FUNCTION public.your_function(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.your_function(uuid) TO service_role;
```

CI's `function_execute_leaks()` flags any left reachable, against a reviewed allowlist — don't green
it by adding your function without justifying it in the PR. **A `DROP FUNCTION` destroys the ACL and
the `COMMENT`**; a migration recreating one must re-issue both.

### Legal documents are frozen once shipped

Every `terms_acceptances` row stores the SHA-256 of the version accepted, from
`public/legal/manifest.json`, so **editing or deleting a shipped file under `public/legal/`
invalidates every acceptance recorded against it** — publish a new version instead.
[`scripts/legalDocumentsCheck.ts`](scripts/legalDocumentsCheck.ts) catches it, but only against the
**PR base ref**, so a direct push to `main` escapes it. Standard:
[legal-acceptance.md](docs/modules/legal-acceptance.md).

### Billing write-gate (new tenant tables)

Browser-writable tenant tables carry `billing_gate_*` restrictive RLS calling
`company_can_write(company_id)`; reads stay open. RLS is per-table, so **a new `company_id` table
without the gate silently bypasses billing** — gate it in the same migration with `SELECT
public.apply_billing_write_gate('public.your_table');`, or exempt it in
`tenant_tables_missing_write_gate()`. `test_no_tenant_table_left_ungated` fails the build either
way. Change the entitlement rule in **both** `lib/entitlement.ts` and the SQL `company_can_write` —
parity is tested. Standard: [billing.md](docs/modules/billing.md) §4.

### Schema source-of-truth

**There is deliberately no cached prod schema file** — `supabase/schema.prod.sql` was deleted
because a snapshot that can be confidently wrong is worse than none. **Never re-introduce one.**

| Question | Ask |
|---|---|
| What *should* the schema be? | `supabase/migrations/` — the executable history, and the only source of truth |
| What columns exist? | [`types/database.ts`](types/database.ts) — generated, CI-enforced byte-exact |
| RLS policies, grants, CHECK constraints, function bodies | The migrations. **None of these appear in `types/database.ts`** — an agent trusting the generated types will conclude a policy is absent when it is present |
| What does *production* actually have? | Query it, via the Supabase MCP server. No file in this repo answers this honestly |

## Design System: Jigged Manufacturing Data Platform (Material-UI)

**[docs/design-system.md](docs/design-system.md) owns this** — principles, components, layouts,
mobile and accessibility; values live in [`lib/theme.ts`](lib/theme.ts), and interaction rules are
machine-enforced ([interaction-standards.md](docs/interaction-standards.md) +
[`scripts/interactionStandardsCheck.ts`](scripts/interactionStandardsCheck.ts)). Use MUI with the
`sx` prop, the theme palette and `theme.spacing(n)` — never hardcoded colours or pixels. Single dark
theme, for 50–60 year old shop owners: substantial, readable under bright light.

### Who uses what, on what — the device model

**There is no single "primary device". There are three surfaces, two of them ours** — decide which
one a change lands on before reasoning about its interaction.

| Surface | Who | Device | What follows |
|---|---|---|---|
| **Admin & User** — Storage, Parts, Quotes, Jobs, data setup | owner, salesperson, scheduler | **Office computer**, mouse + keyboard | Hover available. Drag viable. Bundle weight cheap. Dense tables fine. |
| **Operator** — jobs, scan, notes | shop floor | **Their own phone** | Touch only, no hover. Bundle weight expensive (cellular). One-handed reach. Bright ambient light. |
| **Machine control** | machinist at the machine | The machine's own **HMI** (Haas, Fanuc…) | **Not a Jigged surface.** We never render here; don't design for it. |

Two mistakes this prevents: rejecting a mouse interaction on an admin screen as "touch is
unreliable", and treating a phone on cellular like an office connection. **A phone is at least as
constrained as a tablet**, so touch rules hold throughout.

## Local development

> **Backend Python runs in the `jigged` conda environment.** Always use it (`conda run -n jigged
> <cmd>`) for `python index.py`, `pytest`, and backend scripts — the system `python3` lacks the API
> deps. **Never create per-repo venvs.**

`pnpm install` · `pnpm dev` · `cd api && conda run -n jigged python index.py` · `pnpm build`. Test
and lint commands live in `package.json`; don't invent new harness commands. `supabase db reset`
(alias `pnpm seed`) replays migrations plus `supabase/seed.sql` (the dev/preview seed), which writes
`auth.users` directly — **local/preview only, never prod**. CI is the authoritative gate; for
testing before a PR, E2E setup, worktrees, preview verification and shell-command hygiene see
[docs/runbooks/local-dev-and-testing.md](docs/runbooks/local-dev-and-testing.md).
