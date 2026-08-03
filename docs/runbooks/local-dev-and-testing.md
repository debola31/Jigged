# Runbook — local dev, tests, worktrees and previews

> Moved out of `CLAUDE.md` on 2026-08-03 under [#634](https://github.com/debola31/Jigged/issues/634).
> It is **runbook, not rule**: procedures you follow when doing a specific thing, rather than
> constraints that bind every change. Keeping it in the always-loaded file cost roughly 4,300
> tokens on every session, including the many that never run E2E. Nothing here was cut — it moved.
>
> The rules that *do* bind every change stayed in `CLAUDE.md`.

## E2E setup (only needed once per machine)

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

## Running E2E (or `pnpm dev`) from a git worktree

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

**The local Supabase stack is a machine-wide singleton, shared by every
worktree — it is NOT per-worktree.** There is one Postgres container set per
machine. `supabase start` / `supabase db reset` replay migrations from whatever
directory invokes them into that one shared DB, so a `db reset` from any
worktree **replaces the stack for every other worktree** too. It does not track
a branch; it holds whatever was last replayed into it — in practice the
primary's, since that's where resets usually run. So when working from a
worktree:

- **No migration changes in your branch?** The shared local stack is a valid
  substrate — run `pnpm dev`, unit tests, and E2E against it from the worktree
  normally (the schema it needs already exists).
- **Your branch adds or edits migrations?** **Verify them on the PR's Supabase
  preview branch**, which applies the migration to its own isolated DB — that's
  the gate. Do **not** `db reset` the shared stack from a worktree to pick up
  your migrations: with concurrent worktree agents it clobbers the DB the others
  depend on, and even solo it just confuses what the stack represents. **The
  rule: worktree migrations go to the preview branch, never the shared local
  stack.**
- **Need `types/database.ts` regenerated for a worktree migration?** `pnpm
  gen:db-types` introspects the shared `--local` stack, so it has the same
  hazard. Prefer letting **CI regenerate + diff-check** types on the PR (the
  backend job already fails on a mismatch), or regenerate against a throwaway
  DB — don't `db reset` the shared stack mid-flight just to gen types. Do **not**
  hand-edit the file: the drift check diffs a byte-exact regen, so a hand-edit
  fails CI even when every column is right.

  The generator accepts `--db-url`, so a throwaway container works:

  ```bash
  docker run -d --rm --name migcheck -e POSTGRES_PASSWORD=x -p 55499:5432 postgres:17-alpine
  # create the db, apply Supabase-platform stubs (roles anon/authenticated/
  # service_role/jigged_ai_readonly, schemas auth/storage, auth.uid(),
  # storage.objects + storage.foldername), then replay supabase/migrations/ in order
  npx --yes supabase@2.109.0 gen types typescript \
    --db-url "postgresql://postgres:x@127.0.0.1:55499/jigged" > types/database.ts
  ```

  **Gotcha that costs a red CI run:** a bare Postgres has no `pg_graphql`, so the
  generator silently omits the `graphql_public` schema — in **two** places, the
  schema block *and* the trailing `Constants` export. Splice both back from
  `main` (this migration never touches them), then diff against `main` and
  confirm only your intended tables/functions changed. Keep the generator version
  matching the one pinned in `gen:db-types`.

## Visual verification on a Vercel preview (worktrees, agents)

Preview deployments sit behind Deployment Protection, so an agent gets a login
page. The project has a **Protection Bypass for Automation** secret; it lives in
`.env.local` as `VERCEL_AUTOMATION_BYPASS_SECRET` (gitignored — copy `.env.local`
from the primary checkout in a fresh worktree, and re-copy if it was added after
your worktree was created).

Pass it as **headers**, not query params, so the secret never lands in a URL,
shell history, or an agent transcript. `x-vercel-set-bypass-cookie` sets a cookie
so in-app navigation after the first load keeps working:

```bash
export S=$(grep '^VERCEL_AUTOMATION_BYPASS_SECRET=' .env.local | cut -d= -f2- | tr -d '"'"'"' \r')
export HDRS=$(python3 -c "import json,os;print(json.dumps({'x-vercel-protection-bypass':os.environ['S'],'x-vercel-set-bypass-cookie':'true'}))")
agent-browser open "$PREVIEW_URL/login" --headers "$HDRS"
```

Then sign in with the seed account (`dev@jigged.test` / `jigged-dev-1234`) — the
preview branch runs `supabase/seed.sql`, so it has the full Vanguard Precision
Works data graph. Get `$PREVIEW_URL` from the PR's Vercel comment or
`gh pr view <n> --json comments`.

**Use a fresh `--session` per preview domain.** The bypass cookie is set for one
host; carrying a session over from a previous PR's preview makes the new domain
bounce to Vercel's SSO login even though the headers are correct. `agent-browser
open … --session <pr-number>` avoids it.

**If the app shows "Something Went Wrong" on every route, it is almost certainly
not your code.** Check `agent-browser console` for:

```
@supabase/ssr: Your project's URL and API key are required to create a Supabase client!
```

That means the deployment has no `NEXT_PUBLIC_SUPABASE_*`. Those are inlined at
**build** time, so the first Vercel build of a new preview branch can outrun
Supabase Branching provisioning and bake in empty values. Observed on two
consecutive PRs. **A rebuild fixes it with no code change** — push any commit, or
redeploy from the Vercel dashboard.

It presents as a total outage rather than a broken page because
[`lib/supabase.ts`](lib/supabase.ts) creates the client eagerly at module scope
(`export const supabase = typeof window !== 'undefined' ? getSupabase() : null`),
so the throw happens during module evaluation and nothing renders anywhere.

Notes: `agent-browser get text` needs a selector (`get text body`); prefer
`snapshot -i -c` or `eval` since a not-yet-hydrated App Router page returns raw
RSC payload. `agent-browser console` / `errors` are the fastest triage. Docs:
<https://vercel.com/docs/deployment-protection/automated-agent-access>
- **Merge → local:** merging to `main` auto-applies the migration to **prod**
  (branching pipeline), but your **local** stack only picks it up when you
  `git pull` in the primary and `supabase db reset` again. Merge→prod is
  automatic; merge→local is a manual replay.

## E2E gotchas

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
- **From a worktree, Playwright will happily test the WRONG BRANCH.**
  `playwright.config.ts` no longer launches a dev server — it trusts
  whatever is already serving `localhost:3000`. Run E2E from a worktree
  while the primary checkout's `pnpm dev` is up and the whole suite
  exercises the primary's code against your branch's expectations. It
  fails, or worse passes, for reasons unrelated to your change. The tell
  is a stale string: renamed UI still showing its old label.

  Serve your own port and point Playwright at it — no need to stop
  anyone else's server:

  ```bash
  eval "$(supabase status -o env)"
  export NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
  pnpm next dev -p 3311 &                       # from the worktree
  export TEST_SUPABASE_URL=$API_URL TEST_SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY
  export PLAYWRIGHT_TEST_BASE_URL=http://localhost:3311
  pnpm exec playwright test e2e/<spec>.spec.ts --reporter=list
  ```

  Confirm which checkout owns port 3000 before trusting a local E2E run:
  `lsof -p $(lsof -ti:3000) -a -d cwd`.
- **`global-setup` is find-or-insert, so an incomplete row STAYS
  incomplete.** A seeder that early-returns on "the job exists" will
  never backfill something added to it later — the local stack keeps
  whatever the first run created until `supabase db reset`. When
  extending a seeder, ensure each child record separately rather than
  behind the parent's existence check, and remember CI always starts
