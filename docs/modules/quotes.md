# Quotes Module

## Overview

The Quotes module handles the sales quoting process - the entry point for work into the shop. Quotes capture what a customer wants, at what price, and track whether the customer & the shop owner accepts or declines. Approved quotes convert into Jobs. Quotes use a **cost-plus pricing model** where the quoted price is derived from base cost plus a margin percentage.

**Priority:** Must Have (Build Third)

**Dependencies:**

- Customers module (quotes require a customer)

- Parts module (quotes reference parts)

**Database Table:** `quotes`

---

## Quote Status Workflow

```javascript
   DRAFT
     │
     ▼
 PENDING APPROVAL  ───────────▶  REJECTED
     │
     ▼
  APPROVED
     │
     ▼
━━━━━━━━━━━━━━━━━━
 Convert to Job
━━━━━━━━━━━━━━━━━━
```

**Status Definitions:**

- **Draft** - Quote is being prepared, not yet sent to customer

- Pending Approval - Quote has been sent to Customer & Shop Owner, awaiting response

- **Approved** - Customer & Shop Owner Approved the quote, ready to convert to job

- Rejected - Customer or Shop Owner Rejected the quote

- **Expired** - Quote passed its valid_until date without response

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Salesperson | Create a quote for a customer | I can respond to customer inquiries |
| Salesperson | Select an existing part and see its cost with a default margin | I can quickly quote repeat orders |
| Salesperson | Enter an ad-hoc part for one-off jobs | I can quote new work without creating a part first |
| Salesperson | Mark a quote as sent for approval | I can track that the customer has received it |
| Salesperson | Mark a quote as Approved or Rejected | I can track the outcome |
| Salesperson | Convert an Approved quote to a job | Production can begin on the work |
| Owner | View all open quotes | I can see the sales pipeline |
| Owner | Filter quotes by status and customer | I can focus on specific opportunities |
| Owner | Approve or reject quotes | Work can be started on quotes or quotes can be sent back to sales people for revision |

---

## Data Model

| Field | Type | Required | Description |
|---|---|---|---|
| quote_number | Text | Auto | Auto-generated: Q-0001, Q-0002, etc. |
| legacy_quote_number | Text | No | Original quote number from legacy system (for migrated quotes) |
| customer_id | UUID (FK) | Yes | Link to customer |
| part_id | UUID (FK) | No | Link to existing part (optional) |
| part_number_text | Text | No | Ad-hoc part number (when part_id is null) |
| description | Text | No | Part/job description |
| quantity | Integer | Yes | Number of units quoted |
| base_cost | Decimal(12,4) | No | Cost per unit (from routing calculation or manual entry) |
| cost_source | Text | No | How base_cost was determined: 'routing', 'manual', 'estimate' |
| margin_percent | Decimal(5,2) | No | Margin percentage (pre-filled from part category, overridable) |
| estimated_labor_cost | Decimal(12,4) | No | Labor cost breakdown from routing (for display) |
| estimated_material_cost | Decimal(12,4) | No | Material cost breakdown from routing (for display) |
| unit_price | Decimal | No | Price per unit (derived: `base_cost / (1 - margin_percent / 100)`, or directly entered) |
| total_price | Decimal | No | Total quoted price (quantity × unit_price) |
| estimated_lead_time_days | Integer | No | Estimated days to complete |
| valid_until | Date | No | Quote expiration date |
| status | Text | Yes | draft, pending approval, approved, rejected, expired |
| converted_to_job_id | UUID (FK) | No | Link to job when converted |
| converted_at | Timestamp | No | When quote was converted to job |
| notes | Text | No | Internal notes |

**Snapshot Behavior:** `base_cost`, `cost_source`, `margin_percent`, `estimated_labor_cost`, and `estimated_material_cost` are **snapshot fields** — copied from the part/routing at quote creation time. They do NOT auto-update if the part's routing changes later. Draft quotes for affected parts may show a "cost may be outdated" indicator, but the stored values remain frozen until the user explicitly refreshes them.

