# Billing & Subscriptions

> **As-built reference** for the self-serve subscription billing feature. This
> describes what shipped (which diverged from the original implementation plan as
> decisions were made) — not a forward-looking PRD. When code and this doc
> disagree, fix whichever is wrong; keep them in sync.

## 1. Overview

Jigged bills each shop (company) a monthly subscription. **Maximum delegation to
Stripe, minimum custom code:** Stripe-hosted Checkout + Customer Portal (both are
server-created redirect URLs — **no Stripe.js, no publishable key on the
client**), Stripe-managed receipts, retries, and dunning. No card data touches our
stack.

- **Stripe is the sole source of truth** for billing state.
- **Supabase holds a read-cache** (`company_billing`, 1:1 with `companies`), kept
  current by webhooks.
- **Entitlement is enforced at the database layer** (RLS), not just the UI, so a
  lapsed shop genuinely cannot write even if the frontend is bypassed — while
  reads stay open (read-only, never a hard lockout, never deletion).

Every self-serve signup gets a **30-day trial, card collected upfront**, billing
begins day 31. One reserved customer (Contour) gets a **$250 price with no trial**
via per-company overrides.

## 2. Data model — `company_billing`

Dedicated 1:1 satellite of `companies` (migration `stripe_billing_cache`). It is a
**cache**, not the source of truth. Key columns:

| Column | Meaning |
|---|---|
| `company_id` (PK/FK) | the shop |
| `billing_exempt` | grandfathered → full access without a subscription (see §7) |
| `stripe_customer_id` (unique) | one Stripe Customer per company |
| `stripe_subscription_id`, `subscription_status`, `subscription_price_id` | cached sub state |
| `current_period_end`, `cancel_at`, `canceled_at`, `ended_at`, `trial_end` | cached timestamps |
| `override_price_id`, `override_trial_days` | reserved-customer checkout overrides (§6) |
| `subscription_event_at` | monotonic write-guard stamp (§5) |

**Why a separate table, not columns on `companies`:** `companies` grants
`GRANT ALL … TO authenticated` at the table level and its INSERT policy is
`WITH CHECK (true)`. A column-level `REVOKE` there is a Postgres no-op, so writable
billing columns on `companies` would let any admin self-stamp `active` from the
browser. `company_billing` grants members **`SELECT` only**; the **service-role
webhook is the sole writer**. Entitlement is *derived* from the cache, never
stored.

## 3. Entitlement — one rule, two encodings (KEEP IN PARITY)

The rule "may this company write?" lives in **two places that must agree**:

- `lib/entitlement.ts` → `getEntitlement(isDemo, billing)` → `full | past_due |
  read_only | must_subscribe` (drives banners + the UI).
- `public.company_can_write(company_id)` (SQL, `SECURITY DEFINER STABLE`) →
  boolean (the actual RLS enforcement).

`isWriteAllowed(entitlement)` (∈ {full, past_due}) must equal `company_can_write`
for every case. Mapping:

| State | Entitlement | Can write? |
|---|---|---|
| `is_demo` | full | yes |
| `billing_exempt` | full | yes |
| `trialing`, `active` | full | yes |
| `past_due` | past_due (banner) | yes |
| `canceled`/`unpaid`, within 7-day grace | full | yes |
| `canceled`/`unpaid`, past grace | read_only | **no** |
| `paused` | read_only | **no** |
| `incomplete`/`incomplete_expired` | must_subscribe | **no** |
| no row / no sub, not exempt | must_subscribe | **no** |

- **Grace window = `GRACE_DAYS` (7)**, anchored on `ended_at ?? cancel_at ??
  current_period_end`. The same constant feeds the UI and the SQL, so the date the
  card shows ("Access ends …") is exactly when the DB flips to read-only.
- **Parity is tested both ways** — `__tests__/lib/entitlement.test.ts` (TS) and
  `test_company_can_write_parity` (SQL) run the same golden cases.

## 4. Write enforcement (RLS) — and the new-table invariant

Members write directly through the browser Supabase client, so enforcement is in
Postgres. Because RLS is **per-table** (no global write hook), every
browser-writable tenant table carries **additive `AS RESTRICTIVE`** policies
(`billing_gate_insert/update/delete`) that AND `company_can_write(company_id)` onto
the existing membership policy. **SELECT is never gated.** `service_role` and
`SECURITY DEFINER` functions bypass RLS, so the webhook, importers, and demo
seeder are unaffected.

