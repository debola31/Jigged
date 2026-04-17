# Quotes Module

## Overview

The Quotes module handles the sales quoting process — the entry point for work into the shop. Quotes capture what a customer wants, at what price, and when they need it. A quote can be converted directly into a job at any time; there is no separate approval step. Quotes use a **cost-plus pricing model** where the quoted price is derived from base cost plus a markup percentage, with an optional override.

**Priority:** Must Have (Build Third)

**Dependencies:**

- Customers module (quotes require a customer)

- Parts module (quotes reference parts)

**Database Table:** `quotes` (plus `quote_operations`, `quote_materials`, `quote_attachments`)

---

## Quote Status Workflow

```
 ACTIVE ──(date > expiration_date)──▶ EXPIRED
   │                                     │
   └──────────── Convert to Job ─────────┘
                     │
                     ▼
              (quote stays in its status;
               converted_to_job_id set)
```

**Status Definitions:**

- **Active** — the quote is open. Editable, attachable, convertible.
- **Expired** — past `expiration_date`. Read-only, but can still be converted with a warning (the price is no longer guaranteed).

**Conversion flag:** `converted_to_job_id` is set when the quote becomes a job. It is *not* a status — a quote can be `active` + `converted`, or `expired` + `converted`.

The pending-approval / approved / rejected states were removed in April 2026. For small shops the salesperson and the approver are the same person; the state machine added friction without adding value.

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Salesperson | Create a quote for a customer | I can respond to customer inquiries |
| Salesperson | Select an existing part and see its cost with a default markup | I can quickly quote repeat orders |
| Salesperson | Set a lead time and expiration date | The customer knows when and for how long |
| Salesperson | Expand a cost breakdown to see per-op / per-material costs | I can explain the price if asked |
| Salesperson | Override the unit price on top of the computed cost | I can adjust for one-off negotiations |
| Salesperson | Convert a quote directly to a job | Production can begin without a ceremony step |
| Owner | View all active quotes | I can see the sales pipeline |
| Owner | Filter quotes by active/expired and customer | I can focus on what's still live |
| Owner | See when a quote was overridden off the base + markup | I know the markup wasn't just blindly adjusted |

---

## Data Model

| Field | Type | Required | Description |
|---|---|---|---|
| quote_number | Text | Auto | Auto-generated: Q-0001, Q-0002, etc. |
| legacy_quote_number | Text | No | Original quote number from legacy system (for migrated quotes) |
| customer_id | UUID (FK) | Yes | Link to customer |
| part_id | UUID (FK) | No | Link to existing part (optional) |
| quantity | Integer | Yes | Number of units quoted |
| base_cost | Decimal(12,4) | No | Cost per unit (from routing calculation at creation time) |
| markup_percent | Decimal(5,2) | No | Markup percentage (pre-filled from part category, overridable) |
| estimated_labor_cost | Decimal(12,4) | No | Rolled-up labor cost from routing (snapshot) |
| estimated_material_cost | Decimal(12,4) | No | Rolled-up material cost from routing (snapshot) |
| unit_price | Decimal | No | Price per unit. Defaults to `base_cost × (1 + markup_percent / 100)` but can be overridden |
| total_price | Decimal | No | `quantity × unit_price` |
| lead_time_days | Integer | No | Days to deliver; copied to `jobs.lead_time_days` on conversion |
| expiration_date | Date | No | When the quoted price stops being honored. Defaults to `created_at + 10 days` |
| status | Text | Yes | `active` or `expired` |
| converted_to_job_id | UUID (FK) | No | Link to job when converted |
| converted_at | Timestamp | No | When the quote was converted to a job |

**Note:** The free-text `description` field was removed in April 2026. The part itself carries descriptive detail; the quote no longer needs a separate narrative.

### Cost Breakdown Snapshots

`quote_operations` and `quote_materials` are per-row snapshots of the part's routing taken at quote creation. They are immutable after creation so the breakdown survives later routing edits. Columns roughly mirror `calculateRoutingCost()`'s output: operation name, run/setup minutes, labor rate, computed run/setup cost; material name, quantity, unit, cost-per-unit, line cost.

Snapshots are refreshed if the user edits the quote and changes `part_id`, `base_cost`, or `markup_percent`. Other edits (e.g. changing only the quantity) preserve the snapshot.

