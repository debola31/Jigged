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
> A new `company_id` table without the gate **silently bypasses billing**. To make
> that a *loud CI failure* instead of tech debt:
> - Gate a new direct-`company_id` table in one line, in its migration:
>   `SELECT public.apply_billing_write_gate('public.your_table');`
>   (Parent-resolved child tables — no `company_id` — still need hand-written
>   policies that resolve the parent's company; see the
>   `stripe_write_enforcement` migration for the pattern.)
> - The CI test **`test_no_tenant_table_left_ungated`** calls
>   `public.tenant_tables_missing_write_gate()` and fails if any `company_id` table
>   is neither gated nor on the explicit exempt list. Add a genuinely-exempt table
>   (identity/bootstrap or service-role-only) to that function's list — a conscious
>   one-line decision.

**Storage:** the private `attachments` bucket's `storage.objects` INSERT/DELETE
policies also call `company_can_write` (company derived from the first path
segment), so a lapsed shop can't upload; SELECT stays open.

## 5. Webhook + sync — single source-of-truth pattern

**One function writes subscription state:** `_sync_customer(customer_id)` in
`api/routes/stripe_routes.py` fetches the customer's current subscription from
Stripe and overwrites the cache with its **actual** status (so a `canceled` sub
keeps its grace window; the cache is cleared only when the customer has no
subscription at all). Everything calls it, so behaviour is identical everywhere and
no code parses event payloads.

Writes go through the `apply_stripe_subscription(...)` RPC (guarded upsert):
- **Monotonic guard** on `subscription_event_at` (webhooks stamp `event.created`;
  `/checkout/sync` and reconcile stamp `now()`) — concurrent/out-of-order Vercel
  lambdas can't lose-update each other.
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

- **`STRIPE_PRICE_ID`** = the default $300 monthly price every self-serve company
  gets. The frontend never names a price.
- **`STRIPE_FOUNDING_PRICE_ID`** = the reserved $250 founder price id. **Not read by
  the app** — it's the value you copy into a company's `override_price_id`.
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
  `apply_stripe_subscription` guard, and the completeness check.
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
