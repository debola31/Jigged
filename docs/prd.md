# Product Requirements Document

### 1. Overview

Jigged is a web-based data platform for small manufacturing shops that struggle to manage their custom workflows in existing legacy systems. It centralizes jobs, inventory tracking, and shop-floor status into focused tabs, then layers on AI-assisted insights to surface bottlenecks and recommend actions to preserve operational efficiency. Gamified experiences for operators—including performance metrics, streaks, and achievements—encourage consistent data capture and process compliance, so owners get reliable, real-time visibility into their production.

**Problem Statement**

Small machine shop owners face three core challenges that legacy ERP systems fail to address:

1. **Inflexible Inventory Management**: They cannot easily record material depletion and additions in both granular and bulk measurements (e.g., depleting 3 oz from a 10 lb bar of steel), and they lack clear signals for when items should be reordered before stockouts impact production.

2. Limited Visibility into Shop-Floor Operations: They lack an integrated view of work in progress tied to revenue and labor. Owners cannot see which jobs are generating revenue, where bottlenecks exist, or how individual jobs are progressing through operation types.

3. Operator Compliance Gaps: They struggle to get operators to consistently follow process steps that aren't blocking but are essential for optimization and traceability—such as logging material usage, recording time at operation types, or following quality checkpoints.

Today, these shops rely on legacy ERP systems like Tangle and E2 JobBoss, which are rigid, hard to customize, and do not provide flexible inventory handling, restock insights, or intuitive, actionable views of shop-floor status and operator compliance.

**Goals and Objectives**

Success looks like:

1. **Reduce admin workload by 10+ hours per week** across shop administrative staff within 3 months of adoption

2. **Achieve operator NPS of 50+** within 6 months of deployment

3. **Achieve administrative staff NPS of 50+** within 6 months of deployment

4. Zero job delays attributable to untracked inventory stockouts within 6 months of adoption

5. **Increase operator workflow compliance from 0% to 60%** within 3 months of adoption

6. **Achieve 100% inventory accuracy** (system counts match physical counts) within 3 months of adoption by enabling frictionless granular inventory updates

**Out of Scope**

1. Integrations with automated factory systems (PLCs, SCADA)

2. Direct machine integrations (CNC program uploads, machine monitoring)

3. Multi-facility/multi-location support (V1 is single-shop focus)

4. Advanced HR/payroll features beyond basic operator tracking

---

### 1.1 Glossary

| Term | Definition |
|---|---|
| Job | A manufacturing order to produce parts for a customer. |
| Routing | A workflow diagram defining how a part is manufactured. Each part has exactly one routing (1:1). Managed from the part detail page. |
| Operation | A single step in a routing (e.g., CNC Turning). |
| Operation Type | A category of operation (e.g., Machining, QC). |
| Part | A company-wide product with name and description. Cost derived from routing when one exists. Not tied to a specific customer. |
| Pricing Tier | A quantity break-point on a part with its own markup % (e.g., "Qty 4 @ 25%"). Unit price is derived live as `base_cost × (1 + markup/100)`. |
| Quote | A cost-plus price estimate. Multi-part; the salesperson quotes one or more quantities per part (each a snapshotted line item, with optional per-line overrides), and each quantity's price is resolved from the part's tiers. Firm (one qty/part → grand total) or price-options (2+ qtys → per-part break tables, no total) is implicit by quantity count. Convert produces one job, one work cell per (part, selected quantity). |

### 2. Users and Use Cases

**Target Users / Personas**

