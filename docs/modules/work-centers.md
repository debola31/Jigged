# Work Centers Module

## Overview

A **work center** is a unit of production capacity. It can be **internal** (a machine, station, or in-house capability with an hourly labor rate) or **external** (an outsourced process performed by a vendor). Work centers are referenced by routing operations (`routing_operations.work_center_id`).

> **Note on terminology.** This module supersedes what older docs called "Operations" (`operation_types` table). Migration `20260502_unify_parts_inventory_add_work_centers_vendors.sql` dropped `operation_types` and introduced `work_centers`. The two-axis design (internal vs external) unified machine capabilities and outsourced capabilities into one table — see `docs/modules/operations.md` for the historical spec, kept for reference.

**Priority:** Built; in production.

**Dependencies:** [Vendors](vendors.md) (external work centers point at a vendor). Consumed by [Routings](routings.md) (via `routing_operations.work_center_id`).

---

## Data Model

### `work_centers` table

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `company_id` | FK |
| `name` | required |
| `kind` | enum: `internal | external` |
| `vendor_id` | FK → `vendors`; required when `kind='external'` (DB CHECK), null when `kind='internal'` |
| `labor_rate` | numeric; used when `kind='internal'`; cleared to null when `kind='external'` |
| `description` | optional multiline |
| `metadata` | jsonb (e.g. `{code: "WC-LATHE-01"}` used for the Station QR code on internal work centers) |
| `created_at`, `updated_at` | |

External work centers do **not** carry a labor_rate on the work-center row. Their cost is set per routing operation (`routing_operations.external_unit_price`, `routing_operations.external_setup_cost`) — pricing is per-operation, not per-vendor.

---

## Pages

### List — `/dashboard/{companyId}/work-centers`

AG Grid columns:

- **Name**
- **Kind** — chip: "Internal" (info color) or "External" (warning color)
- **Cost** — internal rows display `labor_rate` formatted as `$X.XX/hr` (or `—` if null); external rows display "Per operation" (italic, grey). A custom column comparator keeps internal rows sorted by `labor_rate` and pins external rows to the bottom.
- **Vendor name** — hidden for internal rows
- **Description**
- **Updated**

Search across name. **Filter:** kind dropdown (All / Internal / External). Default sort: name asc. Pagination: 25 / 50 / 100. Bulk export CSV, bulk delete, single-row create, import.

### Detail — `/dashboard/{companyId}/work-centers/{workCenterId}`

Sections:

- **Header card** — name, kind badge (icon + text), vendor link (external only).
- **Details card** — labor rate (internal) **or** vendor link + "Pricing per routing operation" note (external); description; routing-operation-usage count; created/updated timestamps.
- **Station QR Code card** (internal only) — `StationQRCode` component rendering `metadata.code`.

The **Delete** button is disabled when `routing_operations_count > 0` (FK constraint `23503` would otherwise block).

### Create — `/dashboard/{companyId}/work-centers/new`

Renders `WorkCenterForm` in `mode="create"`. Fields:

- **Name** — required
- **Kind toggle** — Internal (FactoryIcon) / External (LocalShippingIcon)
- **Internal-only:** `labor_rate` (number, ≥ 0, optional)
- **External-only:** `vendor_id` via `VendorAutocomplete` (required)
- **Description** — optional

Form validation requires `vendor_id` when `kind='external'`; the DB also enforces this via CHECK constraint.

### Import — `/dashboard/{companyId}/work-centers/import`

CSV upload, column mapping, validation, execute. External-row import resolves `vendor_name` → `vendor_id` via a pre-fetched vendor lookup; rows with unresolved vendors are reported in `errors`. De-duplicates by name.

---

## Access Layer

`utils/workCentersAccess.ts`:

| Function | Purpose |
|---|---|
| `getAllWorkCenters(companyId, search, sortField, sortDir)` | Flat list |
| `getWorkCentersByKind(companyId, kind, search)` | Filter by kind |
| `getWorkCentersFlat(companyId, options)` | Optional kind / search filter (used by dropdowns) |
| `getWorkCentersForRouting(companyId, kind?)` | `{id, name, kind, labor_rate, vendor_name}` — vendor name pre-joined for the routing picker |
| `getWorkCenterWithRelations(workCenterId)` | Hydrates with `routing_operations_count` and vendor |
| `createWorkCenter(companyId, formData)` | `kind='external'` clears `labor_rate` to null; inserts `metadata: {}` |
| `updateWorkCenter(workCenterId, formData)` | Same kind logic |
| `deleteWorkCenter(workCenterId)` | Raises `23503` if `routing_operations` reference |
| `bulkDeleteWorkCenters(workCenterIds)` | Batched 100/chunk, same FK guard |
| `bulkImportWorkCenters(companyId, rows)` | Vendor-name resolution for external rows; de-dupe by name |

---

## See also

- [Routings](routings.md) — `routing_operations.work_center_id` is the consumer.
- [Vendors](vendors.md) — external work centers reference a vendor.
- [operations.md](operations.md) — historical spec (predates the unification).