> ### ⚠ Invariant: every new tenant table must be billing-gated
> A new `company_id` table without the gate **silently bypasses billing** — no error,
> no broken page, no symptom. Two guards in
> `api/tests/integration/test_billing_enforcement.py` make that a red build instead of
> tech debt:
>
> | SQL check → CI test | Catches | Fix |
> |---|---|---|
> | `tenant_tables_missing_write_gate()` → `test_no_tenant_table_left_ungated` | a `company_id` table with no `billing_gate_insert` policy | `SELECT public.apply_billing_write_gate('public.your_table');` in that table's own migration |
> | `definer_writers_missing_write_gate()` → `test_no_definer_function_walks_past_the_gate` | a `SECURITY DEFINER` function that writes a gated table without consulting the gate | `PERFORM public.inv_assert_can_write(<company>);` after the membership check |
>
> `apply_billing_write_gate` only works on a **direct `company_id`** table.
> Parent-resolved children (no `company_id`) need hand-written policies that resolve
> the parent's company — pattern in
> [`20260725210136_stripe_write_enforcement.sql`](../../supabase/migrations/20260725210136_stripe_write_enforcement.sql).
>
> **The first guard checks that a policy *exists*, so it is blind to a definer function
> walking past a policy that does.** That is how the five location-stock RPCs shipped
> with no entitlement check (#645), which made billing depend on a feature flag: a
> lapsed shop with `inventory_locations` OFF was blocked (direct browser insert, gate
> applies) and the same shop with it ON wrote freely. The second guard exists only
> because of that blind spot —
> [`20260801150944_inventory_rpc_billing_write_gate.sql`](../../supabase/migrations/20260801150944_inventory_rpc_billing_write_gate.sql).
>
> A genuinely-exempt table (identity/bootstrap, or service-role-only) goes on the exempt
> list inside `tenant_tables_missing_write_gate()` — a conscious one-line edit.
> **A false rationale on that list is the failure mode:** `part_location_stock` sat under
> "writes never come from the browser" while the browser was writing it through definer
> RPCs, and that one sentence is what carried #645 through review. It has since been
> removed from the list and gated.
>
> **Named gap:** `create_shipment_with_line_items` is browser-callable, writes gated
> tables, and does not check. It is on the definer exempt list so the guard stays green
> on a *filed* gap rather than being ignored — whether a lapsed shop may still ship an
> order it already placed is a billing policy question, tracked separately.

**Storage:** the private `attachments` bucket's `storage.objects` INSERT/DELETE
policies also call `company_can_write` (company derived from the first path
segment), so a lapsed shop can't upload; SELECT stays open. Note these are
**permissive**, not restrictive — which is why a blocked upload's message carries no
policy name (see §4.1).

### 4.1 How a blocked write fails, per verb

The three verbs do **not** fail the same way, and the difference is load-bearing.

| Verb | Policy shape | What the client sees |
|---|---|---|
| INSERT | `WITH CHECK (company_can_write(...))` | raises **42501**, message names `billing_gate_insert` |
| UPDATE | `USING (true) WITH CHECK (company_can_write(...))` | raises **42501**, message names `billing_gate_update` |
| DELETE | `USING (company_can_write(...))` | **silent** — zero rows, no error |

**UPDATE used to be silent too**, and that was a bug rather than a design:
`USING (company_can_write(...))` *filters* the row out of the statement instead of
refusing it, so a blocked save changed nothing and reported nothing. A call site with
`.select().single()` saw `PGRST116` ("no rows returned") — a misleading *not found*
for a write that was refused — and one without it saw success.
`markOperationReceived` returned `{ success: true }` and told the shop floor that
outside work was back while the row sat untouched.
[`20260807015028_billing_gate_update_with_check.sql`](../../supabase/migrations/20260807015028_billing_gate_update_with_check.sql)
moved the check to `WITH CHECK` so it raises. Enforcement is unchanged, because
`NEW.company_id ≡ OLD.company_id` on every real path — and a
`<table>_gate_key_immutable` trigger now enforces that for the browser roles, so the
equivalence is guaranteed rather than argued. It is also one `company_can_write()`
call per row instead of two.

**DELETE stays silent on purpose.** A DELETE policy has no `WITH CHECK`, so the only
RLS-shaped fix is `USING (true)` plus a `BEFORE DELETE` trigger that raises — which
inverts the failure mode from fail-closed to **fail-open** if that trigger is ever
dropped. Not worth it here: this repo soft-deletes every user-facing entity
(archive is an UPDATE, so it is covered above), and the remaining hard deletes are
line items, contacts, tiers and reactions, where the worst outcome is the row
reappearing on reload. Those call sites assert the returned row count instead —
`assertDeleted` in [`lib/supabaseErrors.ts`](../../lib/supabaseErrors.ts).
`test_delete_is_silently_filtered_when_lapsed` pins the decision so it is not
"fixed" by accident.

**The policy name in the message is a contract.**
`isBillingWriteBlocked` keys on the `billing_gate` substring to tell a lapsed
subscription from a plain permission denial, and the user-facing copy, the Subscribe
button and the Sentry exemption all hang off that. It works because Postgres emits
one `WithCheckOption` per RESTRICTIVE policy, each carrying its own `polname`, while
OR-folding the permissive ones into a single **nameless** entry — so a membership
failure produces the bare `new row violates row-level security policy for table "x"`
and is never mistaken for a billing block. Both directions are asserted:
`test_blocked_writes_name_the_billing_policy` and
`test_permissive_denial_is_nameless`. **Renaming these policies silently reverts
every billing message in the product to "You don't have permission to do that."**

A third CI guard covers the shape itself:
`tenant_tables_with_silent_update_gate()` → `test_update_gate_never_filters` fails if
any `billing_gate_update` still uses a filtering `USING`, because the natural thing
for the next person to hand-write is the `USING(...) WITH CHECK(...)` pair they see
on every other policy.

**Triggers are safe by construction, and worth stating so nobody re-audits it:** a
trigger that cascades an UPDATE onto a gated table only fires because the user's
primary write succeeded, which means the shop can write, which means the cascade
passes too. The audit of invoker-rights trigger functions that update gated tables
found no exceptions.

### 4.2 What the user is told

The DB refuses the write; the UI has to explain it. That path lives in
[`lib/supabaseErrors.ts`](../../lib/supabaseErrors.ts) and
[`components/common/ErrorAlert.tsx`](../../components/common/ErrorAlert.tsx):

- `isBillingWriteBlocked(err)` — matches the two denial shapes: the RLS policy name
  above, and `inv_assert_can_write`'s `company … has no active subscription`. Walks
  `Error.cause`, so it still classifies after normalisation.
- `friendlyErrorMessage` checks billing **before** its generic 42501 branch. Without
  that ordering a lapsed owner was told *"You don't have permission to do that."* —
  a role diagnosis that sends them to ask an admin for access they already have.
- `toFriendlyError` is what the access layer throws. Supabase rejects with a plain
  object on the `{ data, error }` path, so `err instanceof Error` was false at ~179
  catch sites and every one fell through to a generic `'Failed to …'`.
- `ErrorAlert` checks **subscription context before error shape**. That ordering is
  what catches the cases the error cannot describe: a `PGRST116` from a filtered
  update, and a nameless storage 403. It guards on `!isLoading`, because
  `isLoading` starts true with `billing: null`, which resolves to `must_subscribe` —
  so `canWrite` is false for a *healthy* shop during its first fetch.
- The Subscribe button renders **only for an admin**: `/settings` is behind
  `AdminGuard` and the Stripe routes call `_verify_company_admin`, so offering it to
  anyone else ends in a 403. Operators get wording pointing at the office rather than
  a page they cannot reach.
- `SubscriptionRequiredNotice` says it up front on the five create routes, as an
  explanation rather than a disabled control — see
  [interaction-standards §4](../interaction-standards.md).
- **The wording comes from `subscription_status`, not from entitlement.**
  [`lib/billingCopy.ts`](../../lib/billingCopy.ts) maps the billing row to
  `never_started | ended | paused`, because `read_only` deliberately collapses
  canceled, unpaid *and* paused — right for the write gate, wrong for a sentence.
  Telling a paused shop it "has ended", or a never-subscribed one to "resubscribe",
  are both false, and both were shipped before this split. It is the same field
  `BillingCard` branches on, so the message on a blocked save matches the one in
  Settings when the user goes looking for the cause.
- `shouldReportSupabaseError` **drops** billing denials. The Supabase capture net
  files every `{ error }` response, so a lapsed shop would otherwise generate a Sentry
  issue on every write it attempts — the most predictable non-failure the app can
  produce. A *nameless* privilege denial still reports; that one is a bug.

## 5. Webhook + sync — single source-of-truth pattern

**One function writes subscription state:** `_sync_customer(customer_id)` in
`api/routes/stripe_routes.py` fetches the customer's current subscription from
Stripe and overwrites the cache with its **actual** status (so a `canceled` sub
keeps its grace window; the cache is cleared only when the customer has no
subscription at all). Everything calls it, so behaviour is identical everywhere and
no code parses event payloads.

Writes go through the `apply_stripe_subscription(...)` RPC (guarded upsert):
- **Monotonic guard** on `subscription_event_at` — **every** path stamps `now()`, because
  `_sync_customer` is the sole writer and it always passes `_now_iso()`
  ([`stripe_routes.py`](../../api/routes/stripe_routes.py) `_sync_customer`). Concurrent /
  out-of-order Vercel lambdas therefore can't lose-update each other, and a redelivered old
  event still writes, because what it writes is a *fresh refetch*, not the payload.
  **Withdrawn:** "webhooks stamp `event.created`" — never true in code, and stamping the
  event time would be wrong here: it would let a stale guard value discard a current read.
  The `COMMENT ON COLUMN company_billing.subscription_event_at` in
  [`20260725205821`](../../supabase/migrations/20260725205821_stripe_billing_cache.sql) still
  carries the old wording and needs a follow-up `COMMENT ON` migration.
- **Grandfather auto-clear:** `billing_exempt` clears only on `active`/`past_due`
  (a real paying relationship), **never on `trialing`** — so a grandfathered shop
  that starts a trial and cancels mid-trial keeps its free access.

**Endpoints** (`/api/stripe/*`, admin-only except the webhook):
- `POST /checkout` — server picks the price (`override_price_id` else
  `STRIPE_PRICE_ID`) + trial (`override_trial_days` else 30); rejects demo (400) and
  double-subscribe (409, checked against Stripe, not just the cache).
- `POST /portal` — self-heals a stale cache first (§8); 409 → "subscribe" if no live
  sub.
- `POST /webhook` — verifies signature; resolves the customer → company → sync.
- `POST /checkout/sync` — success-page reconcile with an **ownership check** (403 if
  the session isn't the caller's company).
- `POST /reconcile` — called when the billing card is *viewed*, so it's accurate even
  if a webhook was missed (one bounded Stripe read on a settings visit, not a poll).

**Webhook subscription set:** `checkout.session.completed`,
`customer.subscription.{created,updated,deleted}`, `invoice.{paid,payment_failed}`.

## 6. Prices & the reserved customer

- **`STRIPE_PRICE_ID`** = the default $399 monthly price every self-serve company
  gets — `price_1U0afKHxiLXphzfAu8VRTtBy`, the `Jigged` product's `default_price`.
  The frontend never names a price. The superseded **$300** price
  (`price_1TxIBTHxiLXphzfAna1ebqwx`) is still `active` in Stripe and must not be
  pointed back at; subscriptions created on it keep it. The public price shown on
  `/pricing` is a hardcoded string in `lib/constants/marketing.ts` (rendered by
  `components/marketing/PricingPageContent.tsx`) and is cited in the Terms of
  Service — **a price change edits Stripe and that constant, in the same PR.**
- **`STRIPE_FOUNDING_PRICE_ID`** = the reserved $250 founder price id
  (`price_1TqnlLHxiLXphzfABIdDneFk`). **Not read by the app** — it's the value you
  copy into a company's `override_price_id`.
- To put a company on the reserved deal (e.g. Contour), set two columns
  (service-role): `override_price_id = <$250 price id>`, `override_trial_days = 0`.
  Then they self-serve via Settings → Subscribe → $250, no trial. Overrides are
  service-role-write-only, so $250 is unreachable by self-serve.

Future price changes are **new Price objects** — never mutate/migrate an existing
subscription's price.

## 7. Rollout: grandfathering existing shops

The `stripe_billing_cache` migration backfills `billing_exempt = true` for every
existing **real** company (demo excluded), so nobody is locked out on day one.
New companies have no row until they check out → `must_subscribe`. When a
grandfathered shop subscribes and reaches `active`, the webhook auto-clears its
exempt flag → it's gated by its real subscription thereafter.

**Enforcement was sequenced last** (after the backfill + Contour onboarding) so
every pre-existing company was `exempt`/`active`/`demo` at flip time — zero
lockouts.

## 8. UI states & self-healing

The billing card (`components/settings/BillingCard.tsx`, on the Settings page) shows
the **subscription status**, not entitlement, so a grandfathered/demo company
honestly reads "No subscription" rather than "full access". States: No subscription
· Trial · Active · **Canceling** (set to cancel at period end — shows the date) ·
**Ending** (canceled, in grace — shows the date access ends) · Ended (read-only) ·
Payment failed · Paused.

- **Reconcile-on-view + portal self-heal:** viewing the card, or clicking "Manage
  billing", re-syncs from Stripe, so a missed webhook self-corrects (a stale
  "trialing" from a deleted sub flips to "Subscribe" instead of opening a dead
  portal).