| Role | Description | Primary Goals | Capabilities Needed |
|---|---|---|---|
| Owner | Business owner who oversees all operations, makes strategic decisions. | Maximize revenue, minimize waste, ensure on-time delivery, maintain quality | Dashboard views of work orders, inventory, and revenue. Approve material replenishment. Access business insights and performance metrics. |
| Operator | Manual machine operators who execute defined steps in work orders to build products. May operate CNC machines, lathes, grinders, or perform assembly work. | Complete jobs efficiently, know what to work on next, understand job requirements | Access work orders and instructions. Log progress at stations. View performance metrics and gamified feedback. |
| Admin / Shipping Clerk | Administrative staff who handle material receiving, shipping, customer data management, and general office operations. | Keep inventory accurate, ship orders on time, maintain clean data | Receive inbound materials. Generate shipping labels. Track shipment status. Manage customer records. |
| Salesperson | Handles customer relationships, creates quotes, and converts approved quotes into work orders. | Win customer business, ensure quotes become profitable jobs | Create work orders from quotes. Attach customer specs (PDFs, CAD files). View customer history and order status. |
| Bookkeeper | Manages invoicing, accounts receivable, and financial record-keeping. Often uses QuickBooks for accounting. | Invoice promptly, track payments, keep books accurate | Generate invoices for completed work orders. Track payment status. Export data to QuickBooks. |
| Quality Checker | Inspects finished products from work orders before shipping. | Ensure products meet specifications, catch defects before shipping | Log inspection results. Annotate rework needs on failed jobs. Approve or reject work order completions. |
| Engineer | Estimates material requirements for work orders and configures templates. Designs station routing for jobs. | Create accurate estimates, optimize manufacturing flow | Configure work order templates with station routes. Define material requirements by step. Create BOMs. |

### 2.1 User Roles & Permissions

Jigged uses a simplified 3-role permission model. Each role inherits all capabilities of the roles below it.

### Role Definitions

**Admin** - Full access. Can manage team, create referrals, configure company settings. Inherits all User capabilities. The first user to create a company is automatically an Admin (owner).

**User** - Can interact with all modules (Jobs, Quotes, Parts, Customers, etc.) but cannot manage team members or create referrals. Inherits all Operator capabilities. Use this role for salespeople, bookkeepers, and quality staff.

**Operator** - Shop floor access only. Can log into stations, track time, complete operations, view assigned jobs. Cannot access the admin dashboard.

### Permission Hierarchy

**`Admin > User > Operator`** (each role inherits capabilities of roles below it)

### Capability Matrix

| Capability | Admin | User | Operator |
|---|---|---|---|
| Access Admin Dashboard | Yes | Yes | No |
| Create/Edit Jobs, Quotes, Parts | Yes | Yes | No |
| View Jobs | Yes | Yes | Assigned only |
| Manage Team Members | Yes | No | No |
| Create Referral Links | Yes | No | No |
| Invite Team Members | Yes | No | No |
| Configure Company Settings | Yes | No | No |
| Access Operator View | Yes | Yes | Yes |
| Log Time at Stations | Yes | Yes | Yes |

> 💡 Note: This REPLACES the previous role list (owner/admin/operator/salesperson/bookkeeper/quality). "Owner" is consolidated into Admin. Salesperson, Bookkeeper, and Quality roles are replaced with "User" access.

### Enforcement

Role restrictions are enforced at **two levels**:

1. **Database (RLS):** The `is_company_admin()` function gates write access to team management and company settings to `owner`/`admin` only. Operators are isolated to their own sessions via `get_operator_access_id()`.
2. **UI:** The sidebar hides Team and Settings from non-admin users. Page-level `AdminGuard` components block direct URL access. Operators accessing `/dashboard/*` are redirected to `/operator/{companyId}` by `AuthGuard`.

---

### 4.1 Functional Requirements Table

