> **Condensed 2026-08-03** — 1,774 → 949 words (`wc -w`). **Cut:** the Acceptance-Criteria block (~53% of the file, the highest share of any module doc), whose bullets mostly re-described the test they cited; two Access-Layer tables restating function signatures; the archive policy stated three times; "external work centres point at a vendor" stated four times. **Kept:** every number, every citation, the revive-on-collision and never-blocks semantics, and the coverage gap the AC block existed to record. **Corrections after checking the code (5):** the doc never mentioned the **Outside processing** tab that is half the Vendors page; it tagged the CSV import `automation-pending` when 16 backend tests cover it; it omitted the `/edit` page; it presented dead code (`bulkImportVendors`) as a live import path; it credited the one-primary rule to the access layer alone.

# Vendors Module

Master list of external suppliers and outsourced-process providers. **Built; in production.** No dependencies to create. Consumed by [Parts](parts.md) (`parts.preferred_vendor_id`) and [Vendor Services](vendor-services.md) (`vendor_services.vendor_id` — **that doc owns the services side**, not restated here).

> **⚠ Corrected 2026-08-23.** This doc previously pointed at `work_centers.vendor_id` for the
> outsourced side. That column is **dropped**: a vendor's processes are `vendor_services` rows now,
> owned by the vendor. The "Linked Work Centers" accordion on the detail page is a Services list.

## Data model

**`vendors`** — `id` (uuid PK), `company_id`, `name` (required), `created_at`, `updated_at`, `deleted_at`. Unique `vendors_unique_per_company (company_id, name)`, kept FULL not partial — name is the identity the CSV importer upserts on, so re-import is idempotent and a re-create revives rather than duplicates.

> **⚠ The six address columns are gone (2026-08-24).** `address_line1`…`country` sat on this row, so a vendor had exactly one address and a plater with two plants had nowhere to say so. They moved to **`vendor_addresses`**, backfilled one row per vendor that had any address data, marked default. A vendor row is identity only now: contacts, addresses and services are each their own 1-to-many table.

