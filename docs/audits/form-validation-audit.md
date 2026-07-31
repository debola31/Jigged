# Form Validation Audit & Remediation

**Date:** 2026-06 · **Status:** implemented in branch `feature/mandatory-customer-po-and-validation`

This audit covers every form submission point in the app along two axes:

1. **Disabled-submit clarity** — forms whose Save/Submit button greys out on
   incomplete data, and whether the user is told *what* is missing.
2. **Field-type validation** — inputs that should accept only a specific kind of
   value (email, phone, postal code, numbers) but accepted free text.

The remediation standard is documented in
[design-system.md → Form validation & required-field feedback](../design-system.md).
Reusable building blocks added: [`lib/validators.ts`](../../lib/validators.ts),
[`lib/geo.ts`](../../lib/geo.ts),
[`components/common/MissingFieldsNotice.tsx`](../../components/common/MissingFieldsNotice.tsx),
[`components/common/CountrySelect.tsx`](../../components/common/CountrySelect.tsx),
[`components/common/StateSelect.tsx`](../../components/common/StateSelect.tsx).

---

## 1. Chosen UX pattern (and why)

**Inline `MissingFieldsNotice` above the submit button**, listing each blocking
reason — *not* a hover tooltip. Rationale: 50–60-year-old users, and a hover tooltip is
**undiscoverable** (you must already suspect something is there to hover over) and
unreachable by keyboard — failing the clarity/accessibility goals in CLAUDE.md. We pair the
summary notice with field-level `required` + `error`/`helperText` markers.

> **Corrected 2026-07-31.** This said "Jigged targets shop-floor tablets (touch)" and rested
> the argument on hover being unavailable. Forms are an admin-surface concern — office
> computer, mouse — so hover *is* available; see
> [the device model](../../CLAUDE.md#who-uses-what-on-what--the-device-model). The conclusion
> is unchanged because discoverability, not touch, was always the real reason.

`ShipmentForm` (info-Alert listing blocking messages) was the pre-existing model
for this; `QuoteForm` uses a button tooltip, kept as-is since it's a desktop-heavy
page.

---

## 2. Greyed-out submit buttons (gate on incomplete data)

| Form | File:line | Blocking condition | Notice added |
|---|---|---|---|
| Convert to Job | `components/quotes/ConvertToJobModal.tsx` | no line items / unpicked qty / invalid due date / **missing PO** | ✅ |
| Quick-create Part | `components/parts/PartFormModal.tsx` | `!part_name` | ✅ |
| Feedback | `components/feedback/FeedbackDialog.tsx` | empty feedback | ✅ |
| BOM material row | `components/parts/MaterialRowEditor.tsx` | no part / qty ≤ 0 / no unit | ✅ (per-field) |
| New custom unit | `components/parts/UnitOfMeasurementSelect.tsx` | empty unit name | ✅ + `required` |
| Shipping settings | `components/settings/CompanyShippingSettingsCard.tsx` | invalid number format | ✅ |
| Operator complete | `components/operator/JobCompleteModal.tsx` | `!operatorId` | ✅ |
| Import conflicts | `components/import/ConflictDialog.tsx` | `validRowsCount === 0` | ✅ |
| Quote form | `components/quotes/QuoteForm.tsx` | `validationError` | already has button tooltip |
| Shipment form | `components/shipments/ShipmentForm.tsx` | `!validation.canSubmit` | already inline (reference) |
| Insights chat | `components/insights/InsightsChat.tsx` | empty question | intentionally left (chat box, self-evident) |

Buttons disabled **only** by `loading`/`saving` state (Customer/Vendor/Part/
WorkCenter forms, auth pages, contact modals, settings cards) need no notice and
were not changed.

---

## 3. Field-type validation

All routed through `lib/validators`.

### Email
Consolidated the regex that was copy-pasted in 4 contact forms into
`isValidEmail`. Added validation where it was missing: `Login`, `SignUp`,
`ForgotPassword`, `SendQuoteEmailDialog` (To + CC), `InviteForm`, `EmailCapture`,
`CompanyProfileCard`. The 4 contact forms (`CustomerContactModal`, `CustomerForm`,
`VendorContactModal`, `VendorForm`) now import the shared helper.

### Phone (was 100% unvalidated)
`type="tel"` + `isValidPhone` error/helperText on all phone inputs:
`CustomerContactModal`, `CustomerForm`, `VendorContactModal`, `VendorForm`,
`CompanyProfileCard`. Validation is lenient (7–15 digits, allowed separators) — no
country-format enforcement.

### Address (was free-text city/country)
`CountrySelect` (ISO 3166) + `StateSelect` (US states / CA provinces, free-text
fallback for countries without a known list) replace free-text country/state in
`CustomerAddressModal`, `VendorForm`, `CompanyProfileCard`. **City stays free
text** (full city lists need an external dataset — out of scope). Postal codes
validated per country via `isValidPostalCode`.

**Canonical-only with legacy tolerance** (matches Baymard's autocomplete-resolves-
to-canonical guidance): the selects are type-to-search but, unlike a `freeSolo`
field, only a real list entry can be committed — new input can't persist garbage
like `,mex` or `ca`. Existing/recognized values still display: aliases and codes
resolve to canonical names (`USA` → "United States", state `IL` → "Illinois") via
`resolveCountryCode` / `resolveSubdivisionName` in `lib/geo`; anything truly
unrecognized is surfaced as a one-off option with an inline nudge to re-pick.
`isValidPostalCode` resolves the country (name/alias/code) to a canonical code
first, so US/CA ZIP validation fires regardless of how the country is stored.

**Not changed (deliberate):** phone validation stays lenient — accepting
`8174484963` and `817-448-4963` both is correct per industry guidance (users type
inconsistently). We validate shape but do **not** normalize to E.164 on save;
that's noted as future work below.

### Numeric
Deduped the per-file parsers (`RoutingOperationRowEditor`) onto
`parseOptionalNumber` / `parseOptionalInteger`. Fixed `ShipmentForm`
weight/package-count to coerce non-numeric input to `null` instead of `NaN`.
Routed `CompleteOperationModal`, `PartForm`, `WorkCenterForm` through the shared
parsers. Added `inputMode` (`numeric`/`decimal`) to numeric inputs lacking it for
correct mobile keyboards.

---

## 4. Deferred / out of scope

- **City dropdown / autocomplete** — needs a geocoding dataset or API; left as
  free text.
- **International postal formats** beyond US/CA — `isValidPostalCode` is permissive
  for other countries rather than guessing.
- **Phone normalization** — we accept varied formats (correct) but store the raw
  string. Industry standard is to normalize to E.164 on save (e.g. via
  `libphonenumber-js`) and display formatted, so the same number can't exist as
  two different strings. Deferred per product decision; revisit if phone-based
  dedup/search matters.
- **Phone formatting/masking** — we validate but don't reformat as the user types.
