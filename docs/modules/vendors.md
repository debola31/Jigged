# Vendors Module

## Overview

The Vendors module manages the master list of external suppliers and outsourced-process providers. Vendors are referenced by parts (`parts.preferred_vendor_id`) and by external work centers (`work_centers.vendor_id`).

**Priority:** Built; in production.

**Dependencies:** None for create. Consumed by [Parts](parts.md) and [Work Centers](work-centers.md).

---

## Data Model

### `vendors` table

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `company_id` | FK |
| `name` | required |
| `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `country` | `country` defaults to `'USA'` |
| `legacy_id` | unique per company; used by importers for idempotent upsert |
| `created_at`, `updated_at` | |

### `vendor_contacts` table

1-to-many with `vendors`.

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `vendor_id` | FK |
| `name` | required |
| `role` | enum: `sales | accounts_payable | quality | engineering | shipping_receiving | customer_service | other` |
| `role_label` | required when `role='other'` |
| `email`, `phone` | optional |
| `is_primary` | exactly one primary per vendor (enforced in access layer) |
| `created_at`, `updated_at` | |

---

## Pages

### List — `/dashboard/{companyId}/vendors`

AG Grid columns:

- **Name**
- **Primary contact** — name · email
- **Location** — city, state
- **Updated**

Search across name + city. Default sort: name asc. Pagination: 25 / 50 / 100. Bulk export CSV, bulk delete. Single-row entry → vendor detail.

### Detail — `/dashboard/{companyId}/vendors/{vendorId}`

Sections:

- **Header card** — vendor name, created/updated timestamps.
- **Contacts card** — all `vendor_contacts`; primary marked with a star; per-row actions to edit / set primary / delete.
- **Address card** — `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `country`, formatted multi-line.
- **Linked Parts** (accordion) — parts where `preferred_vendor_id = this vendor`. Shows `part_name`, `primary_unit`.
- **Linked Work Centers** (accordion) — work centers where `vendor_id = this vendor`. Shows `name`, `kind` (`internal | external`; external is the case where the FK is set).

The **Delete** button is disabled when any linked part or work center exists (FK constraint `23503` blocks the delete; the UI checks before showing the button).

### Create — `/dashboard/{companyId}/vendors/new`

Renders `VendorForm` in `mode="create"`.

Form fields:

- **Vendor:** name (required), address fields, country (default `USA`).
- **Initial contact** (create-mode sub-form, optional): name, role, role_label (when `role='other'`), email, phone. If filled, this contact is created with `is_primary=true`.

No "capabilities" checkboxes — what a vendor is used for is derived from inbound references (`parts.preferred_vendor_id`, `work_centers.vendor_id`).

### Import — `/dashboard/{companyId}/vendors/import`

CSV upload, column mapping, validation, then execute via `/api/vendors/import/*` endpoints. De-duplicates by name (case-insensitive).

---

## Access Layer

`utils/vendorsAccess.ts`:

| Function | Purpose |
|---|---|
| `getAllVendors(companyId, search, sortField, sortDir)` | Batched 1000-row fetch; search across name and city |
| `getAllVendorsWithPrimaryContact(companyId, search, sortField, sortDir)` | `getAllVendors` + each vendor's `is_primary` contact joined — powers the list grid |
| `getVendor(vendorId)` | Single-row fetch; returns `null` on `PGRST116` (not found) |
| `checkVendorNameExists(companyId, name, excludeId?)` | Case-insensitive uniqueness check for the create/edit form |
| `getPartsByPreferredVendor(vendorId)` | `{id, part_name, primary_unit}` — for the detail page Linked Parts accordion |
| `getWorkCentersByVendor(vendorId)` | `{id, name, kind}` — for the Linked Work Centers accordion |
| `createVendor(companyId, formData, initialContact?)` | Inserts vendor, optionally inserts one `vendor_contacts` row with `is_primary=true` |
| `updateVendor(vendorId, formData)` | Vendor-row update only; contact CRUD is separate |
| `deleteVendor(vendorId)` | Raises `23503` if FK references exist |
| `bulkDeleteVendors(vendorIds)` | Batched 100/chunk, same FK guard |
| `bulkImportVendors(companyId, rows)` | Direct-client de-dupe-by-name insert (returns `{imported, skipped, errors}`). **Note:** the Import *page* executes via the FastAPI `/api/vendors/import/{analyze,validate,execute}` endpoints (AI column mapping); this function is the direct-client path. |

Contact CRUD lives in `utils/vendorContactsAccess.ts`:

| Function | Purpose |
|---|---|
| `getContactsForVendor(vendorId)` | All contacts; primary first, then by `created_at` |
| `createVendorContact(vendorId, formData)` | Insert; clears any existing primary when `is_primary=true` |
| `updateVendorContact(contactId, formData)` | Update; clears any existing primary when `is_primary=true` |
| `deleteVendorContact(contactId)` | Delete a contact |
| `setPrimaryContact(vendorId, contactId)` | Clear all `is_primary` for the vendor, then set the named one |

---

## Acceptance Criteria

