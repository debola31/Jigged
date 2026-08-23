# Telemetry

Everything we collect about the running system, and everything we collect about the people using
it. **Telemetry is the umbrella; the two halves under it are different disciplines and stay named
apart.**

- **Observability** — inferring system state from its outputs. Sentry and the Vercel surfaces.
  Permanent: an error signal matters for as long as the code runs.
- **Product analytics** — what people did and where they dropped off. PostHog. Question-shaped:
  an event can be retired once its question is answered ([two lifecycles](#two-lifecycles-one-doc)).

They live in one document because they share tools, config surfaces and failure modes — the
session-replay setting below reaches into the Web Vitals argument above, and splitting them is how
you get a PR that changes one without noticing the other. They keep separate names because
"observability" has a specific meaning (metrics, logs, traces) that product analytics is not, and
because rules like *"Sentry owns errors, PostHog must not"* need two things to keep apart.

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

## PostHog session replay: on, and why it is configured this way

**Enabled 2026-08-07.** Replay is the highest-value instrument at pilot scale: with three named
users, watching three sessions beats any aggregate, and rate-based insights over an N that small
are noise. There is **no code for this** — `instrumentation-client.ts` never sets
`disable_session_recording`, so the project's remote config governs. The settings below live only
in PostHog, which is why they are written down here.

| Setting | Value | Why |
|---|---|---|
| `session_recording_opt_in` | `true` | The change itself |
| `session_recording_masking_config` | `{ maskAllInputs: true }` | Never record keystrokes — passwords, prices, quantities. Rendered text stays visible, because a replay with every label masked cannot teach you anything |
| `recording_domains` | `https://www.jigged.app` | Belt-and-braces production-only. The token already gates this, but a domain allowlist survives someone re-adding it to `.env.local` |
| `capture_console_log_opt_in` | `false` | Console output routinely holds API responses and user objects. It was `true` and inert while replay was off — enabling replay is what would have armed it |
| `capture_performance_opt_in` | `false` | **See below** |
| `session_recording_retention_period` | `30d` | Shortest available |

**`capture_performance` is deliberately off, and turning it on would break an argument made
above.** Overlap 2 rests on PostHog having never ingested a `$web_vitals` event — that is what
makes "deleting `<Analytics />` would end Web Vitals, not move them" true. Performance capture is
part of replay, so enabling replay with it on would start producing `$web_vitals` here, and the
next person to read that section would find its premise false and reasonably conclude Vercel
Analytics is now redundant. The cost of keeping it off is network timing in replays, which is not
worth a load-bearing invariant.

**Not masked: rendered text**, which on admin screens means customer names and part numbers. That
is the same exposure as autocapture ([#702](https://github.com/debola31/Jigged/issues/702)), traded
deliberately — a replay is watched by us and expires in 30 days, where an event property is
queried, exported and retained for a year. Revisit when the pilot ends.

---

## The tracking plan

**Machine-enforced** by [`scripts/analyticsEventsCheck.ts`](../scripts/analyticsEventsCheck.ts):
an event captured in code but absent from the registry below fails CI, and so does a registry row
nobody sends. Both directions, because a table with one wrong row stops being read.

### The convention

**`[object] [verb]`, lowercase, spaces, past tense** — `quote created`, not `quote_created` or
`Create Quote`. This is [PostHog's own recommendation](https://posthog.com/docs/product-analytics/capture-events)
and what PostHog uses for its own custom events. The object leads so related events sort together.

**Renamed from snake_case on 2026-08-07**, four days into collecting anything. The argument for
keeping the old names was continuity of historical data; at three users and four days there was no
history worth the inconsistency. **That argument gets stronger every week** — the disciplined way
to rename later is to emit both names, migrate the insights, then retire the old one, and it is
much more work than doing it now.

**Properties describe the shape of the interaction, never the content of the record.** Counts,
booleans and enums — not names, values or free text. `part created` is the model: it sends
`has_reorder_point`, a boolean, not the reorder point.

**Properties stay `snake_case`.** They are code identifiers read in filter expressions, not display
labels.

**A surface is a property, not a name.** Office and operator stock adjustments are one
`stock updated` event with `surface`, not two events. Encoding a variable in the event name is what
PostHog's high-cardinality guidance warns against, and it makes the two impossible to total.

### The registry

The properties column is exhaustive, unioned across call sites: a property passed but unlisted
fails, and so does a listed property nothing passes.

<!-- registry:start -->

| Event | Fires when | Properties | Call site |
|---|---|---|---|
| `user signed in` | The login form is submitted successfully | — | [Login.tsx](../components/auth/Login.tsx) |
| `user signed out` | Supabase emits `SIGNED_OUT` | — | [AuthProvider.tsx](../components/providers/AuthProvider.tsx) |
| `invitation sent` | An admin submits the invite form and the edge function answers | `role`, `email_sent` | [members/new/page.tsx](../app/dashboard/[companyId]/team/members/new/page.tsx) |
| `invitation link expired` | An invitee lands on /login because their link no longer verified | `can_self_resend` | [Login.tsx](../components/auth/Login.tsx) |
| `invitation link resend requested` | An invitee asks for a fresh link from that screen | — | [Login.tsx](../components/auth/Login.tsx) |
| `invitation accepted` | An invitee completes acceptance | `role`, `existing_user` | [accept-invite/page.tsx](../app/accept-invite/[invitationId]/page.tsx) |
| `terms accepted` | Someone ticks the clickwrap box and it is recorded. One event per click, NOT per document: one tick writes a row for each document in a single call, and firing twice would double the denominator for a single act of assent | `surface`, `is_reacceptance` | [TermsAcceptanceDialog.tsx](../components/legal/TermsAcceptanceDialog.tsx) |
| `terms document opened` | A legal document is opened from beside the checkbox. **Whether anyone actually reads them is the legally interesting fact** — it goes to conspicuousness, and nothing else in the product records it | `surface`, `document_type` | [TermsConsentCheckbox.tsx](../components/legal/TermsConsentCheckbox.tsx) |
| `quote created` | A new quote is saved | `line_item_count`, `custom_priced_line_count`, `customer_id`, `has_customer_note` | [QuoteForm.tsx](../components/quotes/QuoteForm.tsx) |
| `quote converted to job` | A quote is accepted and becomes a job | `quote_id`, `part_count`, `is_hot` | [ConvertToJobModal.tsx](../components/quotes/ConvertToJobModal.tsx) |
| `job created from purchase order` | A job is created directly from a PO | `part_count`, `total_value`, `is_hot` | [AcceptPurchaseOrderModal.tsx](../components/jobs/AcceptPurchaseOrderModal.tsx) |
| `jobs bulk cancelled` | Several jobs are cancelled in one action | `count` | [jobs/page.tsx](../app/dashboard/[companyId]/jobs/page.tsx) |
| `shipment created` | A shipment is created | `line_item_count`, `shipping_method` | [ShipmentForm.tsx](../components/shipments/ShipmentForm.tsx) |
| `drawings read` | A folder of drawings is parsed in the browser. No network call and no credits — this is the denominator the AI pass is measured against, and `read_from_pdf` says how often the second front-end earns its place | `file_count`, `part_count`, `read_from_dxf`, `read_from_pdf`, `unreadable_count`, `with_components`, `has_customer` | [parts/drawings/page.tsx](../app/dashboard/[companyId]/parts/drawings/page.tsx) |
| `parts created from drawings` | The import commits. `quotable_count` is the number that matters — a part is only quotable once it has priced work AND a markup, so the gap between `created_count` and `quotable_count` says how often the flow stops short of the thing it exists for. `updated_count` is separated from `created_count` on purpose: whether shops meet the same-number case at all is the question the identity guard was built for | `created_count`, `updated_count`, `failed_count`, `excluded_count`, `files_attached`, `with_operations`, `components_linked`, `quotable_count`, `has_customer` | [parts/drawings/page.tsx](../app/dashboard/[companyId]/parts/drawings/page.tsx) |
| `vendor service created` | An outside process is added to a vendor. **`has_price` is the number this feature exists to move**: 89% of outside routing steps carried no price at the split, and a service is where a shop can set one once instead of per step. If services keep arriving unpriced, naming the process solved the smaller half of the problem | `has_price` | [VendorServiceForm.tsx](../components/vendors/VendorServiceForm.tsx) |
| `vendor service archived` | A service is archived from the vendor page. No properties — the volume is the signal, and a shop steadily archiving services is one whose vendor list was wrong when it was migrated rather than one changing suppliers | — | [vendors/[vendorId]/page.tsx](../app/dashboard/[companyId]/vendors/[vendorId]/page.tsx) |
| `part created` | A part is created in the parts workspace | `source`, `has_reorder_point`, `has_preferred_vendor` | [PartIdentitySection.tsx](../components/parts/workspace/PartIdentitySection.tsx) |
| `bom line charge basis set` | A BOM line is saved, or the per-part toggle sets every purchased material on a part at once. **Whether `price` is ever chosen is the question this feature exists to answer** — it is the practice L&L described and we believe is universal, and if nobody turns it on we have built for a niche of one | `basis`, `bulk`, `child_source` | [PartBomPanel.tsx](../components/parts/PartBomPanel.tsx) |
| `pricing defaults set` | The shop's part-pricing defaults are saved in Settings. The `*_is_zero` pair says whether shops actually configure the markups or leave them at cost; `material_basis` says whether charging material at price is the norm we believe it is, set once globally rather than per part | `made_changed`, `bought_changed`, `material_basis_changed`, `made_is_zero`, `bought_is_zero`, `material_basis` | [AppDefaultsCard.tsx](../components/settings/AppDefaultsCard.tsx) |
| `stock updated` | Stock is adjusted. `surface` says which UI — `office` (a part's own page), `storage` (the four verbs on a place, Storage tab), `operator` (the four verbs on a part already in the bin), `operator_receive` (stocking a part into a bin it was not in yet); `location_id` is absent only on `office`, which picks the place inside the dialog | `surface`, `action`, `part_id`, `quantity`, `unit`, `location_id` | [PartLocationActionModal.tsx](../components/parts/PartLocationActionModal.tsx) · [PlaceStockActionForm.tsx](../components/inventory/locations/place/PlaceStockActionForm.tsx) · [OperatorLocationActionModal.tsx](../components/operator/OperatorLocationActionModal.tsx) · [OperatorReceivePartModal.tsx](../components/operator/OperatorReceivePartModal.tsx) |
| `location layout changed` | A storage unit is reshaped from the Storage page — the one write that can create, rename, re-parent and remove locations *and* redistribute their stock in a single transaction. Deliberately **not** accompanied by a `stock updated` per moved part: the redistribution happens server-side inside `apply_location_layout`, so firing one event per part would attribute forty writes to one click and inflate that event's denominator. The count rides here instead, as `parts_redistributed`. `used_levels_editor` separates the two ways of shaping a unit — by the numbers, or by editing individual locations — which is the open question about whether the numeric editor earns its place at all | `locations_created`, `locations_renamed`, `locations_moved`, `locations_removed`, `locations_with_stock_removed`, `parts_redistributed`, `used_levels_editor`, `final_depth` | [VisualLocationBuilder.tsx](../components/inventory/locations/builder/VisualLocationBuilder.tsx) |
| `operation completed` | An operator completes an operation. Operator-only, so no `surface` | `job_operation_id`, `quantity_good`, `is_partial` | [operations/page.tsx](../app/operator/[companyId]/jobs/[jobId]/parts/[jobPartId]/operations/[jobOperationId]/page.tsx) |
| `operation completed untimed` | An operator takes the `Complete without timing` escape hatch — they did the work and never started the clock, so the completion lands with no interval. **This is the number that says whether the timer is workable**: a low and falling rate means starting is easy, a high or rising one means the flow is too hard to reach and the fix is ours, not the operator's. Deliberately no reason code — asking why would turn an escape hatch into an interrogation, which is how escape hatches stop being used honestly | `is_partial` | [operations/page.tsx](../app/operator/[companyId]/jobs/[jobId]/parts/[jobPartId]/operations/[jobOperationId]/page.tsx) |
| `time interval started` | An operator taps Start on a step. `had_open_interval` is the question the chained model turns on: how often is somebody already running something when they start the next thing — i.e. how much of the shop is genuinely concurrent rather than sequential | `had_open_interval` | [OperatorIntervalContext.tsx](../components/operator/OperatorIntervalContext.tsx) |
| `time interval closed` | An operator records what they finished, closing the interval. There is no `close_reason` property because there is nothing to distinguish: the only explicit close is a completion, and `switched` is written server-side by the chain rather than by a tap. `was_adjusted` is the signal that survives — a high rate means the clock is not being started when the work is | `was_adjusted` | [OperatorIntervalContext.tsx](../components/operator/OperatorIntervalContext.tsx) |
| `demo entered` | Someone steps into the demo/demo company. `surface` says from where — the office calls it demo mode, the shop floor calls it demo mode, and they are one company | `surface` | [DemoModeProvider.tsx](../components/providers/DemoModeProvider.tsx) · [OperatorDemoModeButton.tsx](../components/operator/OperatorDemoModeButton.tsx) |
| `scanner opened` | The in-app scanner dialog opens. The denominator for everything below | `surface` | [LocationScanner.tsx](../components/scanner/LocationScanner.tsx) |
| `label scanned` | A decoded code was accepted by the caller. `ms_to_decode` is measured from the dialog opening and `scan_index` counts within that session, so `scan_index = 1` is time-to-first-scan and the rest is continuous-scan cadence | `surface`, `kind`, `ms_to_decode`, `scan_index`, `torch_used` | [LocationScanner.tsx](../components/scanner/LocationScanner.tsx) |
| `label scan rejected` | A code decoded but was refused. `reason` is one of `not_jigged`, `foreign_company`, `traveler_unsupported`, `caller_rejected` | `surface`, `reason` | [LocationScanner.tsx](../components/scanner/LocationScanner.tsx) |
| `scan link opened` | A printed code scanned with the phone's **camera app** lands on the operator login passthrough. `had_session` false means the scan cost an extra screen | `kind`, `had_session` | [login/page.tsx](../app/operator/[companyId]/login/page.tsx) |

| `accounting connect started` | An admin picks an accounting system and starts connecting. `provider` is `qbo` (an Intuit OAuth redirect) or `qbd` (a setup link created for the shop computer) | `provider` | [QuickBooksIntegrationCard.tsx](../components/settings/QuickBooksIntegrationCard.tsx) |
| `accounting connection tested` | An explicit "Test connection" returns. `ok` false is the ordinary "QuickBooks isn't open right now" case, not an error — it is the denominator for how often a shop PC is actually reachable | `provider`, `ok`, `ms_elapsed` | [QuickBooksDesktopPanel.tsx](../components/settings/quickbooks/QuickBooksDesktopPanel.tsx) |
| `accounting disconnected` | An admin disconnects the accounting system | `provider` | [QuickBooksDesktopPanel.tsx](../components/settings/quickbooks/QuickBooksDesktopPanel.tsx) |
| `invoice pushed` | An invoice is created in QuickBooks from the job push dialog. `has_deep_link` is false for QuickBooks Desktop, which has no web page to link to | `provider`, `line_count`, `already_existed`, `has_deep_link` | [PushToQuickBooksDialog.tsx](../components/jobs/PushToQuickBooksDialog.tsx) |

<!-- registry:end -->

The markers are not decoration — the checker parses only between them, because this document
contains other tables whose first cells are backticked identifiers.

**Several properties carry customer business data and are scheduled for change** — `total_value`,
`quantity`, `quantity_good`, and the raw `customer_id` / `part_id` / `quote_id` /
`job_operation_id` identifiers ([#702](https://github.com/debola31/Jigged/issues/702)). This table
records what we send, not what we have decided is right.

### Known gap: notes and photos are not instrumented

The operator activity feed — the notes-and-photos loop
[modules/operator-view.md](modules/operator-view.md) treats as a core surface — sends **no event**.
A pilot user posted a note on 2026-08-06 and it appeared nowhere in analytics; that is how the gap
was found.

Measurement today is a PostHog **action** (`Note posted (autocapture proxy)`, id 311795) matching
autocapture clicks on the `Post` button. It works retroactively, which is why it was worth making,
but it is text-matched and breaks silently if the label changes.

**This blocks a fix we want.** `mask_all_text` — the remedy for autocapture capturing customer
names — would also break the proxy. Instrument `note posted` properly and both resolve.

### Autocapture is for discovery, not measurement

Autocapture stays **on** and is the highest-volume event by an order of magnitude. Its job is to
answer *"what are people doing that we never thought to measure"* — exactly what it did for notes.
Its job is **not** to be the source of a metric anyone relies on.

The loop: autocapture surfaces a behaviour → the behaviour earns an explicit `posthog.capture()` and
a registry row → the metric now rests on a stable name. Never let a metric you care about depend on
autocapture element text; it is fragile, and it is how customer names reach PostHog.

### What the check cannot do

**It cannot tell you that you forgot to instrument something.** It compares code against this
document; a feature in neither passes green. Notes shipped, went unmeasured, and this check would
have said nothing. The control is review: a PR adding a user-facing write adds a row or says why not.

**It does not verify the event reaches PostHog.** A bad token, an ad blocker, or an `init` that
never ran all produce silence indistinguishable from green.

### Two lifecycles, one doc

Analytics events and error signals are collected the same way and read at different times, and the
difference that matters is **when you stop**.

An observability signal is permanent. Errors and uptime matter for as long as the code runs, and
nobody prunes them because a feature matured.

An analytics event is a **question with an expiry**. Industry practice treats events as having
explicit states — proposed, active, deprecated, removed — with periodic audits that retire events
nobody queries, because unused events cost ingest and clutter the taxonomy. Once *"is anyone using
Storage?"* is answered, `stock updated` may stop earning its keep.

**Two caveats before pruning anything.** Growth events — activation, retention, the quote-to-cash
spine — are never retired; they are the denominators everything else is measured against. And
deleting an event ends the time series: you keep history but lose the future, so retire only what
you would not miss in a year-over-year comparison.

Nothing here is retired yet — we have days of data. The audit is worth running once there is a
quarter of it.

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

An MCP server also exists — `https://mcp.sentry.dev/mcp/jigged`, wired in the gitignored
`.mcp.json`. Its entry **needs `"type": "http"`** or Claude Code silently skips it. Authorise
via `/mcp` in an interactive session. The CLI does everything the MCP does, so this is
convenience, not a prerequisite.

**Scope it to the org, not a project.** The URL takes an optional trailing project
(`…/mcp/jigged/javascript-nextjs`), and a session opened that way can read *only* that project —
`python-fastapi` issues come back as "outside the active project constraint", which reads like a
permissions error rather than a scoping one. Two consequences worth knowing: half a triage can be
silently invisible, and **the constraint is fixed when the connection is established**, so
widening the URL takes a `/mcp reconnect` (or a new session) before it takes effect.

### Environments, and how to filter by them

Post-#625 the environment tags are trustworthy:

| Where | Tag |
|---|---|
| Frontend, production | `vercel-production` |
| Frontend, preview | `vercel-preview` |
| Frontend, local dev / CI E2E | **nothing — the SDK is disabled** |
| Backend, production | `production` |
| Backend, preview | `preview` |
| Backend, local / pytest | **nothing — the SDK is disabled** |

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
| Network failures | The browser never reached Supabase — offline, DNS, a dropped connection. Same resolved-`{ error }` mechanism as an abort, but with no hint: postgrest-js only fills `hint` for `AbortError`, so Safari's `TypeError: Load failed` and Chrome's `Failed to fetch` used to slip through and page somebody. **Matched on the message AND an empty `code`** — a SQLSTATE means PostgREST answered, so a `P0001` raised for the user can never be dropped by a coincidental word match. Operators are on personal phones on cellular, so this class scales with adoption. The user still sees it: the read path renders `LoadFailedState` |
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
