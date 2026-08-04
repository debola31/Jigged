> **Condensed 2026-08-03** — 1,774 → 949 words (`wc -w`). **Cut:** the Acceptance-Criteria block (~53% of the file, the highest share of any module doc), whose bullets mostly re-described the test they cited; two Access-Layer tables restating function signatures; the archive policy stated three times; "external work centres point at a vendor" stated four times. **Kept:** every number, every citation, the revive-on-collision and never-blocks semantics, and the coverage gap the AC block existed to record. **Corrections after checking the code (5):** the doc never mentioned the **Outside processing** tab that is half the Vendors page; it tagged the CSV import `automation-pending` when 16 backend tests cover it; it omitted the `/edit` page; it presented dead code (`bulkImportVendors`) as a live import path; it credited the one-primary rule to the access layer alone.

# Vendors Module

Master list of external suppliers and outsourced-process providers. **Built; in production.** No dependencies to create. Consumed by [Parts](parts.md) (`parts.preferred_vendor_id`) and [Work Centers](work-centers.md) (`work_centers.vendor_id` — **that doc owns the work-centre side**, not restated here).

## Data model

**`vendors`** — `id` (uuid PK), `company_id`, `name` (required), `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `country` (defaults `'USA'`), `created_at`, `updated_at`, `deleted_at`. Unique `vendors_unique_per_company (company_id, name)`, kept FULL not partial — name is the identity the CSV importer upserts on, so re-import is idempotent and a re-create revives rather than duplicates.

**`vendor_contacts`** — 1-to-many with `vendors`, `ON DELETE CASCADE`: `id`, `vendor_id`, `name` (required), `role`, `role_label`, `email`, `phone`, `is_primary`, `created_at`, `updated_at`.

| Constraint | Enforces |
|---|---|
| `vendor_contacts_role_check` | `role ∈ {sales, accounts_payable, quality, engineering, shipping_receiving, customer_service, other}` |
| `vendor_contacts_role_label_required` | `role_label` non-empty when `role='other'` |
| `vendor_contacts_one_primary` (partial unique index on `vendor_id WHERE is_primary`) | at most one primary per vendor *(⚠ This doc previously said one-primary is "enforced in access layer"; the DB enforces it too — the access layer clears the old primary so the index never trips.)* |

## Pages

| Route | Contents |
|---|---|
| `/dashboard/{companyId}/vendors` | **Two tabs** *(⚠ This doc previously described only the grid; the page renders a `Tabs` switch.)*. **Directory** — AG Grid: Name, Primary Contact (`name · email`), Location (`city, state`), Updated; search name + city, sort name asc, pagination 25/50/100, bulk CSV export, bulk archive, row click → detail. **Outside processing** — `components/jobs/OutsideWorkPanel.tsx`, the company-wide queue of external-vendor operations grouped **Not sent** (`status='pending'`) and **At vendor** (`status='sent'`), each with send/receive actions. The shipping lead's worklist — see [prd.md](../prd.md) FR-6a and [jobs.md](jobs.md#outside-external-vendor-operations). |
| `…/{vendorId}` | Header card; Contacts card (primary starred; per-row edit / set-primary / delete); Address card; **Linked Parts** accordion (`part_name`, `primary_unit`); **Linked Work Centers** accordion (`name`, `kind`). Delete archives and is never disabled. |
| `…/{vendorId}/edit` | `VendorForm` edit mode — vendor row only; contact CRUD is separate. *(⚠ This doc previously omitted this page.)* |
| `…/new` | `VendorForm` create mode plus an optional initial-contact sub-form; if filled, that contact is created `is_primary=true`. |
| `…/import` | CSV upload → column mapping → validation → execute, via FastAPI `/api/vendors/import/{analyze,validate,execute}` (AI column mapping). Execute upserts `ON CONFLICT (company_id, name)` case-insensitively, so an existing vendor **updates in place**; within-CSV duplicate names collapse to one row. |

**Decisions.** No "capabilities" checkboxes on a vendor — what it is used for is derived from inbound references, so it cannot drift from reality. Outside processing lives on Vendors rather than as a pseudo job-type on the Jobs list, because it is vendor work.

## Access layer

Signatures live in [`utils/vendorsAccess.ts`](../../utils/vendorsAccess.ts) (11 exports) and [`utils/vendorContactsAccess.ts`](../../utils/vendorContactsAccess.ts) (5 exports). Only non-obvious behaviour is recorded here:

- `getAllVendors` batches 1000 rows per fetch; a whitespace-only search term applies no filter at all.
- `getVendor` returns `null` on `PGRST116` (not found) rather than throwing.
- `checkVendorNameExists` is scoped to **live** rows (`deleted_at IS NULL`), so an archived name never falsely blocks a create.
- `createVendor` on a `23505` collision with an **archived** vendor revives it (`reviveArchivedVendorByName` — un-archive plus apply the form values); a collision with a **live** vendor re-throws as a genuine duplicate.
- `deleteVendor` and `bulkDeleteVendors` (100-row batches) stamp `deleted_at` via `.update()` — never a SQL `DELETE`, never blocked by a part or work-centre reference. Archive is universal; the standard is [architecture.md §16](../architecture.md).
- ⚠ **`bulkImportVendors` has no callers** — `git grep` finds only its definition. Dead code, superseded by the FastAPI import route above. *(This doc previously presented it as "the direct-client path", implying a live second path.)*

## Test coverage

| Layer | File | Coverage |
|---|---|---|
| Vendor access | [`__tests__/utils/vendorsAccess.test.ts`](../../__tests__/utils/vendorsAccess.test.ts) | 9 tests across `getAllVendors`, `getVendor`, `createVendor`, `deleteVendor` |
| Import API | [`api/tests/integration/test_vendors_import_api.py`](../../api/tests/integration/test_vendors_import_api.py) | 16 tests across `TestVendorsAnalyze`, `TestVendorsValidate`, `TestVendorsExecute` *(⚠ This doc previously tagged the import `automation-pending`; this suite exists.)* |

### Known gaps

**There is no E2E spec for vendors and no test file for `utils/vendorContactsAccess.ts`** — so UI reload-persistence and every contact behaviour (create, edit, set-primary, delete) is unverified by automation. This single gap is what the deleted AC block's ~14 `automation-pending` tags were recording; re-verified 2026-08-03 and still true. Doc-vs-code divergences from the original audit: [issue #344](https://github.com/debola31/Jigged/issues/344).

### Withdrawn

- **Withdrawn:** deleting a vendor referenced by a part or work centre must be blocked by an FK guard (`23503`) — wrong because archiving keeps the row, so those references keep resolving; the guard only trapped users, and its test was removed with it.
- **Withdrawn:** a vendor carries one embedded contact (`contact_name` / `email` / `phone` columns on `vendors`) — wrong because a vendor has several people with distinct roles; replaced by `vendor_contacts`, and the columns are gone from the schema.

## See also

- [Parts](parts.md) — preferred-vendor link.
- [Work Centers](work-centers.md) — owns external work centres and their vendor reference.
- [Jobs](jobs.md#outside-external-vendor-operations) — the outside-operation lifecycle behind the Outside processing tab.
