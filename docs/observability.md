# Observability

Three tools, three layers. They are **not** redundant, but there is exactly one overlap
you must not re-create.

| Tool | Layer | Answers |
|---|---|---|
| **Vercel** (logs + analytics) | Infrastructure | Did the deploy work? Is the function slow? |
| **Sentry** | Correctness | What broke, where in the code, for whom? |
| **PostHog** | Behaviour | What did users do? Where did they drop off? |

**Sentry owns error tracking. PostHog must not.** `capture_exceptions` is deliberately
`false` in [`instrumentation-client.ts`](../instrumentation-client.ts) — Sentry has the
grouping, breadcrumbs and source-map upload that make a solo triage queue workable, and
PostHog's error tracking has no advanced grouping. Two trackers means double ingest and
two places to look during an incident. Vercel has **no** JavaScript error tracking at all,
so it is not a substitute for either.

---

## Sentry: the CLI is the interface

The `sentry` CLI is installed and authenticated (`sentry auth status`). Prefer it over the
dashboard — an agent can use it, and it composes.

Two projects:

- `jigged/javascript-nextjs` — frontend
- `jigged/python-fastapi` — backend

```bash
sentry issue list jigged/javascript-nextjs --query "is:unresolved" --period 90d
sentry issue view JAVASCRIPT-NEXTJS-9          # details + latest event
sentry issue events JAVASCRIPT-NEXTJS-9        # per-event list
sentry issue explain JAVASCRIPT-NEXTJS-9       # Seer AI root cause
sentry issue plan JAVASCRIPT-NEXTJS-9          # Seer AI fix plan
sentry issue archive JAVASCRIPT-NEXTJS-9 --until auto
```

An MCP server also exists — `https://mcp.sentry.dev/mcp/jigged/javascript-nextjs`, wired in
the gitignored `.mcp.json`. Its entry **needs `"type": "http"`** or Claude Code silently
skips it. Authorise via `/mcp` in an interactive session. The CLI does everything the MCP
does, so this is convenience, not a prerequisite.

### Environments, and how to filter by them

Post-#625 the environment tags are trustworthy:

| Where | Tag |
|---|---|
| Frontend, production | `vercel-production` |
| Frontend, preview | `vercel-preview` |
| Frontend, local dev / CI E2E | **nothing — the SDK is disabled** |
| Backend, production | `production` |
| Backend, preview | `preview` |
| Backend, local | `development` |

Note the asymmetry: the frontend's tags come from Vercel's Sentry integration
(`vercel-` prefixed), the backend's from `resolve_sentry_environment()` in
[`api/index.py`](../api/index.py) reading `VERCEL_ENV`. Issues older than 2026-07-30 may
carry `staging`, from a since-removed `ENVIRONMENT` variable — that value is legacy, not
a current environment.

```bash
sentry issue list jigged/javascript-nextjs --query "is:unresolved environment:vercel-production"
sentry issue list jigged/python-fastapi    --query "is:unresolved environment:production"
```

> ### ⚠️ An issue is a *group*: the environment filter matches if ANY event matches
>
> Filtering to `environment:vercel-production` returns groups that **also** contain preview
> and local events, and vice versa. This is the single most dangerous gotcha in this
> document: a bulk archive scoped by environment nearly silenced two real production bugs,
> because both groups also had preview events.
>
> **Filter to find. Verify per-event before acting.** Check the actual distribution:
>
> ```bash
> for t in environment url browser user; do
>   sentry api "/api/0/organizations/jigged/issues/<numeric-id>/tags/$t/" \
>     | jq -r ".topValues[]?|\"\(.count)x \(.value)\""
> done
> ```
>
> A `localhost` URL, a `HeadlessChrome` user-agent, or a `*.vercel.app` preview host means
> it isn't production, whatever the group's tag list says.

### Triage runbook

