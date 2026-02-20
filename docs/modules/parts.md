# Parts Module

## Overview

The Parts module manages the catalog of products/parts that Contour manufactures. Parts are typically customer-specific and include pricing information. Parts can be referenced when creating quotes and jobs.

**Priority:** Must Have (Build Second)

**Dependencies:** Customers module (parts are linked to customers)

**Database Table:** `parts`

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner/Admin | View a list of all parts | I can see our product catalog |
| Owner/Admin | Search parts by part number or description | I can quickly find a specific part |
| Owner/Admin | Filter parts by customer | I can see all parts for a specific customer |
| Owner/Admin | Filter parts by active/inactive status | I can focus on current parts |
| Owner/Admin | Create a new part with pricing tiers | I can quote and track new products |
| Owner/Admin | Edit part information | I can update pricing or descriptions |
| Owner/Admin | Mark a part as inactive | Old parts don't clutter my list but history is preserved |
| Owner/Admin | Bulk import parts from CSV | I can migrate from my legacy system |
| Salesperson | Look up part pricing when creating quotes | I can quickly provide accurate quotes |

---

## Data Model

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key (auto-generated) |
| company_id | UUID (FK) | Yes | Link to company (multi-tenant isolation) |
| customer_id | UUID (FK) | No | Link to customer (NULL for generic parts) |
| part_number | Text | Yes | Customer's part number (e.g., "AE36589E-RT") |
| description | Text | No | What the part is (e.g., "Recess Tool Bit") |
| pricing | JSONB | No | Array of quantity-based price tiers (see below) |
| is_active | Boolean | Yes | Active/inactive status (default: true) |
| notes | Text | No | Internal notes |
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes |

**Unique Constraint:** `(company_id, customer_id, part_number)`

This allows the same part number for different customers.

### Pricing JSONB Structure

The `pricing` column stores an array of quantity/price tier objects:

```javascript
[
  { "qty": 1, "price": 188.00 },
  { "qty": 5, "price": 159.00 },
  { "qty": 10, "price": 140.00 },
  { "qty": 50, "price": 125.00 }
]
```

**Schema Rules (enforced by database constraint):**

- Must be a JSON array

- Each object must have exactly two fields: `qty` and `price`

- `qty` must be an integer ≥ 1

- `price` must be a number

- No additional fields allowed

**Why JSONB instead of fixed columns:**

- Legacy data has up to 8 price tiers (fixed columns only supported 3)

- ~450 parts in Shane's data have 4+ tiers

- Flexible for future enhancements (seasonal pricing, date ranges)

- Cleaner import mapping from variable-column CSVs

---

## UI Screens

### 1. Parts List

**Route:** `/dashboard/{companyId}/parts`

**Features:**

- Table showing: Part Number, Description, Customer, Base Price (qty=1), Status

- Search box (searches part number and description)

- Filter dropdown: Customer (All / specific customer)

- Filter toggle: All / Active only / Inactive only

- "+ New Part" button

- Click row to view/edit

- Pagination (25 per page)

**Empty State:**

"No parts yet. Create your first part or import from CSV."

### 2. Part Create/Edit

**Route:** `/dashboard/{companyId}/parts/new` or `/dashboard/{companyId}/parts/{id}/edit`

**Form Sections:**

▸ **Basic Information**

- Customer (dropdown, optional - "Generic Part" if none selected)

- Part Number (required)

- Description

▸ **Pricing Tiers** (dynamic rows)

|  | Min Quantity | Unit Price | Actions |
|---|---|---|---|
| Tier 1 | [1] (default) | [$___] | — |
| Tier 2 | [___] | [$___] | [Remove] |
| ... | ... | ... | ... |

[+ Add Tier] button to add more rows (no limit)

**Validation:**

- Quantities must be ascending (each tier > previous)

- Prices must be valid numbers

- At least one tier required if any pricing exists

▸ **Cost Estimates**

- Material Cost (per unit)

▸ **Status**

- Active toggle

- Notes (multiline)

**Actions:**

- Save → Returns to list

- Cancel → Returns to list without saving

- Delete (edit mode only) → Confirmation dialog

### 3. Part Detail (Optional for Phase 0)

**Route:** `/dashboard/{companyId}/parts/{id}`