| ID | Title | Description | Priority | Acceptance Criteria |
|---|---|---|---|---|
| FR-1 | Flexible Inventory Units | System must support multiple units of measurement per inventory item (e.g., a steel bar can be measured in both pounds and inches). When depleting inventory, users can specify the quantity in any supported unit and the system converts accordingly. | Must | Given a steel bar tracked in lbs, when an operator depletes 6 inches, then the system converts to lbs and decrements inventory correctly. |
| FR-2 | Reorder Threshold Alerts | System must display visual alerts when inventory items fall below their configured reorder threshold. Alerts appear on the inventory dashboard and can trigger email notifications to designated users. | Must | Given an item with reorder threshold of 50 units, when quantity drops to 49, then a reorder alert is displayed and optional email sent. |
| FR-3 | Work Order Creation from Quote | Salesperson can create a quote by selecting a customer and part, reviewing cost and markup (or entering them manually), setting lead time and expiration, and attaching files. Quotes are created as "Active" and can be converted directly to jobs — there is no approval ceremony. | Must | Given a new customer order, when salesperson creates quote with cost, markup, and lead time, then it appears in the quotes pipeline with an expiration date and can be converted to a job in one click. |
| FR-3a | Quote PDF Export | Salesperson can export any quote as a branded, customer-facing PDF that includes the shop's FROM block (company name/logo/address/contact), customer bill-to info, part/quantity/unit price/total, validity (Valid Until), lead time, and an acceptance block with signature/PO line. Internal details (routing, cost breakdown, markup, internal status) are excluded. Shop contact info is configured in Settings → Company Profile; logo in Settings → Company Branding. | Must | Given an active quote, when salesperson clicks Print PDF, then a `Quote-{number}.pdf` downloads with the shop FROM block, customer address block, Valid Until + Lead Time, and a signature line — with no routing or markup visible. |
| FR-4 | Quote Lifecycle | A quote is "Active" until its expiration date passes, at which point it flips to "Expired" (read-only but still convertible with a warning). A quote becomes a job via the Convert action, which copies lead time and computes the job due date. The pending-approval / approved / rejected states were removed in April 2026. | Must | Given an active quote with 14-day lead time, when the owner converts it, then a job is created with due_date = today + 14 and the quote links to that job via converted_to_job_id. |
| FR-5 | Station QR Code Login | Operators scan a QR code at a station to log in. The QR code encodes the station ID. After scanning, operator enters their PIN or scans their personal QR badge to identify themselves. | Must | Given an operator at Station 3, when they scan station QR and enter PIN, then they are logged into Station 3 and can assign work orders. |
| FR-6 | Work Order Assignment to Station | Logged-in operator can enter a work order number to begin working on it. System records start time, associates operator with the work order, and tracks time until operator logs out or assigns a different work order. | Must | Given an operator logged into Station 3, when they enter WO-1234, then time tracking begins and WO-1234 shows "In Progress at Station 3". |
| FR-7 | File Attachment Support | Work orders support PDF and CAD file attachments. Files can be uploaded by salesperson or admin. Operators can view attachments from the work order detail page on any device. | Must | Given a work order with attached PDF drawing, when operator views work order on phone, then they can open and zoom the PDF. |
| FR-8 | Work Order Status Lifecycle | Work orders progress through defined statuses: Requested → Approved → In Progress → Quality Checked → Shipped → Delivered → Invoiced → Complete. Status changes are logged with timestamp and user. | Must | Given a work order in Quality Checked status, when QC approves, then status changes to ready for shipping with audit log entry. |
| FR-9 | Invoice Generation | Bookkeeper can generate an invoice for any work order in Shipped or Delivered status. Invoice includes work order details, line items, customer info, and calculated totals. Invoices can be exported as PDF. | Must | Given a shipped work order, when bookkeeper clicks Generate Invoice, then an invoice is created with correct pricing and can be downloaded as PDF. |
| FR-10 | Invoice Payment Tracking | Bookkeeper can mark invoices as Paid and record payment date, amount, and method. System shows aging report of outstanding invoices. | Must | Given an outstanding invoice, when bookkeeper marks as paid with $500, then invoice status updates and aging report reflects the change. |
| FR-11 | Work Order Templates | Owner/Engineer can create templates that define station routing (series or parallel flows), estimated time per station, and materials consumed. Templates speed up work order creation for repeat jobs. | Should | Given a template for "Custom Reamer", when salesperson creates work order using template, then routing and material estimates auto-populate. |
| FR-12 | Operator Performance Gamification | Operators see real-time performance metrics including jobs completed, average time per station, and streaks for consecutive on-time completions. Achievements unlock for milestones. | Should | Given an operator who completes 5 jobs on-time, when they view dashboard, then a "5-streak" badge is visible. |
| FR-13 | Inventory Transaction History | All inventory changes (additions, depletions, adjustments) are logged with timestamp, user, work order (if applicable), and quantity. Users can filter and export transaction history. | Should | Given an inventory item, when user views history, then all transactions are listed chronologically with full details. |
| FR-14 | Shipping Label Generation | Admin can generate shipping labels for completed work orders. Integration with USPS, UPS, and FedEx APIs. Focus on USPS flat rate boxes for initial release. | Should | Given a work order ready to ship, when admin clicks Generate Label, then a USPS label is created and tracking number is stored. |
| FR-15 | QuickBooks Integration | Invoices can be synced to QuickBooks Online via OAuth connection. Sync creates matching invoice in QuickBooks with customer and line item mapping. | Should | Given a Jigged invoice, when bookkeeper clicks Sync to QuickBooks, then invoice appears in QuickBooks with correct customer. |
| FR-16 | Legacy Data Migration | System supports CSV upload for inventory items, customers, and work order history. Upload wizard validates data, flags errors, and allows user correction before import. | Should | Given a CSV export from Tangle, when owner uploads to migration wizard, then data is validated and imported with error report. |
| FR-17 | Owner Dashboard with Insights | Dashboard displays key metrics: active work orders, revenue in progress, inventory alerts, operator compliance rate, and jobs at risk of delay. AI-powered insights highlight bottlenecks. | Should | Given current shop data, when owner views dashboard, then they see WIP value, 3 inventory alerts, and 2 at-risk jobs flagged by AI. |
| FR-18 | Natural Language Business Queries | Owner can type questions like "What was revenue last month?" or "Which customer has the most open orders?" and receive AI-generated answers based on system data. | Could | Given the question "What's my average order value this quarter?", when owner submits, then AI returns calculated answer with source data. |
| FR-19 | Quality Inspection Workflow | Quality Checker can view completed work orders, perform inspection, and mark as Pass or Fail. Failed jobs route back to production with notes. Passed jobs advance to Shipped queue. | Must | Given a work order awaiting QC, when checker marks Fail with notes "Tolerance out of spec", then work order routes back to operator with notes visible. |
| FR-20 | Customer Management | System maintains customer records with contact info, shipping addresses, and order history. New customers are created when first work order is entered. Admin can edit/delete customer records. | Should | Given a new work order for "Acme Corp", when submitted, then Acme Corp customer record is created if not exists with contact details. |