---

## UI Screens

### 1. Quotes List

**Route:** `/dashboard/{companyId}/quotes`

**Features:**

- Table showing: Quote #, Customer, Part, Quantity, Total, Status, Created

- Search box (searches quote number, customer name, part number)

- Filter dropdown: Status (All / Draft / Pending Approval / Approved / Rejected)

- Filter dropdown: Customer (All / specific customer)

- "+ New Quote" button

- Click row to view/edit

- Pagination (25 per page)

**Row Actions (icon buttons):**

- Edit (pencil) - only for Draft status

- Convert to Job (play icon) - only for Approved status

**Status Pills:**

- Draft = Gray

- Pending Approval = Blue

- Approved = Green

- Rejected = Red

- Expired = Orange

**Empty State:**

"No quotes yet. Create your first quote to get started."

### 2. Quote Create/Edit

**Route:** `/dashboard/{companyId}/quotes/new` or `/dashboard/{companyId}/quotes/{id}/edit`

**Note:** Edit only available for Draft status quotes.

**Form Sections:**

▸ **Customer** (required)

- Customer dropdown with search

- Shows: customer name (customer code)

▸ **Part**

- Radio: ○ Existing Part  ○ New/Ad-hoc Part

- If Existing Part:
  - Part dropdown (all company parts, independent of selected customer)

  - Shows: part number - description

  - Auto-fills description and suggests pricing

- If Ad-hoc Part:
  - Part Number text field

  - Description text field

▸ **Cost & Pricing**

- Quantity (required, number input)

- Base Cost per Unit
  - If part has routing: auto-populated, read-only, shows "Calculated from routing" label
  - If no routing: editable field for manual entry
  - Expandable cost breakdown when cost_source is 'routing': Labor by operation + Materials subtotal

- Cost Source (read-only indicator: "From routing" / "Manual" / "Estimate")

