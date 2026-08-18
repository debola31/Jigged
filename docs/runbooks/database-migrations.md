# Runbook — database migrations

> As-built, verified **2026-08-03** against `supabase/migrations/`, `supabase/config.toml`,
> [`deploy-production.yml`](../../.github/workflows/deploy-production.yml),
> [`test.yml`](../../.github/workflows/test.yml) and [`vercel.json`](../../vercel.json).
>
> Moved out of `CLAUDE.md` under [#634](https://github.com/debola31/Jigged/issues/634) — ceremony you
> follow when writing a migration, not a rule binding every change. Three rules bind at *creation*
> time and stayed inline in `CLAUDE.md`: use `supabase migration new`; a new `public` table needs
> explicit `GRANT`s in the same migration; a new function is browser-callable unless you
> `REVOKE EXECUTE`. This file is the surrounding procedure.

## The workflow, per change

1. **`supabase migration new <slug>`** — creates the file with a fresh 14-digit timestamp. Never
   write a file into `supabase/migrations/` by hand (see "Why the CLI owns the timestamp").
2. Write the SQL into the new file.
3. **If the migration creates a table in `public`, grant it explicitly** — in the same migration,
   alongside `ENABLE ROW LEVEL SECURITY` and the policies. Without a `GRANT` the table is invisible
   to PostgREST/supabase-js and the FastAPI backend. Same migration, same block: the billing
   write-gate (`apply_billing_write_gate`) if it carries `company_id`, and an `EXECUTE` revoke on
   any `SECURITY DEFINER` function. All three standards live in `CLAUDE.md`.
4. **Verify locally:** `supabase db reset` replays the baseline + migrations + `supabase/seed.sql`
   on a fresh local DB — run it plus the relevant tests. This is the deterministic check; there is
   **no staging project to push to anymore** (we run on Supabase Branching now).
5. **Open a PR.** Supabase Branching auto-creates a preview branch, applies the migration to it, and
   reports the **required migration status check**; the Vercel preview points at that branch's DB.
   If the check is red, fix the migration — it blocks merge.
   **A green PR does not mean the migration will apply to production.** See "Why a green PR proves
   less than it looks like" below — this is the single most expensive thing on this page.
6. **Merge to `main` applies migrations to production.** Supabase runs them and posts its verdict as
   a check on the **merge commit** — not on the PR, which is closed and frozen green by then. Do NOT
   run `supabase db push` (or `supabase link`) against prod manually; the branching pipeline owns it.
   The human still owns clicking merge.
7. **The frontend deploys only after that verdict is green** — see "The production gate".
8. Nothing to regenerate afterwards except `types/database.ts` (`pnpm gen:db-types`, which pins its
   own generator version), enforced byte-exact by the backend job in `test.yml`. There is
   deliberately no prod schema snapshot to refresh — see "Schema source-of-truth".

## Why the CLI owns the timestamp

The CLI tracks migrations by `(version, name)` in `supabase_migrations.schema_migrations`. Two files
sharing a version **collapse to one row**, leaving the rest invisible to the tracker — `db push` then
sees them as pending and tries to re-run them. We hit exactly this when legacy 8-digit date-prefixed
files (`20260313_…`) accumulated multiple migrations per date. Never use the 8-digit date-only prefix
for new files; always let the CLI generate the 14-digit `YYYYMMDDHHMMSS`.

## When `main` gains a migration while your PR is open

Long-lived branches make this routine, and there are **two shapes with opposite fixes**. Get the
direction wrong and the "fix" is worse than the symptom, so establish which one you are in before
touching anything: ask production what its newest version is (`list_migrations` over the Supabase
MCP — no file in this repo answers it) and compare.

### Your timestamp is EARLIER than main's newest → renumber it, in the PR

On merge, prod is asked to apply your migration *after* a higher version it already has. The CLI
refuses rather than doing it:

```
Found local migration files to be inserted before the last migration on remote database.
Rerun the command with --include-all flag to apply these migrations: …
```

**Do not take the `--include-all` suggestion on production.** It applies the straggler out of order
for real — that is the state you are trying to avoid, and the flag exists to recover a database that
has *already* diverged, not to wave one through. Instead, renumber: run `supabase migration new`
with the same slug, move the SQL into the new file, delete the old one. Yours sorts last again and
prod applies it in order.

**The renumber is safe only because prod has not applied your migration yet, and that precondition
is the whole rule.** A version prod has already recorded is a version you can never renumber —
changing it makes the migration pending again and re-runs it against a database that already has it.

### Your timestamp is LATER than main's newest → change nothing

The files are already in order and prod will apply them in order. What you may still see is a
**local** out-of-order, which looks alarming and is not a repo problem: your own stack (and a preview
branch provisioned before the other PR merged) applied *yours*, and the earlier one only arrived with
the merge. `supabase migration list --local` shows the straggler with no remote:

```
{"local":"20260809001523","remote":""}                  ← file present, never applied
{"local":"20260809002922","remote":"20260809002922"}    ← applied first
```

That is an artifact of **when each database was built**, not of the migration files. Fix it with
`supabase db reset` and leave the files alone. Renumbering here would orphan the version your local
database has already recorded — a row in `schema_migrations` with no file — which is strictly worse
than the ordering it was meant to tidy.

Observed on [#743](https://github.com/debola31/Jigged/pull/743): its migration was stamped after
`20260809001523`, three PRs merged while it was open, and only the local stack was ever out of order.
Prod, the preview branch and CI were all correct throughout.

## Why a green PR proves less than it looks like

**Every pre-merge gate in this repo builds its database by replaying the migrations** — `supabase db
reset`, the Supabase preview-branch check, the E2E stack. They are therefore green *by construction*
whenever the migration files are internally consistent. Production was never built that way: its
baseline was **marked-as-applied against the pre-existing database rather than executed**. So an
object the baseline creates exists on every preview branch and on every local stack, and does not
exist on prod.

That asymmetry caused the **2026-08-03 outage**, and it is documented at the site of the fix in
[`20260801024552_revoke_function_execute_from_browser_roles.sql`](../../supabase/migrations/20260801024552_revoke_function_execute_from_browser_roles.sql)
(§2b):

- `REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()` raised `42883` on production only.
  `rls_auto_enable` returns `event_trigger`, and creating an event trigger requires **SUPERUSER** —
  which `postgres` is on a local stack and is **not** on hosted Supabase. The baseline creates it
  wherever the baseline actually *runs*; prod never had it.
- Migrations are atomic and ordered, so that one statement aborted its whole file and blocked **the
  twelve behind it**, from 2026-08-01 to 2026-08-03.
- Vercel shipped the frontend anyway. PR #654 then went live selecting
  `customer_contacts.is_billing_default` — a column the blocked migrations were supposed to create —
  and every job and quote page rendered "Job not found", because PostgREST rejects the *whole* select
  on one bad column (`42703`, surfaced as a 400).

The resolution was to **tolerate the absence** (guard the revoke with `to_regprocedure(...) IS NOT
NULL`) rather than create the missing function: an event trigger cannot be created on hosted Supabase
without superuser, and the revoke is meaningless where the function does not exist. Everything else in
that migration stays unguarded on purpose — a function missing anywhere else is real drift and should
still be loud.

**How to apply.** When a migration behaves differently on prod than locally, **suspect privilege level
first** (superuser-only objects: event triggers, some extensions). When the app says data is missing,
check for a 400 + SQLSTATE in the Supabase logs before assuming the rows are gone.

**Never clear a stuck migration with `migration repair --status applied`.** It records the file as done
without running it, so its contents never reach production and the next migration that depends on them
fails the same way.

## The production gate

[`.github/workflows/deploy-production.yml`](../../.github/workflows/deploy-production.yml) — `on: push`
to `main`, plus `workflow_dispatch` for re-running after a migration is fixed. Two jobs:

| Job | What it does |
|---|---|
| `gate` — "Checks passed and database is ready" | Polls the merge commit's check runs every 15s until **every** name in `REQUIRED_CHECKS` has completed — the migration apply *and* the test suites. All `success` → exit 0. Any other conclusion → exit 1 immediately, listing every failure rather than the first. Anything still incomplete at `GATE_TIMEOUT_SECONDS` (1500) → exit 1. |
| `deploy` — needs `gate` | POSTs the Vercel deploy hook (`VERCEL_DEPLOY_HOOK_URL`). Vercel builds it exactly as it does for a git push. |

**This is the only route to production.** `vercel.json` sets
`git.deploymentEnabled: { "main": false }`, so pushing to `main` no longer deploys by itself —
the gate does, after the database says yes. Preview deployments for every other branch are
unaffected, which matters because they pair with the Supabase preview branches.

**Why it exists:** the migration apply and the frontend build used to run in parallel with no ordering,
so when one failed the other shipped anyway — the 2026-08-03 outage above. **It fails closed**: no
verdict is not the same as a good verdict, so a Supabase outage blocks deploys. That cost is
deliberate. If it blocks, fix the migration and merge again.

**The trigger proves acceptance, not completion.** Vercel reports its own build failures; this
workflow does not wait. That is a deliberate limit: a build failing *after* the gate leaves
production on the previous code against an already-migrated database — old code, new schema, the
direction additive migrations are written to survive. The dangerous ordering is new code against old
schema, and that is what the gate refuses.

### Two withdrawn approaches, and why

**Polling `schema_migrations` directly.** Put a prod DB credential in CI and created a second source
of truth that could disagree with Supabase's own verdict. The gate reads the existing verdict instead.

**Building and deploying with the Vercel CLI.** Never shipped a single commit; failed three times on
three different structural limits, none of them misconfiguration:

1. `vercel build` expands this repo's `functions: { "api/**" }` glob into one Serverless Function per
   matched Python file — **82**, against a **12**-function cap on Hobby. It also installed the Python
   dependencies 82 times, which is where a 21-minute build came from.
2. Narrowing the glob to the real entrypoint `api/index.py` gives one function of **244 MB** against a
   **225 MB** cap. The bulk is the dependency stack (three LLM SDKs, Stripe, Sentry, two Postgres
   drivers), so excluding `.vercel`, `public`, `docs` and the test directories from the bundle changed
   the total by **0.00 MB**. Measured, not assumed.
3. A runner has no Vercel build cache, so even a working version traded a ~3 minute deploy for ~30.

Handing the build back to Vercel's own builder left this workflow responsible only for ordering —
which was always the point. Measured after the change: **gate 5s, trigger 5s.**

> ### Correction, 2026-08-15 — read this before quoting the three limits above
>
> This passage used to end "Vercel's own builder hits none of these", and that sentence was wrong
> about limit #1 in a way that cost hours and misled two separate agents into declaring a live
> deployment failure a non-issue. **The 12-function cap is not CLI-only.**
>
> The QuickBooks Desktop branch added seven Python files under `api/` and the *hosted git-integration*
> builder — the one that clones from GitHub, not the CLI — failed with
> `exceeded_serverless_functions_per_deployment` at the `patchBuild` step, **after** a clean build.
> The build log shows its Python dependency install repeating **11 times on that branch against 9 on
> another**, so the hosted builder expands the glob too; it simply expands it less than `vercel build`
> does. The error never appears in the build log — only in
> `GET https://api.vercel.com/v13/deployments/{id}`, as `errorCode` / `errorMessage`. **That API is
> where you diagnose a deploy-step failure**; the log stops at "Deploying outputs…".
>
> **Resolved by upgrading to Vercel Pro**, which removes the cap. Redeploying the identical commit with
> zero code changes went green in 2m, which is what proves the cap was the binding constraint.
>
> The upgrade was owed regardless, and this is the durable reason: **Vercel's fair-use terms restrict
> Hobby to non-commercial personal use, and Jigged takes payments.** Any plan discussion starts there,
> not at a function count.
>
> Two live consequences of being on Pro:
> - **Set a Spend Management cap.** Hobby *stopped* at its ceilings; Pro *meters* past them and bills.
>   That is the header-badge credit burn in [CLAUDE.md](../../CLAUDE.md) with a different currency.
> - Limit #2's **225 MB** figure is **stale and unverified** — Vercel now documents a far larger Python
>   bundle limit. Re-measure before treating it as a constraint, and do not repeat the mistake of
>   narrowing the glob on the strength of it.

> ### Correction, 2026-08-18 — limit #1 is misattributed, and it was measured
>
> **The `functions` glob does not create the fan-out, and narrowing it does nothing.** Limit #1 above
> says `vercel build` "expands this repo's `functions: { "api/**" }` glob into one Serverless Function
> per matched Python file". That reads as cause and effect, and it is not. Vercel's docs are explicit:
> *"Without a detected Python framework preset, each `.py` file inside `/api` becomes a separate Vercel
> Function"*, and the `functions` property is used to **configure** file-based functions, not to select
> them. The `/api` directory convention is the cause; the glob is only the config key that happens to
> match.
>
> Measured, not reasoned: narrowing the glob to `api/index.py` and deploying produced **12 Python
> lambdas and 11 `uv.lock` installs — byte-identical to `api/**`** (`meta.lambdaRuntimeStats`,
> `{"nodejs":3,"python":12}` on both). See PR #772.
>
> **The trap this creates.** Because the key only configures, narrowing it *silently unconfigures the
> other eleven functions* — they keep existing, but lose `maxDuration: 60` and lose `excludeFiles`, so
> they start bundling `api/tests/**`. Narrowing looks like a cleanup and is a regression. The glob must
> stay wide enough to match every entrypoint.
>
> **What actually collapses the fan-out** is the framework preset: *"A Python framework preset takes
> precedence over file-based functions… files under `/api` don't become separate Vercel Functions."*
> That is a real change of shape for a project whose Vercel framework is `nextjs`, and Vercel points
> Next.js + Python at [Services](https://vercel.com/docs/services) instead. Not a config tweak — treat
> it as its own piece of work.
>
> **Limit #2 is resolved.** The cap is **500 MB uncompressed**, larger still on Fluid compute, which
> this project already runs (`resourceConfig.fluid: true`). The 244 MB single-function measurement fits
> with ~2× headroom, so the 225 MB figure that block flagged as stale is now settled — it just no
> longer matters, because narrowing is not the lever anyone thought it was.
>
> **Why any of this got looked at.** Four days into the first Pro billing cycle the team had spent
> **$15.75 of its $20 credit, 99.6% of it Build CPU Minutes**. Over 79 deployments, billed machine time
> averaged **7.82 min/build**: 84s compile+install, 70s deploying outputs, and **314s creating and
> uploading the build cache**. The build had not regressed — builds on Aug 12–14 ran *longer*, at
> ~11 min. Hobby simply never billed for it.
>
> Two measurement traps worth carrying forward, because both cost time here:
> - **Billed build duration is not `ready - buildingAt`.** That field stops at "Deployment completed"
>   and undercounts by ~3×; the machine keeps running through cache creation. Measure first-event to
>   last-event on `GET /v3/deployments/{id}/events?builds=1`.
> - **The build cache has not been shown to pay for itself.** It costs 314s to accelerate a phase that
>   takes 84s in total, so a perfect hit cannot save more than 84s. Settle it with one A/B against
>   `VERCEL_FORCE_NO_BUILD_CACHE=1` before assuming it helps. And do not expect the *glob* to shrink it
>   — uv's cache is content-addressed and deduplicated across entrypoints, so eleven venvs already
>   shared one copy of each wheel.

**If deploys ever stop reaching production**, the first thing to check is whether the hook still
exists (`vercel deploy-hooks list`) and matches the `VERCEL_DEPLOY_HOOK_URL` secret. Reverting
`git.deploymentEnabled` in `vercel.json` restores Vercel's own auto-deploy immediately, at the cost of
the ordering guarantee.

### Gotchas in the gate, each of which cost real time

- **The check is named `Supabase Preview` on the merge commit too** — same name, but there it reports
  the *production* apply. If Supabase renames it, edit `REQUIRED_CHECKS`; the gate fails closed until
  it is corrected.
- **`REQUIRED_CHECKS` matches the API's BARE check name**, not the "Tests / Backend Tests" form the
  GitHub UI shows. A name that never matches shows as `absent` forever and times the gate out rather
  than passing it — safe, but the summary tells you to compare against
  `gh api repos/OWNER/REPO/commits/SHA/check-runs --jq '.check_runs[].name'`.
- **The gate must never list its own checks.** "Checks passed and database is ready" and "Trigger the
  Vercel production deploy" are deliberately absent from `REQUIRED_CHECKS`; including either makes the
  gate wait on itself and time out every run.
- **An `absent` check counts as waiting, not as missing.** A check that has not been created yet is
  indistinguishable from one about to be, so treating absence as "fine" would deploy before it ever
  ran — exactly the ordering bug this workflow exists to prevent, one level up.
- **The gate parses status and conclusion only, never the summary.** Supabase puts a raw multi-line SQL
  error in `.output.summary`; folding it into the delimited row makes it many lines and every parsed
  field garbage — which reads as a *timeout* rather than a *failure*, the most dangerous possible
  misreading here.
- **Nobody saw the original failures, for two structural reasons.** The check lands on the merge commit,
  created *after* the PR page freezes, so a closed PR stays green forever; and GitHub sends no
  notification for third-party App check runs — subscribable failure emails cover Actions workflows only
  ([community#55379](https://github.com/orgs/community/discussions/55379), still open). Making the gate
  an Actions workflow closes that notification gap as a side effect, which is the real reason to prefer
  it.
- **`cancel-in-progress` is deliberately `false`.** Cancelling would kill a deploy midway through
  `vercel deploy`, the one moment where interruption can leave production indeterminate. Two rapid
  merges deploy in order; the later wins because it runs last.
- **`VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` are read from `vars` *or* `secrets`.** They were configured as
  secrets while the workflow read `vars`; `vercel pull` then failed with "The specified token is not
  valid", pointing at the one credential that *was* present. A preflight step now names the missing
  setting instead.

### Is the workflow the only path to production?

**Mostly, and the repo half is now verified.** [`vercel.json`](../../vercel.json) **does** set
`git.deploymentEnabled: { "main": false }`, so a push to `main` does not deploy by itself — the gate
above does, after the database says yes. Two things remain true and worth keeping in mind:

- Whether Vercel's git integration is *additionally* disabled in the dashboard has no representation
  in this repo, so it cannot be checked from files.
- `vercel deploy --prod` is a documented manual escape hatch, so the workflow is not the only
  *possible* path — just the only automatic one.

> **Corrected 2026-08-10.** This section previously read **UNVERIFIED** and asserted that
> `vercel.json` "holds only `functions` and `rewrites`" — which contradicted the workflow section
> above it, and was false at the time of correction. It mattered: the ordering guarantee that makes
> destructive migrations safe to split expand/contract rests entirely on this gate being the deploy
> chokepoint, so anyone reasoning from this section was reasoning from the wrong premise.

## Schema source-of-truth

Different questions have different answers. Conflating them is what made the 2026-08-03 outage hard to
diagnose.

| Question | Ask |
|---|---|
| What *should* the schema be? | `supabase/migrations/` — the executable history, and the only source of truth. New changes land here as new files. |
| What columns exist? | [`types/database.ts`](../../types/database.ts) — generated from the migration-replayed local stack, CI-enforced byte-exact ([#406](https://github.com/debola31/Jigged/issues/406)). |
| RLS policies, grants, CHECK constraints, function bodies | The migrations. **None of these appear in `types/database.ts`.** |
| What does *production* actually have? | Query it — the Supabase MCP server. No file in this repo can answer this honestly. |

**There is deliberately no cached prod schema file.** `supabase/schema.prod.sql` existed for the "what
does column X look like today" lookup and was deleted because it could — and did — lie. It was
hand-edited inside a feature PR to add `customer_contacts.is_billing_default` while production had no
such column, its `Generated:` header left untouched, and it asserted that falsehood for two days.
During the outage it was worse than useless: it had to be ignored in favour of dumping prod live.

A snapshot that can be confidently wrong is worse than none — the same failure shape as a green check
reporting on a preview branch while production burned. **Do not re-introduce a hand-maintainable mirror
of production.**

Migrations and production *can* legitimately diverge for a while: the merge applies them, and until it
succeeds prod is behind. That gap is what `deploy-production.yml` exists to stop the frontend from
stepping into.