- **Demo** companies never show billing UI and are never gated (D11).
- Chips use the shared `StatusChip` (see design-system.md → Status Badges).

## 9. Dashboard configuration (delegate, don't build)

- **Customer Portal:** enable cancellation; **disable plan switching** (prices are
  new-Price-only) and **disable pause** (`paused` stays in the map defensively but
  isn't self-serve-reachable); enable update-payment-method + invoice history.
- **Billing settings:** enable Smart Retries + failed-payment (dunning) emails +
  receipt emails. These are the retries/dunning/receipts the app relies on.
- **Tax:** not collected (conscious deferral — no `automatic_tax`). Revisit via a
  Dashboard registration + `automatic_tax` when there's nexus.

## 10. Environment variables

Backend only (no `NEXT_PUBLIC_STRIPE_*`). The app reads a **restricted key**
(`rk_`) from `STRIPE_RESTRICTED_KEY` — least-privilege, and it matches the var
the Stripe Dashboard / Vercel label (so the unused `STRIPE_SECRET_KEY` /
`STRIPE_PUBLISHABLE_KEY` can't be edited by mistake and silently take effect). See
`.env.local.example`:
`STRIPE_RESTRICTED_KEY`, `STRIPE_PRICE_ID`, `STRIPE_FOUNDING_PRICE_ID`,
`STRIPE_WEBHOOK_SECRET`. **Local** webhook secret = the `whsec_…` from
`stripe listen`; **prod** = the Dashboard endpoint's secret (they differ). The
backend loads env at startup — restart `python api/index.py` after changing them
(`--reload` watches `.py`, not `.env.local`).

### The production webhook URL must be `www.jigged.app` (verified 2026-08-03)

Register the live endpoint as `https://www.jigged.app/api/stripe/webhook` — **on `www`, not the
apex**. Vercel serves `www` as primary and answers `https://jigged.app/…` with a `307` from its
edge router, and **Stripe does not follow redirects**: only `2xx` counts as delivered.

This is as-built, not preference. The endpoint was registered on the apex on 2026-07-26 and
**every live event failed for five days** until Stripe's auto-disable warning surfaced it. Sentry
saw nothing and could not have — the `307` is issued before the function is invoked, so there is
no exception to report. `/checkout/sync` and `/reconcile` (§ above) kept the cache correct
throughout, which is *why* it went unnoticed; treat reconciliation as a safety net, never as
delivery.

**Enforced by** a Sentry uptime monitor asserting `GET …/api/stripe/webhook` returns `405`
(route reachable, method not allowed). `405` = healthy, `307` = this bug returning, `404` =
backend not deployed, `401` = Vercel deployment protection. `GET` is deliberate: it never reaches
the signature path, so the probe generates no Sentry events.

The apex is still what the code advertises as canonical (`metadataBase`, `og:url`, email
`SITE_URL`) — that inconsistency is tracked separately. If it is ever resolved by making the apex
primary in Vercel, **this URL must move back in the same change.**

## 11. Testing

- **DB-only (CI, no Stripe):** `api/tests/integration/test_billing_enforcement.py` —
  the RLS write-gate across every state, read-still-works, TS↔SQL parity, the
  `apply_stripe_subscription` guard, and both §4 completeness guards.
  `__tests__/lib/entitlement.test.ts` (Vitest) + `scripts/verify_billing_parity.sql`
  cover the entitlement rule. `api/tests/unit/test_stripe_routes.py` covers endpoint
  logic (mocked Stripe).
- **Stripe sandbox (local/manual):**
  `api/tests/integration/test_billing_stripe_lifecycle.py` — the real-Stripe
  lifecycle (checkout, override no-trial, cancel, webhook sync). Needs
  `stripe listen` forwarding + sandbox creds; **not run in CI** (CI can't hold your
  sandbox secrets). See its module docstring to run it.

## 12. Local dev

Seed + E2E grandfather their companies (`billing_exempt`) so dev/test flows stay
writable. To exercise the *gated* states or lifecycle transitions locally, run
`stripe listen --forward-to localhost:8000/api/stripe/webhook` (put the printed
`whsec_…` in `STRIPE_WEBHOOK_SECRET`, restart the backend) and drive it with
`stripe trigger` / test clocks — or set `company_billing.subscription_status`
directly via SQL on a throwaway company.
