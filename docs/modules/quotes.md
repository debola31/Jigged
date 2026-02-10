# Quotes Module

## Overview

The Quotes module handles the sales quoting process - the entry point for work into the shop. Quotes capture what a customer wants, at what price, and track whether the customer & the shop owner accepts or declines. Approved quotes convert into Jobs.

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
| Salesperson | Select an existing part with pre-set pricing | I can quickly quote repeat orders |
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
| routing_id | UUID (FK) | No | Link to routing (for routing-based quotes) |
| part_number_text | Text | No | Ad-hoc part number (when part_id is null) |
| description | Text | No | Part/job description |
| quantity | Integer | Yes | Number of units quoted |
| unit_price | Decimal | No | Price per unit |
| total_price | Decimal | No | Total quoted price (quantity × unit_price) |
| estimated_lead_time_days | Integer | No | Estimated days to complete |
| valid_until | Date | No | Quote expiration date |
| status | Text | Yes | draft, pending approval, approved, rejected, expired |
| converted_to_job_id | UUID (FK) | No | Link to job when converted |
| converted_at | Timestamp | No | When quote was converted to job |
| notes | Text | No | Internal notes |

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
  - Part dropdown (filtered by selected customer + generic parts)

  - Shows: part number - description

  - Auto-fills description and suggests pricing

- If Ad-hoc Part:
  - Part Number text field

  - Description text field

▸ **Pricing**

- Quantity (required, number input)

- Unit Price (auto-calculated from part pricing tiers, editable)

- Total Price (calculated: quantity × unit_price, display only)

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

- Quantity, Unit Price, Total

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

**Modal Content:**

- Summary: "Create job from Quote Q-0042?"

- Customer: [display]

- Part: [display]

- Quantity: [display]

- **Due Date** (date picker, optional)

- **Priority** (dropdown: Low / Normal / High / Rush, default: Normal)

- Additional Notes (optional)

**Actions:**

- Create Job → Creates job, redirects to job detail

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

**Trigger:** "+ New Part" button next to part dropdown (only visible when "Existing Part" is selected AND a customer is selected)

**Modal: Quick Create Part**

```javascript
┌─────────────────────────────────────────────┐
│  Quick Create Part                       ✕  │
├─────────────────────────────────────────────┤
│                                             │
│  Customer: Acme Corp (read-only)            │
│                                             │
│  Part Number *      [____________]          │
│  Description        [____________]          │
│                                             │
│  ─────── Pricing (Optional) ───────         │
│  Base Price (1+)    [$__________]           │
│                                             │
│           [Cancel]  [Create Part]           │
└─────────────────────────────────────────────┘
```

**Behavior:**

1. User selects a customer first (required)

2. User clicks "+ New Part" button

3. Modal opens with customer pre-filled (read-only)

4. On success:
  - Modal closes

  - New part auto-selected in dropdown

  - If base price entered, it auto-fills unit price

  - Toast: "Part created successfully"

1. On error: Show inline validation errors

**Required Fields:**

- Part Number (unique per customer within company)

**Optional Fields (for quick entry):**

- Description

- Base Price (creates single pricing tier: qty=1)

> **Note:** Additional pricing tiers and full part details can be added later by editing the part record.

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
  │ [Part Dropdown          ▼]  [+ New] │  ← Only visible when customer selected
  └─────────────────────────────────────┘
  
  If Ad-hoc Part:
  [Part Number field]
  [Description field]
```

### Edge Cases

| Scenario | Behavior |
|---|---|
| Quick create customer with duplicate code | Show error: "Customer code already exists" |
| Quick create part without customer selected | "+ New Part" button disabled with tooltip |
| Quick create part with duplicate part number | Show error: "Part number already exists for this customer" |
| Modal closed without saving | Form state preserved, no changes made |
| Network error during creation | Show error, keep modal open for retry |

### Acceptance Criteria (Quick Create)

- [ ] "+ New Customer" button visible next to customer dropdown

- [ ] Quick Create Customer modal opens with required fields

- [ ] New customer auto-selected after creation

- [ ] "+ New Part" button visible when customer is selected

- [ ] "+ New Part" button disabled/hidden when no customer selected

- [ ] Quick Create Part modal shows selected customer (read-only)

- [ ] New part auto-selected after creation

- [ ] Base price from quick create flows to unit price field

- [ ] Validation errors display inline in modals

- [ ] Success toast shown after creation

---

## Auto-Pricing Logic

When user selects an existing part and enters quantity:

1. Look up part's pricing tiers

2. Find applicable tier based on quantity

3. Auto-fill unit_price field

4. User can override if needed

Example:

- Part has: Tier 1 (1+) = $50, Tier 2 (100+) = $45

- User enters quantity: 150

- System auto-fills unit_price: $45

- Total calculates: $6,750

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

- [ ] Unit price auto-fills from part pricing tiers

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

- [ ] "+ New Part" button visible only when customer is selected

- [ ] Quick Create Part modal shows selected customer (read-only)

- [ ] New part auto-selected in dropdown after creation

- [ ] Base price from quick create flows to unit price field

- [ ] Validation errors display inline in modals

- [ ] Success toast notifications after creation

---

## Phase 1 Enhancement: Routing-Based Cost Estimation

> **Note:** This section documents planned enhancements for Phase 1, after the Resources and Routings modules are complete.

In Phase 1, quotes will support **routing-based cost estimation**:

### How It Works

1. When creating a quote for a part that has a **routing** defined:
  - System calculates estimated cost from routing operations

  - Each operation: `estimated_hours × resource.labor_rate`

  - Total: `Σ (operation costs) + material_cost`

1. **Auto-fill pricing** from routing:

```javascript
function calculateQuoteCost(routing: Routing): number {
  const laborCost = routing.operations.reduce((sum, op) => {
    return sum + (op.estimated_hours * op.resource.labor_rate);
  }, 0);
  
  const materialCost = routing.material_cost ?? 0;
  
  return laborCost + materialCost;
}
```

1. **Quote form additions:**
  - Show calculated cost breakdown (labor by operation + materials)

  - User can override suggested price

  - Margin calculator: `(quoted_price - estimated_cost) / quoted_price`

### Data Model Addition (Phase 1)

| Field | Type | Description |
|---|---|---|
| estimated_labor_cost | Decimal | Calculated from routing operations |
| estimated_material_cost | Decimal | From part or routing |
| estimated_total_cost | Decimal | Labor + materials |
| margin_percent | Decimal | Calculated: (price - cost) / price |

### Acceptance Criteria (Phase 1)

- [ ] Quotes for parts with routings show estimated cost breakdown

- [ ] Labor cost calculated from routing operations × resource rates

- [ ] User can see and override suggested pricing

- [ ] Margin percentage displayed when cost and price both entered

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

- **"Create New Part"** option in part dropdown - opens modal with customer pre-selected

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

**Unit Price:** Decimal, 0 to 999,999.99 (optional)

**Description:** Max 5,000 characters

---

## Pricing Integration

When selecting an existing part:

- All pricing tiers are displayed below the part field

- Unit price auto-fills based on quantity and applicable tier

- Total price is calculated as: quantity × unit_price

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