**`vendor_addresses`** — 1-to-many with `vendors`, `ON DELETE CASCADE`: `id`, `vendor_id`, `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `country` (defaults `'USA'`), `attention_to`, `is_default`, timestamps. `idx_vendor_addresses_one_default` is a partial unique index on `vendor_id WHERE is_default`, so at most one default per vendor is **enforced** rather than promised — the lesson of [20260802013846](../../supabase/migrations/20260802013846_customer_address_default_uniqueness.sql), where `customer_addresses`' comments cited two indexes that had never existed.

**One `is_default`, not the `default_billing` / `default_shipping` pair customers carry.** For a customer an invoice and a pallet genuinely go to different places; the vendor equivalent would be "where we send parts" vs "where we send payment", and nothing in the product distinguishes those today. Two flags nothing reads is two flags nobody keeps true.

Addresses are **hard-deleted, not archived**, matching `customer_addresses` and `vendor_contacts`. That is the archive-vs-delete test in [architecture.md §16](../architecture.md) applied, not an exception to it: nothing stores a `vendor_address_id`, so there is no retained reference to keep resolving. Deleting the default promotes the oldest survivor — a vendor with addresses and no default is a state the UI has no reading of.

**`vendor_contacts`** — 1-to-many with `vendors`, `ON DELETE CASCADE`: `id`, `vendor_id`, `name` (required), `role`, `role_label`, `email`, `phone`, `is_primary`, `created_at`, `updated_at`.

| Constraint | Enforces |
|---|---|
| `vendor_contacts_role_check` | `role ∈ {sales, accounts_payable, quality, engineering, shipping_receiving, customer_service, other}` |
| `vendor_contacts_role_label_required` | `role_label` non-empty when `role='other'` |
| `vendor_contacts_one_primary` (partial unique index on `vendor_id WHERE is_primary`) | at most one primary per vendor *(⚠ This doc previously said one-primary is "enforced in access layer"; the DB enforces it too — the access layer clears the old primary so the index never trips.)* |

## Pages

| Route | Contents |
|---|---|
| `/dashboard/{companyId}/vendors` | **One grid, no tabs** *(⚠ Corrected 2026-08-23: the Directory / Outside processing tab strip and its actionable queue are **deleted** — see [jobs.md](jobs.md#outside-external-vendor-operations).)* AG Grid: Name, **Services** (derived, read-only), Primary Contact (`name · email`), Location (`city, state`), Updated. No send/receive lives on this page. Search name + city, sort name asc, pagination 25/50/100, bulk CSV export, bulk archive, row click → detail. |
| `…/{vendorId}` | Header card; **Services** card — name, description and price per piece, **edited in place** ([`VendorServicesCard`](../../components/vendors/VendorServicesCard.tsx)); Contacts card (primary starred; per-row edit / set-primary / delete); Address card; **Parts supplied** card; **Open jobs** card — read-only, *At {vendor} now* sorted **oldest sent first** (chase order) and *Waiting to go out*, every row deep-linking to `?op=` on the job. Delete archives and is never disabled. |
| `…/{vendorId}/edit` | `VendorForm` edit mode — vendor row only; contact CRUD is separate. *(⚠ This doc previously omitted this page.)* |
| `…/new` | `VendorForm` create mode plus an optional initial-contact sub-form; if filled, that contact is created `is_primary=true`. |

*(There was a `…/import` page here — a vendor-specific CSV wizard. It is gone: vendors are imported through the one guided importer at `/dashboard/{companyId}/import` (see [data-import.md](data-import.md)), which writes via FastAPI `/api/vendors/import/execute`. That write upserts `ON CONFLICT (company_id, name)` case-insensitively, so an existing vendor **updates in place**; within-CSV duplicate names collapse to one row.)*

**Decisions.** No "capabilities" checkboxes on a vendor — what it is used for is derived from inbound references, so it cannot drift from reality. Services are that derived truth made first-class: they are the processes the vendor performs, stored once, not a duplicated flag.

**A service is a name, a description and a price, and the UI is sized to that.** There is no service detail page and no form route: editing happens inline on the vendor, because sending someone to a separate screen for three fields makes them leave the vendor they were looking at and gives them a back button to find their way home from. A shop owner adding three processes in a row does that whole interaction on one card.

*(The description field was briefly labelled **Notes for whoever ships it**, which read as an optional aside rather than part of what a service IS, and was cut on that basis. It is back as plain **Description** — the label was the problem, not the field.)*

**Withdrawn 2026-08-23**, all on the same reasoning — a count that costs a query per page load to decorate a list of three rows: a *Used on* and *Out now* column on the Services card, and *Out now* / *Oldest out* columns on the directory. The vendor's **Open jobs** card answers "what is out at this vendor" properly, and the Jobs list already flags a job whose parts are at one. Outside processing lives on Vendors rather than as a pseudo job-type on the Jobs list, because it is vendor work.

## Access layer

Signatures live in [`utils/vendorsAccess.ts`](../../utils/vendorsAccess.ts) (11 exports) and [`utils/vendorContactsAccess.ts`](../../utils/vendorContactsAccess.ts) (5 exports). Only non-obvious behaviour is recorded here:

- `getAllVendors` batches 1000 rows per fetch; a whitespace-only search term applies no filter at all.
- `getVendor` returns `null` on `PGRST116` (not found) rather than throwing.
- `checkVendorNameExists` is scoped to **live** rows (`deleted_at IS NULL`), so an archived name never falsely blocks a create.
- `createVendor` on a `23505` collision with an **archived** vendor revives it (`reviveArchivedVendorByName` — un-archive plus apply the form values); a collision with a **live** vendor re-throws as a genuine duplicate.
- `deleteVendor` and `bulkDeleteVendors` (100-row batches) stamp `deleted_at` via `.update()` — never a SQL `DELETE`, never blocked by a part or work-centre reference. Archive is universal; the standard is [architecture.md §16](../architecture.md).
- **`bulkImportVendors` is gone.** It had no callers — `git grep` found only its definition — and was superseded by the FastAPI import route above. *(This doc once presented it as "the direct-client path", implying a live second path.)*

## Test coverage

| Layer | File | Coverage |
|---|---|---|
| Vendor access | [`__tests__/utils/vendorsAccess.test.ts`](../../__tests__/utils/vendorsAccess.test.ts) | 9 tests across `getAllVendors`, `getVendor`, `createVendor`, `deleteVendor` |
| Import API | [`api/tests/integration/test_vendors_import_api.py`](../../api/tests/integration/test_vendors_import_api.py) | 14 tests across `TestVendorsValidate` and `TestVendorsExecute` *(⚠ This doc previously tagged the import `automation-pending`; this suite exists. It was 16 across three classes until `TestVendorsAnalyze` went with the `/analyze` endpoint.)* |

### Known gaps

**There is no E2E spec for vendors and no test file for `utils/vendorContactsAccess.ts`** — so UI reload-persistence and every contact behaviour (create, edit, set-primary, delete) is unverified by automation. This single gap is what the deleted AC block's ~14 `automation-pending` tags were recording; re-verified 2026-08-03 and still true. Doc-vs-code divergences from the original audit: [issue #344](https://github.com/debola31/Jigged/issues/344).

### Withdrawn

- **Withdrawn:** deleting a vendor referenced by a part or work centre must be blocked by an FK guard (`23503`) — wrong because archiving keeps the row, so those references keep resolving; the guard only trapped users, and its test was removed with it.
- **Withdrawn:** a vendor carries one embedded contact (`contact_name` / `email` / `phone` columns on `vendors`) — wrong because a vendor has several people with distinct roles; replaced by `vendor_contacts`, and the columns are gone from the schema.

## See also

- [Parts](parts.md) — preferred-vendor link.
- [Vendor Services](vendor-services.md) — owns a vendor's processes and their pricing.
- [Work Centers](work-centers.md) — in-house capacity, which no longer references a vendor.
- [Jobs](jobs.md#outside-external-vendor-operations) — the outside-operation lifecycle behind the Outside processing tab.
