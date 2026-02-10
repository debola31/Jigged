# Build Sequence & Checklist

## Overview

Phase 0 establishes the core quote-to-job workflow for Jigged. This is the minimum viable product that allows Shane to manage customer quotes and track jobs through completion.

**Goal:** Shane can create a quote, accept it, convert to a job, and track it through to shipped.

**Timeline:** ~14 working days

---

## The Flow

```javascript
QUOTE (draft)
    │
    ▼
QUOTE (sent)  ────────────▶  QUOTE (declined)
    │
    ▼
QUOTE (accepted)
    │
    ▼
━━━━━━━━━━━━━━━━━━
 Convert to Job
━━━━━━━━━━━━━━━━━━
    │
    ▼
JOB (pending)
    │
    ▼
JOB (in_progress)
    │
    ▼
JOB (complete)
    │
    ▼
JOB (shipped)
```

---

## Build Sequence

| Order | Module | Est. Days | Status | ETA | PRD |
|---|---|---|---|---|---|
| 1 | Customers | 1-2 | ✅ Complete | — | Phase 0 Module: Customers |
| 2 | Parts | 1-2 | ✅ Complete | — | Phase 0 Module: Parts |
| 3 | Operations | 1-2 | ✅ Complete | — | Phase 0 Module: Operations |
| 4 | Quotes | 2-3 | ✅ Complete | — | Phase 0 Module: Quotes |
| 5 | Jobs | 2-3 | ⬜ Not Started | 2026-01-08 | Phase 0 Module: Jobs |
| 6 | Dashboard | 1-2 | ⬜ Not Started | 2026-01-10 | Phase 0 Module: Dashboard |
| 7 | Operator View | 2-3 | ⬜ Not Started | — | Phase 0 Module: Operator View |
| 8 | Inventory | 2-3 | ⬜ Not Started | — | [Phase 0 Module: Inventory](modules/inventory.md) |
| 9 | Invitation & Demo content | 1-2 | ⬜ Not Started | - |  |

---

## Already Complete

- [x] Supabase project setup

- [x] Database schema (companies, customers, parts, quotes, jobs)

- [x] Multi-tenant RLS policies

- [x] Authentication (signup, login, company access)

- [x] Vercel deployment

- [x] Company + user access working

- [x] **Customers module** (CRUD + AI-powered CSV import)

- [x] **Testing infrastructure** (Vitest, pytest, GitHub Actions CI)

- [x] **Parts module** (CRUD + AI-powered CSV/Excel import + flexible pricing tiers)

- [x] **Operations module** (Resource groups + operation types with labor rates + AI import)

---

## Deferred to Later Phases

| Feature | Phase |
|---|---|
| Routings (operation sequences for parts) | Phase 1 |
| Job operations tracking (per-step progress) | Phase 1 |
| Time tracking per operation | Phase 1 |
| Shop floor operator view | Phase 1 |
| Multi-user / roles | Phase 1 |
| Resource instances (multiple machines of same type) | Phase 1 |
| Machine availability/status tracking | Phase 1 |
| Quality inspection workflow | Phase 2 |
| Scheduling / Gantt | Phase 2 |
| Inventory / Materials | Phase 2 |
| Reporting / Analytics | Phase 2 |
| Manufacturing Lines (station sequences) | Phase 2+ |
| Buildings / Sites (physical locations) | Phase 3+ |
| QuickBooks integration | Phase 3 |
| Shipping label generation | Phase 3 |
| Customer portal | Phase 3 |

---

## Success Criteria

Phase 0 is complete when Shane can:

- [x] Log in to Jigged

- [x] Create a new customer

- [x] Bulk import customers via AI-powered CSV mapping

- [x] Create a new part for that customer

- [x] Bulk import parts via AI-powered CSV/Excel mapping

- [x] Create resource groups and operation types with labor rates

- [x] Bulk import operation types from legacy system

- [ ] Create a quote for the customer/part

- [ ] Send the quote (change status)

- [ ] Mark quote as accepted

- [ ] Convert accepted quote to job

- [ ] Start the job

- [ ] Update job progress

- [ ] Mark job as complete

- [ ] Mark job as shipped

- [ ] See summary on dashboard

---

## Technical Notes

**Stack:**

- Frontend: Next.js + TypeScript + Material UI

- Backend: Supabase (PostgreSQL + Auth + Storage)

- Hosting: Vercel

