# Parts Module

## Overview

The Parts module manages the catalog of products/parts that a company manufactures. Parts are **company-wide entities** and are not tied to a specific customer. The customer relationship is expressed through quotes and jobs, not parts. Parts include a category assignment for default markup configuration and can have a routing defining their manufacturing process. If a routing exists, cost is calculated from it (labor + materials). Cost determination happens at quote creation time, not on the part itself.

**Priority:** Must Have (Build Second)

**Dependencies:** None (parts are independent company-wide entities)

**Database Table:** `parts`

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner/Admin | View a list of all parts | I can see our product catalog |
| Owner/Admin | Search parts by part name or description | I can quickly find a specific part |
| Owner/Admin | Create a new part and assign it to a category | I can quote and track new products with default markups |
| Owner/Admin | Edit part information | I can update descriptions or other details |
| Owner/Admin | Manage part categories with default markups | I can standardize markup expectations across similar parts |
| Owner/Admin | Delete a part | I can remove parts we no longer manufacture |
| Owner/Admin | Bulk import parts from CSV | I can migrate from my legacy system |
| Owner/Admin | Create or edit a routing from the part detail page | I can define the manufacturing process for a part |
| Salesperson | Look up part cost and category markup when creating quotes | I can quickly provide accurate quotes |

---

## Data Model

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key (auto-generated) |
| company_id | UUID (FK) | Yes | Link to company (multi-tenant isolation) |
| part_name | Text | Yes | Part number (e.g., "AE36589E-RT") |
| description | Text | No | What the part is (e.g., "Recess Tool Bit") |
| category_id | UUID (FK) | No | Link to part_categories table |
| notes | Text | No | Internal notes |
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes |

**Unique Constraint:** `(company_id, part_name)`

Part names must be unique within a company.

### Part Categories Table (`part_categories`)

Part categories classify parts for default markup configuration during quoting. Each company defines its own categories (e.g., "Precision Machined", "Assemblies", "Tooling"). A typical shop has 5–10 categories.

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key (auto-generated) |
| company_id | UUID (FK) | Yes | Link to company (multi-tenant isolation) |
| name | Text | Yes | Category name (e.g., "Precision Machined", "Assemblies", "Tooling") |
| default_markup_percent | Decimal(5,2) | No | Default markup % applied when quoting parts in this category |
| description | Text | No | Optional description of the category |
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes |

**Unique Constraint:** `(company_id, name)`

### Pricing Tier Migration

The legacy `pricing` JSONB column (quantity-based price tiers) is **replaced** by the cost-plus model. This is a clean break with no deprecation period:

**Migration steps (single migration):**
1. Drop the `pricing` column entirely
2. Drop the `validate_pricing_json` function, `idx_parts_pricing` GIN index, and `parts_valid_pricing` CHECK constraint

**Code changes (same PR):**
- Remove `getUnitPrice`, `calculateUnitPrice`, `sortPricingTiers`, `validatePricingTiers` from `types/part.ts`
- Remove pricing tier rendering from PartForm and QuoteForm
- Remove `PricingTier` interface

---

## UI Screens

### 1. Parts List

**Route:** `/dashboard/{companyId}/parts`

**Features:**

- Table showing: Part Name, Description, Category, Cost (from routing if available)

- Search box (searches part name and description)

- "+ New Part" button

- Click row to view/edit

- Pagination (25 per page)

**Empty State:**

"No parts yet. Create your first part or import from CSV."

### 2. Part Create/Edit

**Route:** `/dashboard/{companyId}/parts/new` or `/dashboard/{companyId}/parts/{id}/edit`

**Form Sections:**

▸ **Basic Information**

- Part Name (required)

- Description

▸ **Category**

- Category dropdown (list of company's part_categories)
  - Shows: category name (default markup %)
  - "+ New Category" quick-create link opens inline modal
  - Optional — parts can exist without a category

▸ **Cost Information**

- If routing exists: "Calculated from routing" (read-only, with cost value)
- If no routing: "No cost data — create a routing to calculate cost"

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

## Cost Determination Logic

A part's cost is determined solely by its routing:

```javascript
function getPartBaseCost(part: Part): number | null {
  if (part.routing) {
    // Calculated from routing — see routings.md for formula
    return calculateRoutingCost(part.routing);
  }
  // No routing — no cost data available
  return null;
}
```

Cost determination happens at **quote creation time**, not on the part itself. When creating a quote for a part, the routing cost (if available) flows into the quote's `base_cost` field and the part category's `default_markup_percent` pre-fills the markup. Parts without a routing have no cost data until a routing is created. See [Quotes Module — Cost-Plus Pricing](quotes.md#cost-plus-pricing-logic) for the full pricing flow.

---

## AI-Powered Bulk Import

**Route:** `/dashboard/{companyId}/parts/import`

Uses the same AI-powered import infrastructure as Customers (see Customers PRD for full details).

### Parts-Specific Flow

1. **Upload CSV** - Parse file, extract headers + first 5 rows

2. **AI Analysis** - AI suggests column mappings with confidence scores

3. **Review Mappings** - Display with confidence indicators

4. **Validate** - Check for duplicate part names within company

5. **Execute** - Import with results summary

### Category Mapping

If the CSV contains a "Category" column, the import will:
- Match existing categories by name (case-insensitive)
- Auto-create new categories for unmatched values (with no default markup — admin sets markups later)

### Conflict Detection

- **Duplicate part_name** within company → Conflict

### API Endpoints

- `POST /api/parts/import/analyze` - AI mapping suggestions

- `POST /api/parts/import/validate` - Conflict detection

- `POST /api/parts/import/execute` - Perform import

### Validation Rules

- part_name is required

- part_name must be unique within the company

---

## Acceptance Criteria

### Core CRUD

- [ ] Can view paginated list of parts

- [ ] Can search parts by number or description

- [ ] Can create new part

- [ ] Can edit existing part

- [ ] Can assign a part to a category

- [ ] Can create a new part category from the part form (quick-create)

- [ ] Category default markup displays on part detail

- [ ] Parts with routings show calculated cost (read-only)

- [ ] Parts without routings show "No cost data" indicator

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

- [ ] Detects duplicate part names within company

- [ ] Can skip conflicts and import valid rows

- [ ] Shows import results: imported, skipped, orphaned

---

## Delete Behavior

Parts can be deleted even if they have related quotes or jobs. When a part is deleted:

- Related quotes will have their part_id set to NULL (orphaned)

- Related jobs will have their part_id set to NULL (orphaned)

A warning is shown in the delete confirmation dialog when the part has related records.
