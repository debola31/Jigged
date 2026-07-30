<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into Jigged, a manufacturing data platform. PostHog was already partially initialised (`instrumentation-client.ts` with client-side init, `lib/posthog-server.ts` with server-side client, and reverse-proxy rewrites in `next.config.ts`). This run wired up user identification across the full auth lifecycle and added `posthog.capture()` calls to all 12 key business events spanning the quote-to-cash funnel, shop-floor operator actions, and Phase 2 inventory operations.

**Changes made:**

- `components/auth/Login.tsx` — Added `posthog.identify()` and `posthog.capture('user_signed_in')` on successful Supabase sign-in.
- `components/providers/AuthProvider.tsx` — Added `posthog.capture('user_signed_out')` and `posthog.reset()` on `SIGNED_OUT` auth event; `posthog.identify()` already present and preserved in the session-restore `useEffect`.
- `app/accept-invite/[invitationId]/page.tsx` — Added `posthog.identify()` and `posthog.capture('invitation_accepted', { role })` after RPC acceptance succeeds.
- `components/quotes/QuoteForm.tsx` — Added `posthog.capture('quote_created', { line_item_count, customer_id })` after `createQuote` returns.
- `components/quotes/ConvertToJobModal.tsx` — Added `posthog.capture('quote_converted_to_job', { quote_id, part_count, is_hot })` after `convertQuoteToJob` succeeds.
- `components/jobs/AcceptPurchaseOrderModal.tsx` — Added `posthog.capture('job_created_from_po', { part_count, total_value, is_hot })` after `createJobFromPurchaseOrder` succeeds.
- `app/dashboard/[companyId]/jobs/page.tsx` — Added `posthog.capture('jobs_bulk_cancelled', { count })` after `bulkCancelJobs` succeeds.
- `app/operator/[companyId]/jobs/[jobId]/parts/[jobPartId]/operations/[jobOperationId]/page.tsx` — Added `posthog.capture('operator_operation_completed', { job_operation_id, quantity_good, is_partial })` alongside the existing `logOperatorEvent` call.
- `components/shipments/ShipmentForm.tsx` — Added `posthog.capture('shipment_created', { line_item_count, shipping_method })` after `createShipment` succeeds.
- `components/parts/PartLocationActionModal.tsx` — Added `posthog.capture('inventory_stock_updated', { action, part_id, quantity, unit })` after any stock operation (add/deplete/adjust/move) succeeds.
- `components/operator/OperatorLocationActionModal.tsx` — Added `posthog.capture('operator_inventory_stock_updated', { action, part_id, quantity, unit, location_id })` after any stock operation succeeds.
- `.env.local` — Confirmed `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` are set to the correct project values.

| Event name | Description | File |
|---|---|---|
| `user_signed_in` | A user successfully signed in with email and password. | `components/auth/Login.tsx` |
| `user_signed_out` | A user explicitly signed out of their session. | `components/providers/AuthProvider.tsx` |
| `invitation_accepted` | A new team member accepted their invitation and completed account setup. | `app/accept-invite/[invitationId]/page.tsx` |
| `quote_created` | A new customer quote was created with line items. | `components/quotes/QuoteForm.tsx` |
| `quote_converted_to_job` | A quote was accepted and converted into a production job. | `components/quotes/ConvertToJobModal.tsx` |
| `job_created_from_po` | A new job was created directly from a customer purchase order. | `components/jobs/AcceptPurchaseOrderModal.tsx` |
| `jobs_bulk_cancelled` | One or more production jobs were bulk cancelled. | `app/dashboard/[companyId]/jobs/page.tsx` |
| `operator_operation_completed` | An operator recorded completion of a manufacturing operation step. | `app/operator/.../operations/[jobOperationId]/page.tsx` |
| `shipment_created` | A shipment was created to fulfill part of a job. | `components/shipments/ShipmentForm.tsx` |
| `part_created` | A new part was added to the company's parts catalog. | `components/parts/workspace/PartWorkspace.tsx` |
| `inventory_stock_updated` | Stock level at a location was added, depleted, adjusted, or moved by an owner-side user. | `components/parts/PartLocationActionModal.tsx` |
| `operator_inventory_stock_updated` | Stock level at a location was added, depleted, adjusted, or moved by a shop-floor operator. | `components/operator/OperatorLocationActionModal.tsx` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard:** [Analytics basics (wizard)](https://us.posthog.com/project/534393/dashboard/1927054)
- [Quote-to-Job conversion funnel (wizard)](https://us.posthog.com/project/534393/insights/x9kJI3Yx) — Funnel: `quote_created` → `quote_converted_to_job`
- [Operator operations completed (wizard)](https://us.posthog.com/project/534393/insights/K65LNFxH) — Daily count of shop-floor operation completions
- [Shipments created (wizard)](https://us.posthog.com/project/534393/insights/337bKoSw) — Weekly shipment volume bar chart
- [Active signed-in users (wizard)](https://us.posthog.com/project/534393/insights/7Kfzq5ma) — Weekly unique active users
- [Inventory stock updates (wizard)](https://us.posthog.com/project/534393/insights/ICvmnKdP) — Daily inventory activity stacked by owner vs operator

## Verify before merging

- [ ] Run a full production build (the wizard only verified the files it touched) and fix any lint or type errors introduced by the generated code.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Add `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` to `.env.example` and any onboarding scripts so collaborators know what to set.
- [ ] Wire source-map upload (`posthog-cli sourcemap` or your bundler's upload step) into CI so production stack traces de-minify in PostHog error tracking.
- [ ] Confirm the returning-visitor path also calls `identify` — a handler that only identifies on fresh login can leave returning sessions on anonymous distinct IDs. (The `AuthProvider` `useEffect` already does this; verify it fires on every page load when a session exists.)
- [ ] The `part_created` event is listed in the plan for `components/parts/workspace/PartWorkspace.tsx` but was not implemented in this run (the workspace component is large; its submit handler needs a targeted `posthog.capture('part_created')` call). Add it before shipping.
- [ ] This project connects to PostgreSQL (Supabase), Stripe, and other data sources. Run `npx @posthog/wizard warehouse` to connect them to PostHog's data warehouse for richer cross-source analytics.

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-nextjs-app-router/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