- Repo: [https://github.com/debola31/Jigged](https://github.com/debola31/Jigged)

**Company ID (Shane/Contour):** `08856a10-0153-4094-b065-d482c6a9b08d`

**Database Tables:**

- `companies`

- `user_company_access`

- `user_preferences`

- `customers`

- `parts`

- `resource_groups` (categories of operations - e.g., CNC, LATHE&MILL, Hone)

- `operation_types` (operation types with labor rates - e.g., HURCO Mill @ $135/hr)

- `quotes`

- `jobs`

- `ai_config` (AI provider settings per company/feature)

- `routings` (Phase 1 - operation sequences for parts)

- `routing_operations` (Phase 1 - steps in a routing)

- `job_operations` (Phase 1 - tracking job progress per step)

**AI Infrastructure:**

- AI-powered CSV/Excel import with confidence scoring

- Provider abstraction layer (Claude default, OpenAI/Gemini supported)

- Per-company provider configuration via `ai_config` table

- API keys in environment variables, provider selection in database

[Routings Module](modules/routings.md)
## Overview

  The Routings module provides a **visual workflow diagram builder** for defining manufacturing processes. Unlike traditional linear operation lists, routings in Jigged are **node-based workflow diagrams** where operations can run in **parallel** or **series**.

  Users build routings by dragging operations onto a canvas and connecting them with edges to define execution flow. This enables complex manufacturing processes where multiple operations can happen simultaneously on different machines, reducing total production time.

  **Priority:** Must Have (Build after Operations, before Jobs)

  **Dependencies:**

  - Parts module (routings are linked to parts)

  - Operations module (routings reference operation types)

  **Database Tables:** `routings`, `routing_nodes`, `routing_edges`

  ---

## Terminology

  | Term | Description |
  |---|---|
  | **Routing** | A workflow diagram defining how a part is manufactured, consisting of nodes (operations) and edges (connections) |
  | **Workflow Node** | An operation represented as a card on the canvas, containing setup time, run time, and resource assignment |
  | **Edge/Connection** | A link between nodes showing execution dependency - the source must complete before the target starts |
  | **Parallel Branch** | Multiple nodes that can execute simultaneously because they have no dependencies on each other |
  | **Series Path** | Nodes that execute sequentially, one after another, where each depends on the previous |
  | **Start Node** | The entry point of the workflow - operations with no incoming edges |
  | **End Node** | The final operation(s) before completion - operations with no outgoing edges |

  ---

## Visual Workflow Builder

  The routing editor provides a drag-and-drop canvas for building manufacturing workflows:

  - **Canvas** - Drag and drop operations as nodes onto an infinite canvas

  - **Operations Toolbar** - Select operations from your operations library to add to the workflow

  - **Node Cards** - Each node displays operation name, resource group, and estimated time

  - **Connections** - Draw edges between nodes by dragging from output to input handles

  - **Parallel Patterns** - Create branches by connecting one node to multiple targets

  - **Validation** - System ensures valid workflow (no cycles, all nodes connected)

  ---

## Workflow Examples

### Series Workflow (Sequential Operations)

  Operations execute one after another. Total time = sum of all operation times.

  ```plain text
  [Start] → [CNC Mill] → [Deburr] → [Inspect] → [End]
  ```

### Parallel Workflow (Simultaneous Operations)

  Multiple operations run at the same time on different machines, then converge.

  ```plain text
                ┌→ [CNC Mill Op1] ─┐
  [Start] ──────┼→ [CNC Mill Op2] ─┼→ [Deburr] → [Inspect] → [End]
                └→ [Manual Drill] ─┘
  ```

  ---

## Data Model

### Routings Table (`routings`)

  | Column | Type | Required | Description |
  |---|---|---|---|
  | id | uuid | Yes | Primary key |
  | company_id | uuid | Yes | FK to companies |
  | part_id | uuid | Yes | FK to parts |
  | name | text | No | Optional routing name |
  | is_default | boolean | Yes | Default routing for this part |

### Routing Nodes Table (`routing_nodes`)

  Node positions are **auto-calculated** using a DAG layout algorithm (dagre) when rendering. Positions are presentation-layer, not business logic - the workflow is defined by edges.

  | Column | Type | Required | Description |
  |---|---|---|---|
  | id | uuid | Yes | Primary key |
  | routing_id | uuid | Yes | FK to routings |
  | operation_type_id | uuid | Yes | FK to operation_types |
  | setup_time | float | No | Setup time in minutes |
  | cycle_time | float | No | Run time per unit in minutes |
  | metadata | jsonb | No | Optional JSON (can store position hints for custom layouts) |

### Routing Edges Table (`routing_edges`)

  | Column | Type | Required | Description |
  |---|---|---|---|
  | id | uuid | Yes | Primary key |
  | routing_id | uuid | Yes | FK to routings |
  | source_node_id | uuid | Yes | FK to routing_nodes (start of edge) |
  | target_node_id | uuid | Yes | FK to routing_nodes (end of edge) |

  ---

## User Stories

  | As a... | I want to... | So that... |
  |---|---|---|
  | Owner/Admin | Build a routing by dragging operations onto a canvas | I can visually design manufacturing workflows |
  | Owner/Admin | Connect operations with edges to define execution order | I can specify which operations depend on others |
  | Owner/Admin | Create parallel branches for simultaneous operations | Multiple operations can run at the same time |
  | Owner/Admin | View estimated total time (sum of all operations) | I can accurately quote jobs |
  | Owner/Admin | Clone an existing routing | I can quickly create similar workflows |
  | Owner/Admin | Set a default routing for a part | Jobs are auto-populated with correct operations |
  | Owner/Admin | Validate my workflow has no cycles | I avoid invalid routing configurations |

  ---

## Material Definitions per Routing Node

  Routing nodes can optionally define expected materials for each operation. This enables:

  - Routing designers to specify expected materials per operation step

  - Operator View to pre-populate material logging when completing operations

  - Actual vs expected material consumption comparison

### routing_nodes.materials Column

  Add the following column to the routing_nodes table:

  | Column | Type | Required | Description |
  |---|---|---|---|
  | materials | jsonb | No | Expected materials for this operation |

### materials JSONB Structure

  The materials field is an array of material specifications:

  ```json
  [
    {
      "inventory_item_id": "uuid",
      "quantity": 0.5,
      "unit": "lbs"
    },
    {
      "inventory_item_id": "uuid",
      "quantity": 12,
      "unit": "inches"
    }
  ]
  ```

  **Field Descriptions:**

  - `inventory_item_id` - UUID FK to inventory_items table

  - `quantity` - Expected quantity to be consumed

  - `unit` - Unit of measure (must be primary or configured secondary unit)

### UI Addition: Material Input

  When editing a routing node, add a "Materials" section:

  - "+Add Material" button opens inventory item picker

  - For each material: inventory item dropdown, quantity input, unit dropdown

  - Materials can be reordered or removed

### User Story Addition

  - As a routing designer, I want to specify expected materials for each operation so that operators know what materials to log when completing work

[Quotes Module](modules/quotes.md)
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
  | customer_id | UUID (FK) | Yes | Link to customer |
  | part_id | UUID (FK) | No | Link to existing part (optional) |
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

[Operations Module](modules/operations.md)
## Overview

  The Operations module manages the catalog of operation types available in the shop. Operation types define what work can be done and at what cost - they're referenced when creating routings (Phase 1) and for job costing.

  **Priority:** Must Have (Build after Parts, before Quotes)

  **Dependencies:** None (foundational module)

  **Database Tables:** `resource_groups`, `operation_types`

  ---

## Terminology

  Aligned with Contour's legacy system for familiarity:

  | Jigged Term | Legacy System Term | Description |
  |---|---|---|
  | **Resource Group** | Resource Group | A category of related operations (e.g., "LATHE&MILL", "CNC", "EDM", "Hone") |
  | **Operation Type** | Operation Type | A specific operation or machine with labor rate (e.g., "HURCO Mill" @ $135/hr) |

  **Future Scalability:** This two-level model can extend to support:

  - Manufacturing Lines (ordered sequences of operations)

  - Buildings / Sites (physical locations)

  - Machine Instances (multiple identical machines)

  ---

## User Stories

  | As a... | I want to... | So that... |
  |---|---|---|
  | Owner/Admin | View all operation types organized by resource group | I can see our shop's capabilities at a glance |
  | Owner/Admin | Create resource groups to categorize operations | I can organize similar machines/operations together |
  | Owner/Admin | Create operation types with hourly labor rates | I can track costs accurately |
  | Owner/Admin | Edit operation type rates when costs change | My quotes and job costing stay accurate |
  | Owner/Admin | Bulk import operation types from my legacy system | I can migrate quickly without manual data entry |
  | Owner/Admin | Add custom fields to operation types | I can track setup time, capabilities, or other shop-specific data |
  | Estimator | Look up operation type rates when quoting | I can calculate accurate job costs |
  | Estimator | See operation types sorted by resource group | I can quickly find the right operation |

  ---

## Data Model

### Resource Groups Table (`resource_groups`)

  | Field | Type | Required | Description |
  |---|---|---|---|
  | id | UUID | Yes | Primary key (auto-generated) |
  | company_id | UUID (FK) | Yes | Link to company (multi-tenant isolation) |
  | name | Text | Yes | Group name (e.g., "LATHE&MILL", "CNC", "Hone") |
  | description | Text | No | Optional description |
  | display_order | Integer | No | Sort order in UI (default: 0) |
  | created_at | Timestamp | Yes | Auto-generated |
  | updated_at | Timestamp | Yes | Auto-updated on changes |

  **Unique Constraint:** `(company_id, name)`

### Operation Types Table (`operation_types`)

  | Field | Type | Required | Description |
  |---|---|---|---|
  | id | UUID | Yes | Primary key (auto-generated) |
  | company_id | UUID (FK) | Yes | Link to company (multi-tenant isolation) |
  | resource_group_id | UUID (FK) | No | Link to resource group (NULL = ungrouped) |
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

### 1. Operations List (Grouped View)

  **Route:** `/dashboard/{companyId}/operations`

  **Layout:** Accordion-style grouped list (not a flat table)

  **Features:**

  - Resource groups as expandable sections

  - Operation types listed within each group

  - "Ungrouped" section at bottom for orphan operation types

  - Search box (searches operation type name and code)

  - "+ New Operation Type" button

  - "+ New Group" button (secondary)

  - Click operation type row to view/edit

  **Group Header Display:**

  ```javascript
  ▼ LATHE&MILL (7 operation types)              [Edit Group]
     ├─ LATHE             $105/hr     [Edit]
     ├─ SAW               $90/hr      [Edit]
     ├─ BRIDGEPORT MILL   $95/hr      [Edit]
     ├─ HURCO Lathe       $135/hr     [Edit]
     └─ Mazak Lathe       $135/hr     [Edit]
  
  ▼ CNC (2 operation types)                     [Edit Group]
     ├─ POLISH            $95/hr      [Edit]
     └─ HURCO Mill        $135/hr     [Edit]
  
  ▼ Ungrouped (5 operation types)
     ├─ Hone              $95/hr      [Edit]
     └─ TRM30 Mill        $135/hr     [Edit]
  ```

  **Empty State:**

  "No operation types yet. Create your first operation type or import from your legacy system."

### 2. Operation Type Create/Edit

  **Route:** `/dashboard/{companyId}/operations/new` or `/dashboard/{companyId}/operations/{id}/edit`

  **Form Sections:**

  ▸ **Basic Information**

  - Name (required)

  - Code (optional, for short display)

  - Resource Group (dropdown, optional)

  - Description

  ▸ **Costing**

  - Labor Rate ($/hour)

  ▸ **Additional Details** (collapsible, optional)

  - Setup Time (minutes) - stored in metadata

  - Notes - stored in metadata

  **Actions:**

  - Save → Returns to list

  - Cancel → Returns to list without saving

  - Delete (edit mode only) → Confirmation dialog

  **Delete Validation:**

  - Cannot delete if operation type is used in any routing (Phase 1)

  - Show warning with count of affected routings

### 3. Resource Group Create/Edit

  **Route:** Modal overlay (not separate page)

  **Trigger:** "+ New Group" button or "Edit Group" link

  **Modal Content:**

  - Name (required)

  - Description (optional)

  - Display Order (number, for sorting groups)

  **Actions:**

  - Save → Closes modal, refreshes list

  - Cancel → Closes modal

  - Delete (edit mode) → Moves all operation types to "Ungrouped", deletes group

  ---

## AI-Powered Bulk Import

  **Route:** `/dashboard/{companyId}/operations/import`

  Uses the same AI-powered import infrastructure as Customers and Parts.

### Import Flow

  1. **Upload CSV/Excel** - Parse file, extract headers + sample rows

  2. **AI Analysis** - AI suggests column mappings with confidence scores

  3. **Review Mappings** - User confirms/adjusts mappings

  4. **Group Handling:**
    - Auto-create resource groups from unique values in mapped group column

    - Option to map to existing groups

    - Option to import all as ungrouped

  1. **Execute** - Import with results summary

### Expected Source Columns (from Contour export)

  | Source Column | Maps To | Notes |
  |---|---|---|
  | name | operation_[types.name](http://types.name/) | Primary identifier |
  | laborRate | operation_types.labor_rate | Hourly rate |
  | resourceGroup | resource_[groups.name](http://groups.name/) | Auto-creates groups |
  | resource | operation_types.code | Optional short code |
  | _id | operation_types.metadata.legacy_id | Preserve for reference |

### Conflict Detection

  - **Duplicate name** within company → Conflict (skip or update)

  - **Missing laborRate** → Warning (import with NULL)

  - **Unknown resourceGroup** → Auto-create new group

### API Architecture

  **CRUD Operations → Direct Supabase Calls**

  Simple create, read, update, delete operations use direct Supabase client calls from the frontend (via `utils/operationsAccess.ts`). This follows the same pattern as Customers and Parts:

  - Avoids Vercel serverless cold starts

  - Leverages Supabase RLS for security

  - Simpler, faster for basic operations

  **Complex Operations → FastAPI Endpoints**

  AI-powered features that require server-side processing use FastAPI:

  - `POST /api/operations/import/analyze` - AI mapping suggestions

  - `POST /api/operations/import/execute` - Perform import with group auto-creation

  ---

## Rate Lookup Logic

  When calculating job costs (Phase 1+), the system will:

  ```javascript
  function getOperationTypeRate(operationTypeId: string): number | null {
    const operationType = await getOperationType(operationTypeId);
    return operationType?.labor_rate ?? null;
  }
  ```

  ---

## Acceptance Criteria

### Resource Groups

  - [ ] Can view list of resource groups

  - [ ] Can create new resource group

  - [ ] Can edit resource group name/description

  - [ ] Can reorder groups via display_order

  - [ ] Can delete empty group

  - [ ] Deleting group with operation types moves them to "Ungrouped"

  - [ ] Group names are unique within company

### Operation Types

  - [ ] Can view operation types organized by group

  - [ ] Can search operation types by name or code

  - [ ] Can create new operation type with group assignment

  - [ ] Can create operation type without group (ungrouped)

  - [ ] Can edit operation type details

  - [ ] Can change operation type's group

  - [ ] Can set labor rate

  - [ ] Operation type names are unique within company

  - [ ] Form shows validation errors inline

### AI-Powered Import

  - [ ] Can upload CSV or Excel file

  - [ ] AI analyzes file and suggests column mappings

  - [ ] Confidence scores displayed with color coding

  - [ ] Resource groups auto-created from import data

  - [ ] Detects duplicate operation type names

  - [ ] Can skip conflicts and import valid rows

  - [ ] Shows import results: imported, skipped, groups created

  - [ ] Legacy IDs preserved in metadata

  ---

## Database Migration

  **Note:** If tables were previously created as `resources`, run this migration to rename:

  ```sql
  -- Rename resources table to operation_types
  ALTER TABLE resources RENAME TO operation_types;
  
  -- Update foreign key column name for clarity (optional)
  ALTER TABLE operation_types RENAME COLUMN resource_group_id TO resource_group_id;
  
  -- Update indexes
  ALTER INDEX idx_resources_company RENAME TO idx_operation_types_company;
  ALTER INDEX idx_resources_group RENAME TO idx_operation_types_group;
  
  -- Update RLS policy
  ALTER POLICY resources_company_isolation ON operation_types RENAME TO operation_types_company_isolation;
  ```

  **Fresh install schema:**

  ```sql
  -- Resource Groups (categories)
  CREATE TABLE resource_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(company_id, name)
  );
  
  -- Operation Types
  CREATE TABLE operation_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    resource_group_id UUID REFERENCES resource_groups(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    code TEXT,
    labor_rate DECIMAL(10,2),
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(company_id, name)
  );
  
  -- RLS Policies
  ALTER TABLE resource_groups ENABLE ROW LEVEL SECURITY;
  ALTER TABLE operation_types ENABLE ROW LEVEL SECURITY;
  
  CREATE POLICY resource_groups_company_isolation ON resource_groups
    USING (company_id IN (
      SELECT company_id FROM user_company_access WHERE user_id = auth.uid()
    ));
  
  CREATE POLICY operation_types_company_isolation ON operation_types
    USING (company_id IN (
      SELECT company_id FROM user_company_access WHERE user_id = auth.uid()
    ));
  
  -- Indexes
  CREATE INDEX idx_resource_groups_company ON resource_groups(company_id);
  CREATE INDEX idx_operation_types_company ON operation_types(company_id);
  CREATE INDEX idx_operation_types_group ON operation_types(resource_group_id);
  ```

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

  - Download PNG - Downloads the QR code as a PNG image file

  - Download PDF - Downloads a PDF with the QR code, station name, and company branding for printing labels

  - Print - Opens the browser print dialog with the QR code and station label

### Usage

  1. Navigate to Operations > Operation Types tab

  2. Click on an Operation Type row to view its details

  3. The Station QR Code is displayed on the left side of the detail page

  4. Use the export buttons to download or print the QR code

  5. Print and affix QR codes to machines/workstations

  6. Operators scan the QR code to log into the Operator View for that station

[Parts Module](modules/parts.md)
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
  | material_cost | Decimal | No | Estimated material cost per unit |
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

[Customers Module](modules/customers.md)
## Overview

  The Customers module manages the master list of companies that Contour does business with. Customers are required to create quotes and jobs.

  **Priority:** Must Have (Build First)

  **Dependencies:** None - this is the foundational module

  **Database Table:** `customers`

  ---

## User Stories

  | As a... | I want to... | So that... |
  |---|---|---|
  | Owner/Admin | View a list of all customers | I can see who we do business with |
  | Owner/Admin | Search customers by name or code | I can quickly find a specific customer |
  | Owner/Admin | Filter customers by active/inactive status | I can focus on current customers |
  | Owner/Admin | Create a new customer with contact details | I can start doing business with them |
  | Owner/Admin | Edit customer information | I can keep records up to date |
  | Owner/Admin | Mark a customer as inactive | They don't clutter my active list but history is preserved |
  | Owner/Admin | Bulk import customers from CSV | I can migrate from my legacy system |

  ---

## Data Model

  | Field | Type | Required | Description |
  |---|---|---|---|
  | customer_code | Text | Yes | Short unique identifier (e.g., "ABC00", "CONTOUR") |
  | name | Text | Yes | Full company name |
  | phone | Text | No | Main phone number |
  | email | Text | No | Main email address |
  | website | Text | No | Company website |
  | contact_name | Text | No | Primary contact person |
  | contact_phone | Text | No | Primary contact's phone |
  | contact_email | Text | No | Primary contact's email |
  | address_line1 | Text | No | Street address |
  | address_line2 | Text | No | Suite/unit |
  | city | Text | No | City |
  | state | Text | No | State/province |
  | postal_code | Text | No | ZIP/postal code |
  | country | Text | No | Country (default: USA) |
  | is_active | Boolean | Yes | Active/inactive status (default: true) |
  | notes | Text | No | Internal notes |

  ---

## UI Screens

### 1. Customer List

  **Route:** `/dashboard/{companyId}/customers`

  **Features:**

  - Table showing: Customer Code, Name, Contact, Phone, City/State, Status

  - Search box (searches name and code)

  - Filter toggle: All / Active only / Inactive only

  - "+ New Customer" button

  - Click row to view/edit

  - Pagination (25 per page)

  **Empty State:**

  "No customers yet. Create your first customer or import from CSV."

### 2. Customer Create/Edit

  **Route:** `/dashboard/{companyId}/customers/new` or `/dashboard/{companyId}/customers/{id}/edit`

  **Form Sections:**

  ▸ **Basic Information**

  - Customer Code (required, unique)

  - Company Name (required)

  - Website

  ▸ **Primary Contact**

  - Contact Name

  - Phone

  - Email

  ▸ **Address**

  - Address Line 1

  - Address Line 2

  - City

  - State

  - Postal Code

  - Country

  ▸ **Status**

  - Active toggle

  - Notes (multiline)

  **Actions:**

  - Save → Returns to list

  - Cancel → Returns to list without saving

  - Delete (edit mode only) → Confirmation dialog, then soft-delete (mark inactive)

### 3. Customer Detail (Optional for Phase 0)

  **Route:** `/dashboard/{companyId}/customers/{id}`

  Read-only view showing:

  - All customer fields

  - Related quotes (future)

  - Related jobs (future)

  - Edit button

  ---

## AI-Powered Bulk Import

  **Route:** `/dashboard/{companyId}/customers/import`

  Replaces manual CSV column mapping with an AI-powered backend that analyzes CSV data, suggests mappings with confidence scores, detects conflicts, and provides a guided import workflow.

### Import Flow (5 Steps)

  ```javascript
  1. UPLOAD CSV
     Parse file, extract headers + first 5 rows
         │
         ▼
  2. AI ANALYSIS
     Call /analyze endpoint, show loading spinner
     AI suggests column mappings with confidence scores
         │
         ▼
  3. REVIEW MAPPINGS
     Display mappings with confidence indicators (green/yellow/red)
     User can override AI suggestions
         │
         ▼
  4. VALIDATE
     Call /validate endpoint
     Show conflicts if any (duplicate customer_code or name)
         │
         ▼
  5. EXECUTE
     Call /execute endpoint
     Show results: imported, skipped, errors
  ```

### Conflict Detection

  - **Duplicate customer_code** → Conflict (code must be unique)

  - **Duplicate name** → Conflict (flag for review)

  - User can choose to skip conflicts and import valid rows

### Confidence Scoring

  | Score | Color | Meaning |
  |---|---|---|
  | >= 0.8 | Green | High confidence, auto-mapped |
  | 0.5 - 0.79 | Yellow | Medium confidence, review suggested |
  | < 0.5 | Red | Low confidence, manual selection needed |

### API Endpoints

  **POST ****`/api/customers/import/analyze`**

  Send CSV headers + 5 sample rows, get AI mapping suggestions.

  ```json
  // Request
  {
    "company_id": "uuid",
    "headers": ["Company", "Tel", "Email"],
    "sample_rows": [["Acme Corp", "555-1234", "[info@acme.com](mailto:info@acme.com)"]]
  }
  
  // Response
  {
    "mappings": [
      {"csv_column": "Company", "db_field": "name", "confidence": 0.95, "needs_review": false},
      {"csv_column": "Tel", "db_field": "phone", "confidence": 0.65, "needs_review": true}
    ],
    "unmapped_required": [],
    "discarded_columns": ["Internal ID"],
    "ai_provider": "claude"
  }
  ```

  **POST ****`/api/customers/import/validate`**

  Check for conflicts before import.

  ```json
  // Response
  {
    "has_conflicts": true,
    "conflicts": [
      {"row_number": 3, "conflict_type": "duplicate_code", "csv_value": "ACM01"}
    ],
    "valid_rows_count": 47,
    "conflict_rows_count": 3
  }
  ```

  **POST ****`/api/customers/import/execute`**

  Perform the import.

  ```json
  // Response
  {
    "success": true,
    "imported_count": 47,
    "skipped_count": 3,
    "errors": []
  }
  ```

### UI Components

  | Component | Purpose |
  |---|---|
  | `MappingReviewTable` | Show mappings with confidence chips, allow manual changes |
  | `ConflictDialog` | Display conflicts, option to skip and proceed |
  | `ConfidenceChip` | Visual indicator based on confidence score |

### Mapping Review UI Sections

  1. **Mapped Columns** - CSV → DB field with confidence indicator

  2. **Discarded Columns** - CSV columns that won't be imported

  3. **Missing Required** - Alert if customer_code or name unmapped

### AI Provider Configuration

  Provider selection is per-company, stored in `ai_config` database table:

  ```sql
  CREATE TABLE [public.ai](http://public.ai/)_config (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES companies(id),
    feature text NOT NULL,  -- 'csv_mapping', 'chat', etc.
    provider text NOT NULL DEFAULT 'anthropic',  -- 'anthropic', 'openai', 'gemini'
    model text,
    settings jsonb DEFAULT '{}',
    UNIQUE (company_id, feature)
  );
  ```

  API keys remain in environment variables (secure). Default provider is Claude if no config exists.

### Error Handling

  - **AI failure** → Fall back to manual column mapping

  - **Rate limit** → Show "Too many requests, please wait"

  - **Conflicts found** → Block import, show conflict resolution UI

  - **Validation errors** → Show per-row errors in results table

### Backend Files (New)

  ```javascript
  /api/
  ├── routes/import_[routes.py](http://routes.py/)         # Import endpoints
  ├── services/
  │   ├── ai/
  │   │   ├── base_[provider.py](http://provider.py/)        # Abstract AI provider
  │   │   ├── claude_[provider.py](http://provider.py/)      # Claude implementation
  │   │   ├── openai_[provider.py](http://provider.py/)      # OpenAI implementation
  │   │   ├── gemini_[provider.py](http://provider.py/)      # Gemini implementation
  │   │   └── [factory.py](http://factory.py/)              # Provider factory with DB lookup
  │   └── import_[service.py](http://service.py/)           # Import business logic
  ├── models/import_[models.py](http://models.py/)         # Pydantic schemas
  └── utils/rate_[limiter.py](http://limiter.py/)           # Rate limiting
  ```

### Frontend Files (New)

  ```javascript
  /components/customers/import/
  ├── MappingReviewTable.tsx
  ├── ConflictDialog.tsx
  └── ConfidenceChip.tsx
  
  /types/import.ts
  ```

### Validation Rules

  - customer_code is required and must be unique

  - name is required

  - Simple 1:1 column mapping only (no concatenation)

  ---

## Acceptance Criteria

### Core CRUD

  - [ ] Can view paginated list of customers

  - [ ] Can search customers by name or code

  - [ ] Can filter by active/inactive status

  - [ ] Can create new customer with required fields

  - [ ] Can edit existing customer

  - [ ] Can toggle customer active/inactive

  - [ ] Customer code is unique within company

  - [ ] Form shows validation errors inline

### AI-Powered Import

  - [ ] Can upload CSV file and see preview

  - [ ] AI analyzes CSV and suggests column mappings

  - [ ] Confidence scores displayed with color coding (green/yellow/red)

  - [ ] Can manually override AI-suggested mappings

  - [ ] Shows unmapped required fields as alert

  - [ ] Detects duplicate customer_code conflicts

  - [ ] Detects duplicate name conflicts

  - [ ] Can skip conflicts and import valid rows

  - [ ] Shows import results: imported, skipped, errors

  - [ ] Falls back to manual mapping if AI fails

  - [ ] AI provider configurable per company via database

  ---

## Delete Behavior

  Customers can be deleted even if they have related quotes or jobs. When a customer is deleted:

  - Related quotes will have their customer_id set to NULL (orphaned)

  - Related jobs will have their customer_id set to NULL (orphaned)

  - Related parts will have their customer_id set to NULL (become generic parts)

  A warning is shown in the delete confirmation dialog when the customer has related records.

[Dashboard Module](modules/dashboard.md)
## Overview

  The Dashboard is the home screen after login - a high-level overview of the shop's current state. It shows key metrics, highlights urgent items, and provides quick actions to create quotes and jobs.

  **Priority:** Should Have (Build Last in Phase 0)

  **Dependencies:** All other modules (displays data from quotes and jobs)

  **Route:** `/dashboard/{companyId}`

  ---

## User Stories

  | As a... | I want to... | So that... |
  |---|---|---|
  | Owner | See a summary of open quotes | I know how much potential work is in the pipeline |
  | Owner | See a count of active jobs | I know how busy the shop is |
  | Owner | Quickly create a new quote | I can respond to customer inquiries fast |
  | Owner | Quickly create a new job | I can get rush orders into production |
  | Owner | See recent activity | I know what's been happening |

  ---

## Summary Cards

### Card 1: Open Quotes

  **Query:** Count quotes where status IN ('draft', 'sent')

  **Display:**

  - Large number

  - Label: "Open Quotes"

  - Click → Navigate to Quotes list (filtered to open)

  **Color:** Default/neutral

### Card 2: Active Jobs

  **Query:** Count jobs where status IN ('pending', 'in_progress')

  **Display:**

  - Large number

  - Label: "Active Jobs"

  - Click → Navigate to Jobs list (filtered to active)

  **Color:** Default/neutral

  ---

## Recent Activity Section

  **Query:** Most recent status changes from quotes and jobs

  - UNION of quote status changes and job status changes

  - ORDER BY timestamp DESC

  - LIMIT 10

  **Activity Types:**

  - Quote created

  - Quote sent

  - Quote accepted

  - Quote declined

  - Job created

  - Job started

  - Job completed

  - Job shipped

  **Display per row:**

  - Icon (quote icon or job icon)

  - Entity number (Q-0089 or J-0042)

  - Action text ("sent to XYZ Corp", "marked complete")

  - Relative timestamp ("2h ago", "yesterday")

  **"View All" link:** Future feature - Activity log page

  **Empty State:** "No recent activity."

  **Implementation Note for Phase 0:**

  For simplicity, this can be derived from `created_at`, `status_changed_at`, `started_at`, `completed_at`, `shipped_at` timestamps rather than a separate activity log table. A proper activity/audit log can be added in a later phase.

  ---

## Quick Actions

### + New Quote Button

  - Primary button style

  - Click → Navigate to `/dashboard/{companyId}/quotes/new`

### + New Job Button

  - Secondary button style

  - Click → Navigate to `/dashboard/{companyId}/jobs/new`

  ---

## Responsive Behavior

  **Desktop (> 1024px):**

  - 4 summary cards in a row

  - Two-column layout for sections below

  **Tablet (768px - 1024px):**

  - 2 summary cards per row (2x2 grid)

  - Single column for sections

  **Mobile (< 768px):**

  - 2 summary cards per row (2x2 grid, smaller)

  - Single column, stacked sections

  - Quick action buttons full width

  ---

## Data Refresh

  **On page load:** Fetch all dashboard data

  **Auto-refresh:** Optional - refresh every 60 seconds (can be Phase 0+)

  **Manual refresh:** Pull-to-refresh on mobile, refresh button on desktop

  ---

## Acceptance Criteria

  - [ ] Dashboard loads as home page after login

  - [ ] Shows count of open quotes (draft + sent)

  - [ ] Shows count of active jobs (pending + in_progress)

  - [ ] Shows count of overdue jobs with warning indicator

  - [ ] Clicking summary cards navigates to filtered list

  - [ ] Shows recent activity feed

  - [ ] "+ New Quote" button navigates to quote creation

  - [ ] "+ New Job" button navigates to job creation

  - [ ] Dashboard is responsive on mobile

  - [ ] Empty states display when no data

[Jobs Module](modules/jobs.md)
## Overview

  The Jobs module tracks production work through the shop. Jobs represent actual work to be done - they're created from accepted quotes (or directly) and tracked through to completion and shipping.

  **Priority:** Must Have (Build Fourth)

  **Dependencies:**

  - Customers module (jobs have a customer)

  - Parts module (jobs reference parts)

  - Routings module (jobs typically have routings)

  - Quotes module (jobs are typically created from quotes)

  **Database Table:** `jobs`

  ---

## Job Status Workflow

  ```javascript
    PENDING
       │
       ▼
  IN_PROGRESS
       │
       ▼
    COMPLETE
       │
       ▼
    SHIPPED
  ```

  **Status Definitions:**

  - **Pending** - Job created, not yet started

  - **In Progress** - Work has begun on the shop floor

  - **Complete** - All work finished, ready to ship

  - **Shipped** - Job shipped to customer

  - **Cancelled** - Job cancelled (can happen from any status)

  ---

## User Stories

  | As a... | I want to... | So that... |
  |---|---|---|
  | Owner | View all active jobs | I can see what's in production |
  | Owner | Filter jobs by status, customer | I can focus on specific work |
  | Owner | Create a job directly (without quote) | I can handle rush orders or internal work |
  | Operator | See what jobs are pending | I know what to work on next |
  | Operator | Mark a job as in progress | Others know I'm working on it |
  | Operator | Mark a job as complete | It moves to the shipping queue |
  | Admin | Mark a job as shipped | I can track what's been sent out |

  ---

## Data Model

  | Field | Type | Required | Description |
  |---|---|---|---|
  | id | UUID | Yes | Primary key (auto-generated) |
  | job_number | Text | Auto | Auto-generated: J-0001, J-0002, etc. |
  | quote_id | UUID (FK) | No | Link to source quote (if created from quote) |
  | customer_id | UUID (FK) | Yes | Link to customer |
  | part_id | UUID (FK) | No | Link to part (optional) |
  | routing_id | UUID (FK) | No | Link to routing (optional) |
  | description | Text | No | Job/part description |
  | status | Text | Yes | pending, in_progress, complete, shipped, cancelled |
  | started_at | Timestamp | No | When job moved to in_progress |
  | completed_at | Timestamp | No | When job moved to complete |
  | shipped_at | Timestamp | No | When job moved to shipped |
  | notes | Text | No | Internal notes |

  ---

## UI Screens

### 1. Jobs List

  **Route:** `/dashboard/{companyId}/jobs`

  **Features:**

  - Table showing: Job #, Customer, Part, Qty (completed/ordered), Due Date, Priority, Status

  - Search box (searches job number, customer name, part number)

  - Filter dropdown: Status (All / Pending / In Progress / Complete / Shipped)

  - "+ New Job" button

  - Click row to view detail

  - Pagination (25 per page)

  **Status Pills:**

  - Pending = Gray

  - In Progress = Blue

  - Complete = Green

  - Shipped = Purple

  - Cancelled = Red strikethrough

  **Empty State:**

  "No jobs yet. Create a job or convert a quote to get started."

### 2. Job Create

  **Route:** `/dashboard/{companyId}/jobs/new`

  **Note:** Jobs are usually created via quote conversion, but direct creation is supported.

  **Form Sections:**

  ▸ **Customer** (required)

  - Customer dropdown with search with quick create part UX option similar to quotes

  ▸ **Part**

  - Part dropdown with search with quick create part UX option similar to quotes

  ▸ **Notes**

  - Notes (multiline)

  **Actions:**

  - Create Job → Creates job in Pending status, redirects to detail

  - Cancel → Returns to list

### 3. Job Detail View

  **Route:** `/dashboard/{companyId}/jobs/{id}`

  **Header:**

  - Job number (large)

  - Status pill

  **Content Sections:**

  ▸ **Source**

  - From Quote: Q-0042 (link) - or "Direct entry"

  ▸ **Customer**

  - Customer name (link to customer)

  - Contact info

  ▸ **Part**

  - Part number (link to part if exists)

  - Description

  ▸ **Timeline**

  - Created: Dec 28, 2025

  - Started: Dec 29, 2025 (or "-")

  - Completed: - (or date)

  - Shipped: - (or date)

  ▸ **Notes**

  - Notes text

  **Actions (based on status):**

  | Current Status | Available Actions |
  |---|---|
  | Pending | Start Job, Edit, Cancel Job |
  | In Progress | Update Progress, Mark Complete, Cancel Job |
  | Complete | Mark Shipped, Reopen (back to In Progress) |
  | Shipped | (read only) |
  | Cancelled | (read only) |

### 4. Cancel Job Confirmation

  **Trigger:** Click "Cancel Job"

  **Modal Content:**

  - "Are you sure you want to cancel job J-0042?"

  - "This action cannot be undone."

  - Cancellation Reason (required text input)

  **Actions:**

  - Cancel Job → Sets status to cancelled, saves reason in notes

  - Keep Job → Closes modal

  ---

## Status Transition Rules

  | From | To | Trigger | Auto-set |
  |---|---|---|---|
  | Pending | In Progress | User clicks "Start Job" | started_at = now |
  | Pending | Cancelled | User clicks "Cancel Job" | - |
  | In Progress | Complete | User clicks "Mark Complete" | completed_at = now |
  | In Progress | Cancelled | User clicks "Cancel Job" | - |
  | Complete | Shipped | User clicks "Mark Shipped" | shipped_at = now |
  | Complete | In Progress | User clicks "Reopen" | completed_at = null |

  ---

## Acceptance Criteria

  - [ ] Can view paginated list of jobs

  - [ ] Can search jobs by number, customer, part

  - [ ] Can filter by status

  - [ ] Can filter by customer

  - [ ] Can sort by created date and other fields in table

  - [ ] Can create new job directly

  - [ ] Job number auto-generates (J-0001 format)

  - [ ] Can view job detail with all information

  - [ ] Can start a pending job (moves to in_progress)

  - [ ] Can update progress (completed/scrapped quantities)

  - [ ] Can mark in_progress job as complete

  - [ ] Can mark complete job as shipped

  - [ ] Can reopen a complete job back to in_progress

  - [ ] Can cancel a job from pending or in_progress

  - [ ] Timestamps auto-set on status transitions

  - [ ] Jobs created from quotes show link back to quote

  - [ ] Jobs created from quotes show attachments added to quote

  ---

## Job Operations Tracking

  Jobs with routings automatically have operations copied from the routing. These operations can be stepped through on the Job Detail page with Start, Complete, Skip, and Undo actions.

  **Operation Status Workflow:**

  - **Pending** - Operation not yet started

  - **In Progress** - Operation currently being worked on (only one at a time)

  - **Completed** - Operation finished successfully (can record actual hours)

  - **Skipped** - Operation skipped (with optional reason)

  **Auto-Progression Rules:**

  - When first operation starts → Job auto-transitions from Pending to In Progress

  - When all operations are completed/skipped (with at least one completed) → Job auto-completes

  - Manual Start/Complete buttons are hidden when operations exist (auto-progression handles these transitions)

  **Database Table: **`job_operations`

  - `sequence` - Execution order (10, 20, 30...)

  - `operation_name` - Name from operation type

  - `status` - pending | in_progress | completed | skipped

  - `estimated_setup_hours` / `estimated_run_hours_per_unit` - Copied from routing

  - `actual_setup_hours` / `actual_run_hours` - Recorded when completing

  - `started_at` / `completed_at` - Timestamps for tracking

  ---

## Material Tracking on Job Operations

  Job operations include expected material definitions copied from the routing when the job is created. This enables operators to know what materials are expected for each operation.

### job_operations.materials Column

  Add the following column to the job_operations table:

  Column: materials | Type: jsonb | Required: No | Description: Expected materials for this operation (copied from routing_node.materials)

### materials JSONB Structure

  The materials field is an array of material specifications:

  ```json
  [
    {
      "inventory_item_id": "uuid",
      "quantity": 0.5,
      "unit": "lbs",
      "inventory_item_name": "4140 Steel Bar"
    }
  ]
  ```

### Job Creation from Routing

  When a job is created with a routing:

  - For each routing_node, create a job_operation

  - Copy routing_node.materials to job_operation.materials

  - Include inventory_item_name snapshot in case item is later deleted

  - Operators can then log actual materials used when completing the operation

[Operator View Module](modules/operator-view.md)
## Overview

  The Operator View module provides a mobile-first interface for shop floor operators to log in with email/password, scan station QR codes to identify their workstation, view their assigned jobs, track time on operations, and mark work complete. This is the primary touchpoint for operators using Jigged on the shop floor.

  **Priority:** Must Have (Build after Jobs module)

  **Dependencies:**

  - Jobs module (operators work on jobs)

  - Authentication system (operator login)

  - Operations module (for operation types)

  **Database Tables:** `operators`, `operator_sessions`

  **Route:** `/operator/{companyId}` (dedicated mobile-first interface)

  ---

## User Stories

  | As a... | I want to... | So that... |
  |---|---|---|
  | Operator | Scan a station QR code to identify my workstation | The system knows which station I am working at |
  | Operator | Log in with my email and password | I can access my work using credentials I already have |
  | Operator | View a list of pending jobs | I know what work is available |
  | Operator | Start work on a job | Time tracking begins and others see Im working on it |
  | Operator | Stop work on a job | I can take a break or switch to another job |
  | Operator | Mark a job operation as complete | The job moves to the next operation or completion |
  | Owner | See which operators are currently active | I have real-time visibility into shop floor activity |
  | Owner | Create and manage operator accounts | I control who can access the operator view |

  ---

## Data Model

### Operators Table

  | Field | Type | Required | Description |
  |---|---|---|---|
  | id | uuid | Yes | Primary key |
  | company_id | uuid | Yes | FK to companies |
  | name | text | Yes | Operator display name |
  | user_id | uuid | Yes | FK to auth.users (Supabase user) |
  | is_active | boolean | Yes | Whether operator can log in (default true) |
  | last_login_at | timestamptz | No | Updated on each successful login |
  | created_at | timestamptz | Yes | Record creation timestamp |
  | updated_at | timestamptz | Yes | Last update timestamp |

### Operator Sessions Table

  | Column | Type | Required | Description |
  |---|---|---|---|
  | id | uuid | Yes | Primary key |
  | company_id | uuid | Yes | FK to companies |
  | operator_id | uuid | Yes | FK to operators |
  | job_id | uuid | Yes | FK to jobs (current job being worked) |
  | operation_type_id | uuid | Yes | FK to operation_types (from station QR code) |
  | job_operation_id | uuid | No | FK to job_operations (the specific operation step being worked) |
  | started_at | timestamptz | Yes | When work session started |
  | ended_at | timestamptz | No | When work session ended (null if in progress) |

  ---

## Routing & Session Tracking

  Operators work on specific routing nodes (operation steps) within a job. The session tracking system must capture which exact step was worked.

### Key Relationships

  `Job → Routing → Routing Nodes (each node is an operation_type)`

  - Station QR codes encode `operation_type_id` (station = operation_type)

  - When starting work, the system finds the matching uncompleted job_operation for that operation_type

  - Sessions track both the operation_type_id (from QR) and job_operation_id (specific step)

### Data Model Update

  **operator_sessions table changes:**

  - Rename `station_id` (text) → `operation_type_id` (uuid FK to operation_types)

  - Add job_operation_id (uuid FK to job_operations) - which specific operation step was worked

  ---

## Job List Filtering Logic

  When an operator scans a station QR code (encoding an operation_type_id), the job list is filtered to show only relevant jobs:

  1. Job status is `PENDING` or `IN_PROGRESS`

  2. Job has an uncompleted job_operation matching the operator's operation_type

  3. All predecessor nodes in the routing DAG must be complete (node is "ready" to work)

  4. Sorted by due date (urgent first), then by job number

  **API:** `GET /api/operator/jobs?operation_type_id={uuid}`

### How routing_node_id is Determined

  When an operator starts work on a job, the system infers the specific job_operation_id:

  1. Operator scans station QR → provides `operation_type_id`

  2. Operator selects a job → provides `job_id`

  3. System queries to find the job_operation where:

  - `routing_id` matches the jobs parts routing

  - `operation_type_id` matches the scanned station

  - `completed_at` is NULL (not yet completed)

  1. This gives the specific job_operation_id to track in the session

  ---

## Routing Advancement Logic

  When an operator marks an operation as complete:

  1. The specific job_operation is marked as completed with timestamp

  2. The current operator_session is ended (end_time set)

  3. If job was in PENDING status, it transitions to IN_PROGRESS

  4. System checks if ALL job_operations for this job are now complete

  5. If all nodes complete → Job status automatically transitions to COMPLETE

  6. Downstream nodes (successors in the DAG) become "ready" for operators at those stations

  **Note:** For parallel routing branches, multiple nodes can be in progress simultaneously on different stations.

  ---

## UI Screens

### 1. Station Login

  **Route:** `/operator/{companyId}/login`

  Mobile-first login screen with email/password authentication. Station is pre-selected if operator scanned a station QR code:

  - Email and password form - mobile-optimized input fields with large touch targets

  - Station QR code parameter auto-captured from URL when scanned

  - Clear error messaging for invalid credentials

### Password Change (First Login)

  Route: /operator/{companyId}/change-password

  When operator logs in for the first time with temp password set by admin:

  - Show "Change Password" prompt (required before proceeding)

  - Fields: Current password, New password, Confirm password

  - Minimum 8 characters for new password

  - On success: Clear needs_password_change flag, redirect to jobs list

  - Store flag in Supabase user metadata: needs_password_change: false

  Implementation: Use supabase.auth.updateUser() with password and data fields.

### 2. Job List

  **Route:** `/operator/{companyId}/jobs`

  List of available jobs the operator can work on:

  - Large, tappable job cards with job number, customer, and part info

  - Visual status indicators (pending, in progress by others)

  - Due date with color coding (on time = green, at risk = yellow, overdue = red)

  - Refresh button for latest job data

  - Bottom navigation bar with Jobs, Active, Profile tabs

### 3. Active Job View

  **Route:** `/operator/{companyId}/jobs/{jobId}`

  Job detail screen when operator is working on a job:

  - Job header with job number, customer, part details

  - Live timer showing time on current session

  - Large STOP button to pause work

  - COMPLETE button to mark operation done

  - View attached files (PDFs, drawings)

  - Optional notes field for operator comments

### 4. Job Complete Confirmation

  Modal/screen shown after marking a job complete:

  - Summary of time spent on job

  - Optional quality notes or issue flagging

  - Confirm button to finalize

  - Returns to job list after confirmation

  ---

## API Endpoints

  | Method | Endpoint | Description | Auth |
  |---|---|---|---|
  | POST | /api/operators | Create operator (admin only - requires service role key) | Admin JWT |
  | GET | /api/operators?company_id={id} | List all operators with emails for a company | Service Role |
  | GET | /api/operators/{operator_id} | Get single operator with email | Service Role |

  Authentication Note: Operators authenticate using Supabase Auth (same as admin users) but access a dedicated operator interface. The system verifies the user has an active operator record for the company.

  Direct Supabase Operations (no backend API needed):

  - Sign in: supabase.auth.signInWithPassword()

  - Sign out: supabase.auth.signOut()

  - Validate operator: Query operators table with RLS

  - List jobs: Query jobs table with RLS

  - Start/stop/complete session: CRUD operator_sessions with RLS

  - Update password: supabase.auth.updateUser()

  ---

## Mobile Design Requirements

  The operator view is designed mobile-first for use on smartphones in shop floor environments. Key design considerations:

### Touch Targets

  - Minimum 48px x 48px touch targets for all interactive elements

  - Large buttons for primary actions (Start, Stop, Complete)

  - Generous spacing between tappable elements to prevent mis-taps

### Visibility

  - High contrast colors for readability under bright shop floor lighting

  - Minimum 16px font size for body text

  - Clear status indicators with color + icon (not color alone)

  - Dark theme to reduce glare and match admin interface

### Navigation

  - Bottom navigation bar (thumb-friendly)

  - Simple 3-tab structure: Jobs, Active, Profile

  - No complex nested navigation

### Performance

  - Fast initial load (target < 3 seconds on 4G)

  - Offline-tolerant - queue actions if connection drops

  - Optimized for portrait orientation

  ---

## Acceptance Criteria

### Authentication

  - [ ] Operator can scan station QR code to identify workstation

  - [ ] Operator can authenticate via email/password

  - [ ] Invalid credentials show clear error message

  - [ ] Session persists until explicit logout or timeout

### Job Management

  - [ ] Operator can view list of pending/available jobs

  - [ ] Operator can start work on a job

  - [ ] Starting work creates a session record with start_time

  - [ ] Job status updates to In Progress when started

  - [ ] Operator can pause/stop work on a job

  - [ ] Stopping work records end_time on session

  - [ ] Operator can mark job operation as complete

### Time Tracking

  - [ ] Active session shows live timer on job view

  - [ ] Multiple sessions per job are tracked separately

  - [ ] Total time per job is calculated from all sessions

### Admin Features

  - [ ] Owner can create operator accounts with name and email

  - [ ] Owner can view list of active operators

  - [ ] Owner can deactivate operator accounts

  - [ ] Owner can reset operator password via email

  - [ ] Owner can bulk delete operators

  - [ ] Owner can export operators to CSV

## Material Consumption Logging

  > 🚧 Future Enhancement: This feature is planned but not yet implemented in the current release. The Job Complete Modal currently supports quantity tracking and notes only.

  When completing an operation, operators log materials consumed. Expected materials are pre-defined in routing nodes.

### Workflow

  1. Routing nodes define expected materials (inventory_item_id, quantity, unit)

  2. When operator taps "Complete", system shows materials expected for this operation

  3. Operator can confirm quantities or adjust if different amounts were used

  4. On submit, inventory transactions are created (type: depletion)

  5. Transactions link to job_id and operator_id for traceability

### UI Update: Job Complete Confirmation Screen

  - Add "Materials Used" section showing expected materials from routing

  - Editable quantity fields for each material

  - Unit selector (primary + secondary units)

  - "No materials used" option if routing has no materials defined

  ---

## Admin Screens (Operator Management)

  Owners manage operator accounts from the admin dashboard.

### 1. Operator List

  **Route:** `/dashboard/{companyId}/team` (tabbed interface with Operators tab)

  - Table: Name, Status (Active/Inactive), Last Login, Actions

  - + New Operator button

  - Active Operators Now widget showing currently logged-in operators

### 2. Create/Edit Operator

  **Route:** `/dashboard/{companyId}/team/operators/new` or `/{id}`

  - Name (required)

  - Email (required) - linked to Supabase user account

  - Active toggle

  - View Work History (link to sessions list)

  ---

## QR Code Specification

### Station QR Codes

  **Format:** URL encoding operation_type UUID

  `https://app.jigged.io/operator/{companyId}/login?station={operation_type_id}`

  - Printed and posted at each workstation/machine

  - Operator scans to identify which station they are working at

  - Generated from the Operations module (each operation_type has a QR code)

### 

  ---

## Token & Session Lifecycle

  - Authentication: Supabase Auth (email/password)

  - Session: Managed by Supabase (standard user session)

  - Storage: Supabase client handles session storage

  - On Expiry: Redirect to login screen (Supabase handles session refresh)

  - Refresh: Automatic via Supabase session refresh tokens

  ---

## Edge Cases & Concurrent Sessions

### Job Already In Progress

  If operator tries to start a job/routing node already being worked by someone else:

  - Show warning: "John is currently working on this operation"

  - Allow "Take Over" option (ends Johns session, starts new session)

  - Johns time is still recorded up to takeover point

### Operator Has Active Session

  If operator with an active session tries to start a new job:

  - Auto-stop current session (end_time set to now)

  - Start new session on the new job

  - Show brief confirmation toast

### Multi-Device Login

  If same operator logs in from a different device:

  - Both sessions remain valid (operators may switch devices)

  - Work sessions are tied to operator, not device

  - Future: Consider notifying when active session exists on another device

  ---

[Inventory Module](modules/inventory.md)
## Overview

  Phase 0 Inventory module providing basic inventory tracking with flexible units of measure and full transaction history. This module enables operators to log material consumption during job completion and provides owners with visibility into stock levels.

  **PRD Requirements Addressed:**

  - **FR-1 (Must): Flexible Inventory Units** - Multiple units per item with automatic conversion

  - **FR-13 (Should): Transaction History** - Full audit trail of all inventory changes

  **NOT in Phase 0:**

  - FR-2: Reorder Alerts (deferred to future phase)

## Dependencies

  - **Operator View** - Material consumption logging creates inventory transactions (Inventory must be built first)

  - **Routings module** - Routing nodes define expected materials per operation

  **Build Order for Material Consumption Flow:**

  1. Routings module (defines routing_nodes with materials JSONB)

  2. Jobs module (creates jobs linked to routings)

  3. Inventory module (tracks materials, provides inventory_items for materials JSONB)

  4. Operator View (logs material consumption → creates inventory transactions)

  **Material Definitions:**

  - Materials are defined in `routing_nodes.materials` (JSONB column in Routings module)

  - Each entry references an `inventory_item_id` from this module

  - No separate routing_node_materials table needed - using JSONB approach

  ---

## User Stories

  **Owner Stories:**

  - As an owner, I want to add inventory items with primary and secondary units so I can track materials in any unit

  - As an owner, I want to view current stock levels so I know what materials are available

  - As an owner, I want to manually adjust inventory quantities so I can correct errors or record receipts

  - As an owner, I want to view transaction history for any item so I have a full audit trail

  - As an owner, I want to export inventory and transaction reports so I can analyze usage patterns

  **Operator Stories:**

  - As an operator, I want to log materials used when completing an operation so inventory stays accurate

  ---

## Data Model

### inventory_items

  Core inventory item records with primary unit tracking.

  | Column | Type | Required | Description |
  |---|---|---|---|
  | id | uuid | Yes | Primary key |
  | company_id | uuid | Yes | FK to companies |
  | name | text | Yes | Item name (e.g., "4140 Steel Bar") |
  | description | text | No | Optional description |
  | sku | text | No | Internal SKU |
  | primary_unit | text | Yes | Primary unit of measure (e.g., "lbs") |
  | quantity | numeric | Yes | Current quantity in primary unit |
  | cost_per_unit | numeric | No | Cost per primary unit |
  | created_at | timestamptz | Yes | Record creation |
  | updated_at | timestamptz | Yes | Last update |

### inventory_unit_conversions

  Secondary units with conversion factors to primary unit. Enables FR-1 (Flexible Inventory Units).

  | Column | Type | Required | Description |
  |---|---|---|---|
  | id | uuid | Yes | Primary key |
  | inventory_item_id | uuid | Yes | FK to inventory_items |
  | from_unit | text | Yes | Secondary unit (e.g., "inches") |
  | to_primary_factor | numeric | Yes | Multiply by this to get primary units |

  **Example:** Steel bar tracked in lbs (primary). from_unit: "inches", to_primary_factor: 0.166 means 1 inch = 0.166 lbs

### inventory_transactions

  Full audit trail of all inventory changes. Enables FR-13 (Transaction History).

  | Column | Type | Required | Description |
  |---|---|---|---|
  | id | uuid | Yes | Primary key |
  | company_id | uuid | Yes | FK to companies |
  | inventory_item_id | uuid | Yes | FK to inventory_items |
  | type | text | Yes | "addition", "depletion", "adjustment" |
  | quantity | numeric | Yes | Amount changed (positive value) |
  | unit | text | Yes | Unit used for this transaction |
  | converted_quantity | numeric | Yes | Quantity in primary unit |
  | job_id | uuid | No | FK to jobs (if from job completion) |
  | operator_id | uuid | No | FK to operators (if operator action) |
  | notes | text | No | Optional notes |
  | created_at | timestamptz | Yes | Transaction timestamp |
  | created_by | uuid | No | FK to users (if admin action) |

  ---

## UI Screens

### 1. Inventory List

  **Route:** /dashboard/{companyId}/inventory

  - Table columns: Item Name, SKU, Quantity, Unit, Last Updated

  - Search by name/SKU

  - "+Add Item" button → Create screen

  - Row click → Item Detail screen

### 2. Inventory Item Create/Edit

  **Routes:** /dashboard/{companyId}/inventory/new, /dashboard/{companyId}/inventory/{id}/edit

  Form Fields:

  - Name (required)

  - Description

  - SKU

  - Primary Unit (required) - e.g., lbs, kg, pcs

  - Current Quantity (required)

  - Cost per Unit

  - Unit Conversions section: Add secondary units with conversion factors

### 3. Inventory Item Detail

  **Route:** /dashboard/{companyId}/inventory/{id}

  - Item details card (name, SKU, description, unit)

  - Current quantity (large display)

  - Quick actions: Add Stock, Remove Stock, Adjust

  - Edit button → Edit screen

  - Transaction History table: Date, Type, Quantity, Unit, Job, User, Notes

  - Pagination for transaction history

### 4. Add/Remove/Adjust Modal

  Modal dialog for inventory adjustments.

  - Select action type: Add Stock / Remove Stock / Adjust

  - Quantity input

  - Unit dropdown (primary + configured secondary units)

  - Notes field

  - System auto-converts to primary unit and updates quantity

  ---

## API Endpoints

  | Method | Endpoint | Description |
  |---|---|---|
  | GET | /api/inventory | List inventory items |
  | POST | /api/inventory | Create inventory item |
  | GET | /api/inventory/{id} | Get item details |
  | PUT | /api/inventory/{id} | Update item |
  | DELETE | /api/inventory/{id} | Delete item |
  | POST | /api/inventory/{id}/transaction | Create transaction (add/remove/adjust) |
  | GET | /api/inventory/{id}/transactions | Get transaction history |
  | GET | /api/inventory/export | Export inventory to CSV |

  ---

## Acceptance Criteria

  **Inventory CRUD:**

  - [ ] Owner can create inventory items with name, unit, quantity

  - [ ] Owner can view list of all inventory items

  - [ ] Owner can edit inventory item details

  - [ ] Owner can delete inventory items

  **Flexible Units (FR-1):**

  - [ ] Owner can add secondary units with conversion factors

  - [ ] When depleting inventory, user can specify any configured unit

  - [ ] System converts to primary unit automatically

  - [ ] Quantity display shows primary unit

  **Transaction History (FR-13):**

  - [ ] All inventory changes create transaction records

  - [ ] Transactions show: timestamp, type, quantity, unit, user

  - [ ] Transactions linked to job show job number

  - [ ] History is filterable and exportable

  **Operator Integration:**

  - [ ] Operator material logging creates depletion transactions

  - [ ] Transactions from operators link to job_id and operator_id

  ---

## Additional Requirements

### Job Operation Tracking

  The inventory_transactions table should include a job_operation_id column (UUID FK to job_operations) to track which specific operation consumed materials. This enables:

  - Linking material consumption to the exact operation step

  - Comparing actual vs expected materials per operation

  - Detailed audit trail for manufacturing traceability

### Quantity Validation Rules

  The system must enforce the following validation rules:

  - Quantity cannot go negative - Depletion transactions that would result in negative inventory must be rejected with an error message

  - Zero quantity allowed - Items can have zero stock (indicates out of stock)

  - Adjustment transactions - Can set quantity to any non-negative value (used for corrections/reconciliation)

### Hard Delete (No Soft Delete)

  Inventory items use hard delete (no deleted_at column). When an item is deleted:

  - The inventory_items record is permanently removed

  - Associated inventory_unit_conversions are cascade deleted

  - inventory_transactions remain orphaned for audit purposes (store item_name snapshot)

[Invitation System](modules/invitation-system.md)
### 5.3 Demo Reset Flow

  1. User clicks "Reset Demo" in demo company settings

  2. Confirmation modal: "This will delete all your changes to the demo"

  3. User confirms

  4. System deletes all company data and re-clones from active template

  5. Page refreshes with fresh demo data

  ---

## 6. UI Components

### New Pages

  - /signup - Modified to handle invite tokens and referral codes

  - /dashboard/[companyId]/settings/team - Invitation management

  - /dashboard/[companyId]/settings/referrals - Referral link management

### New Components

  - InviteTeamMemberDialog - Modal for creating team invitations

  - ReferralLinkCard - Display shareable referral link with copy button

  - InvitationsList - Table of pending/accepted invitations

  - DemoResetButton - Button with confirmation for resetting demo

  - DemoBanner - Visual indicator when viewing demo company

  ---

## 7. Open Questions

  1. Should demo companies count toward any limits? (e.g., if we add company limits later)
    1. No

  2. Should we track referral chain analytics? (who referred who for growth metrics)
    1. Yes

  3. Should demo operators be interactive? (can log in as demo operator for full experience)
    1. Yes

  4. Rate limiting on referral creation? (prevent spam link generation)
    1. Yes

  ---

## 8. Success Metrics

  - Referral conversion rate - % of referral link clicks that result in signups

  - Demo engagement - % of users who interact with demo before creating real data

  - Team invitation acceptance rate - % of team invites accepted vs expired

  - Time to first real job - How quickly users go from signup to creating real jobs

  ---

## 9. Technical Notes

### Email Provider

  Recommend Resend for transactional emails:

  - Modern API designed for developers

  - React Email templates support

  - Generous free tier (100 emails/day, 3,000/month)

  - Easy integration with Next.js and FastAPI

### API Endpoints

  Invitations: POST/GET/DELETE /api/invitations, GET/POST /api/invitations/validate/{token}, /api/invitations/accept/{token}

  Referrals: POST/GET/DELETE /api/referrals, GET /api/referrals/validate/{code}, POST /api/referrals/redeem/{code}

  Demo: POST /api/demo/reset/{company_id}, GET/POST /api/demo/templates

  [Platform Foundation](modules/invitation-system.md#platform-foundation)
## 1. Overview

    Establish platform-level administrative capabilities for managing Jigged as a SaaS product.

### Problem Statement

    No distinction between company admins and platform-level administrators who manage the entire system.

### Solution

    Create a system_admins infrastructure that grants platform-wide privileges.

    ---

## 2. Database Schema

### New Table: system_admins

    ```sql
    CREATE TABLE system_admins (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES auth.users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      created_by UUID REFERENCES auth.users(id),
      UNIQUE(user_id)
    );
    ```

### RLS Policies

    - Only system admins can read/write this table

    - Bootstrap: First admin added via direct DB insert

### Helper Function

    ```sql
    CREATE FUNCTION is_system_admin(user_id UUID) RETURNS BOOLEAN
    ```

    ---

## 3. UI Components

    - None initially (admin operations via Supabase dashboard)

    - Future: /admin dashboard routes

    ---

## 4. API Endpoints

    - GET /api/admin/status - Check if current user is system admin

    ---

## 5. Acceptance Criteria

    - [ ] system_admins table exists with RLS

    - [ ] is_system_admin() function works correctly

    - [ ] At least one bootstrap admin can be added

  [Demo Company](modules/invitation-system.md#demo-company)
## 1. Overview

    Provide every user with an isolated sandbox environment pre-populated with realistic manufacturing data to explore Jigged risk-free.

### Problem Statement

    - New users have no safe way to explore features before committing real data

    - Learning curve is steep without example data to reference

### Solution

    Every new user automatically receives a personal demo company with realistic mock data that can be reset at any time.

    ---

## 2. User Stories

    **System Admin: Create/update demo templates, set active template version, view template usage statistics**

    **All Users: Automatically receive demo company on signup, access demo risk-free, reset demo at any time, switch between real and demo company, demo operators are interactive**

    ---

## 3. Feature Specifications

### 3.1 Demo Company Naming

    Format: "{User's First Name}'s Demo Shop" (e.g., "John's Demo Shop")

### 3.2 Demo Data Included

    - 3 Customers (Acme Manufacturing, Ajax Industries, Precision Corp)

    - 6 Parts with pricing tiers

    - 4 Resource Groups (CNC, Manual, Quality, Finishing)

    - 8 Operation Types with labor rates

    - 3 Routings with nodes and edges

    - 5 Quotes (draft, pending, accepted)

    - 4 Jobs (pending, in_progress, completed)

    - 10+ Job Operations, 8 Inventory Items

    - 2 Demo Operators (Mike Johnson, Sarah Williams) - interactive with PIN codes

### 3.3 Reset Behavior

    1. Deletes all user-created/modified data in demo company

    2. Re-clones from current active template

    3. Preserves company name and user_company_access record

    4. Instant operation (< 3 seconds)

    > 💡 Demo companies do NOT count toward any future limits

    ---

## 4. Database Schema

### 4.1 New Table: demo_templates

    ```sql
    CREATE TABLE demo_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      is_active BOOLEAN DEFAULT FALSE,
      template_data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      created_by UUID REFERENCES auth.users(id),
      UNIQUE(name, version)
    );
    ```

### 4.2 Companies Table Modifications

    ```sql
    ALTER TABLE companies ADD COLUMN is_demo BOOLEAN DEFAULT FALSE;
    ALTER TABLE companies ADD COLUMN demo_template_id UUID REFERENCES demo_templates(id);
    ALTER TABLE companies ADD COLUMN demo_owner_id UUID REFERENCES auth.users(id);
    ```

### 4.3 Database Functions

    ```sql
    CREATE FUNCTION clone_demo_company(p_user_id UUID, p_template_name VARCHAR DEFAULT 'default') RETURNS UUID
    CREATE FUNCTION reset_demo_company(p_company_id UUID) RETURNS VOID
    ```

    ---

## 5. User Flows

### 5.1 Demo Creation on Signup

    1. User completes email verification → 2. System calls clone_demo_company(user_id) → 3. Demo company created with user's name → 4. Demo populated from active template → 5. user_company_access record created (role: admin) → 6. User lands on dashboard

### 5.2 Demo Reset Flow

    1. User clicks Reset Demo button → 2. Confirmation dialog shown → 3. User confirms → 4. Loading indicator → 5. reset_demo_company() called → 6. Page reloads with fresh data → 7. Success toast

    ---

## 6. UI Components

    **DemoBanner**: Sticky banner at top when viewing demo. Text: "You're viewing your demo company." Contains Reset Demo button.

    **DemoResetButton**: Appears in DemoBanner and Settings. Opens confirmation dialog. Shows loading state during reset.

    **Company Switcher Enhancement**: Demo company shows (Demo) suffix or badge with different icon/color.

    ---

## 7. API Endpoints

    - POST /api/demo/create - Create demo for current user

    - POST /api/demo/reset/{company_id} - Reset demo company

    - GET /api/demo/templates - List templates (System Admin)

    - POST /api/demo/templates - Create template (System Admin)

    - PUT /api/demo/templates/{id}/activate - Set active template (System Admin)

    ---

## 8. Success Metrics

    - Demo engagement: % of users who interact with demo before creating real data

    - Demo reset usage: How often users reset their demo

    - Time to first real job: How quickly users go from signup to creating real jobs

    ---

## 9. Acceptance Criteria

    - [ ] demo_templates table with seed data

    - [ ] companies.is_demo, demo_template_id, demo_owner_id columns

    - [ ] clone_demo_company() function works

    - [ ] reset_demo_company() function works (< 3 seconds)

    - [ ] Signup flow creates demo company automatically

    - [ ] DemoBanner displays when viewing demo

    - [ ] Demo company appears in company switcher with badge

    - [ ] Reset Demo button works with confirmation

    - [ ] Demo operators can be logged into

  [Invitation System](modules/invitation-system.md#invitation-system)
## 1. Overview

    Enable viral growth through user-to-user referrals and streamlined team onboarding via email invitations.

### Problem Statement

    No mechanism to invite new users, company admins cannot onboard team members, no viral growth loop.

### Solution

    1. Team Invitations: Admins send email invites for team members with specific roles. 2. Referral Links: Admins generate shareable links for others to create their own companies.

    ---

## 2. User Stories

    **System Admin**: Invite anyone via email, manage all invitations/referrals, view referral chain analytics

    **Company Admin**: Invite team members with role, generate referral links (max 5 uses), see who redeemed, revoke invitations/links

    **Invited User**: Receive email link, see company + role, sign up/in and join, also get demo company (PRD 0B)

    **Referred User**: Click referral link, see referrer, sign up + name company, become owner + get demo (PRD 0B)

    ---

## 3. Feature Specifications

### 3.1 Invitation Types

    Team Invite (Company Admin → email → joins existing company) | Referral Link (Company Admin → shareable URL → creates new company) | System Invite (Platform Admin → email → creates new company)

### 3.2 Limits & Expiry

    Team invite: 7 days | Referral link: 5 uses max, 30 days | 1 pending invite per email per company | Rate limit: 3 referrals/hour/company

### 3.3 Role-Based Permissions

    Admins: Full access | Users: View own invitation history | Operators: No access to invitation features

    ---

## 4. Database Schema

### 4.1 invitations table

    ```sql
    CREATE TABLE invitations (
      id UUID PRIMARY KEY,
      company_id UUID NOT NULL REFERENCES companies(id),
      email VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,  -- admin, user, operator
      token VARCHAR(64) UNIQUE NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',  -- pending, accepted, expired, revoked
      invited_by UUID, accepted_by UUID,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ```

### 4.2 referral_links table

    ```sql
    CREATE TABLE referral_links (
      id UUID PRIMARY KEY,
      company_id UUID NOT NULL REFERENCES companies(id),
      code VARCHAR(20) UNIQUE NOT NULL,
      max_uses INTEGER DEFAULT 5,
      current_uses INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active',
      created_by UUID, expires_at TIMESTAMPTZ NOT NULL
    );
    ```

### 4.3 referral_redemptions table

    ```sql
    CREATE TABLE referral_redemptions (
      id UUID PRIMARY KEY,
      referral_link_id UUID NOT NULL REFERENCES referral_links(id),
      user_id UUID NOT NULL, company_id UUID NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ```

### 4.4 Database Functions

    ```sql
    validate_invitation_token(token) → (valid, company_name, role, email)
    validate_referral_code(code) → (valid, company_name, uses_remaining)
    accept_invitation(token, user_id) → company_id
    redeem_referral(code, user_id, company_name) → new_company_id
    ```

    ---

## 5. User Flows

### 5.1 Team Invitation Flow

    Admin clicks Invite → Enters email + role → System sends email via Resend → Recipient clicks /signup?invite=TOKEN → Validates, shows company/role → User signs up/in → accept_invitation() → Demo created (PRD 0B) → Redirect to dashboard

### 5.2 Referral Link Flow

    Admin creates link → Shares URL → Recipient visits /signup?ref=CODE → Shows Referred by {Company} → User signs up + names company → redeem_referral() → Demo created (PRD 0B) → Redirect to new company

    ---

## 6. UI Components

    **Pages**: /signup (enhanced), /dashboard/[companyId]/settings/team, /dashboard/[companyId]/settings/referrals

    **Components**: InviteTeamMemberDialog, InvitationsList, ReferralLinkCard, ReferralRedemptionsList

    ---

## 7. API Endpoints

    **Invitations**: POST/GET/DELETE /api/invitations, POST /api/invitations/{id}/resend, GET/POST /api/invitations/validate/{token}, /api/invitations/accept/{token}

    **Referrals**: POST/GET/DELETE /api/referrals, GET/POST /api/referrals/validate/{code}, /api/referrals/redeem/{code}, GET /api/referrals/redemptions

    ---

## 8. Technical Notes

    Email: Resend (100/day free, 3000/month) | Tokens: 64 char secure random | Codes: 8 char alphanumeric | Rate limits: 10 invites/hr, 3 referrals/hr per company

    ---

## 9. Success Metrics

    Team invitation acceptance rate | Referral conversion rate | Referral chain depth | Viral coefficient

    ---

## 10. Acceptance Criteria

    - [ ] invitations table with proper indexes and RLS

    - [ ] referral_links table with proper indexes and RLS

    - [ ] referral_redemptions table for analytics

    - [ ] Resend integration working

    - [ ] Team invitation email sends correctly

    - [ ] Invitation accept flow works for new and existing users

    - [ ] Referral link generation and display

    - [ ] Referral redemption creates new company

    - [ ] Rate limiting prevents spam

    - [ ] All flows create demo company via PRD 0B

  > 📋 This PRD has been split into three separate documents for clearer implementation.

  

## Implementation Order

  

  1. [**[Phase 0A: Platform Foundation](https://www.notion.so/Phase-0A-Platform-Foundation-2e95314e84758186a863f4c8f68c3d5d)**](https://www.notion.so/Phase-0A-Platform-Foundation-2e95314e84758186a863f4c8f68c3d5d) - system_admins table for platform-level admin privileges

  2. [**[Phase 0B: Demo Company](https://www.notion.so/Phase-0B-Demo-Company-2e95314e847581518912ed236a58976a)**](https://www.notion.so/Phase-0B-Demo-Company-2e95314e847581518912ed236a58976a) - Sandbox environment with demo data, reset functionality, DemoBanner

  3. [**[Phase 0C: Invitation System](https://www.notion.so/Phase-0C-Invitation-System-2e95314e847581bdb102d04827204734)**](https://www.notion.so/Phase-0C-Invitation-System-2e95314e847581bdb102d04827204734) - Team invitations, referral links, email via Resend

  

  ---

## Dependency Diagram

  ```plain text
  Phase 0A: Platform Foundation
          ↓
  Phase 0B: Demo Company
          ↓
  Phase 0C: Invitation System
  ```

  

  ---

## Summary

  

  **Phase 0A** establishes platform-level admin capabilities (Small effort)

  **Phase 0B** provides demo company sandbox with realistic manufacturing data (Medium effort)

  **Phase 0C** enables viral growth via team invites and referral links (Large effort)

- 
