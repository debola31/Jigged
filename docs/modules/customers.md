# Customers Module

## Overview

The Customers module manages the master list of companies that the shop does business with. Customers are required to create quotes and jobs.

**Priority:** Must Have (Build First)

**Dependencies:** None - this is the foundational module

**Database Table:** `customers`

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner/Admin | View a list of all customers | I can see who we do business with |
| Owner/Admin | Search customers by name | I can quickly find a specific customer |
| Owner/Admin | Create a new customer with contact details | I can start doing business with them |
| Owner/Admin | Edit customer information | I can keep records up to date |
| Owner/Admin | Delete a customer | I can remove customers we no longer do business with |
| Owner/Admin | Bulk import customers from CSV | I can migrate from my legacy system |

---

## Data Model

The `customers` row holds only **identity** — name + website. Contacts and addresses were split into their own tables (`customer_contacts`, `customer_addresses`), so a customer can have many of each. There is **no** `notes` column, no embedded `phone`/`email`, and no embedded single-contact/single-address columns.

**`customers`**

| Field | Type | Required | Description |
|---|---|---|---|
| name | Text | Yes | Full company name (unique per company — `customers_company_name_unique`) |
| website | Text | No | Company website |

**`customer_contacts`** (one person at the customer; managed via `utils/customerContactsAccess.ts`)

| Field | Type | Required | Description |
|---|---|---|---|
| name | Text | Yes | Contact person's name |
| role | Enum | Yes | `buyer` / `accounts_payable` / `engineering` / `quality` / `shipping_receiving` / `other` |
| role_label | Text | When `role='other'` | Free-text label (DB CHECK requires it for `other`) |
| email | Text | No | Contact email |
| phone | Text | No | Contact phone |
| is_primary | Boolean | — | At most one primary per customer (`customer_contacts_one_primary` partial unique index) |

**`customer_addresses`** (managed via `utils/customerAddressesAccess.ts`)

| Field | Type | Required | Description |
|---|---|---|---|
| address_line1 / address_line2 | Text | No | Street / suite |
| city / state / postal_code | Text | No | Locality (state/country picked from canonical lists) |
| country | Text | No | Default `USA` |
| attention_to | Text | No | "ATTN:" recipient line printed above the address on packing slips |
| default_billing | Boolean | — | At most one default-billing address per customer (partial unique index) |
| default_shipping | Boolean | — | At most one default-shipping address per customer (partial unique index) |

> **Note:** A quote **snapshots** the chosen billing/shipping address and contact at creation time (via `pickBillingAddress` / `pickShippingAddress` / `pickPrimaryContact`), and the printed quote PDF renders that frozen snapshot in its customer block — it does not read the customer's current default. Keep contacts + addresses filled in for customers you send quotes to. Missing fields are skipped cleanly — no "null" placeholders.

---

## UI Screens

### 1. Customer List

**Route:** `/dashboard/{companyId}/customers`

**Features:**

- AG Grid showing: Name, Contact (primary contact name), Email (primary contact email), Phone (primary contact phone), Location (default-billing city/state)

- Search box (searches name, case-insensitive, debounced)

- "New Customer" and "Import" buttons

- Row checkboxes with a bulk **Delete** action (and Export CSV) shown when rows are selected

- Click row (or Enter on a focused row) to open the customer detail page

- Client-side pagination (25 per page, selector for 25 / 50 / 100)

**Empty State:**

"No customers yet. Create your first customer or import from CSV."

### 2. Customer Create/Edit

**Route:** `/dashboard/{companyId}/customers/new` or `/dashboard/{companyId}/customers/{id}/edit`

**Form Sections:**

▸ **Basic Information**

- Company Name (required, unique per company)

- Website

▸ **Initial Contact (optional — create mode only)**

An expandable accordion that captures one optional primary contact so a user can create the customer and its first contact in one step. Fields: Contact Name, Role, Email, Phone (Role label appears when Role = Other). Leaving all fields blank inserts no contact. In **edit mode this accordion is hidden** — contacts and addresses are managed on the customer detail page.

There are **no** Address or Notes sections on this form. Additional contacts and all addresses are added/edited on the detail page.

**Actions:**

