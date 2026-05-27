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
| `getAllVendors(companyId, search, sortField, sortDir)` | Batched 1000-row fetch; search across name and city; contacts hydrated via separate query |
| `getPartsByPreferredVendor(vendorId)` | `{id, part_name, primary_unit}` — for the detail page Linked Parts accordion |
| `getWorkCentersByVendor(vendorId)` | `{id, name, kind}` — for the Linked Work Centers accordion |
| `createVendor(companyId, formData, initialContact?)` | Inserts vendor, optionally inserts one `vendor_contacts` row with `is_primary=true` |
| `updateVendor(vendorId, formData)` | Vendor-row update only; contact CRUD is separate |
| `deleteVendor(vendorId)` | Raises `23503` if FK references exist |
| `bulkDeleteVendors(vendorIds)` | Batched 100/chunk, same FK guard |
| `bulkImportVendors(companyId, rows)` | De-dupe by name (case-insensitive); returns `{imported, skipped, errors}` |

---

## See also

- [Parts](parts.md) — preferred vendor link.
- [Work Centers](work-centers.md) — external work centers point at a vendor.