1. **List unresolved production issues** for both projects.
2. **For each, get the real payload.** Titles lie — see the `toError` rule below. A
   `"Object captured as exception with keys: …"` body means the real message is hidden in a
   `__serialized__` extra:
   ```bash
   sentry api '/api/0/organizations/jigged/issues/<id>/events/latest/' \
     | jq -r '.context.__serialized__, (.entries[]?|select(.type=="exception")|.data.values[]?
              |"mechanism=\(.mechanism.type) handled=\(.mechanism.handled)")'
   ```
3. **Check `mechanism` and `handled`.** `onunhandledrejection` with no in-app frames is
   usually a library's own background recovery, with no user-visible effect.
   `on_request_error` is a server render that threw — the user saw an error page.
4. **Confirm it's our code at all.** If a symbol appears nowhere in the source,
   `node_modules`, *or* a built bundle (`pnpm build` then `grep -rl "<symbol>" .next/static`),
   it's an injected browser extension. Single stack frame with no filename is the tell.
5. **Fix, or filter with a reason.** Never archive without recording why.

### Archiving

`--until auto` re-opens the issue if event frequency spikes again, so a fix that didn't
work resurfaces. Prefer it to archive-forever.

```bash
sentry issue archive PYTHON-FASTAPI-1N --until auto
```

Needs a permission rule — `Bash(sentry issue archive:*)` in `.claude/settings.local.json`.
**A `for` loop does not match that rule** (the command must *start* with `sentry issue
archive`), so issue individual calls, batched in parallel.

### Alert rules live in the Workflow Engine, not `rules/`

This org has been migrated. The old endpoint is gone:

```
GET /api/0/projects/jigged/javascript-nextjs/rules/{id}/
  → {"message": "This API no longer exists."}
```

**`sentry alert issues edit` is therefore broken here** — it resolves the rule name to the
correct id, then calls the dead endpoint and 404s. Use the workflows API:

```bash
sentry api '/api/0/organizations/jigged/workflows/'              # list (id, environment, detectorIds)
sentry api '/api/0/organizations/jigged/detectors/'              # detector → projectId
sentry api '/api/0/organizations/jigged/workflows/{id}/' --method PUT --input body.json
```

The `PUT` requires the **full body** (`name`, `triggers`, `actionFilters`, `config`,
`detectorIds`, `enabled`, `environment`) — a partial returns `{"name": ["This field is
required."]}`. Build it from a `GET` with `jq`, and back up first. Also: `sentry alert
issues list` crashes on an empty list (a CLI rendering bug) — use the API.

Both workflows are scoped to production so local and CI runs can't page anyone. **A rule
scoped to an environment nothing emits is silent** — only scope after the code that emits
that tag has actually deployed.

### Inbound filters: what's free and what isn't

Free, per-project, at `/api/0/projects/jigged/<project>/filters/`:

- `localhost` — **on for both projects.** Drops local dev, local backend and CI E2E at
  ingest. This was off and was most of the historical noise.
- `browser-extensions`, `web-crawlers`, `legacy-browsers`, `filtered-transaction`

```bash
sentry api '/api/0/projects/jigged/javascript-nextjs/filters/' | jq -r '.[]|"\(.id) active=\(.active)"'
sentry api '/api/0/projects/jigged/javascript-nextjs/filters/localhost/' --method PUT --input on.json
```

Custom **error-message** filters (`filters:error_messages`) are a **paid** feature —
`{"detail":"You do not have that feature enabled"}`. Use the SDK's `ignoreErrors` instead,
which is strictly better anyway: the event never leaves the browser and never counts
against quota.

> **Open question:** `legacy-browsers` is active on the frontend with `safari` in its list.
> Shop-floor tablets are iPads. If any run an older iOS, this filter may be discarding
> errors from exactly the devices that matter most. Not yet resolved.

### Plan and budget

Free Developer plan: **5,000 errors/month, 30-day retention.** Measured usage is ~394
errors/30d (~8%), so quota is not a constraint — but 30-day retention means an issue's
early events are gone, so act inside the window.

```bash
sentry api '/api/0/organizations/jigged/stats_v2/?statsPeriod=30d&field=sum(quantity)&category=error&groupBy=outcome' \
  | jq -r '.groups[]|"\(.by.outcome) \(.totals["sum(quantity)"])"'
```

