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
| `created_at`, `updated_at` | |

**Unique Constraint:** `(company_id, name)` — the identity key the CSV importer upserts on (`ON CONFLICT (company_id, name)`), so re-importing is idempotent.

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

The **Delete** button archives the vendor (sets `deleted_at`) and is **never disabled or blocked** — even when parts (`preferred_vendor_id`) or work centers (`vendor_id`) still point at it. The row survives the archive, so those links keep resolving; the vendor simply disappears from lists, search, and pickers (all of which filter `deleted_at IS NULL`). Reusing the name later revives the row. See [architecture.md §16](../architecture.md) for the universal archive (soft-delete) policy.

### Create — `/dashboard/{companyId}/vendors/new`

Renders `VendorForm` in `mode="create"`.

Form fields:

- **Vendor:** name (required), address fields, country (default `USA`).
- **Initial contact** (create-mode sub-form, optional): name, role, role_label (when `role='other'`), email, phone. If filled, this contact is created with `is_primary=true`.

No "capabilities" checkboxes — what a vendor is used for is derived from inbound references (`parts.preferred_vendor_id`, `work_centers.vendor_id`).

### Import — `/dashboard/{companyId}/vendors/import`

CSV upload, column mapping, validation, then execute via `/api/vendors/import/*` endpoints. Execute upserts `ON CONFLICT (company_id, name)` (case-insensitive match), so a vendor already in the company **updates in place** rather than being skipped — re-importing the same file is idempotent. Within-CSV duplicate names collapse into one row.

---

## Access Layer

`utils/vendorsAccess.ts`:

| Function | Purpose |
|---|---|
| `getAllVendors(companyId, search, sortField, sortDir)` | Batched 1000-row fetch; search across name and city |
| `getAllVendorsWithPrimaryContact(companyId, search, sortField, sortDir)` | `getAllVendors` + each vendor's `is_primary` contact joined — powers the list grid |
| `getVendor(vendorId)` | Single-row fetch; returns `null` on `PGRST116` (not found) |
| `checkVendorNameExists(companyId, name, excludeId?)` | Case-insensitive uniqueness check for the create/edit form; scoped to **live** rows (`deleted_at IS NULL`) so an archived name doesn't falsely block — it revives on create instead |
| `getPartsByPreferredVendor(vendorId)` | `{id, part_name, primary_unit}` — for the detail page Linked Parts accordion |
| `getWorkCentersByVendor(vendorId)` | `{id, name, kind}` — for the Linked Work Centers accordion |
| `createVendor(companyId, formData, initialContact?)` | Inserts vendor, optionally inserts one `vendor_contacts` row with `is_primary=true`. On a `23505` name collision with an **archived** vendor, revives that row instead (un-archive + apply form values via `reviveArchivedVendorByName`); a collision with a **live** vendor re-throws as a genuine duplicate |
| `updateVendor(vendorId, formData)` | Vendor-row update only; contact CRUD is separate |
| `deleteVendor(vendorId)` | **Archive** — sets `deleted_at` via `.update()` (not a SQL `DELETE`); never blocks on references (parts / work-center links survive the archived row) |
| `bulkDeleteVendors(vendorIds)` | **Archive** in 100-row batches; same never-blocks semantics |
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
- [ ] **Given** the create form, **when** a user submits a name already used by a **live** vendor (case-insensitive), **then** it is flagged as a duplicate before insert; a name held only by an **archived** vendor is not blocked — it revives that row instead — *automation-pending (`checkVendorNameExists` is scoped to `deleted_at IS NULL`; `createVendor` revives on the `23505`; DB unique `(company_id, name)`)*.

**Edit a vendor (edit → save → reload → persists)**

- [ ] **Given** an existing vendor, **when** a user edits name / address_line1 / address_line2 / city / state / postal_code / country and saves, **then** reloading the detail page shows the new values — *automation-pending (`updateVendor`)*.

**Contacts (edit → save → reload → persists)**

- [ ] **Given** a vendor, **when** a user adds a contact (name required; `role_label` required when `role='other'`) and saves, **then** reloading shows it in the Contacts card — *automation-pending (`createVendorContact`; `role_label` enforced by DB check `vendor_contacts_role_label_required`)*.
- [ ] **Given** an existing contact, **when** a user edits its fields and saves, **then** reloading shows the change — *automation-pending (`updateVendorContact`)*.
- [ ] **Given** a vendor with several contacts, **when** a user marks one primary, **then** exactly one primary remains (the previous one is cleared) and reloading confirms it — *automation-pending (`setPrimaryContact`; enforced by partial unique index `vendor_contacts_one_primary`)*.
- [ ] **Given** a contact, **when** a user deletes it, **then** reloading shows it gone — *automation-pending (`deleteVendorContact`)*.

**Delete (= archive) & bulk**

- [ ] **Given** any vendor, **when** a user deletes it, **then** it is **archived** — `deleted_at` is stamped via `.update()` (no SQL `DELETE`) — and it disappears from lists, search, and pickers, while a by-id link (`getVendor`) still resolves it — *verified by `__tests__/utils/vendorsAccess.test.ts > 'deleteVendor' > 'archives by vendor id (sets deleted_at) instead of deleting'`*.
- [ ] **Given** a vendor referenced by a part (`preferred_vendor_id`) or work center (`vendor_id`), **when** a user deletes it, **then** the archive still **succeeds — it never blocks** — and the row survives so those references keep resolving (there is no `23503` FK guard, and the detail-page Delete button is never disabled) — *same archive path as above; the former FK-guard test was removed*.
- [ ] **Given** a Supabase failure while archiving, **when** the update runs, **then** a friendly error is thrown rather than failing silently — *verified by `__tests__/utils/vendorsAccess.test.ts > 'deleteVendor' > 'throws when the archive update errors'`*.
- [ ] **Given** selected vendors, **when** a user bulk-deletes, **then** they are archived (`deleted_at` set) in 100-row batches, never blocked by references — *automation-pending (`bulkDeleteVendors`)*.
- [ ] **Given** an archived vendor's name, **when** a user re-creates or re-imports that name, **then** the archived row is **revived** (un-archived + updated) rather than duplicated — *insert-collision revive path in `createVendor` (`reviveArchivedVendorByName`); import upsert sets `deleted_at=None`; automation-pending*.

**Read edge cases**

- [ ] **Given** a vendor id, **when** it is fetched, **then** the row is returned, or `null` when not found (PGRST116) — *verified by `__tests__/utils/vendorsAccess.test.ts > 'getVendor' > 'queries by id and returns the row'` AND `__tests__/utils/vendorsAccess.test.ts > 'getVendor' > 'returns null when supabase returns PGRST116 not-found'`*.
- [ ] **Given** a vendor detail page, **when** it loads, **then** the Linked Parts and Linked Work Centers accordions list inbound references read-only — *automation-pending (`getPartsByPreferredVendor`, `getWorkCentersByVendor`)*.

**Import**

- [ ] **Given** a vendors CSV, **when** a user maps columns and executes the import, **then** rows are inserted and duplicates (by name, case-insensitive) are skipped, with an imported/skipped/errors summary — *automation-pending (Import page posts to FastAPI `/api/vendors/import/{analyze,validate,execute}`; the `csv-import` E2E is CI-skipped)*.

---

## See also

- [Parts](parts.md) — preferred vendor link.
- [Work Centers](work-centers.md) — external work centers point at a vendor.
