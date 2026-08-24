# Feature Flags

> **New 2026-08-24.** The flag system had no doc. It was described in scattered halves —
> architecture.md's `companies` row, a line in whichever module doc a flag happened to gate, and
> the header comment of [`lib/featureFlags.ts`](../../lib/featureFlags.ts) — and most of those
> lines were describing flags that no longer existed by the time anyone read them. **The registry
> file stays canon**; this doc carries only what reading it does not tell you.

## Where a flag lives

`companies.settings.features.<key>` — a jsonb sub-key on the tenant's own row, edited from
`/admin` (`PATCH /api/admin/companies/{id}/features`, [`admin_routes.py`](../../api/routes/admin_routes.py)).
Read on the client through [`useCompanyFeatures()`](../../hooks/useCompanyFeatures.ts), which
resolves the whole map in one `getCompany`; server-side through `isFeatureEnabled`.

**One read per screen, then pass it down.** The hook has no shared cache, so a second consumer on
the same page is a second `getCompany`. A child gets a boolean prop (`revenueEnabled` on
`DashboardMetrics`) or a context (`OperatorCompanyProvider`), never its own hook call.

**The rule has one live exception, and it is not a flag read.**
[`useOperatorIdentity`](../../hooks/useOperatorIdentity.ts) calls the hook for `companyName`
alone, so every operator screen still pays a second `getCompany` beside the provider's. Worth
naming because it is the shape the rule is meant to catch — the cost is the round trip, not what
you took off the row.

**A flag is not a security boundary.** RLS is company-scoped, not column-scoped: everything a
flag hides is still readable by anyone with access to the company. Gate on a flag for what a
tenant should *see*; gate on RLS and role checks for what they may *have*.

**Demo companies mirror their source's whole `features` block** and are invisible to the `/admin`
editor, so a demo's flags are never set directly — [demo-mode.md](demo-mode.md).

## Opt-in vs opt-out

| | `defaultEnabled` | Absent key means | Use for |
|---|---|---|---|
| **Opt-IN** | omitted / `false` | off | a pilot that must run at named shops only |
| **Opt-OUT** | `true` | on | a GA feature that ships everywhere and needs a per-tenant kill-switch |

**Every registered flag is opt-OUT today, and the opt-in path is live but unused.** It is still
supported and still tested, because the alternative — deleting it — makes the next pilot rewrite
it. The last two opt-in flags went for unrelated reasons: `machine_maintenance`'s pilot shops all
had it on already, so retiring it released the feature to nobody new; `quickbooks_desktop` was a
cost decision (step 6 below).

**Shipping a live feature as opt-in is the mistake to avoid.** An opt-in flag over something every
tenant can already see silently *removes* it from all of them and then needs a backfill to undo.
`dashboard_revenue` is opt-out for exactly that reason.

**Mind the direction when flipping one by hand.** On an opt-out flag, deleting the key turns the
feature back ON and storing `false` is what kills it; on an opt-in flag the two statements swap
meaning. The registry header has both statements written out — use them rather than memory.

## Two places carry a default, and only one is tested

`defaultEnabled` in [`lib/featureFlags.ts`](../../lib/featureFlags.ts) is what the app reads.
`features.setdefault("<key>", True)` in [`admin_routes.py`](../../api/routes/admin_routes.py) is
what the `/admin` list reports, so the toggle mirrors the effective state instead of showing an
off switch for a feature the tenant can plainly see. **Nothing checks that these two agree** — a
new opt-out flag missing from the Python side shows as off, and ticking it writes an explicit
`true` that was already the effective state.

**One Save from `/admin` detaches that company from the defaults for good.** The editor is
replace-style: it writes an explicit boolean for every registered key, so from then on the row
answers from stored values and a later change to `defaultEnabled` will not reach it.

`isAiInsightsEnabled` is a third copy of one flag's default, and the only one with a parity test
against the registry. That is why no second named helper was written for `dashboard_revenue`.

**There is no CI guard on the registry at all** — no `scripts/` check that walks it the way
[`analyticsEventsCheck.ts`](../../scripts/analyticsEventsCheck.ts) walks the event registry. A flag
registered and never read ships green; so does `isFeatureEnabled(company, 'typo')`, which is
`false` forever. The type union below is the only enforcement there is, and it reaches map reads
only.

**Verified by** [`__tests__/lib/featureFlags.test.ts`](../../__tests__/lib/featureFlags.test.ts) —
`featureFlags: the registry itself` (5 `it`s, including that the retired keys are gone and that an
unregistered key still reads `false`), plus one describe per registered flag (11 `it`s).

## `KnownFeatureKey` must stay a union

`KNOWN_FEATURES` is declared `as const`, **not** `: readonly FeatureFlagDescriptor[]`. Under the
annotation, `KnownFeatureKey` widened to `string`, so `features.machine_maintenance` left behind
after a retirement kept compiling, evaluated to `undefined`, and **permanently hid the feature it
was meant to release**. The August 2026 retirement of three flags meant eleven such reads and the
compiler had an opinion on none of them. Keep the `as const`; read `defaultEnabled` through the
widened `DESCRIPTORS` view rather than re-annotating.

## Retiring a flag

The order this change followed, and the reason each step is not optional:

1. **Delete the descriptor first.** With the union intact, every stale read is now a compile
   error — that is the search.
2. **Delete the reads, not just the UI ones.** `quickbooks_desktop` was enforced in the backend
   too; missing that would have left an endpoint rejecting every caller.
3. **Delete whatever the flag was the last user of.** The Sidebar's `featureFlag` field and its
   Skeleton existed for one nav item; `OperatorInventoryGate.tsx` and the operator inventory
   `layout.tsx` were gates and nothing else.
4. **Strip the key at rest**, object-preserving with `#-` because `settings` also holds payment
   terms, defaults and AI limits, and every writer of that column is read-modify-write:
   [`20260824221219`](../../supabase/migrations/20260824221219_retire_three_feature_flags.sql),
   after [`20260819030101`](../../supabase/migrations/20260819030101_drop_data_import_feature_flag.sql).
   `readCompanyFeatures` already drops unknown keys, so the row is inert either way — the strip is
   against the *next* flag registered under a recycled name silently inheriting years-old answers.
5. **Count the production rows before merge.** Every pre-merge gate replays migrations against an
   empty database, so a backfill's first real run is production
   ([CLAUDE.md](../../CLAUDE.md#database-changes)).
6. **Ask what the flag was actually fencing.** An affordance is free to release; a *bill* is not.
   Dropping `quickbooks_desktop` made a $49/month-per-connection integration self-serve for any
   company admin, with `verify_company_access(require_admin=True)` the only remaining check and the
   billing write-gate inapplicable (service-role path). Accepted knowingly — see
   [quickbooks-desktop.md](quickbooks-desktop.md).

Retiring a flag never needs a data backfill of its own: a flag governs what a tenant sees, so if
flipping one would leave rows needing repair, the schema change owed that backfill, not the flag.