---

## UI Screens

### 1. Quotes List

**Route:** `/dashboard/{companyId}/quotes`

**Features:**

- Table showing: Quote #, Customer, Part, Quantity, Total, Status, Created

- Search box (searches quote number, customer name, part name)

- Filter dropdown: Status (All / Pending Approval / Approved / Rejected)

- Filter dropdown: Customer (All / specific customer)

- "+ New Quote" button

- Click row to view/edit

- Pagination (25 per page)

**Row Actions (icon buttons):**

- Edit (pencil) - only for Pending Approval or Rejected status

- Convert to Job (play icon) - only for Approved status

**Status Pills:**

- Pending Approval = Blue

- Approved = Green

- Rejected = Red

- Expired = Orange

**Empty State:**

"No quotes yet. Create your first quote to get started."

### 2. Quote Create/Edit

**Route:** `/dashboard/{companyId}/quotes/new` or `/dashboard/{companyId}/quotes/{id}/edit`

**Note:** Edit only available for Pending Approval or Rejected status quotes.

**Form Sections:**

▸ **Customer** (required)

- Customer dropdown with search

- Shows: customer name (customer code)

▸ **Part**

- Radio: ○ Existing Part  ○ New/Ad-hoc Part

- If Existing Part:
  - Part dropdown (all company parts, independent of selected customer)

  - Shows: part name - description

  - Auto-fills description and suggests pricing

- If Ad-hoc Part:
  - Part Name text field

  - Description text field

▸ **Cost & Pricing**

- Quantity (required, number input)

- Base Cost per Unit
  - If part has routing: auto-populated from routing calculation, but editable (user can override)
  - If no routing: starts at $0.00, editable field for user to enter an estimate
  - Expandable cost breakdown when auto-populated from routing: Labor by operation + Materials subtotal

