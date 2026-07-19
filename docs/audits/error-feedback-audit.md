# Error-feedback Audit & Remediation

**Date:** 2026-06 · **Branch:** `feature/mandatory-customer-po-and-validation`

Triggered by a customer-address delete that surfaced a raw Postgres string:

> update or delete on table "customer_addresses" violates foreign key constraint
> "quotes_billing_address_id_fkey" on table "quotes" (SQLSTATE 23503)

Users should never see SQLSTATE codes or constraint names. This audit maps where
raw DB errors can leak and standardizes the fix.

---

## The fix: one translator, thrown from the access layer

[`lib/supabaseErrors.ts`](../../lib/supabaseErrors.ts) now exports
**`friendlyErrorMessage(error, { entity, references?, fallback? })`**, which maps:

- **23503** (FK violation) → "This `<entity>` can't be deleted because it's still
  referenced by `<X>`. Remove or reassign those first." — `<X>` is auto-derived
  from the constraint name / `on table` clause, or set via `references`.
- **23505** (unique) → "That `<entity>` already exists — use a different value."
- **42501** / RLS / "permission denied" → "You don't have permission to do that."
- auth errors (via `isAuthError`) → "Your session has expired. Please sign in again."
- anything else → `fallback` (or a generic "Something went wrong. Please try again.")

> **Scope update — universal archive (PR #580; [Architecture §16 — Deletion &
> Archiving Policy](../architecture.md#16-deletion--archiving-policy)).** "Delete" is now
> a soft-delete (archive via `deleted_at`) for **parts, customers, vendors, work_centers,
> jobs, and quotes**, and it **never blocks on references** — the row survives so
> referencing records still resolve. Those delete paths therefore **no longer raise
> `23503` at all**, and the friendly "`<entity>` can't be deleted…" message no longer
> applies to them (this supersedes the `deleteJob`/`deleteQuote` rows and the
> `deletePart`/`deleteVendor`/`deleteWorkCenter` entries in the tables below, which
> predate the archive model). Keep the `23503` mapping only as **generic guidance** for
> genuine remaining FK-violation surfaces where a hard `DELETE` can still trip a
> constraint — e.g. customer addresses/contacts, routing/BOM sub-items,
> pricing/procurement tiers, operators (the customer-address case that triggered this
> audit is exactly such a surface).

Access functions throw `new Error(friendlyErrorMessage(error, …))`, so the friendly
text propagates to every caller's `err.message` — UIs that do
`setError(err instanceof Error ? err.message : '…')` now show the friendly message
automatically, no per-component change needed. Covered by unit tests in
[`__tests__/lib/supabaseErrors.test.ts`](../../__tests__/lib/supabaseErrors.test.ts).

---

## Delete operations — FK (23503) handling

Translator applied this pass (were surfacing raw errors):

| Function | File | Entity |
|---|---|---|
| `deleteCustomerAddress` | `utils/customerAddressesAccess.ts` | address |
| `deleteCustomerContact` | `utils/customerContactsAccess.ts` | contact |
| `deleteJob` / `bulkDeleteJobs` | `utils/jobsAccess.ts` | job |
| `deleteQuote` | `utils/quotesAccess.ts` | quote |
| `deleteRouting` / `deleteRoutingOperation` | `utils/routingsAccess.ts` | routing / operation |
| `deleteBomLine` | `utils/bomAccess.ts` | BOM line |
| `deleteTier` (pricing) | `utils/partPricingTiersAccess.ts` | pricing tier |
| `deleteTier` (procurement) | `utils/procurementTiersAccess.ts` | procurement tier |
| `deleteOperator` | `utils/operatorAccess.ts` | operator |

Already protected before this pass (hand-rolled 23503/42501 copy — left as-is,
could be consolidated onto the translator later): `deletePart` / `bulkDeleteParts`,
`deleteVendor` / `bulkDeleteVendors`, `deleteWorkCenter` / `bulkDeleteWorkCenters`,
`bulkDeleteQuotes`, `bulkSoftDeleteCustomers`.

---

## Remaining / deferred (lower risk)

- **Load/save handlers** that fall back to `err.message` (≈23 components, e.g.
  customer/quote/part/shipment forms). With the access layer now translating the
  common DB codes, a leaked raw string requires an *unmapped* error — rarer.
  Optional hardening: route their `catch` through `friendlyErrorMessage(err, {
  fallback })` as a final safety net.
- **Error-boundary pages** (`app/**/error.tsx`) render `error.message` for
  uncaught exceptions. Consider showing a generic line + a "details" disclosure
  rather than the raw message.
- **Consolidation:** fold the five already-protected delete functions onto
  `friendlyErrorMessage` so all delete copy comes from one place.

These are tracked here rather than done now to keep the change focused on the
user-visible leak (FK-violation deletes).
