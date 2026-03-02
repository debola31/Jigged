# Customers Module

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
| Owner/Admin | Search customers by name | I can quickly find a specific customer |
| Owner/Admin | Create a new customer with contact details | I can start doing business with them |
| Owner/Admin | Edit customer information | I can keep records up to date |
| Owner/Admin | Delete a customer | I can remove customers we no longer do business with |
| Owner/Admin | Bulk import customers from CSV | I can migrate from my legacy system |

---

## Data Model

| Field | Type | Required | Description |
|---|---|---|---|
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
| notes | Text | No | Internal notes |

---

## UI Screens

### 1. Customer List

**Route:** `/dashboard/{companyId}/customers`

**Features:**

- Table showing: Name, Contact, Phone, City/State

- Search box (searches name)

- "+ New Customer" button

- Click row to view/edit

- Pagination (25 per page)

**Empty State:**

"No customers yet. Create your first customer or import from CSV."

### 2. Customer Create/Edit

**Route:** `/dashboard/{companyId}/customers/new` or `/dashboard/{companyId}/customers/{id}/edit`

**Form Sections:**

▸ **Basic Information**

- Company Name (required, unique per company)

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

▸ **Other**

- Notes (multiline)

**Actions:**

- Save → Returns to list

- Cancel → Returns to list without saving

- Delete (edit mode only) → Confirmation dialog, then hard delete

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

### Core CRUD

- [ ] Can view paginated list of customers

- [ ] Can search customers by name

- [ ] Can create new customer with required fields

- [ ] Can edit existing customer

- [ ] Can delete a customer (hard delete with confirmation)

- [ ] Customer name is unique within company

- [ ] Form shows validation errors inline

### AI-Powered Import

- [ ] Can upload CSV file and see preview

- [ ] AI analyzes CSV and suggests column mappings

- [ ] Confidence scores displayed with color coding (green/yellow/red)

- [ ] Can manually override AI-suggested mappings

- [ ] Shows unmapped required fields as alert

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
