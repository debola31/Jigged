# Observability

Four surfaces across three vendors. They answer different questions, and the two places
they *do* overlap are handled deliberately — one avoided, one knowingly accepted.

| Surface | Layer | Answers | Wired in |
|---|---|---|---|
| **Vercel Runtime Logs** | Infrastructure | Did the deploy succeed? Did the function throw or time out? | nothing to wire — platform |
| **Vercel Web Analytics** | Basic traffic | How many pageviews? Which routes? Web Vitals? | `<Analytics />` in [`app/layout.tsx`](../app/layout.tsx) |
| **Sentry** | Correctness | What broke, where in the code, for whom? | 3 config files + `instrumentation.ts` |
| **PostHog** | Behaviour | What did users do? Where did they drop off? | [`instrumentation-client.ts`](../instrumentation-client.ts) |

### Overlap 1 — error tracking: avoided

**Sentry owns errors. PostHog must not. Never add a second error tracker.**
`capture_exceptions` is deliberately off in
[`instrumentation-client.ts`](../instrumentation-client.ts) — Sentry has the grouping,
breadcrumbs and source-map upload that make a solo triage queue workable, and PostHog's
error tracking has no advanced grouping. Two trackers means double ingest and two places to
look during an incident. Turning it on would also make PostHog source-map upload a hard CI
requirement; leaving it off deletes that work item.

**Named gap:** the option is never *written*. `capture_exceptions` appears in that file only
inside a comment, so no test and no grep fails if someone turns it on. Verified behaviourally
instead — the PostHog project has never ingested an `$exception` event; the name is absent
from its taxonomy entirely (checked 2026-08-03).

**Vercel has no JavaScript error tracking at all**, so it substitutes for neither. A
client-side crash is invisible in Vercel logs.

### Overlap 2 — basic web analytics: accepted on purpose

Vercel Web Analytics and PostHog's web-analytics view genuinely overlap. **This is a
deliberate choice, not an oversight — do not "clean it up".**

- **Vercel Analytics** stays for at-a-glance pageview counts, per-route traffic and Web
  Vitals. It's the free tier, zero-config, zero-maintenance, and it needs no instrumentation
  per feature. One component in the root layout and it keeps working.
- **PostHog** is where the analysis that actually informs product decisions lives: user
  journeys, funnels, retention, drop-off, session replay, feature flags. Vercel can tell you
  conversions fell; only PostHog can tell you where.

**The overlap is also smaller than it looks: Web Vitals are Vercel-only.** PostHog has never
ingested a `$web_vitals` event here — the name is absent from its taxonomy (checked
2026-08-03), because nothing turns on `capture_performance`. Deleting `<Analytics />` would
not move Web Vitals to PostHog; it would end them.

The redundancy costs one script tag. Removing it would trade a free, always-correct traffic
number for a marginal bundle saving and a dependency on PostHog events being instrumented
correctly. **Keep both — neither is "redundant".**

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

### What actually alerts, and who receives it

The section above is mechanics. This is the state, and it is recorded here because none of it
lives in the repo — **all alerting config is server-side only**, which is exactly why the two
holes below went unnoticed for months. Re-measure with `sentry api` before trusting it.

| | `javascript-nextjs` | `python-fastapi` |
|---|---|---|
| Workflow id | 3138841 | 3174587 |
| Environment | `vercel-production` | `production` |
| Detector | 6744903 (Issue Stream) | 6806071 (Issue Stream) |
| Triggers (`any-short`) | `new_high_priority_issue`, `existing_high_priority_issue` | same |
| Action | `email` → `issue_owners` | same |
| Frequency | 30 min | 30 min |

Ownership on both projects is `{"raw": null, "fallthrough": true}` — **no CODEOWNERS**, so
`issue_owners` always falls through to ActiveMembers, which is the org's single member. In
practice: *every alert goes to the one account email, and nothing routes by area.*

**Trap 1 — the account email is the whole delivery path, and it is not validated by anything.**
Until 2026-08-05 the org's sole member was an address that did not exist, so five months of alert
email went nowhere while the workflows reported themselves healthy and `lastTriggered` kept
advancing. Nothing in Sentry surfaces this. Check it directly, and check it after any account
change:

```bash
sentry api '/api/0/organizations/jigged/members/' | jq -r '.[] | "\(.email) active=\(.user.isActive)"'
```

Sentry also does not deliver to an **unverified** primary address, and the org-scoped CLI token is
denied on `/users/{id}/emails/` — so verification can only be confirmed in
Settings → Account → Emails. A green workflow is not evidence anyone was told.

**Trap 2 — a detector with no workflow notifies nobody.** The uptime monitor is live and
unrouted:

```bash
sentry api '/api/0/organizations/jigged/detectors/' \
  | jq -r '.[] | "\(.name) → workflowIds=\(.workflowIds)"'
# Stripe webhook reachable (405 = healthy) → workflowIds=[]
```

An empty `workflowIds`, with no workflow listing it in `detectorIds`, means downtime is detected
and then dropped. Its `intervalSeconds: 3600 × downtimeThreshold: 3` also puts detection ~3 hours
behind the event. **Any new detector is silent until a workflow claims it** — the uptime UI does
not warn about this.

