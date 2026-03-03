# Parts Module

## Overview

The Parts module manages the catalog of products/parts that a company manufactures. Parts are **company-wide entities** and are not tied to a specific customer. The customer relationship is expressed through quotes and jobs, not parts. Parts include pricing information and can have a routing defining their manufacturing process.

**Priority:** Must Have (Build Second)

**Dependencies:** None (parts are independent company-wide entities)

**Database Table:** `parts`

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner/Admin | View a list of all parts | I can see our product catalog |
| Owner/Admin | Search parts by part number or description | I can quickly find a specific part |
| Owner/Admin | Create a new part with pricing tiers | I can quote and track new products |
| Owner/Admin | Edit part information | I can update pricing or descriptions |
| Owner/Admin | Delete a part | I can remove parts we no longer manufacture |
| Owner/Admin | Bulk import parts from CSV | I can migrate from my legacy system |
| Owner/Admin | Create or edit a routing from the part detail page | I can define the manufacturing process for a part |
| Salesperson | Look up part pricing when creating quotes | I can quickly provide accurate quotes |

---

## Data Model

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key (auto-generated) |
| company_id | UUID (FK) | Yes | Link to company (multi-tenant isolation) |
| part_number | Text | Yes | Part number (e.g., "AE36589E-RT") |
| description | Text | No | What the part is (e.g., "Recess Tool Bit") |
| pricing | JSONB | No | Array of quantity-based price tiers (see below) |
| notes | Text | No | Internal notes |
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes |

**Unique Constraint:** `(company_id, part_number)`

Part numbers must be unique within a company.

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

- Table showing: Part Number, Description, Base Price (qty=1)

- Search box (searches part number and description)

- "+ New Part" button

- Click row to view/edit

- Pagination (25 per page)

**Empty State:**

"No parts yet. Create your first part or import from CSV."

### 2. Part Create/Edit

**Route:** `/dashboard/{companyId}/parts/new` or `/dashboard/{companyId}/parts/{id}/edit`

**Form Sections:**

▸ **Basic Information**

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

▸ **Other**

- Notes (multiline)

**Actions:**

- Save → Returns to list

- Cancel → Returns to list without saving

- Delete (edit mode only) → Confirmation dialog

### 3. Part Detail

**Route:** `/dashboard/{companyId}/parts/{id}`

Read-only view showing:

- All part fields

- Related quotes (future)

- Related jobs (future)

- Edit button

▸ **Routing Info Card**

The part detail page includes a routing info card that shows:

- If routing exists: Routing name, number of operations, and an "Edit Routing" button (links to `/dashboard/{companyId}/parts/{id}/routing/edit`)
- If no routing exists: A "Create Routing" button (links to `/dashboard/{companyId}/parts/{id}/routing/new`)

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

4. **Validate** - Check for duplicate part numbers within company

5. **Execute** - Import with results summary

### Conflict Detection

- **Duplicate part_number** within company → Conflict

### API Endpoints

- `POST /api/parts/import/analyze` - AI mapping suggestions

- `POST /api/parts/import/validate` - Conflict detection

- `POST /api/parts/import/execute` - Perform import

### Validation Rules

- part_number is required

- part_number must be unique within the company

---

## Acceptance Criteria

### Core CRUD

- [ ] Can view paginated list of parts

- [ ] Can search parts by number or description

- [ ] Can create new part

- [ ] Can edit existing part

- [ ] Can add/remove unlimited pricing tiers

- [ ] Pricing tiers enforce qty ascending order

- [ ] Can delete a part (hard delete with confirmation)

- [ ] Part number is unique within company

- [ ] Part detail page shows routing info card

- [ ] Can create routing from part detail page if none exists

- [ ] Can edit routing from part detail page if one exists

- [ ] Form shows validation errors inline

### AI-Powered Import

- [ ] Can upload CSV file and see preview

- [ ] AI analyzes CSV and suggests column mappings

- [ ] Confidence scores displayed with color coding

- [ ] Detects duplicate part numbers within company

- [ ] Can skip conflicts and import valid rows

- [ ] Shows import results: imported, skipped, orphaned

---

## Delete Behavior

Parts can be deleted even if they have related quotes or jobs. When a part is deleted:

- Related quotes will have their part_id set to NULL (orphaned)

- Related jobs will have their part_id set to NULL (orphaned)

A warning is shown in the delete confirmation dialog when the part has related records.