Read-only view showing:

- All part fields

- Customer link

- Related quotes (future)

- Related jobs (future)

- Edit button

---

## Pricing Tier Logic

When calculating the unit price for a given quantity, find the highest tier where `qty <= order_quantity`:

```javascript
function getUnitPrice(pricing: Array<{qty: number, price: number}>, orderQty: number): number | null {
  // Sort by qty descending, find first tier where qty <= orderQty
  const sortedTiers = [...pricing].sort((a, b) => b.qty - a.qty);
  const applicableTier = sortedTiers.find(tier => tier.qty <= orderQty);
  return applicableTier?.price ?? null;
}
```

**Example:**

Pricing array:

```javascript
[
  { "qty": 1, "price": 50.00 },
  { "qty": 10, "price": 45.00 },
  { "qty": 50, "price": 40.00 },
  { "qty": 100, "price": 35.00 }
]
```

| Order Quantity | Applicable Tier | Unit Price | Total |
|---|---|---|---|
| 5 | qty ≥ 1 | $50.00 | $250.00 |
| 25 | qty ≥ 10 | $45.00 | $1,125.00 |
| 75 | qty ≥ 50 | $40.00 | $3,000.00 |
| 250 | qty ≥ 100 | $35.00 | $8,750.00 |

**PostgreSQL Helper Function:**

```sql
CREATE FUNCTION get_part_price(p_pricing JSONB, p_quantity INT)
RETURNS NUMERIC AS $$
  SELECT (elem->>'price')::numeric
  FROM jsonb_array_elements(p_pricing) elem
  WHERE (elem->>'qty')::int <= p_quantity
  ORDER BY (elem->>'qty')::int DESC
  LIMIT 1;
$$ LANGUAGE sql IMMUTABLE;
```

---

## AI-Powered Bulk Import

**Route:** `/dashboard/{companyId}/parts/import`

Uses the same AI-powered import infrastructure as Customers (see Customers PRD for full details).

### Parts-Specific Flow

1. **Upload CSV** - Parse file, extract headers + first 5 rows

2. **AI Analysis** - AI suggests column mappings with confidence scores

3. **Review Mappings** - Display with confidence indicators

4. **Customer Matching** - Additional step for parts:
  - Match by `customer_code` column in CSV

  - Assign all to specific customer (dropdown)

  - Leave unassigned (generic parts)

1. **Validate** - Check for duplicate part numbers per customer

2. **Execute** - Import with results summary

### Conflict Detection

- **Duplicate part_number** within same customer → Conflict

- **Unmatched customer_code** → Warning (can proceed as generic)

### API Endpoints

- `POST /api/parts/import/analyze` - AI mapping suggestions

- `POST /api/parts/import/validate` - Conflict detection

- `POST /api/parts/import/execute` - Perform import

### Validation Rules

- part_number is required

- part_number must be unique per customer

- If customer_code provided, must match existing customer (or flag as orphan)

---

## Acceptance Criteria

### Core CRUD

- [ ] Can view paginated list of parts

- [ ] Can search parts by number or description

- [ ] Can filter by customer

- [ ] Can filter by active/inactive status

- [ ] Can create new part with customer link

- [ ] Can create generic part (no customer)

- [ ] Can edit existing part

- [ ] Can add/remove unlimited pricing tiers

- [ ] Pricing tiers enforce qty ascending order

- [ ] Can toggle part active/inactive

- [ ] Part number is unique per customer within company

- [ ] Form shows validation errors inline

### AI-Powered Import

- [ ] Can upload CSV file and see preview

- [ ] AI analyzes CSV and suggests column mappings

- [ ] Confidence scores displayed with color coding

- [ ] Can select customer matching strategy

- [ ] Detects duplicate part numbers per customer

- [ ] Flags unmatched customer codes as warnings

- [ ] Can skip conflicts and import valid rows

- [ ] Shows import results: imported, skipped, orphaned

---

## Delete Behavior

Parts can be deleted even if they have related quotes or jobs. When a part is deleted:

- Related quotes will have their part_id set to NULL (orphaned)

- Related jobs will have their part_id set to NULL (orphaned)

A warning is shown in the delete confirmation dialog when the part has related records.