- Margin % (pre-filled from part's category default, editable)
  - Hint: "Default: 35% (Precision Machined)" showing source category

- Unit Price (calculated from cost + margin, editable for bidirectional editing)

- Total Price (calculated: quantity × unit_price, display only)

**Bidirectional Editing:**
- User edits Margin % → Unit Price recalculates
- User edits Unit Price → Margin % back-calculates
- Base Cost stays anchored (only changes if routing changes or user edits manual cost)

▸ **Timeline**

- Estimated Lead Time (days)

- Valid Until (date picker)

▸ **Notes**

- Notes (multiline)

**Actions:**

- Save as Draft → Returns to list

- Cancel → Returns to list without saving

### 3. Quote Detail View

**Route:** `/dashboard/{companyId}/quotes/{id}`

**Header:**

- Quote number (large)

- Status pill

- Created date

**Content:**

- Customer (link to customer)

- Part info (link to part if exists)

- **Cost & Pricing:**
  - Base Cost per Unit with cost source indicator ("From routing" / "Manual" / "Estimate")
  - Cost breakdown (expandable: labor by operation + materials) when cost_source is 'routing'
  - Margin % with source hint ("Category default" or "Custom override")
  - Unit Price, Quantity, Total Price
  - If part's routing has changed since quote creation: subtle "Cost may be outdated" indicator with "Refresh cost" action (available on draft/rejected quotes only)

- Lead time, Valid until

- Notes

**Actions (based on status):**

| Current Status | Available Actions |
|---|---|
| Draft | Edit, Mark as Sent for Approval, Delete |
| Pending Approval | Mark as Approved, Mark as Rejected |
| Approved | Convert to Job |
| Rejected | (none - read only) |
| Expired | (none - read only) |

### 4. Convert to Job Modal

**Trigger:** Click "Convert to Job" on Approved quote

**Prerequisite:** The quote must reference a part (part_id is not null) and that part must have a routing defined. If the part has no routing, the conversion is blocked and a message is shown with a link to create a routing from the part detail page.

**Modal Content:**

- Summary: "Create job from Quote Q-0042?"

- Customer: [display]

- Part: [display]

- Quantity: [display]

- **Due Date** (date picker, optional)

- **Priority** (dropdown: Low / Normal / High / Rush, default: Normal)

- Additional Notes (optional)

**Note:** Routing is auto-resolved from the part. There is no routing selection in this modal.

**Actions:**

- Create Job → Creates job (routing auto-resolved from part), redirects to job detail

- Cancel → Closes modal

---

## Quick Create: Inline Customer & Part Creation

To streamline the quoting workflow, users can create new customers and parts directly from the quote form without navigating away. This keeps the user in context and enables rapid quote creation for new business.

### User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Salesperson | Create a new customer while creating a quote | I don't lose my quote context when a new customer calls |
| Salesperson | Create a new part while creating a quote | I can quote new work immediately without switching screens |
| Salesperson | See the newly created customer/part auto-selected | I can continue creating the quote seamlessly |

### UI Implementation

### Customer Quick Create

**Trigger:** "+ New Customer" button next to customer dropdown

**Modal: Quick Create Customer**

```javascript
┌─────────────────────────────────────────────┐
│  Quick Create Customer                   ✕  │
├─────────────────────────────────────────────┤
│                                             │
│  Customer Code *    [____________]          │
│  Customer Name *    [____________]          │
│                                             │
│  ─────── Optional ───────                   │
│  Contact Name       [____________]          │
│  Contact Email      [____________]          │
│  Contact Phone      [____________]          │
│                                             │
│           [Cancel]  [Create Customer]       │
└─────────────────────────────────────────────┘
```

**Behavior:**

1. User clicks "+ New Customer" button

2. Modal opens with minimal required fields (code, name)

3. Optional fields collapsed or shown below divider

4. On success:
  - Modal closes

  - New customer auto-selected in dropdown

  - Toast: "Customer created successfully"

1. On error: Show inline validation errors

**Required Fields:**

- Customer Code (unique within company)

- Customer Name

**Optional Fields (for quick entry):**

- Contact Name

- Contact Email

- Contact Phone

> **Note:** Full customer details (address, website, etc.) can be added later by editing the customer record.

### Part Quick Create

**Trigger:** "+ New Part" button next to part dropdown (only visible when "Existing Part" is selected)

**Modal: Quick Create Part**

```javascript
┌─────────────────────────────────────────────┐
│  Quick Create Part                       ✕  │
├─────────────────────────────────────────────┤
│                                             │
│  Part Number *      [____________]          │
│  Description        [____________]          │
│                                             │
│  ─────── Category ───────                   │
│  Category           [Dropdown    ▼]         │
│                                             │
│  ─────── Cost (Optional) ───────            │
│  Manual Cost/Unit   [$__________]           │
│                                             │
│           [Cancel]  [Create Part]           │
└─────────────────────────────────────────────┘
```

**Behavior:**

1. User clicks "+ New Part" button

2. Modal opens

3. On success:
  - Modal closes

  - New part auto-selected in dropdown

  - If category selected, margin pre-fills from category default

  - If manual cost entered, it populates the quote's base_cost field (cost_source = 'manual')

  - Toast: "Part created successfully"

4. On error: Show inline validation errors

**Required Fields:**

- Part Number (unique within company)

**Optional Fields (for quick entry):**

- Description

- Category (dropdown of existing part_categories)

- Manual Cost per Unit (sets base cost for the quote)

> **Note:** Full part details, routing, and category assignment can be added later by editing the part record.

### Updated Quote Form Layout

```javascript
▸ Customer (required)
  ┌─────────────────────────────────────┐
  │ [Customer Dropdown      ▼]  [+ New] │
  └─────────────────────────────────────┘

▸ Part
  ○ Existing Part  ○ New/Ad-hoc Part

  If Existing Part:
  ┌─────────────────────────────────────┐
  │ [Part Dropdown          ▼]  [+ New] │  ← All company parts (independent of customer)
  └─────────────────────────────────────┘

  If Ad-hoc Part:
  [Part Number field]
  [Description field]
```

### Edge Cases

| Scenario | Behavior |
|---|---|
| Quick create customer with duplicate code | Show error: "Customer code already exists" |
| Quick create part with duplicate part number | Show error: "Part number already exists in this company" |
| Modal closed without saving | Form state preserved, no changes made |
| Network error during creation | Show error, keep modal open for retry |

### Acceptance Criteria (Quick Create)

- [ ] "+ New Customer" button visible next to customer dropdown

- [ ] Quick Create Customer modal opens with required fields

- [ ] New customer auto-selected after creation

- [ ] "+ New Part" button visible when "Existing Part" is selected

- [ ] Quick Create Part modal opens with category dropdown and manual cost field

- [ ] New part auto-selected after creation

- [ ] Manual cost from quick create flows to quote base_cost

- [ ] Category from quick create pre-fills quote margin

- [ ] Validation errors display inline in modals

- [ ] Success toast shown after creation

---

## Cost-Plus Pricing Logic

When a user selects an existing part and enters quantity:

1. **Determine base cost:**
   - If part has a routing: auto-calculate from routing operations (see [Routings — Cost Calculation](routings.md#cost-calculation-from-routing))
   - If part has `manual_cost`: use that value
   - If neither: leave blank for user to enter manually

2. **Apply margin default:**
   - Look up part's category → `default_margin_percent`
   - Pre-fill `margin_percent` field
   - If part has no category, margin is blank (user must enter)

3. **Calculate unit price:**
   ```
   unit_price = base_cost / (1 - margin_percent / 100)
   ```

4. **Calculate total price:**
   ```
   total_price = quantity × unit_price
   ```

### Bidirectional Editing

Users can edit pricing from two directions — the system keeps cost, margin, and price in sync:

- **Edit margin_percent** → `unit_price` recalculates, `total_price` recalculates
- **Edit unit_price** → `margin_percent` back-calculates: `margin = (unit_price - base_cost) / unit_price × 100`
- **base_cost stays anchored** — it only changes if the routing changes or the user explicitly edits it (manual/estimate cost source)

### Cost Source Display

| cost_source | UI Display | Editable? |
|---|---|---|
| `routing` | "Calculated from routing" with expandable breakdown | Base cost read-only |
| `manual` | "Manual entry" | Base cost editable |
| `estimate` | "Estimate" with warning indicator | Base cost editable |
| `null` | "No cost data — enter base cost to continue" | Base cost editable |

### Example

- Part "AE36589E-RT" has a routing with total cost = $103.25
- Part category "Precision Machined" has default margin = 35%
- User enters quantity: 50

System auto-fills:
- Base Cost: $103.25 (from routing)
- Margin: 35% (from category)
- Unit Price: $103.25 / (1 - 0.35) = $158.85
- Total Price: 50 × $158.85 = $7,942.31

---

## Status Transition Rules

| From | To | Trigger |
|---|---|---|
| Draft | Pending Approval | User clicks "Send for Approval" |
| Draft | Deleted | User clicks "Delete" |
| Pending Approval | Approved | User clicks "Mark as Approved" |
| Pending Approval | Rejected | User clicks "Mark as Rejected" |
| Pending Approval | Expired | System auto-expires past valid_until (future feature) |
| Approved | (converted) | User clicks "Convert to Job" |

**Note:** Once a quote leaves Draft status, it cannot be edited. Create a new quote instead.

---

## Convert to Job Function

When converting quote to job:

1. Validate quote status is "Approved"

2. Validate quote not already converted

3. Create new job with:
  - customer_id from quote

  - part_id from quote

  - part_number_text from quote (if ad-hoc)

  - description from quote

  - quantity_ordered from quote.quantity

  - due_date from modal input

  - priority from modal input

  - status = "pending"

  - quote_id = link back to quote

1. Update quote:
  - converted_to_job_id = new job id

  - converted_at = now

1. Redirect to job detail page

---

## API Architecture

**All Operations → Direct Supabase Calls**

The Quotes module uses direct Supabase calls from the frontend (via `utils/quotesAccess.ts`) for all operations:

- CRUD operations

- Status transitions (draft → Pending Approval → Approved/Rejected)

- Convert to Job

This follows the same pattern as Customers, Parts, and Operations:

- Avoids Vercel serverless cold starts

- Leverages Supabase RLS for security

- Simpler, faster for all operations

**No FastAPI endpoints needed** - there are no AI-powered features in Phase 0 Quotes.

---

## Acceptance Criteria

### Core Functionality

- [ ] Can view paginated list of quotes

- [ ] Can search quotes by number, customer, part

- [ ] Can filter by status

- [ ] Can filter by customer

- [ ] Can create new quote with existing part

- [ ] Can create new quote with ad-hoc part

- [ ] Base cost auto-populates from routing when part has a routing

- [ ] Base cost uses manual_cost when part has no routing

- [ ] Margin pre-fills from part's category default_margin_percent

- [ ] Editing margin recalculates unit price (bidirectional)

- [ ] Editing unit price back-calculates margin (bidirectional)

- [ ] Base cost is read-only when cost_source is 'routing'

- [ ] Cost breakdown (labor + materials) shown for routing-based costs

- [ ] Cost source indicator displayed on quote form

- [ ] Total price calculates automatically

- [ ] Can save quote as draft

- [ ] Can mark draft as sent for approval

- [ ] Can mark pending approval quote as Approved or Rejected

- [ ] Can convert Approved quote to job

- [ ] Converted quote shows link to created job

- [ ] Quote number auto-generates (Q-0001 format)

- [ ] Cannot edit quotes that are not in draft status

### Quick Create

- [ ] "+ New Customer" button visible next to customer dropdown

- [ ] Quick Create Customer modal creates customer with minimal fields

- [ ] New customer auto-selected in dropdown after creation

- [ ] "+ New Part" button visible when "Existing Part" is selected

- [ ] Quick Create Part modal opens without customer dependency

- [ ] New part auto-selected in dropdown after creation

- [ ] Manual cost from quick create flows to quote base_cost field

- [ ] Category from quick create pre-fills margin on quote

- [ ] Validation errors display inline in modals

- [ ] Success toast notifications after creation

---

## Routing-Based Cost Calculation

When a part has a routing, the base cost is automatically calculated. See [Routings Module — Cost Calculation](routings.md#cost-calculation-from-routing) for the detailed formula.

### Summary

```
base_cost = labor_cost + material_cost
labor_cost = Σ (node.run_time_per_unit / 60 × operation_type.labor_rate)
material_cost = Σ (node.materials[].quantity × inventory_item.cost_per_unit)
```

### Cost Breakdown Display

The quote form shows an expandable cost breakdown when cost_source is 'routing':

| Operation | Time/Unit | Rate | Cost |
|---|---|---|---|
| CNC Mill | 0.5 hr | $135/hr | $67.50 |
| Deburr | 0.25 hr | $90/hr | $22.50 |
| Inspect | 0.1 hr | $95/hr | $9.50 |
| **Labor Subtotal** | | | **$99.50** |
| 6061 Aluminum (0.5 lbs) | | | $3.75 |
| **Material Subtotal** | | | **$3.75** |
| **Total Base Cost** | | | **$103.25** |

### When Routing Changes After Quote Creation

Quote cost fields are snapshots (frozen at creation time). If a part's routing is updated after a quote was created:

- **Draft/Rejected quotes:** Show a subtle "Cost may be outdated" indicator with a "Refresh cost" button that re-fetches the routing cost and updates the snapshot fields
- **Pending Approval/Approved/Converted quotes:** No indicator — the quoted price stands as agreed

### Acceptance Criteria (Routing Cost)

- [ ] Quotes for parts with routings show cost breakdown (labor by operation + materials)

- [ ] Labor cost calculated from routing node run times × operation type labor rates

- [ ] Material cost calculated from routing node materials × inventory item costs

- [ ] Quote detail page displays margin %, base cost, cost source, and cost breakdown

- [ ] Quote detail page shows "cost may be outdated" when part routing has changed since quote creation

- [ ] "Refresh cost" button updates draft/rejected quote cost from current routing

---

## File Attachments

Quotes support PDF file attachments for drawings, specifications, and other documents.

**Attachment Limits:**

- Maximum 5 attachments per quote

- Maximum file size: 50MB per file

- Allowed file types: PDF only

**Behavior:**

- Attachments can only be added/modified in Draft or Rejected status

- Multiple files can be uploaded at once via drag-and-drop or file picker

- When quote is converted to a job, attachments are automatically copied to the job

---

## Quote Attachments

Quotes support PDF file attachments for customer drawings, specifications, or related documents.

**Constraints:**

- File type: PDF only

- Maximum size: 50MB per file

- Maximum count: 5 attachments per quote

**Operations:**

- Upload via drag-and-drop or file picker

- Download via signed URL

- Replace existing attachment

- Delete attachment (draft/rejected quotes only)

**Job Conversion:** First attachment is automatically copied to the job when converting.

---

## Inline Entity Creation

While creating/editing a quote, users can create new entities without leaving the form:

- **"Create New Customer"** option in customer dropdown - opens modal

- **"Create New Part"** option in part dropdown - opens modal (parts are company-wide, no customer pre-selection)

- Newly created entity is automatically selected

---

## Search and Filter

**Search:** Full-text search on quote number and description (toolbar input)

**Filters:**

- Status dropdown: All, Draft, Pending Approval, Approved, Rejected

- Customer dropdown: All or specific customer

**Sorting:** Click any column header to sort

---

## Validation Rules

**Customer:** Required

**Part:** Required if "Existing Part" selected

**Quantity:** Integer, 1 to 1,000,000

**Base Cost:** Decimal, 0 to 999,999.9999 (optional, but required before leaving draft)

**Margin Percent:** Decimal, -100 to 100 (negative margins allowed for loss-leader quotes)

**Unit Price:** Decimal, 0 to 999,999.99 (optional)

**Description:** Max 5,000 characters

---

## Pricing Integration

When selecting an existing part:

- Base cost auto-populates from routing calculation or manual_cost

- Margin pre-fills from the part's category `default_margin_percent`

- Unit price calculated: `base_cost / (1 - margin_percent / 100)`

- Total price calculated: `quantity × unit_price`

- Cost breakdown (labor + materials) shown if cost_source is 'routing'

---

## Status Workflow Updates

**Editing Rule:** Only Draft and Rejected quotes can be edited

**Re-submit:** Rejected quotes can be edited and re-submitted for approval (rejected → pending_approval)

**Note:** The "Expired" status is available for manual use but there is no automatic expiration logic implemented.

---

## Convert to Job Details

When converting an approved quote to a job:

**User Input:**

- Due date (optional date picker)

- Priority: low, normal, high, rush

**Job Created With:**

- status = pending

- quantity_ordered = quote quantity

- quantity_completed = 0

- quantity_scrapped = 0

- First attachment copied to job_attachments table

**Quote Updated:**

- converted_to_job_id set to new job ID

- converted_at set to current timestamp

---

## Additional Data Model Fields

These additional fields exist in the quotes table:

- `status_changed_at` (timestamp) - When status last changed

- `converted_to_job_id` (uuid FK) - Reference to job if converted

- `converted_at` (timestamp) - When converted to job

The `quote_attachments` table stores file attachments:

- id, quote_id, company_id - Primary and foreign keys

- file_name, file_path, file_size, mime_type - File metadata

- uploaded_by, uploaded_at - Audit fields
