# Divergence report — Vendors (#344)

Audit under [#332](https://github.com/debola31/Jigged/issues/332) / [#344](https://github.com/debola31/Jigged/issues/344).
Compared `docs/modules/vendors.md` against `utils/vendorsAccess.ts`,
`utils/vendorContactsAccess.ts`, `components/vendors/*`,
`app/dashboard/[companyId]/vendors/*`, `__tests__/utils/vendorsAccess.test.ts`,
and the `vendors` / `vendor_contacts` tables in `supabase/schema.prod.sql`.

Vendors is a recently-built, clean module — **well aligned**. One doc-completeness
fix applied; no open decisions.

## Fixed in this PR

1. **Access Layer section was incomplete.** It omitted `getAllVendorsWithPrimaryContact` (powers the list grid), `getVendor`, `checkVendorNameExists`, and the entire `utils/vendorContactsAccess.ts` (contact CRUD + the one-primary invariant). → Table expanded and a `vendorContactsAccess.ts` table added.
2. **Import execute path clarified.** Added a note that the Import *page* runs via the FastAPI `/api/vendors/import/{analyze,validate,execute}` endpoints (the `bulkImportVendors` client function is the direct path). *(This resolves an initial "doc says `/api/vendors/import/*` but no routes exist" suspicion — the routes DO exist as FastAPI endpoints; the earlier check only looked at Next.js `app/api/`. Doc was correct; note added for clarity.)*

## Decision needed

_None._ The module's doc, UI, access layer, and schema agree.

## Informational / aligned

- **`legacy_id`** exists on the `vendors` table + import mapping but not the create/edit form. vendors.md already frames it as importer-only — consistent. (Flag only if you want it form-editable.)
- **Delete is archive (soft-delete).** Since the universal archive model (PR #580), `deleteVendor` / `bulkDeleteVendors` stamp `deleted_at` via `.update()` instead of issuing a SQL `DELETE`, and the archive **never blocks** on references — a vendor used as a part's `preferred_vendor_id` or a work center's `vendor_id` archives fine, the row survives so those links keep resolving. Reads filter `deleted_at IS NULL` (lists / search / pickers); by-id (`getVendor`) does not. Name stays the natural identity: re-creating or re-importing an archived name **revives** the row (`createVendor` revives on the `23505`; import upsert sets `deleted_at=None`). This replaced the old hard-delete-with-`23503`-FK-guard behaviour. See [architecture.md §16](../../architecture.md).
- **Contact-name search** is deferred (doc says so); the list searches name + city only. Aligned.
- **One-primary-contact invariant** — enforced in `vendorContactsAccess.ts` AND by the partial unique index `vendor_contacts_one_primary`. Doc's "enforced in access layer" note is accurate (belt-and-suspenders with the DB index).