- Save → Create mode routes to the new customer's detail page; edit mode routes back to detail

- Cancel → Returns without saving

- Delete (edit mode only) → Confirmation dialog, then hard delete (cascades to contacts + addresses)

### 3. Customer Detail

**Route:** `/dashboard/{companyId}/customers/{id}`

The detail page is the hub for everything below the name:

- Header card: name + website link + created/updated timestamps

- **Contacts** card — list of contacts with a primary star, role chip, and email/phone links; add/edit via `CustomerContactModal`, "Set as primary" on non-primary rows, and per-row delete

- **Addresses** card — list of addresses with Billing / Shipping / "Not assigned" chips; add/edit via the inline `CustomerAddressForm`, and per-row delete (deleting a default warns it will leave the customer without one)

- **Related** card — live counts of the customer's Quotes and Jobs

- **Edit** button (routes to the `/edit` form) and a **Delete** button that is disabled when the customer has related quotes or jobs

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
   Show conflicts if any (duplicate name)
       │
       ▼
5. EXECUTE
   Call /execute endpoint
   Show results: imported, skipped, errors
```

### Conflict Detection

- **Duplicate name** → Conflict (name must be unique per company)

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
    {"row_number": 3, "conflict_type": "duplicate_name", "csv_value": "ACM01"}
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

3. **Missing Required** - Alert if name unmapped

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

- name is required and must be unique per company

- Simple 1:1 column mapping only (no concatenation)

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit -> save -> reload -> persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #333.

**List & search**

- [ ] **Given** a company's customers, **when** the list page loads, **then** it renders an AG Grid of Name / Contact / Email / Phone / Location (primary contact + default-billing city/state joined per row) with client-side pagination at 25/page — *access-layer join verified by `__tests__/utils/customerAccess.test.ts > 'customerAccess utilities' > 'getAllCustomers' > 'returns customers for a company'`; grid rendering automation-pending (`CustomersPage`)*.

- [ ] **Given** the search box, **when** the user types a name fragment, **then** the list filters to customers whose name matches (case-insensitive `name.ilike`, debounced) — *verified by `__tests__/utils/customerAccess.test.ts > 'customerAccess utilities' > 'getAllCustomers' > 'applies search filter correctly'`*.

**Create**

- [ ] **Given** the New Customer form, **when** the user submits with a Company Name, **then** a customer row is inserted (name + website only) and the app routes to the new customer's detail page — *verified by `__tests__/components/customers/CustomerForm.test.tsx > 'CustomerForm' > 'Create mode' > 'creates customer and redirects on success'` AND write path by `__tests__/utils/customerAccess.test.ts > 'customerAccess utilities' > 'createCustomer' > 'inserts customer and returns data'`*.

- [ ] **Given** the create form's optional "Initial Contact" accordion, **when** the user fills a contact name and submits, **then** `createCustomer` receives that contact and inserts it as the customer's primary — *write path verified by `__tests__/utils/customerAccess.test.ts > 'customerAccess utilities' > 'createCustomer' > 'inserts customer and returns data'` (the 3rd-arg initial-contact plumbing is asserted undefined-by-default in `__tests__/components/customers/CustomerForm.test.tsx > 'CustomerForm' > 'Create mode' > 'creates customer and redirects on success'`); populated-contact E2E automation-pending (#367)*.

- [ ] **Given** the create form, **when** the user submits an empty Company Name, **then** an inline "Company name is required" error shows and no insert fires — *verified by `__tests__/components/customers/CustomerForm.test.tsx > 'CustomerForm' > 'Validation' > 'shows error when name is empty on submit'`*.

- [ ] **Given** a name already used in the company, **when** the user submits, **then** an inline "A customer with this name already exists" error shows (enforced by the `customers_company_name_unique` constraint) and no insert fires — *verified by `__tests__/components/customers/CustomerForm.test.tsx > 'CustomerForm' > 'Create mode' > 'shows error for duplicate customer name'` AND lookup by `__tests__/utils/customerAccess.test.ts > 'customerAccess utilities' > 'checkCustomerNameExists' > 'returns true when name exists'`*.

- [ ] **Given** the New Customer dialog opened from the Quote form (`CustomerFormModal`), **when** it is closed and reopened, **then** the embedded form remounts empty (no stale Company Name) — *verified by `__tests__/components/customers/CustomerFormModal.test.tsx > 'CustomerFormModal — reopen remounts a fresh CustomerForm (formKey bump)' > 'clears a typed Company Name when the modal is closed and reopened (no stale value)'`*.

**Edit (edit -> save -> reload -> persists)**

- [ ] **Given** an existing customer, **when** the edit form loads, **then** it pre-fills Company Name + Website and hides the Initial Contact accordion (contacts/addresses are edited on the detail page) — *verified by `__tests__/components/customers/CustomerForm.test.tsx > 'CustomerForm' > 'Edit mode' > 'pre-fills form with existing customer data'`*.

- [ ] **Given** an edited customer, **when** the user saves and the detail page reloads, **then** the new name/website persist — *write path verified by `__tests__/utils/customerAccess.test.ts > 'customerAccess utilities' > 'updateCustomer' > 'updates customer and returns data'`; reload-persistence E2E automation-pending (#367)*.

- [ ] **Given** a customer contact, **when** the user edits it in `CustomerContactModal` and saves, **then** reopening the modal on that contact shows the saved values (re-seeded on open, no stale carry-over) — *write path verified by `__tests__/utils/customerAccess.test.ts` is N/A (contact writes live in `customerContactsAccess`, `updateCustomerContact`, automation-pending); modal re-seed verified by `__tests__/components/customers/CustomerContactModal.test.tsx > 'CustomerContactModal — reopen shows fresh (re-seeded) state' > 're-seeds the Name field from a DIFFERENT existing contact on reopen (no stale carry-over)'`*.

- [ ] **Given** two contacts on a customer, **when** the user marks a different one primary, **then** the previous primary is cleared and only the new one carries the star (DB `customer_contacts_one_primary` partial unique index) — *automation-pending (`setPrimaryContact`)*.

- [ ] **Given** a customer address, **when** the user edits it in the inline `CustomerAddressForm` and saves with Default Billing/Shipping checked, **then** that flag is cleared on any other address and the saved row shows the Billing/Shipping chip on reload — *automation-pending (`updateCustomerAddress`)*.

**Delete**

- [ ] **Given** a customer with zero quotes and zero jobs, **when** the user confirms delete, **then** the row is hard-deleted (its contacts + addresses cascade) and the app returns to the list — *write path verified by `__tests__/utils/customerAccess.test.ts > 'customerAccess utilities' > 'softDeleteCustomer' > 'deletes customer by ID'` (note: `softDeleteCustomer` performs a hard `.delete()` despite the name — rename tracked in #550); reload E2E automation-pending (#367)*.

- [ ] **Given** a customer referenced by quotes or jobs, **when** the user opens its detail page, **then** the Delete button is disabled with a "Cannot delete — customer is referenced by quotes or jobs" tooltip; a bulk delete that hits the FK surfaces "Cannot delete some customers because they have associated parts, quotes, or jobs" — *automation-pending (detail-page guard reads `quotes_count`/`jobs_count` from `getCustomerWithRelations`; bulk guard is the `23503` branch in `bulkSoftDeleteCustomers`)*. **Resolved (#550): the "Delete Behavior" section below documents this shipped block; the snapshot + hard-delete model that would let a referenced customer be removed — deletion drops the customer's count/history while the snapshot keeps their name on historical docs — is Planned, not yet built.**

- [ ] **Given** a contact or address on the detail page, **when** the user deletes it, **then** a confirmation dialog appears (address dialog warns if a default is being removed) and the row is deleted independently of the customer — *automation-pending (`deleteCustomerContact` / `deleteCustomerAddress`)*.

**AI-powered CSV import** (`/customers/import`, backed by FastAPI `/api/customers/import/{analyze,validate,execute}`)

- [ ] **Given** a CSV, **when** the user uploads it and AI analysis returns mappings, **then** the review table shows one row per mapping with the CSV column and a needs-review alert when any mapping is low-confidence — *verified by `__tests__/components/import/MappingReviewTable.test.tsx > 'MappingReviewTable' > 'renders one row per mapping with csv_column + reasoning'` AND `> 'shows the needs-review alert with singular wording for one needs-review mapping'`*.

- [ ] **Given** the review table, **when** the user picks a different DB field (or "Skip") for a column, **then** the mapping change fires with the new field (or null) — *verified by `__tests__/components/import/MappingReviewTable.test.tsx > 'MappingReviewTable' > 'calls onMappingChange with the new db_field when the user changes the dropdown'` AND `> 'calls onMappingChange with null when "Skip" is selected'`*.

- [ ] **Given** validation returns duplicate-name conflicts, **when** the conflict dialog opens, **then** it shows can-import / will-skip / total counts and lets the user proceed importing only the valid rows — *verified by `__tests__/components/import/ConflictDialog.test.tsx > 'ConflictDialog' > 'renders the headline counts (can-import / will-skip / total)'` AND `> 'enables the import button and labels it with the count'` AND `> 'calls onConfirm when the import button is clicked'`*.

- [ ] **Given** zero importable rows, **when** the conflict dialog renders, **then** the import button is disabled — *verified by `__tests__/components/import/ConflictDialog.test.tsx > 'ConflictDialog' > 'disables the import button when validRowsCount is 0'`*.

- [ ] **Given** an import row that maps contact/address columns (`contact_name`/`contact_phone`/`contact_email`/`address_line1`…/`country`), **when** execute runs, **then** the backend writes a `customers` row plus an optional `customer_contacts` row and `customer_addresses` row per customer — *manual: `api/routes/import_routes.py` execute handler splits each CSV row into customer + contact + address payloads (`CUSTOMER_FIELDS` in `types/import.ts` defines the mappable set)*.

- [ ] **Given** the AI provider config, **when** no `ai_config` row exists for the company, **then** import defaults to Claude; a per-company row can select another provider — *automation-pending (provider factory in `api/services/ai/`)*.

---

## Delete Behavior

**Current (shipped): a customer that is referenced by quotes or jobs cannot be deleted through the app.** There is **no** "delete anyway and orphan the records" flow, and nothing sets `customer_id` to NULL as a product action today.

- On the **detail page**, the Delete button is **disabled** whenever the customer has related quotes or jobs — the page computes `hasRelatedRecords` from the `quotes_count` / `jobs_count` returned by `getCustomerWithRelations` and shows a "Cannot delete — customer is referenced by quotes or jobs" tooltip.

- The **bulk delete** path (`bulkSoftDeleteCustomers`) does not pre-check counts; it catches the Postgres foreign-key violation (`23503`) and surfaces "Cannot delete some customers because they have associated parts, quotes, or jobs. Remove those references first." The single-delete path (`softDeleteCustomer`) likewise does not pre-check and re-throws the raw FK error.

- A delete that *does* succeed (an unreferenced customer) cascades only to that customer's own `customer_contacts` and `customer_addresses` (both `ON DELETE CASCADE`).

_DB-level detail (for accuracy):_ the foreign keys to `customers(id)` are mixed — `quotes.customer_id` and `jobs.customer_id` are `ON DELETE SET NULL`, `customer_contacts` / `customer_addresses` are `ON DELETE CASCADE`, and `shipments.customer_id` is `NOT NULL` with a plain FK (`NO ACTION`), so a customer that has shipments is what actually raises the `23503` the delete paths hit. The user-facing guard keys off the `quotes_count` / `jobs_count` check, independent of these constraints. (No `parts → customers` FK exists, despite the bulk error string mentioning "parts".)

> **Planned: snapshot + hard-delete (see #550).** Not built yet. **Owner decision (#333):** hard delete is the model — there is **no archive**, and history for a deleted customer is **not** retained. The intended direction is to (a) **snapshot** the customer's display fields (**name**, bill-to address, contact) onto quotes / jobs / invoices at creation, so each document keeps a readable customer record even after the customer is gone; and (b) rely on the existing **`ON DELETE SET NULL`** on `quotes.customer_id` / `jobs.customer_id` so that deleting a customer removes the live link and its "N quotes / N jobs" count (the count is intentionally not preserved). Deleting a customer that still has **shipments** stays blocked while `shipments.customer_id` is `NOT NULL`. No `is_active` / Archive is planned right now. The snapshot columns don't exist yet — do not treat this as shipped.
