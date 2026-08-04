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
| `gate` — "Database is ready for this code" | Polls the check runs on the merge commit every 15s for the newest run named by `SUPABASE_CHECK_NAME`. `success` → exit 0. Any other conclusion → exit 1, printing Supabase's `.output.summary`. No verdict inside `GATE_TIMEOUT_SECONDS` (600) → exit 1. |
| `deploy` — needs `gate` | `vercel pull --environment=production`, `vercel build --prod`, `vercel deploy --prebuilt --prod`. |

**Why it exists:** the migration apply and the frontend build used to run in parallel with no ordering,
so when one failed the other shipped anyway — the 2026-08-03 outage above. **It fails closed**: no
verdict is not the same as a good verdict, so a Supabase outage blocks deploys. That cost is
deliberate. If it blocks, fix the migration and merge again.

**Withdrawn:** an earlier attempt polled production's `schema_migrations` over a direct database
connection — wrong because it put a prod DB credential in CI and created a second source of truth that
could disagree with Supabase's own verdict. The gate reads the verdict that already exists instead.

### Gotchas in the gate, each of which cost real time

- **The check is named `Supabase Preview` on the merge commit too** — same name, but there it reports
  the *production* apply. If Supabase renames it, `SUPABASE_CHECK_NAME` is the one line to change; the
  gate fails closed until it is corrected.
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

**UNVERIFIED — and the claim it replaces was false.** `CLAUDE.md` asserted Vercel's git auto-deploy was
off for `main` via `git.deploymentEnabled` in `vercel.json`. It is not: [`vercel.json`](../../vercel.json)
holds only `functions` and `rewrites`, and the *only* occurrence of `deploymentEnabled` anywhere in the
repo was that sentence describing itself.

Verifiable from files: the workflow deploys production on every push to `main` and gates it on the
migration verdict. Whether Vercel's git integration *also* auto-deploys `main` is a dashboard setting
with no representation in this repo — confirm it in Vercel before treating the gate as an exclusive
chokepoint. `vercel deploy --prod` is in any case a documented manual escape hatch, so the workflow is
not the only *possible* path.

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