**What is deliberately not alerted.** Only *high* priority fires, and Sentry derives priority from
level: `error`/`fatal` → high, `warning` → medium, `info`/`debug` → low. So the repo's deliberate
`captureException(…, { level: 'warning' })` sites raise nothing, by construction. That is the
intended trade — see [why any of this matters](#why-any-of-this-matters) — but it means **lowering
a capture to `warning` silently opts it out of alerting**, which is easy to do by accident.

**The real ceiling is capture, not routing.** 4 of 34 `utils/*Access.ts` modules import Sentry, so
most write failures never become an issue at all and no rule can reach them —
[#708](https://github.com/debola31/Jigged/issues/708). Tuning alerts on a queue that is nearly
empty because reporting is thin is motion without progress.

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
> Operators are on **their own phones**, and in a machine shop a good share of those are
> iPhones — so this is still a Safari exposure, just via personal handsets rather than the
> shop-floor tablets this note originally assumed (corrected 2026-07-31; see
> [the device model](../CLAUDE.md#who-uses-what-on-what--the-device-model)). If any run an
> older iOS, this filter may be discarding
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

### Supabase failures report themselves — do not report them again

**A failed `.from()` read or write is captured automatically.** `lib/supabase.ts` installs
Sentry's `instrumentSupabaseClient`, which intercepts every `{ error }` response and files it
with the query and request body attached. You do not have to remember anything at a call site,
which is the point: the alternative considered in [#708](https://github.com/debola31/Jigged/issues/708)
was a rule across ~174 call sites, and a rule nothing enforces decays (see the `deleted_at`
rule, [#687](https://github.com/debola31/Jigged/issues/687)).

Why it exists at all: Supabase returns failures as `{ data, error }` rather than throwing, so a
caller that puts `error` into component state and stops — most of them — left no record
anywhere. On 2026-08-05 that meant a day of failed maintenance-note saves whose only surviving
trace was the Postgres log, found by hand.

**So the rule is: do not add a `captureException` for a failure the integration already
reports.** Two captures for one failure is worse than either alone — it becomes two issues,
fingerprinted differently, and fixing one leaves the other looking live.

**What it does NOT cover, where you still capture by hand:**

| Not covered | Why |
|---|---|
| `.rpc()` | Suppressed on purpose — see below |
| Storage (`supabase.storage.*`) | The integration doesn't instrument it |
| Anything that isn't a Supabase response | A thrown `Error`, a FastAPI call, a `fetch` |

### `.rpc()` is the access layer's to report, not the net's

`beforeSend` drops the integration's automatic capture for rpc calls, so `utils/*Access.ts`
stays their only reporter. Two reasons, both load-bearing:

1. **The net's rpc coverage is real but order-dependent.** The integration classifies by HTTP
   method, so an rpc POST reads as an `insert` — but the builder prototype is only patched as a
   side effect of a `.from()` chain. An `.rpc()` that is the first Supabase call on a page load
   is never captured. Coverage that depends on call ordering is not coverage.
2. **Only the call site can tell a deliberate raise from a bug.** `P0001` covers both
   *"Insufficient stock at location (have 0, need 999)"*, which is a user being told something,
   and the cross-company bug behind #708, which was also a `P0001`. No rule in `beforeSend`
   could separate them.

The mechanism is a span attribute stamped by the client's own `fetch` when the path is
`/rest/v1/rpc/…` — the one place the distinction is unambiguous. The span records only
`db.table`, which for an rpc holds the *function* name and is otherwise indistinguishable from
a table name; the list needed to tell them apart is not available at runtime, since
`types/database.ts` is types-only.

### What is never reported, and where that is decided

`shouldReportSupabaseError` in [`lib/supabaseErrors.ts`](../lib/supabaseErrors.ts), applied from
`beforeSend`:

| Dropped | Why |
|---|---|
| `PGRST116` | A `.single()` that matched nothing. The caller asked "is there one?" and got "no" |
| Transient aborts | Superseded, not failed. **Load-bearing:** postgrest-js does not reject on a cancelled request, it resolves `{ error }` with `hint: 'Request was aborted…'`, so without this every navigation-away becomes an issue |
| Auth errors | Session expiry is already handled by the refresh-and-retry in `lib/supabase.ts` |

Add to this list only with a recorded reason, exactly as with `ignoreErrors` below.

### Never hand a raw Supabase error to `captureException`

Still true wherever you capture by hand (the rpc, storage and thrown-error rows above). Supabase
returns a plain object (`{ code, details, hint, message }`), not an `Error`. Sentry cannot
fingerprint that, so it lands as an issue titled `"e"` or `"<unknown>"` with the body *"Object
captured as exception with keys: …"*, and the real message is buried in a `__serialized__` extra.
One such issue went unread for four months.

```ts
import { toError } from '@/lib/supabaseErrors';
Sentry.captureException(toError(err, 'Failed to verify company access'));
```

The integration does this for you on the paths it covers — it builds a real `Error` and copies
`code`/`details` onto it, which is the same job `toError` does.

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

Add to this list only with a verified reason, and record it here. An entry with no recorded
reason is indistinguishable from a mistake.

### Don't re-enable the SDKs outside a production build

`enabled: process.env.NODE_ENV === "production"` guards all three JS configs —
[`instrumentation-client.ts`](../instrumentation-client.ts),
[`sentry.server.config.ts`](../sentry.server.config.ts),
[`sentry.edge.config.ts`](../sentry.edge.config.ts) — and `"pytest" in sys.modules` guards
the backend (next section). `pnpm dev` and the Playwright suite both run with
`NODE_ENV=development`, and their errors used to land in the same queue as production; that
noise is what made the alerts ignorable ([why](#why-any-of-this-matters)).

**The guard costs no deployment coverage.** Vercel builds *previews* with
`NODE_ENV=production` too — which is where `vercel-preview` in the environment table above
comes from. Only local and CI runs are silenced.

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