---

## Rules for writing code

### Never hand a raw Supabase error to `captureException`

Supabase rejects with a plain object (`{ code, details, hint, message }`), not an `Error`.
Sentry cannot fingerprint that, so it lands as an issue titled `"e"` or `"<unknown>"` with
the body *"Object captured as exception with keys: …"*, and the real message is buried in a
`__serialized__` extra. One such issue went unread for four months.

```ts
import { toError } from '@/lib/supabaseErrors';
Sentry.captureException(toError(err, 'Failed to verify company access'));
```

### "Couldn't check" is not "denied"

A failed check must never render as a definitive negative. `verifyCompanyAccess` used to
swallow errors into `return false`, and its caller rendered that as *"You don't have access
to this company"* — so one dropped request locked a user out of their own shop. Return a
definitive answer only for a definitive result; throw otherwise, and give the UI a
distinct, retryable state. See [`AuthGuard.tsx`](../components/auth/AuthGuard.tsx).

### Transient aborts are not failures

`@supabase/auth-js` serialises token refreshes with the Web Locks API. When a lock is
orphaned (a component unmounting mid-refresh), the next caller times out and re-acquires
with `{ steal: true }`, and the orphan rejects with `AbortError: Lock was stolen by another
request`. That means *superseded*, not *failed*. Classify with `isTransientAbortError` and
retry; never report it and never surface it as an error.

### `ignoreErrors` — what's filtered and why

In [`instrumentation-client.ts`](../instrumentation-client.ts):

| Pattern | Why |
|---|---|
| `Invalid login credentials` | A mistyped password is not a bug |
| `EmptyRanges` | A Safari extension. Absent from source, `node_modules` **and** the built bundle |
| `Lock was stolen` | auth-js's own recovery working as designed; no user-visible effect |

Add to this list only with a verified reason, and record it here.

---

## Python SDK: two traps

Both cost real debugging time. Both look correct and are not.

**1. `dsn=None` does not disable the SDK.** It falls back to reading `SENTRY_DSN` from the
environment — which `load_dotenv` has already populated from `.env.local`. Disabling needs
an **empty string**:

```python
sentry_sdk.init(dsn="" if _UNDER_PYTEST else os.getenv("SENTRY_DSN"), ...)
```

**2. `client.is_active()` is not a "will it send" check.** It returns `True` for any
initialised client regardless of DSN. The operative fact is the transport, which
`make_transport` returns `None` for when the DSN is falsy:

```python
assert sentry_sdk.get_client().transport is None
```

`sentry_sdk.init` runs at import time, and `api/tests/conftest.py` does
`from index import app` — so pytest arms the SDK during collection, before
`PYTEST_CURRENT_TEST` exists. The guard is `"pytest" in sys.modules`. Without it, tests
that deliberately provoke failures get filed as High-priority *production* errors.
Regression-tested in [`test_sentry_config.py`](../api/tests/unit/test_sentry_config.py).

---

## CLI ergonomics

**`--json` returns `{"data": [...]}`, not a bare array.** `jq 'length'` counts object keys
and silently returns 3 or 4 for any query. Use `jq '.data | length'`.

```bash
sentry issue list jigged/javascript-nextjs --query 'is:unresolved' --json | jq '.data|length'
```

`sentry schema` browses the API; `sentry api <endpoint>` is a `curl`-alike that handles
auth. There is no `--environment` flag on `issue list` — environment goes in `--query`.

---

## Why any of this matters

Sentry sat unread for months because 55 of its 61 issues were this project's own `pytest`
runs, dev machines and CI E2E — with an unscoped default alert rule emailing on every one.
That is textbook alert fatigue, and it hid three real bugs, one of which had been live
since March. The fix was four lines of configuration, not a new tool.

**The lesson to keep:** a queue you don't trust is worse than no queue, because it trains
you to ignore the one alert that mattered. Every filter added here needs a reason recorded,
and every archive needs `--until auto` so a wrong call corrects itself.