- Markup % (pre-filled from part's category default when part has a routing, editable)
  - Hint: "Default: 35% (Precision Machined)" showing source category

- Unit Price (calculated from cost + markup, editable for bidirectional editing)

- Total Price (calculated: quantity × unit_price, display only)

**Bidirectional Editing:**
- User edits Markup % → Unit Price recalculates
- User edits Unit Price → Markup % back-calculates
- Base Cost is always editable (can override routing-calculated value)

▸ **Timeline**

- Estimated Lead Time (days)

- Valid Until (date picker)

▸ **Notes**

- Notes (multiline)

**Actions:**

- Send for Approval → Goes to quote detail

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
  - Base Cost per Unit
  - Cost breakdown (expandable: labor by operation + materials) when routing data was captured
  - Markup % with source hint ("Category default" or "Custom override")
  - Unit Price, Quantity, Total Price

- Lead time, Valid until

- Notes

**Actions (based on status):**

| Current Status | Available Actions |
|---|---|
| Pending Approval | Edit, Mark as Approved, Mark as Rejected |
| Approved | Convert to Job |
| Rejected | Edit |
| Expired | (none - read only) |

**Print PDF** lives in the top-right page toolbar (opposite the "Back to Quotes" link) and is available in every status. It generates a single-page, customer-facing PDF (`Quote-{quote_number}.pdf`). See [Printing Quotes](#printing-quotes) below.

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
│  Part Name *      [____________]          │
│  Description        [____________]          │
│                                             │
│  ─────── Category ───────                   │
│  Category           [Dropdown    ▼]         │
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

  - If category selected, markup pre-fills from category default

  - Toast: "Part created successfully"

4. On error: Show inline validation errors

**Required Fields:**

- Part Name (unique within company)

**Optional Fields (for quick entry):**

- Description

- Category (dropdown of existing part_categories)

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
  [Part Name field]
  [Description field]
```

### Edge Cases

| Scenario | Behavior |
|---|---|
| Quick create customer with duplicate code | Show error: "Customer code already exists" |
| Quick create part with duplicate part name | Show error: "Part number already exists in this company" |
| Modal closed without saving | Form state preserved, no changes made |
| Network error during creation | Show error, keep modal open for retry |

### Acceptance Criteria (Quick Create)

- [ ] "+ New Customer" button visible next to customer dropdown

- [ ] Quick Create Customer modal opens with required fields

- [ ] New customer auto-selected after creation

- [ ] "+ New Part" button visible when "Existing Part" is selected

- [ ] Quick Create Part modal opens with category dropdown

- [ ] New part auto-selected after creation

- [ ] Category from quick create pre-fills quote markup

- [ ] Validation errors display inline in modals

- [ ] Success toast shown after creation

---

## Cost-Plus Pricing Logic

When a user selects an existing part and enters quantity:

1. **Determine base cost:**
   - If part has a routing: auto-populate from routing calculation (see [Routings — Cost Calculation](routings.md#cost-calculation-from-routing)), but the user can override the value
   - If part has no routing: base_cost starts at $0.00 and the user enters an estimate

2. **Apply markup:**
   - Look up part's category → `default_markup_percent`, pre-fill `markup_percent` field
   - If part has no category, markup is blank (user must enter)
   - Markup is applied to all quotes: `unit_price = base_cost × (1 + markup_percent / 100)`

3. **Calculate unit price:**
   ```
   unit_price = base_cost × (1 + markup_percent / 100)
   ```

4. **Calculate total price:**
   ```
   total_price = quantity × unit_price
   ```

### Markup Editing

During quote creation, the salesperson sees the pre-calculated unit price but cannot edit markup directly. The owner/approver can adjust markup during the approval step (`pending_approval` status), which recalculates the unit price.

### Example (part with routing)

- Part "AE36589E-RT" has a routing with total cost = $103.25
- Part category "Precision Machined" has default markup = 35%
- User enters quantity: 50

System auto-fills:
- Base Cost: $103.25 (from routing — user can override)
- Markup: 35% (from category default)
- Unit Price: $103.25 × (1 + 0.35) = $139.39
- Total Price: 50 × $139.39 = $6,969.50

**Example (part without routing):**
- Part "WIDGET-01" has no routing
- User enters base cost estimate: $50.00, markup: 20%, quantity: 10
- Unit Price: $50.00 × (1 + 0.20) = $60.00
- Total Price: 10 × $60.00 = $600.00

---

## Status Transition Rules

| From | To | Trigger |
|---|---|---|
| New Quote | Pending Approval | User clicks "Send for Approval" on creation form |
| Pending Approval | Approved | User clicks "Mark as Approved" |
| Pending Approval | Rejected | User clicks "Mark as Rejected" |
| Pending Approval | Expired | System auto-expires past valid_until (future feature) |
| Approved | (converted) | User clicks "Convert to Job" |

**Note:** Pending Approval or Rejected quotes can be edited. Approved, Converted, and Expired quotes cannot be edited.

---

## Convert to Job Function

When converting quote to job:

1. Validate quote status is "Approved"

2. Validate quote not already converted

3. Create new job with:
  - customer_id from quote

  - part_id from quote

  - part_name_text from quote (if ad-hoc)

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

- Status transitions (Pending Approval → Approved/Rejected)

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

- [ ] Base cost auto-populates from routing when part has a routing (but can be overridden)

- [ ] Base cost starts at $0 when part has no routing

- [ ] Markup pre-fills from part's category default_markup_percent

- [ ] Editing markup recalculates unit price (bidirectional)

- [ ] Editing unit price back-calculates markup (bidirectional)

- [ ] Cost breakdown (labor + materials) shown when routing data was captured

- [ ] Total price calculates automatically

- [ ] Quote goes directly to Pending Approval on creation

- [ ] Can mark pending approval quote as Approved or Rejected

- [ ] Can convert Approved quote to job

- [ ] Converted quote shows link to created job

- [ ] Quote number auto-generates (Q-0001 format)

- [ ] Cannot edit quotes that are not in Pending Approval or Rejected status

### Quick Create

- [ ] "+ New Customer" button visible next to customer dropdown

- [ ] Quick Create Customer modal creates customer with minimal fields

- [ ] New customer auto-selected in dropdown after creation

- [ ] "+ New Part" button visible when "Existing Part" is selected

- [ ] Quick Create Part modal opens without customer dependency

- [ ] New part auto-selected in dropdown after creation

- [ ] Category from quick create pre-fills markup on quote

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

The quote form shows an expandable cost breakdown when routing data was captured at creation:

| Operation | Time/Unit | Rate | Cost |
|---|---|---|---|
| CNC Mill | 0.5 hr | $135/hr | $67.50 |
| Deburr | 0.25 hr | $90/hr | $22.50 |
| Inspect | 0.1 hr | $95/hr | $9.50 |
| **Labor Subtotal** | | | **$99.50** |
| 6061 Aluminum (0.5 lbs) | | | $3.75 |
| **Material Subtotal** | | | **$3.75** |
| **Total Base Cost** | | | **$103.25** |

### Immutability After Creation

Quote cost fields are immutable snapshots frozen at creation time. If a part's routing is updated after a quote was created, the quote's cost data is not affected. To quote at a new cost, the user creates a new quote.

### Acceptance Criteria (Routing Cost)

- [ ] Quotes for parts with routings show cost breakdown (labor by operation + materials)

- [ ] Labor cost calculated from routing node run times × operation type labor rates

- [ ] Material cost calculated from routing node materials × inventory item costs

- [ ] Quote detail page displays markup %, base cost, and cost breakdown

---

## Printing Quotes

Quote detail pages include a **Print PDF** button that generates a single-page, customer-facing PDF locally in the browser (no server round-trip).

**What the PDF contains:**

- Company logo (if uploaded in Settings → Company Branding) and company name in the header
- Large "QUOTE" heading with the quote number, date, and status
- **Bill To** block — customer name, contact person, address, phone, and email (pulled from the customer record; missing fields are skipped cleanly)
- Line-item table — part name, description, quantity, unit price, total
- Bottom-line total
- Notes section — the quote's description field, if present
- Footer with generation date and page number

**Intentionally excluded** (kept off the customer's view):

- Routing / operations / run times
- Labor and material cost snapshots
- Markup percentage and base cost

**Filename:** `Quote-{quote_number}.pdf`

**Branding:** Upload your logo at `/dashboard/{companyId}/settings` (admin-only, Company Branding card). PNG, JPG, or WebP up to 2 MB. SVGs are accepted for storage but currently fall back to a text-only header in the PDF — use a raster format for logos that should appear. If no logo is uploaded, the PDF renders with the company name only.

**Immutability:** The PDF reflects the quote's current saved state. Because quotes are immutable cost snapshots after creation (see [Routing-Based Cost Calculation](#immutability-after-creation)), the printed PDF is a faithful record of the price the customer was quoted.

---

## File Attachments

Quotes support PDF file attachments for drawings, specifications, and other documents.

**Attachment Limits:**

- Maximum 5 attachments per quote

- Maximum file size: 50MB per file

- Allowed file types: PDF only

**Behavior:**

- Attachments can only be added/modified in Pending Approval or Rejected status

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

- Delete attachment (pending approval/rejected quotes only)

**Job Conversion:** First attachment is automatically copied to the job when converting.

---

## Inline Entity Creation

While creating/editing a quote, users can create new entities without leaving the form:

- **"Create New Customer"** option in customer dropdown - opens modal

- **"Create New Part"** option in part dropdown - opens modal (parts are company-wide, no customer pre-selection)

- Newly created entity is automatically selected

---

## Search and Filter

**Search:** Full-text search on quote number (toolbar input)

**Filters:**

- Status dropdown: All, Pending Approval, Approved, Rejected

- Customer dropdown: All or specific customer

**Sorting:** Click any column header to sort

---

## Validation Rules

**Customer:** Required

**Part:** Required if "Existing Part" selected

**Quantity:** Integer, 1 to 1,000,000

**Base Cost:** Decimal, 0 to 999,999.9999 (optional, but required before sending for approval)

**Markup Percent:** Decimal, -100 to 100 (negative markups allowed for loss-leader quotes)

**Unit Price:** Decimal, 0 to 999,999.99 (optional)

**Description:** Max 5,000 characters

---

## Pricing Integration

When selecting an existing part:

- Base cost auto-populates from routing calculation (if part has a routing), otherwise starts at $0

- Base cost is always editable (user can override the routing-calculated value)

- Markup pre-fills from the part's category `default_markup_percent`

- Unit price calculated: `base_cost × (1 + markup_percent / 100)`

- Total price calculated: `quantity × unit_price`

- Cost breakdown (labor + materials) shown when routing data was captured

---

## Status Workflow Updates

**Editing Rule:** Only Pending Approval and Rejected quotes can be edited

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
