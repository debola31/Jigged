# Jigged — Manufacturing Data Platform

Web platform for small precision manufacturing shops: jobs, inventory, and shop-floor status.
Next.js 16 + TypeScript + MUI v7 · FastAPI · Postgres on Supabase · Vercel. Exact versions live in
`package.json`; the system picture is [docs/architecture.md](docs/architecture.md).

**There is no gamification, and that is a rule rather than a gap.** No operator-facing surface may
reflect an operator's pace or standing back at them — no counts, streaks, averages, points, badges
or leaderboards. Existing per-surface tests assert this, but **they only cover the surfaces that
exist**: a new operator page with a counter ships green. Treat it as a design constraint you apply,
not one you will be caught violating. Why, and the whole read-back model:
[operator-view.md](docs/modules/operator-view.md#surveillance-guardrail-non-negotiable).

**Where everything is documented:** [docs/README.md](docs/README.md) is the index.
Writing or editing a doc? [docs/writing-docs.md](docs/writing-docs.md) is the standard, and it is
enforced — [`scripts/docLinkCheck.ts`](scripts/docLinkCheck.ts) fails CI on a cited path that does
not exist or a link that does not resolve.

---

## API and data access

**Supabase-first.** Simple CRUD goes through the Supabase client (`utils/*Access.ts`). The FastAPI
backend (`api/`) is only for the four criteria in
[architecture.md §8.1](docs/architecture.md#81-when-to-use-fastapi-backend): AI operations,
service-role work (`auth.admin.*`), complex multi-step logic, and third-party secrets or inbound
webhooks (Stripe, QuickBooks OAuth). **Do not add a FastAPI endpoint for standard CRUD.**

**Every app route is company-scoped** (`/dashboard/{companyId}/…`) and isolation is enforced by RLS
over `user_company_access`, not by the URL. One user can hold access to several companies, with
roles `admin | user | operator` — and operators land on `/operator/{companyId}`, not `/dashboard`
([`homePathForRole`](utils/companyAccess.ts)). Model and auth flow:
[architecture.md §3](docs/architecture.md).

**`getSupabase()` is the only client getter, and it is always typed** — it type-checks each
`.from().select()` against [`types/database.ts`](types/database.ts). The untyped second getter and
the lint ratchet that policed it are **gone** (#573): there is no untyped symbol left to import, so
the guarantee is structural rather than an exemption list. **Never reintroduce an untyped view of
this client, and never launder a row through `as unknown as` — that erases the query result exactly
like the old getter did.** Schema mistakes compiling silently is how the May 2026 `jobs.status`
regression shipped. **Regenerate types after any migration that changes columns**
(`pnpm gen:db-types`, against a running local stack); CI fails on a diff. Details, and the three
places the generator version is pinned: [architecture.md §6](docs/architecture.md).

---

## Engineering principles

### AI calls require an explicit user action

Anthropic calls cost real credits. **Never invoke an AI endpoint from a `useEffect`, page load,
route mount, auto-refresh, or polling loop.** The user must have clicked, submitted, or explicitly
asked. This binds at every layer: no fetch-on-mount in the frontend; no endpoint that generates AI
summaries as a read side effect; background jobs only if infrequent and rate-limited per company,
and never wired to login or page view.

**Why:** a header alert badge once called `/api/insights/{id}/dashboard`, firing 5 Anthropic calls
on every dashboard load. Nobody ever read the output — the badge only used the raw metric arrays.
Credits ran out in days. Both the badge and the endpoint are gone; the failure mode is the point.

**How to apply:** the entry point must be a button, form submit, or explicit refresh — not a
lifecycle hook. For passive UI (badges, dashboards) compute from Supabase without AI, or cache in a
table populated by a scheduled job. Unsure whether a path can fire on mount? Trace up from the call
site through its `useEffect` callers. **Nothing enforces this** — it is prose and a code review.

### No silent runtime fallbacks for data-at-rest issues

If a schema change leaves existing rows inconsistent, **fix the data at rest** with a backfill
migration. Do NOT paper over it with an "if empty, compute live" fallback in the access layer or UI.
Fallbacks hide data-quality problems, create two code paths to one answer that can silently diverge,
and compound as tech debt.

**The rule:** after a schema change every existing row must satisfy the new invariant by the time
the migration finishes, and the read path should have one shape with no "what if it's missing"
branch. If a backfill is genuinely impossible, prefer an explicit "no data available" state — it
surfaces the gap instead of hiding it.

### Telemetry: Sentry owns errors, PostHog owns behaviour, and neither lies

Full runbook, event registry, CLI recipes and traps: **[docs/telemetry.md](docs/telemetry.md)** —
read it before touching Sentry config, adding a PostHog event, or triaging. **Telemetry** is the
umbrella; **observability** (Sentry, Vercel) and **product analytics** (PostHog) stay named apart
because rules like the first one below need two things to keep separate. The rules that bind while
writing code:

- **Sentry is the error tracker; PostHog is product analytics.** Never add a second error tracker.
  **Vercel Web Analytics (`<Analytics />`) is kept deliberately** despite overlapping PostHog — do
  not remove either as "redundant".
- **Every `posthog.capture()` needs a row in the event registry, and CI enforces it both ways.**
  A capture with no row fails; a row nothing sends fails too. Names are `[object] [verb]`
  (`quote created`); properties are `snake_case` and describe the *shape* of the interaction —
  counts, booleans, enums — **never the customer's business data**. A surface belongs in a property,
  not the event name. Registry and convention:
  [telemetry.md](docs/telemetry.md), guard: [`scripts/analyticsEventsCheck.ts`](scripts/analyticsEventsCheck.ts).
- **The check cannot tell you that you forgot to instrument.** It compares code to the registry, so
  a feature in neither passes green — that is exactly how the operator notes feature shipped
  unmeasured for months. When a PR adds a user-facing write, it adds a row or says why not.
- **A failed `.from()` read or write reports itself — don't report it again.** `lib/supabase.ts`
  installs Sentry's Supabase integration, so every `{ error }` is captured with its query
  attached. Adding a `captureException` for one files the same failure as two issues. You still
  capture by hand for **`.rpc()`** (deliberately excluded — only the call site can tell a raise
  meant for the user from a bug), **storage**, and anything that isn't a Supabase response.
- **Never pass a raw Supabase error to `Sentry.captureException`** — it can't fingerprint a plain
  object and you get an issue titled `"e"`. Wrap with `toError` from
  [`lib/supabaseErrors.ts`](lib/supabaseErrors.ts). (The integration already does this on the
  paths it covers.)
- **"Couldn't check" is never "denied."** A failed access check must not render as a definitive
  negative — throw and give the UI a retryable state.
- **Transient aborts are not failures.** `AbortError: Lock was stolen` means superseded; classify
  with `isTransientAbortError` and retry.
- **The SDKs are off outside production builds.** Don't remove those guards — 90% of the issue queue
  was once this repo's own test runs.

### Deletion is archive (soft-delete), and never blocks

Every user-facing entity has a nullable `deleted_at`. "Delete" sets it — **never** a hard `DELETE`,
**never** blocked by a foreign key. Referencing quotes, jobs, shipments and BOMs keep resolving.
Full standard, including which tables carry it: [architecture.md §16](docs/architecture.md).

- **Every list / search / picker / count / dashboard query must filter `deleted_at IS NULL`.**
  By-id reads (a detail page, a document's retained FK) intentionally must **not**.
- **Name is identity, and the constraints stay FULL, not partial** — importers upsert on them and
  PostgREST cannot target a partial index. What a `23505` MEANS then differs by entity:
  customers, vendors and work centres **revive** the archived row; **parts do not** — the archived
  namesake is renamed `<name> (archived)` and a NEW part takes the name
  ([`reclaim_part_name`](supabase/migrations/20260818141141_reclaim_archived_part_name.sql)).
  The rename happens on the collision, never on archive: quote lines and job parts store no name
  snapshot, so renaming eagerly would rewrite how every past document reads.
- Don't re-introduce records-of-value delete guards. An invoiced job archives like anything else.

**Nothing enforces this** ([#687](https://github.com/debola31/Jigged/issues/687)), and it is the
most-violated rule in the repo — a missing filter is silent. Two live violations: #682, #684.

### Never make changes directly on the main branch

Create a feature branch before modifying code, schema, or config. No exceptions for "small fixes".
Direct edits bypass review, make rollbacks harder, and can clobber in-progress work.
`git checkout -b <prefix>/<short-description>` — this repo uses `feature/`, `fix/`, `docs/` and
`chore/`. **`main` is not branch-protected**, so this rule is the only barrier; check
`git branch --show-current` if unsure.

---

## Database changes

Procedure, the PR/preview/merge pipeline, and the 2026-08-03 outage:
**[docs/runbooks/database-migrations.md](docs/runbooks/database-migrations.md)**. What binds as you
write one:

**Always create the file with `supabase migration new <slug>`** — never by hand. The CLI generates a
unique 14-digit timestamp; hand-written date-only prefixes collide and break `schema_migrations`
tracking (two files sharing a version collapse to one row, and the rest go invisible). Verify with
`supabase db reset` before opening the PR.

### Data API grants (new tables in `public`)

**Every new table in `public` needs explicit grants in its own migration.** Nothing is exposed to
the Data API automatically —
[`20260716025048`](supabase/migrations/20260716025048_align_data_api_default_privileges.sql) revoked
the defaults that used to do it, matching what Supabase enforces on all projects from 2026-10-30.
Bundle grants with the RLS + policy block, in the same migration as the `CREATE TABLE`:

```sql
GRANT SELECT ON public.your_table TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO service_role;
```

**Grants and RLS are different layers.** A grant decides whether a role can touch the table at all;
RLS decides which rows. RLS with no grant is unreachable; a grant with no policy is denied — you
need both. Tailor the roles: `anon` often needs nothing; backend-only tables grant `service_role`
only and explicitly `REVOKE` from `anon`/`authenticated`. Do **not** write `REVOKE`-down-from-`ALL`
to express intent — that idiom relied on the old permissive default and now revokes privileges that
were never granted. **Symptom of a missing grant:** PostgREST `42501`, whose hint names the grant.

### Function EXECUTE grants (new functions in `public`)

**A new function is browser-callable unless you revoke it.** Postgres grants `EXECUTE` to `PUBLIC`
on every function, and `authenticated` is a member of `PUBLIC` — so a `SECURITY DEFINER` helper you
intend as backend-only is reachable from the browser the moment it exists, and since it bypasses RLS
the grant is the *only* thing between a caller and the data. To make one service-role-only, **name
the roles**:

```sql
REVOKE EXECUTE ON FUNCTION public.your_function(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.your_function(uuid) TO service_role;
```

`FROM PUBLIC` alone is sufficient today, but the explicit form is correct under either state and
costs nothing — until [`20260801024552`](supabase/migrations/20260801024552_revoke_function_execute_from_browser_roles.sql)
a default privilege also granted the browser roles directly, so eight migrations claimed
"service-role only" and none were ([#640](https://github.com/debola31/Jigged/issues/640)).

Three cases need no grant, and revoking is free: **trigger functions** and **event-trigger
functions** (permission is checked when the trigger is created, not when it fires), and **helpers
called only from `SECURITY DEFINER` parents** (the parent runs as its owner). Both claims are
asserted behaviourally in
[`test_function_execute_grants.py`](api/tests/integration/test_function_execute_grants.py).

**Enforced in CI:** `function_execute_leaks()` lists any `SECURITY DEFINER` function a browser role
can execute off its reviewed allowlist. The guard exists because over-granting is silent — no error,
no broken page. It is an *allowlist*, so the cheap way to green it is to add your function: don't,
without a sentence in the PR saying why the browser needs it. **A `DROP FUNCTION` destroys both the
ACL and the `COMMENT`** — any migration that drops and recreates one must re-issue both.

### Legal documents are frozen once shipped

`public/legal/` holds the Terms of Service and Privacy Policy as **versioned files**, with the
version, effective date and SHA-256 of each in `public/legal/manifest.json`. Every
`terms_acceptances` row stores that hash, so **editing a published document silently invalidates
every acceptance already recorded against it.**

**Never edit a shipped version.** Publish a new one: add the file, add a manifest entry, bump
`current`. **Never delete a version file** — a stored hash you cannot produce bytes for is an
assertion you cannot substantiate. [`scripts/legalDocumentsCheck.ts`](scripts/legalDocumentsCheck.ts)
fails CI on an edited entry, a hash that does not match the bytes, or an undeclared file under
`public/legal/`. It compares against the **PR base ref**, so it does not cover a direct push to
`main`. Full standard: [legal-acceptance.md](docs/modules/legal-acceptance.md).

### Billing write-gate (new tenant tables)

Every browser-writable tenant table carries `billing_gate_*` restrictive RLS calling
`company_can_write(company_id)`; reads stay open. RLS is per-table, so **a new `company_id` table
without the gate silently bypasses billing.** Gate it in the same migration —
`SELECT public.apply_billing_write_gate('public.your_table');` — or add it to the exempt list in
`tenant_tables_missing_write_gate()`. `test_no_tenant_table_left_ungated` fails the build either
way. Change the entitlement rule in **both** `lib/entitlement.ts` and the SQL `company_can_write`
(parity is tested). Full standard: [billing.md](docs/modules/billing.md) §4.

### Schema source-of-truth

Different questions have different answers. Conflating them is what made the 2026-08-03 outage hard
to diagnose.

| Question | Ask |
|---|---|
| What *should* the schema be? | `supabase/migrations/` — the executable history, and the only source of truth |
| What columns exist? | [`types/database.ts`](types/database.ts) — generated, CI-enforced byte-exact (#406) |
| RLS policies, grants, CHECK constraints, function bodies | The migrations. **None of these appear in `types/database.ts`** — an agent trusting the generated types will conclude a policy is absent when it is present |
| What does *production* actually have? | Query it, via the Supabase MCP server. No file in this repo answers this honestly |

**There is deliberately no cached prod schema file.** `supabase/schema.prod.sql` was deleted because
it could — and did — lie: hand-edited in a feature PR to add a column production did not have, its
`Generated:` header untouched, asserting that falsehood for two days. A snapshot that can be
confidently wrong is worse than none. **Do not re-introduce a hand-maintainable mirror of
production.**

---

## Design System: Jigged Manufacturing Data Platform (Material-UI)

**Source of truth:** [`lib/theme.ts`](lib/theme.ts) holds the values.
**Rationale, layouts, and the accessibility bar:** [docs/design-system.md](docs/design-system.md).
**Normative interaction rules** are machine-enforced —
[interaction-standards.md](docs/interaction-standards.md) +
[`scripts/interactionStandardsCheck.ts`](scripts/interactionStandardsCheck.ts).

Use MUI components and the `sx` prop; use the theme palette and `theme.spacing(n)` rather than
hardcoded colours or pixels. Audience is 50–60 year old shop owners: professional and substantial,
not trendy or playful, and readable under bright shop lighting. Single dark theme.

### Who uses what, on what — the device model

**There is no single "primary device". There are three surfaces, and two of them are ours.**
Corrected 2026-07-31 from founder observation: *"no one used a shop tablet in Contour or any shop
I've seen."* The docs had assumed shop-floor tablets throughout, and that was wrong.

| Surface | Who | Device | What follows |
|---|---|---|---|
| **Admin & User** — Storage, Parts, Quotes, Jobs, data setup | owner, salesperson, scheduler | **Office computer**, mouse + keyboard | Hover available. Drag viable. Bundle weight cheap. Dense tables fine. |
| **Operator** — jobs, scan, notes | shop floor | **Their own phone** | Touch only, no hover. Bundle weight expensive (cellular). One-handed reach. Bright ambient light. |
| **Machine control** | machinist at the machine | The machine's own **HMI** (Haas, Fanuc…) | **Not a Jigged surface.** We never render here; don't design for it. |

Decide which surface a change lands on before reasoning about its interaction. The two mistakes this
prevents: rejecting a mouse interaction on an admin screen because "touch is unreliable", and
treating a phone on cellular as though it had an office connection. Touch rules survive the
correction unchanged — **a phone is at least as constrained as a tablet.**

---

## Local development

> **Backend Python runs in the `jigged` conda environment.** Always use it
> (`conda run -n jigged <cmd>`) for `python index.py`, `pytest`, and backend scripts — the system
> `python3` lacks the API deps. **Never create per-repo venvs.**

`pnpm install` · `pnpm dev` · `cd api && conda run -n jigged python index.py` · `pnpm build`.
Test and lint commands live in `package.json`; don't invent new harness commands.

`supabase db reset` (alias `pnpm seed`) replays migrations plus `supabase/seed.sql`, the canonical
dev/preview seed — a rich company with dynamic dates and fixed UUIDs. It writes `auth.users`
directly, so it is **local/preview only, never prod**. Logins are listed at the top of
`supabase/seed.sql`.

**Which tests to run before a PR, E2E setup, running from a worktree, preview verification, and
shell-command hygiene** (which command shapes force an approval prompt, and why a worktree makes no
difference): [docs/runbooks/local-dev-and-testing.md](docs/runbooks/local-dev-and-testing.md).
CI is the authoritative gate; local runs just shorten the loop.
