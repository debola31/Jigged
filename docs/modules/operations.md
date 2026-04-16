# Operations Module

## Overview

The Operations module manages the catalog of operation types available in the shop. Operation types define what work can be done and at what cost — they're referenced when creating routings and for job costing.

**Priority:** Must Have (Build after Parts, before Quotes)

**Dependencies:** None (foundational module)

**Database Tables:** `operation_types`

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner/Admin | View all operation types in one flat list | I can see our shop's capabilities at a glance |
| Owner/Admin | Create operation types with hourly labor rates | I can track costs accurately |
| Owner/Admin | Edit operation type rates when costs change | My quotes and job costing stay accurate |
| Owner/Admin | Bulk import operation types from my legacy system | I can migrate quickly without manual data entry |
| Estimator | Look up operation type rates when quoting | I can calculate accurate job costs |

---

## Data Model

### Operation Types Table (`operation_types`)

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key (auto-generated) |
| company_id | UUID (FK) | Yes | Link to company (multi-tenant isolation) |
| name | Text | Yes | Operation type name (e.g., "HURCO Mill", "Mazak Lathe") |
| code | Text | No | Short code for display (e.g., "HRC-M1") |
| labor_rate | Decimal | No | Hourly rate in dollars (e.g., 135.00) |
| description | Text | No | Optional description or notes |
| metadata | JSONB | No | Flexible field for future extensions (see below) |
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes |

**Unique Constraint:** `(company_id, name)`

### Metadata JSONB Structure

The `metadata` column provides flexibility for shop-specific needs without schema changes:

```javascript
{
  "setup_time_minutes": 30,
  "capabilities": ["5-axis", "high-speed"],
  "max_part_size": { "x": 24, "y": 18, "z": 12 },
  "manufacturer": "Hurco",
  "model": "VM10i",
  "year_acquired": 2019,
  "notes": "Preferred for aluminum parts"
}
```

---

## UI Screens

### 1. Operations List

**Route:** `/dashboard/{companyId}/operations`

**Layout:** Single flat AG Grid list sorted by name.

**Features:**

- Search box (searches operation type name)
- "+ New Operation" button
- "Import" button (CSV)
- Click a row to view/edit the operation type

**Empty State:**

"No operations yet. Create your first operation or import from your legacy system."

### 2. Operation Type Create/Edit

**Route:** `/dashboard/{companyId}/operations/new` or `/dashboard/{companyId}/operations/{id}/edit`

**Form Sections:**

▸ **Basic Information**

- Name (required)
- Labor Rate ($/hour)

▸ **Description**

- Description (freeform notes)

**Actions:**

- Save → Returns to list
- Cancel → Returns to list without saving
- Delete (edit mode only) → Confirmation dialog

**Delete Validation:**

- Cannot delete if operation type is used in any routing
- Show warning with count of affected routings

---

## AI-Powered Bulk Import

**Route:** `/dashboard/{companyId}/operations/import`

Uses the same AI-powered import infrastructure as Customers and Parts.

### Import Flow

1. **Upload CSV/Excel** — Parse file, extract headers + sample rows
2. **AI Analysis** — AI suggests column mappings with confidence scores
3. **Review Mappings** — User confirms/adjusts mappings
4. **Execute** — Import with results summary

### Expected Source Columns

| Source Column | Maps To | Notes |
|---|---|---|
| name | operation_types.name | Primary identifier |
| laborRate | operation_types.labor_rate | Hourly rate |
| description | operation_types.description | Freeform notes |
| _id | operation_types.metadata.legacy_id | Preserve for reference |

### Conflict Detection

- **Duplicate name** within company → Conflict (skip or update)
- **Missing laborRate** → Warning (import with NULL)

### API Architecture

**CRUD Operations → Direct Supabase Calls**

Simple create, read, update, delete operations use direct Supabase client calls from the frontend (via `utils/operationsAccess.ts`).

**Complex Operations → FastAPI Endpoints**

AI-powered features that require server-side processing use FastAPI:

- `POST /api/operations/import/analyze` — AI mapping suggestions
- `POST /api/operations/import/validate` — Validate mapped rows before commit
- `POST /api/operations/import/execute` — Perform the import

---

## Rate Lookup Logic

When calculating job costs, the system looks up `operation_types.labor_rate` by `operation_type_id`:

```javascript
function getOperationTypeRate(operationTypeId: string): number | null {
  const operationType = await getOperationType(operationTypeId);
  return operationType?.labor_rate ?? null;
}
```

---

## Acceptance Criteria

### Operation Types

- [ ] Can view operation types in a flat list
- [ ] Can search operation types by name
- [ ] Can create a new operation type
- [ ] Can edit operation type details
- [ ] Can set labor rate
- [ ] Operation type names are unique within company
- [ ] Form shows validation errors inline

### AI-Powered Import

- [ ] Can upload CSV or Excel file
- [ ] AI analyzes file and suggests column mappings
- [ ] Confidence scores displayed with color coding
- [ ] Detects duplicate operation type names
- [ ] Can skip conflicts and import valid rows
- [ ] Shows import results: imported, skipped
- [ ] Legacy IDs preserved in metadata

---

## Station QR Codes

Each Operation Type represents a station in the shop. Operators can scan station QR codes to access the Operator View for that specific workstation.

### QR Code URL Format

```plain text
https://app.jigged.io/operator/{companyId}/login?station={operation_type_id}
```

### QR Code Display

The QR code is displayed on the Operation Type detail page. Users can access it by clicking on any row in the Operation Types table.

### Export Options

- Download PNG — Downloads the QR code as a PNG image file
- Download PDF — Downloads a PDF with the QR code, station name, and company branding for printing labels
- Print — Opens the browser print dialog with the QR code and station label

### Usage

1. Navigate to Operations
2. Click on an Operation row to view its details
3. The Station QR Code is displayed on the left side of the detail page
4. Use the export buttons to download or print the QR code
5. Print and affix QR codes to machines/workstations
6. Operators scan the QR code to log into the Operator View for that station
