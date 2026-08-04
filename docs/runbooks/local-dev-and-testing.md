# Runbook — local dev, tests, worktrees and previews

> Moved out of `CLAUDE.md` on 2026-08-03 under [#634](https://github.com/debola31/Jigged/issues/634):
> E2E/worktree/preview procedures first, then pre-PR validation and shell-command hygiene.
> It is **runbook, not rule** — procedures you follow when doing a specific thing, rather than
> constraints that bind every change. Keeping it in the always-loaded file cost roughly 4,300
> tokens on every session, including the many that never run E2E. Nothing was cut — it moved.
>
> The rules that *do* bind every change stayed in `CLAUDE.md`.

## Pre-PR validation (smart-scope)

Don't run "everything" before every PR. **CI is the authoritative gate and it already runs all of
it:** [`test.yml`](../../.github/workflows/test.yml) runs `pnpm exec tsc --noEmit`, `pnpm lint`,
Vitest with coverage thresholds and pytest with a coverage floor;
[`e2e-tests.yml`](../../.github/workflows/e2e-tests.yml) runs the whole Playwright suite. Local
runs exist only to shorten the feedback loop — match the check to what the change risks breaking.

> **Withdrawn:** "`next build` already type-checks and lints, so re-running them locally is
> redundant." The conclusion survives but the reason was wrong, and it named the wrong enforcer.
> The steps that go red are `Type check` and `Lint` in `test.yml`'s frontend job. In particular
> `pnpm lint` is `eslint --max-warnings <N>` (cap lives in `package.json`, ratcheting down under
> [#442](https://github.com/debola31/Jigged/issues/442)) — a Vercel build enforces no such cap, so
> it cannot be what keeps the number falling.

| Change | Run before opening PR |
|---|---|
| Component / page / logic in `app/`, `components/`, or `lib/` | `pnpm test --run __tests__/<path>.test.ts` (file-scoped). Fall back to full `pnpm test --run` if the change is to a widely-imported helper. |
| `utils/*Access.ts` or other Supabase access | `pnpm exec tsc --noEmit -p tsconfig.json` + matching `pnpm test --run __tests__/utils/<file>.test.ts`. |
| Backend (`api/**/*.py`) | `cd api && conda run -n jigged pytest tests/unit/test_<area>.py` (or `pytest -m unit` for the fast suite). |
| `supabase/migrations/*` schema work | `supabase db reset` (replays the migration + seed on a fresh local DB) and skim for errors; the PR's preview branch is the real gate. Spot-check any access layer that touched the changed columns/tables. **From a worktree, don't reset the shared stack** — see below. |
| `e2e/*.spec.ts`, or UI on a flow a spec exercises | Run that spec only: `pnpm exec playwright test e2e/<spec>.spec.ts --reporter=list`. `ls e2e/*.spec.ts` names them by flow — check it rather than trusting a list written here, which is exactly the kind that rots. |
| Doc / config / CI YAML / `.gitignore` / `scripts/` | Skip pre-PR validation. CI is the right gate. |

Use **copy-pasteable, file-scoped** commands — `pnpm test --run __tests__/utils/partsAccess.test.ts`,
not "run the tests". File-scoped runs in seconds; project-wide takes minutes and trains everyone to
ignore the result. If unsure what a change touches, `tsc` is the universally-cheap default (~15s,
whole frontend); backend changes get one `pytest -m unit` (~seconds). Anything beyond that should be
motivated by the specific change.

**Anti-patterns:**

- **Running the full E2E suite before every PR.** CI runs it on every PR against a fresh stack, and
  locally it wants the whole four-service orchestration (below) for minutes. Run the affected spec.
- **Re-running tsc / lint for doc-only PRs.** Adds nothing a CI step won't do.
- **Treating "local pass + CI fail" as a code bug.** That's expected env drift (cache state, machine
  differences, parallelism). Read the CI log and fix the actual failure; don't try to make local
  mirror CI exactly.

## Shell hygiene: the two command shapes that force an approval prompt

Claude Code's permission allowlist matches on command **names/prefixes**, not on arbitrary code
payloads. Two shapes defeat it and force a manual approval even when every tool involved is already
allowed:

1. **Inline-code execution** — `python3 -c "…"`, `python -c`, `node -e "…"`, `psql … -c "<SQL>"`,
   `agent-browser eval`. These hand the shell an arbitrary code/query payload, which the permission
   system **always** confirms by design; no allow rule generalizes across payloads (each dialog only
   offers to allow that one exact snippet).
   - To inspect a file, use the `Read` tool, or `jq`/`grep`/`cat` — not `python3 -c "import json…"`.
   - **Never re-validate a file right after `Edit`/`Write`.** The tool already confirmed the write
     succeeded. That redundant `python3 -c` JSON check is the most common self-inflicted prompt.
   - For DB reads prefer `psql "postgresql://…" -f <file.sql>` (a committed query file) over an
     inline `-c "<SQL>"`. Keep any inline query to a single standalone command you accept will
     prompt once.
2. **Compound commands** — chaining with `&&`, `;`, `|`, or heredocs. Approval requires **every**
   segment to match an allow rule, so one un-allowable segment (e.g. an inline `eval`) forces the
   whole block to prompt, including the innocent `cd`/`echo` in front. Prefer single-purpose
   commands; never bury an inline-code step inside a chain.

Plain allowlisted single commands (`grep`, `cat`, `ls`, `find`, `awk`, `curl`, `git …`, `pnpm …`,
`psql … -f`) run without prompting. Working in a **git worktree has no effect** on this — prompts
are about command *shape*, not location.

## E2E setup (only needed once per machine)

```bash
pnpm exec playwright install chromium
```

E2E runs against an **ephemeral local Supabase** (`supabase start`), not staging.
`e2e/global-setup.ts` provisions the test user, company and the whole data graph itself
(find-or-insert) with the local **service-role** key — so no committed login is needed, only two env
vars taken from the running local stack:

- `TEST_SUPABASE_URL` = `API_URL` from `supabase status`
- `TEST_SUPABASE_SECRET_KEY` = `SERVICE_ROLE_KEY` from `supabase status`

These are the local stack's keys and **rotate every `supabase start`** — fetch them fresh via the
CLI, never hardcode.

**`pnpm test:e2e:local` is the whole run, and it is exactly what CI invokes.** It runs
[`e2e/run-stack.mjs`](../../e2e/run-stack.mjs), which spawns the Anthropic mock (9876), FastAPI
(8000) and Next.js (3000), waits for each readiness URL, then runs Playwright and tears them all
down. Full env contract in [`e2e/README.md`](../../e2e/README.md); don't duplicate it here.

```bash
supabase start
eval "$(supabase status -o env)"      # API_URL / ANON_KEY / SERVICE_ROLE_KEY
# …export the TEST_* / NEXT_PUBLIC_* / SUPABASE_* / ANTHROPIC_* set from e2e/README.md…
pnpm test:e2e:local                   # add --grep <name> to narrow
```

> **Withdrawn (both were true before `run-stack.mjs`):** "Playwright auto-launches `pnpm dev` when
> not in CI" — `playwright.config.ts` has no `webServer` any more; orchestration owns service
> lifecycle and Playwright just trusts `localhost:3000`. And "the `csv-import` spec skips in CI, so
> filter it with `--grep-invert 'CSV Import'`" — the skip is gone, the AI column analysis it needs
> is served by `e2e/mocks/anthropic-server.mjs`, and CI runs the suite unfiltered.

## Running E2E (or `pnpm dev`) from a git worktree

Git worktrees do **not** inherit gitignored files, so a fresh worktree has no `.env.local` (or any
`.env*`). `pnpm dev` and anything that reads Supabase creds will fail until you pull them from the
**primary checkout** (the first entry in `git worktree list`). Do this once at the top of a worktree
session:

```bash
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
cp "$PRIMARY/.env.local" .                   # dev-server Supabase creds
[ -f "$PRIMARY/.env.test.local" ] && cp "$PRIMARY/.env.test.local" .
[ -f "$PRIMARY/e2e/.env.test.local" ] && cp "$PRIMARY/e2e/.env.test.local" e2e/
```

They land gitignored in the worktree, so they're never committed. Note the **E2E local-Supabase vars
are *not* copied** — `TEST_SUPABASE_URL` / `TEST_SUPABASE_SECRET_KEY` come from
`supabase status -o env` of the running local stack (above), so they're correct in any worktree
without copying. (Claude can run `supabase status -o env`, and `supabase start` if the stack isn't
up, to fetch them — they're local-only, not secrets.)

**Node deps + Python env in a worktree.** `node_modules` is gitignored too, so a fresh worktree has
none — run `pnpm install` **inside the worktree** (fast: pnpm hardlinks from its global store, so
it's correct for that branch's exact deps and costs almost no extra disk). Do **not** symlink the
primary's `node_modules` — it silently breaks when a branch's deps differ, and a stray
`pnpm install` would mutate the primary. Backend Python uses the shared `jigged` conda env — nothing
to install per worktree.

```bash
pnpm install                                       # node deps for THIS worktree
conda run -n jigged python -m pytest tests/unit/   # backend tests, jigged env
```

**The local Supabase stack is a machine-wide singleton, shared by every worktree — it is NOT
per-worktree.** There is one Postgres container set per machine. `supabase start` / `supabase db
reset` replay migrations from whatever directory invokes them into that one shared DB, so a
`db reset` from any worktree **replaces the stack for every other worktree** too. It does not track
a branch; it holds whatever was last replayed into it — in practice the primary's, since that's
where resets usually run. So when working from a worktree:

- **No migration changes in your branch?** The shared local stack is a valid substrate — run
  `pnpm dev`, unit tests and E2E against it from the worktree normally (the schema it needs already
  exists).
- **Your branch adds or edits migrations?** **Verify them on the PR's Supabase preview branch**,
  which applies the migration to its own isolated DB — that's the gate. Do **not** `db reset` the
  shared stack from a worktree to pick up your migrations: with concurrent worktree agents it
  clobbers the DB the others depend on, and even solo it just confuses what the stack represents.
  **The rule: worktree migrations go to the preview branch, never the shared local stack.**
- **Merge → local is manual.** Merging to `main` auto-applies the migration to **prod** (the
  branching pipeline), but your **local** stack only picks it up when you `git pull` in the primary
  and `supabase db reset` again.
- **Need `types/database.ts` regenerated for a worktree migration?** `pnpm gen:db-types`
  introspects the shared `--local` stack, so it has the same hazard. Prefer letting **CI regenerate
  + diff-check** types on the PR (the backend job already fails on a mismatch), or regenerate
  against a throwaway DB — don't `db reset` the shared stack mid-flight just to gen types. Do
  **not** hand-edit the file: the drift check diffs a byte-exact regen, so a hand-edit fails CI even
  when every column is right.

  The generator accepts `--db-url`, so a throwaway container works:

  ```bash
  docker run -d --rm --name migcheck -e POSTGRES_PASSWORD=x -p 55499:5432 postgres:17-alpine
  # create the db, apply Supabase-platform stubs (roles anon/authenticated/
  # service_role/jigged_ai_readonly, schemas auth/storage, auth.uid(),
  # storage.objects + storage.foldername), then replay supabase/migrations/ in order
  npx --yes supabase@2.109.0 gen types typescript \
    --db-url "postgresql://postgres:x@127.0.0.1:55499/jigged" > types/database.ts
  ```

  **Gotcha that costs a red CI run:** a bare Postgres has no `pg_graphql`, so the generator silently
  omits the `graphql_public` schema — in **two** places, the schema block *and* the trailing
  `Constants` export. Splice both back from `main` (this migration never touches them), then diff
  against `main` and confirm only your intended tables/functions changed. Keep the generator version
  matching the one pinned in `gen:db-types`.

## Visual verification on a Vercel preview (worktrees, agents)

Preview deployments sit behind Deployment Protection, so an agent gets a login page. The project has
a **Protection Bypass for Automation** secret; it lives in `.env.local` as
`VERCEL_AUTOMATION_BYPASS_SECRET` (gitignored — copy `.env.local` from the primary checkout in a
fresh worktree, and re-copy if it was added after your worktree was created).

Pass it as **headers**, not query params, so the secret never lands in a URL, shell history, or an
agent transcript. `x-vercel-set-bypass-cookie` sets a cookie so in-app navigation after the first
load keeps working:

```bash
export S=$(grep '^VERCEL_AUTOMATION_BYPASS_SECRET=' .env.local | cut -d= -f2- | tr -d '"'"'"' \r')
export HDRS=$(python3 -c "import json,os;print(json.dumps({'x-vercel-protection-bypass':os.environ['S'],'x-vercel-set-bypass-cookie':'true'}))")
agent-browser open "$PREVIEW_URL/login" --headers "$HDRS"
```

(The `python3 -c` is one of the accepted one-off prompts described above — there's no allowlisted
way to build that JSON.)

Then sign in with the seed account (`dev@jigged.test` / `jigged-dev-1234`) — the preview branch runs
`supabase/seed.sql`, so it has the full Vanguard Precision Works data graph. Get `$PREVIEW_URL` from
the PR's Vercel comment or `gh pr view <n> --json comments`.

**Use a fresh `--session` per preview domain.** The bypass cookie is set for one host; carrying a
session over from a previous PR's preview makes the new domain bounce to Vercel's SSO login even
though the headers are correct. `agent-browser open … --session <pr-number>` avoids it.

**If the app shows "Something Went Wrong" on every route, it is almost certainly not your code.**
Check `agent-browser console` for:

```
@supabase/ssr: Your project's URL and API key are required to create a Supabase client!
```

That means the deployment has no `NEXT_PUBLIC_SUPABASE_*`. Those are inlined at **build** time, so
the first Vercel build of a new preview branch can outrun Supabase Branching provisioning and bake
in empty values. Observed on two consecutive PRs. **A rebuild fixes it with no code change** — push
any commit, or redeploy from the Vercel dashboard.

It presents as a total outage rather than a broken page because
[`lib/supabase.ts`](../../lib/supabase.ts) creates the client eagerly at module scope
(`export const supabase = typeof window !== 'undefined' ? getSupabase() : null`), so the throw
happens during module evaluation and nothing renders anywhere.

Notes: `agent-browser get text` needs a selector (`get text body`); prefer `snapshot -i -c` or
`eval` since a not-yet-hydrated App Router page returns raw RSC payload. `agent-browser console` /
`errors` are the fastest triage. Docs:
<https://vercel.com/docs/deployment-protection/automated-agent-access>

## E2E gotchas

- **Don't pass `CI=1` to simulate CI locally.** It changes `forbidOnly`, retries, worker count and
  reporter in `playwright.config.ts` — you get a serialized run that fails on a stray `.only`, not a
  faithful CI mirror. `pnpm test:e2e:local` *is* the faithful mirror: CI runs that exact script.
- **Seed contract:** any new spec that depends on a particular data shape (pricing tiers, routings,
  BOM rows, addresses, …) should extend `e2e/global-setup.ts` rather than runtime-skipping. Skips
  hide real regressions — see the `jobs.status` prod incident (May 2026) where a runtime-skipped
  spec masked a broken SELECT.
- **From a worktree, Playwright will happily test the WRONG BRANCH.** Playwright launches no dev
  server — it trusts whatever is already serving `localhost:3000`. Run E2E from a worktree while the
  primary checkout's `pnpm dev` is up and the whole suite exercises the primary's code against your
  branch's expectations. It fails, or worse passes, for reasons unrelated to your change. The tell
  is a stale string: renamed UI still showing its old label. Confirm which checkout owns port 3000
  before trusting a local run: `lsof -p $(lsof -ti:3000) -a -d cwd`.

  `run-stack.mjs` hardcodes 3000, so to serve your own port you drive Playwright directly — fine for
  any spec that doesn't need FastAPI or the Anthropic mock:

  ```bash
  eval "$(supabase status -o env)"
  export NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
  pnpm next dev -p 3311 &                       # from the worktree
  export TEST_SUPABASE_URL=$API_URL TEST_SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY
  export PLAYWRIGHT_TEST_BASE_URL=http://localhost:3311
  pnpm exec playwright test e2e/<spec>.spec.ts --reporter=list
  ```

- **`global-setup` is find-or-insert, so an incomplete row STAYS incomplete.** A seeder that
  early-returns on "the job exists" will never backfill something added to it later — the local
  stack keeps whatever the first run created until `supabase db reset`. When extending a seeder,
  ensure each child record separately rather than behind the parent's existence check. CI always
  starts from an empty database, so this is a local-only symptom of a real seeder bug: green in CI,
  mystifying locally.