### 4.2 Flows and Scenarios

Flow 1: job Happy Path

1. Customer requests quote from Salesperson

2. Salesperson creates quote with lead time & expiration (status: Active)

3. Salesperson/Owner converts quote directly into a job (job.due_date = today + lead_time)

4. Operator scans operation type QR, enters job number (status: In Progress)

5. Operator completes work, logs output

6. 

7. Quality Checker inspects and approves (status: Quality Checked)

8. Admin generates shipping label, ships order (status: Shipped)

9. Carrier delivers, tracking updates (status: Delivered)

10. Bookkeeper generates and sends invoice (status: Invoiced)

11. Customer pays, bookkeeper marks paid (status: Complete)

**Flow 2: Quality Rejection / Rework**

1. Quality Checker inspects job output

2. QC marks as Fail with notes ("Dimension out of tolerance")

3. job routes back to “In Progress” with rework flag

4. Operator sees rework notification with QC notes

5. Operator completes rework, logs output

6. job returns to QC queue

7. QC re-inspects and approves

**Flow 3: Inventory Reorder**

1. Operator depletes inventory during job execution

2. Inventory drops below reorder threshold

3. System displays alert on Owner dashboard

4. Owner reviews and approves reorder

5. Admin places order with supplier (manual, external)

6. Material arrives, Admin logs receipt to increment inventory

7. Reorder alert clears

**Flow 4: Operator Shift Start**