Given/When/Then scenarios, each carrying a **verification clause** — a test pointer (`*verified by <file> > 'test name'*`), a manual procedure, or an explicit `automation-pending` tag. Every editable entity has at least one `edit → save → reload → persists` bullet. Vendors has unit coverage (`__tests__/utils/vendorsAccess.test.ts`, 9 tests) but **no E2E spec yet** and **no test file for `utils/vendorContactsAccess.ts`**, so UI reload-persistence and all contact bullets are tagged `automation-pending`. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on [issue #344](https://github.com/debola31/Jigged/issues/344).

**List, search & sort**

- [ ] **Given** a company's vendors, **when** a user opens the list, **then** vendors show Name, Primary contact (name · email), Location (city · state), and Updated, default-sorted by name asc, paginated 25/50/100 — *list query verified by `__tests__/utils/vendorsAccess.test.ts > 'getAllVendors' > 'queries the vendors table filtered by company_id'`; grid rendering + pagination automation-pending*.
- [ ] **Given** the list, **when** a user types a search term, **then** vendors are filtered by name or city (case-insensitive `ilike`), and a whitespace-only term applies no filter — *verified by `__tests__/utils/vendorsAccess.test.ts > 'getAllVendors' > 'applies name + city ilike when search is non-empty'` AND `__tests__/utils/vendorsAccess.test.ts > 'getAllVendors' > 'skips the or() filter when search is whitespace'`*.
- [ ] **Given** a Supabase failure while listing, **when** the query runs, **then** a friendly error is thrown rather than a silent empty list — *verified by `__tests__/utils/vendorsAccess.test.ts > 'getAllVendors' > 'throws when supabase returns an error'`*.

**Create a vendor (edit → save → reload → persists)**

- [ ] **Given** the create form, **when** a user enters a name (required) plus optional address fields and saves, **then** a vendor is created with `company_id` stitched on and `country` defaulting to `USA`, and reloading the list shows it — *insert path verified by `__tests__/utils/vendorsAccess.test.ts > 'createVendor' > 'inserts a vendor row with company_id stitched on'`; reload-persistence E2E automation-pending*.
- [ ] **Given** the create form with the optional initial-contact sub-form filled, **when** the user saves, **then** the vendor is created together with one `vendor_contacts` row flagged `is_primary=true` — *automation-pending (`createVendor` `initialContact` path)*.
- [ ] **Given** the create form, **when** a user submits a name already used in the company (case-insensitive), **then** it is flagged as a duplicate before insert — *automation-pending (`checkVendorNameExists`; DB unique `(company_id, name)`)*.

**Edit a vendor (edit → save → reload → persists)**

- [ ] **Given** an existing vendor, **when** a user edits name / address_line1 / address_line2 / city / state / postal_code / country and saves, **then** reloading the detail page shows the new values — *automation-pending (`updateVendor`)*.

**Contacts (edit → save → reload → persists)**

- [ ] **Given** a vendor, **when** a user adds a contact (name required; `role_label` required when `role='other'`) and saves, **then** reloading shows it in the Contacts card — *automation-pending (`createVendorContact`; `role_label` enforced by DB check `vendor_contacts_role_label_required`)*.
- [ ] **Given** an existing contact, **when** a user edits its fields and saves, **then** reloading shows the change — *automation-pending (`updateVendorContact`)*.
- [ ] **Given** a vendor with several contacts, **when** a user marks one primary, **then** exactly one primary remains (the previous one is cleared) and reloading confirms it — *automation-pending (`setPrimaryContact`; enforced by partial unique index `vendor_contacts_one_primary`)*.
- [ ] **Given** a contact, **when** a user deletes it, **then** reloading shows it gone — *automation-pending (`deleteVendorContact`)*.

**Delete & bulk**

- [ ] **Given** a vendor with no linked parts or work centers, **when** a user deletes it, **then** it is removed — *verified by `__tests__/utils/vendorsAccess.test.ts > 'deleteVendor' > 'deletes by vendor id'`*.
- [ ] **Given** a vendor referenced by a part (`preferred_vendor_id`) or work center (`vendor_id`), **when** a user attempts delete, **then** it is blocked with a friendly FK message and the detail-page Delete button is disabled — *delete guard verified by `__tests__/utils/vendorsAccess.test.ts > 'deleteVendor' > 'throws with a friendly message on FK violation (23503)'`; disabled-button UI automation-pending*.
- [ ] **Given** selected vendors, **when** a user bulk-deletes, **then** unreferenced vendors are removed in 100-row batches under the same FK guard — *automation-pending (`bulkDeleteVendors`)*.

**Read edge cases**

- [ ] **Given** a vendor id, **when** it is fetched, **then** the row is returned, or `null` when not found (PGRST116) — *verified by `__tests__/utils/vendorsAccess.test.ts > 'getVendor' > 'queries by id and returns the row'` AND `__tests__/utils/vendorsAccess.test.ts > 'getVendor' > 'returns null when supabase returns PGRST116 not-found'`*.
- [ ] **Given** a vendor detail page, **when** it loads, **then** the Linked Parts and Linked Work Centers accordions list inbound references read-only — *automation-pending (`getPartsByPreferredVendor`, `getWorkCentersByVendor`)*.

**Import**

- [ ] **Given** a vendors CSV, **when** a user maps columns and executes the import, **then** rows are inserted and duplicates (by name, case-insensitive) are skipped, with an imported/skipped/errors summary — *automation-pending (Import page posts to FastAPI `/api/vendors/import/{analyze,validate,execute}`; the `csv-import` E2E is CI-skipped)*.

---

## See also

- [Parts](parts.md) — preferred vendor link.
- [Work Centers](work-centers.md) — external work centers point at a vendor.