1. Operator arrives at operation type (e.g., CNC Lathe #2)

2. Operator scans operation type QR code with personal phone

3. System prompts for operator identification (PIN or badge scan)

4. Operator authenticated and logged into operation type

5. Operator views available jobs, selects one

6. Time tracking begins for operator + job + operation type combination

---

### 5. Non‑Functional Requirements (NFRs)

### 5.1 NFR Overview Table

| ID | Category | Requirement | Measurement / Target | Notes |
|---|---|---|---|---|
| NFR-1 | Performance | Page load and API response times must be fast enough for shop floor use | 95% of page loads < 2 seconds, 99% of API requests < 500ms under 50 concurrent users | Operators on shop floor need quick response to maintain workflow |
| NFR-2 | Performance | Mobile experience must be responsive on low-end devices | Functional on 3-year-old Android phones with 4G connection | Operators often use personal phones, not latest models |
| NFR-3 | Security | All data in transit must be encrypted | HTTPS/TLS 1.2+ for all connections | Standard security baseline |
| NFR-4 | Security | Authentication must be secure but not burdensome for shop floor | Supabase Auth with session persistence, optional PIN for quick re-auth | Balance security with operator convenience |
| NFR-5 | Security | Role-based access control | Users see only data/actions appropriate to their role (Owner, Operator, Admin, etc.) | Enforce least-privilege principle |
| NFR-6 | Reliability / Availability | System must be highly available during shop operating hours | 99.5% monthly uptime (allows ~3.6 hours downtime/month) | Scheduled maintenance during off-hours (nights/weekends) |
| NFR-7 | Reliability / Availability | Data must be backed up and recoverable | Daily automated backups, RPO < 24 hours, RTO < 4 hours | Supabase provides automated backups |
| NFR-8 | Scalability | System must support typical small shop workloads | Support 1-50 concurrent users, 10,000+ inventory items, 5,000+ work orders | Designed for small shops; enterprise scale is out of scope for V1 |
| NFR-9 | Usability | Interface must be intuitive for non-technical users | New operator productive within 15 minutes, no formal training required | Shop workers may have limited software experience |
| NFR-10 | Usability | Follow Material Design principles for consistency | Use Material UI component library throughout | Provides professional, consistent UX |
| NFR-11 | Usability | Mobile-first design for operator interfaces | All operator functions fully usable on mobile devices | Operators use personal phones on shop floor |
| NFR-12 | Accessibility | Basic accessibility for vision-impaired users | WCAG 2.1 Level A compliance | Good contrast, keyboard navigation, screen reader basics |
| NFR-13 | Compliance | Data residency in United States | All data stored in US-based data centers | Supabase region selection |
| NFR-14 | Auditability | Key actions must be logged for traceability | Audit log for work order changes, inventory transactions, user logins | Supports quality compliance and dispute resolution |

### 5.2 Additional NFR Details

**Performance Considerations**

Shop floor operations are time-sensitive. If the system is slow, operators will bypass it or enter incorrect data to save time. Target sub-2-second page loads and responsive UI interactions. Consider offline capability for critical functions if connectivity is unreliable.

**Security Model**

Role-based access ensures Operators can only access the Operator View (not admin dashboard), and Users cannot manage team members or company settings.

**Usability for Shop Environment**

Shop floors are noisy, dirty, and workers may have gloves on. UI elements should be large touch targets. QR codes enable login without typing. Consider voice input for future iterations.

---

### 6. Data and Integrations

**Data Model Notes**

**Core Entities:**

- **Customer**: id, name, email, phone, address, created_at, updated_at

- **Inventory Item**: id, name, description, unit_of_measure, quantity, reorder_threshold, cost_per_unit, location, created_at, updated_at

- **Inventory Transaction**: id, item_id, quantity_change, unit, transaction_type (add/deplete/adjust), work_order_id, user_id, notes, created_at

- **Part**: id, company_id, part_name, description, created_at, updated_at (company-wide entity, no customer_id). Pricing is cost-plus and lives on `part_pricing_tiers`: each tier carries its own quantity + markup %; unit price is derived live as `base_cost × (1 + markup/100)` against the routing. Quotes snapshot one `quote_line_items` row per quoted (part, quantity) — the price resolved from these tiers and frozen by default — and may carry per-line price overrides.

- **Part Pricing Tier**: id, part_id, company_id, sequence, quantity, base_cost_per_unit, markup_percent, unit_price, created_at, updated_at. Markup % is the source of truth; typing a unit price back-calculates markup. No per-tier "lock" — for stable customer prices, override at the quote line item.

- job: id, customer_id, part_id, created_by, status, estimated_price, actual_price, priority, due_date, created_at, updated_at (routing auto-resolved from part)

- job Attachment: id, work_order_id, file_name, file_url, file_type, uploaded_by, created_at

- job Template: id, name, description, operation type_routing (JSON), estimated_materials (JSON), estimated_time, created_by

- operation type: id, name, description, qr_code, location, created_at

- Operator Session: id, user_id, operation type_id, work_order_id, start_time, end_time, created_at

- **Invoice**: id, work_order_id, customer_id, amount, status (draft/sent/paid/overdue), due_date, paid_date, quickbooks_id, created_at

- **User**: id, email, name, role (admin/user/operator), created_at

- **Shipment**: id, work_order_id, carrier, tracking_number, label_url, status, shipped_at, delivered_at

- **Quality Inspection**: id, work_order_id, inspector_id, result (pass/fail), notes, inspected_at

**Key Relationships:**

- Part → Routing (one-to-one; each part has exactly one routing)

- Part → Part Pricing Tier (one-to-many; quantity break-points with markup % per tier)

- Part → Company (many-to-one; parts are company-wide, not customer-specific)

- Quote → Quote Line Item (one-to-many; one snapshot per (part, quantity), reconciled on edit with pricing frozen by default)

- Quote Line Item → Job (one-to-one on conversion via `jobs.source_quote_line_item_id`)

- job → Customer (many-to-one)

- job → Part (many-to-one; routing auto-resolved from part)

- job → Template (many-to-one, optional)

- job → Attachments (one-to-many)

- job → Invoice (one-to-one)

- job → Shipment (one-to-one)

- job → Quality Inspections (one-to-many)

- Inventory Transaction → Item (many-to-one)

- Inventory Transaction → job (many-to-one, optional)

- Operator Session → User, operation type, job (many-to-one each)

**External Systems / Integrations**

| System | Type | Direction | Data Exchanged | Protocol / Interface | Notes |
|---|---|---|---|---|---|
| QuickBooks Online | 3rd party | Outbound | Invoices, customer records | REST API, OAuth 2.0 | Sync invoices for bookkeeping; should priority |
| USPS Web Tools | 3rd party | Outbound | Shipping label requests, tracking | REST API | Primary carrier for flat rate boxes |
| UPS APIs | 3rd party | Outbound | Shipping labels, tracking | REST API, OAuth | Secondary carrier option |
| FedEx APIs | 3rd party | Outbound | Shipping labels, tracking | REST API, OAuth | Secondary carrier option |
| Supabase Storage (S3) | Internal | Both | PDF drawings, CAD files, shipping labels | S3-compatible API | File storage for work order attachments |
| OpenAI / Anthropic API | 3rd party | Outbound | Natural language queries, insight generation | REST API | Powers AI insights and NL queries (Could priority) |
| Email Service (SendGrid/Resend) | 3rd party | Outbound | Invoice emails, reorder alerts, notifications | REST API | Transactional email for notifications |

---

### 7. Technical Constraints

1. **Frontend**: Next.js with TypeScript, Material UI component library and iconography

2. **Backend**: FastAPI (Python) for API endpoints

3. **Hosting**: Frontend and Backend hosted on Vercel (backend as serverless functions)

4. **Database**: PostgreSQL hosted on Supabase

5. **File Storage**: Supabase Storage (S3-compatible) for PDFs, CAD files, labels

6. **Authentication**: Supabase Auth (email/password, with optional PIN for quick shop-floor re-auth)

**Risks**

1. **Supabase Vendor Lock-in**: Heavy reliance on Supabase for DB, auth, and storage. Mitigation: Use standard PostgreSQL patterns, abstract storage layer.

2. **Serverless Cold Starts**: Vercel serverless functions may have latency on first request. Mitigation: Keep functions warm, optimize bundle size.

3. **Shop Connectivity**: Manufacturing floors may have spotty WiFi/cellular. Mitigation: Design for graceful degradation, consider offline-first for critical paths.

4. **Integration Complexity**: QuickBooks, shipping carrier APIs have rate limits and can be brittle. Mitigation: Queue-based sync, robust error handling, manual fallbacks.

5. **User Adoption**: Operators may resist new system if not easier than current process. Mitigation: Focus on UX, gamification, involve users in testing.

**Assumptions**

1. Target customers have reliable internet connectivity in their office (may be spotty on shop floor)

2. Operators have access to personal smartphones with modern web browsers (Chrome, Safari)n browsers

3. Shops operate primarily during weekday business hours (maintenance windows available nights/weekends)

4. Initial target is single-location shops (multi-location is V2)

5. English-only interface for V1 (localization is future consideration)

6. Customers are comfortable with SaaS/cloud-based tools (no on-premise requirement)

7. Legacy data from Tangle/E2 JobBoss can be exported to CSV for migration

8. Pilot shop owner available for feedback during development

---

### 8. Milestones and Release Plan

| Milestone | Description | Owner | Target Date | Status |
|---|---|---|---|---|
| Discovery complete | PRD finalized, technical architecture approved, design mockups reviewed | Debola | 2025-12-29  | In progress |
| MVP ready | Core features: Work orders, inventory, operator stations, basic invoicing. Deployed to pilot customer. | Debola | 2026-01-04  | Not started |
| Pilot feedback incorporated | Pilot customer uses system for 60 days, feedback collected and addressed | Debola / pilot shop owner | 2026-04-30  | Not started |
| GA release | Public launch with integrations (QuickBooks, shipping carriers), marketing site live | Debola | 2026-07-31  | Not started |

---

### 9. Open Questions

1. What is the pricing model? (Per-user? Per-shop? Tiered by job volume?)
  1. The pricing model is per user

2. Should operators be able to deplete inventory without associating to a job? (For shop supplies, maintenance materials?)
  1. Yes, you should primarily deplete inventory through jobs but for many other reasons you should be able to do it elsewhere

3. What is the target timeline for MVP deployment to the pilot customer?
  1. 6 months

4. Does the pilot customer have ITAR compliance requirements that would affect data handling?
  1. No

5. What specific reports or exports does the pilot shop owner currently use from Tangle that must be replicated?
  1. Exports to excel for all the data elements, no visualizations yet

6. What is the tolerance for offline operation on the shop floor? (Must-have or nice-to-have?)
  1. Nice to have

7. Should job templates support parallel operation type routing (e.g., two operations happen simultaneously) or only series?
  1. Parallel is a must have

8. What gamification elements are most motivating for operators? (Leaderboards? Badges? Cash bonuses tied to achievements?)
  1. Leaderboards, badges and customization. no cash bonuses as all value should be intrinsic to the app



[PRD Critique](prd-critique.md)
# Executive Summary

  > ⚠️ Overall Assessment: NEEDS WORK - Significant gaps exist between documentation and implementation on main branch.

## Key Strengths

  - Clear problem statement addressing real pain points for small machine shops

  - Well-defined user personas (Owner, Operator, Salesperson, Estimator)

  - Comprehensive user stories in table format for each module

  - Proper multi-tenancy architecture (company_id isolation)

## Critical Gaps

  1. Quotes module not on main branch - Fully developed on feature branch but not merged

  2. Jobs module is placeholder only - DB schema exists but no UI/functionality

  3. Dashboard is empty - Spec calls for KPI cards, due-this-week list, activity feed

  4. Routings module missing entirely - Not even a placeholder page

  ---

# PRD Completeness Analysis

  ✅ Present: Vision & Summary, Problem Statement, User Stories, Functional Requirements, Data Model, Dependencies

  ⚠️ Partial: User Personas, Scope (In/Out), Timeline/Phases

  ❌ Missing: Non-Functional Requirements, Success Metrics, Assumptions, Risks

  ---

# Module Gap Analysis

## Customers Module ✅

  FULL MATCH - All 9 user stories implemented. CRUD, CSV import with AI mapping, bulk operations, soft delete all working.

## Parts Module ⚠️

  MOSTLY ALIGNED - Missing: Filter by customer dropdown, Active/inactive status field and filter

## Quotes Module ❌

  CRITICAL: NOT ON MAIN BRANCH - Exists on feature/quotes-module branch with ~3,320 lines but not merged. Users cannot create quotes.

## Jobs Module ❌

  CRITICAL: PLACEHOLDER ONLY - Page shows 'jobs & Jobs - coming soon'. DB schema exists but no frontend. This is the CORE of manufacturing ERP.

## Operations Module ✅

  FULL MATCH - Resource groups and operation types with labor rates. Only gap: custom fields not implemented (low priority).

## Dashboard Module ❌

  CRITICAL: MINIMAL - Spec has detailed wireframe with 4 KPI cards, jobs due list, activity feed. Implementation is just 'Welcome to Jigged'.

## Routings Module ❌

  PLACEHOLDER ONLY - Page shows 'Production Routings - coming soon'. Schema exists but no UI.

  ---

# Recommendations

## Critical (Must Fix)

  1. Merge Quotes module to main - Sales pipeline is blocked without quoting

  2. Implement Jobs module - Core of manufacturing ERP; without it, system is just a CRM

  3. Build Dashboard KPIs - Owners need at-a-glance visibility

## Important (Should Fix)

  1. Add Routings module - Jobs without routings lack manufacturing process definition

  2. Add Parts filtering - Customer filter and active/inactive status per spec

  3. Document RLS policies - Security configuration should be in PRD

## Minor (Nice to Have)

  1. Add success metrics to PRD

  2. Add non-functional requirements to PRD

  3. Create risk register

  ---

  **Evaluated: **2026-01-02 by Claude Code (Opus 4.5)

  **Branch: **main
