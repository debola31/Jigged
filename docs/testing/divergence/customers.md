# Divergence report — Customers (#333)

Method: compared `docs/modules/customers.md` against the real UI (`app/dashboard/[companyId]/customers/**`, `components/customers/**`), the access layer (`utils/customerAccess.ts`, `utils/customerContactsAccess.ts`, `utils/customerAddressesAccess.ts`), the CSV-import backend (`api/routes/import_routes.py`), the schema (`supabase/schema.prod.sql`), and the tests under `__tests__/utils/`, `__tests__/components/customers/`, and `__tests__/components/import/`.

## Fixed in this PR

- **Data Model listed a flat single-table customer with embedded contact/address/notes columns.**
  - *What was wrong:* the table listed `phone`, `email`, `contact_name`, `contact_phone`, `contact_email`, `address_line1/2`, `city`, `state`, `postal_code`, `country`, and `notes` as columns on `customers`.
  - *What's right:* `customers` holds only `name` + `website` (plus id/company_id/timestamps). Contacts live in `customer_contacts` (name, role, role_label, email, phone, is_primary) and addresses in `customer_addresses` (address lines, city/state/postal_code, country, attention_to, default_billing, default_shipping). There is **no** `notes` column anywhere, and no embedded `phone`/`email` on the customer. Confirmed in `supabase/schema.prod.sql` lines 100–145.
  - *What changed:* replaced the single table with three tables (`customers`, `customer_contacts`, `customer_addresses`) and rewrote the accompanying note to describe the quote-time address/contact **snapshot** rather than reading embedded fields.

- **Customer Create/Edit form documented Primary Contact, full Address, and Notes sections.**
  - *What was wrong:* the form was described as having "Primary Contact" (name/phone/email), "Address" (all fields), and "Other → Notes" sections.
  - *What's right:* the create/edit form (`components/customers/CustomerForm.tsx`) has only **Basic Information** (Company Name, Website) plus an optional **Initial Contact** accordion that is create-mode-only (name/role/email/phone) and hidden in edit mode. Addresses and additional contacts are managed on the detail page. There is no Notes field. The edit-mode test asserts the Initial Contact accordion is absent.
  - *What changed:* rewrote the "Form Sections" list to Basic Information + Initial Contact (create only), and stated explicitly that Address/Notes sections do not exist.

- **Customer List columns were stale.**
  - *What was wrong:* "Table showing: Name, Contact, Phone, City/State".
  - *What's right:* AG Grid columns are Name, Contact (primary contact name), Email, Phone, Location (default-billing city/state); plus row checkboxes with bulk Delete + Export CSV, and pagination selector 25/50/100. Confirmed in `app/dashboard/[companyId]/customers/page.tsx` `columnDefs`.
  - *What changed:* rewrote the List "Features" bullets.

- **Customer Detail was marked "(Optional for Phase 0)" and "Read-only".**
  - *What was wrong:* the section said the detail page is optional and a read-only view with "related quotes/jobs (future)".
  - *What's right:* the detail page is fully built and is the CRUD hub for Contacts (add/edit/delete/set-primary) and Addresses (add/edit/delete), shows live Quotes/Jobs counts, and has Edit (routes to `/edit`) + a Delete button. Confirmed in `app/dashboard/[companyId]/customers/[customerId]/page.tsx`.
  - *What changed:* rewrote the Detail section to describe the Contacts/Addresses/Related cards and the disabled-when-related Delete button.

- **Acceptance Criteria** were flat checkboxes with no verification clauses. Rewritten to the locked Given/When/Then format grouped under List/Create/Edit/Delete/Import, every editable entity (customer, contact, address) carrying an edit→save→reload bullet, each with a cited test or an automation-pending tag.

## Resolved (owner decision)

- **Delete behavior: block-when-referenced ships today; snapshot + archive is the intended (unbuilt) future — #550.**
  - *Decision:* the intended direction is (a) **snapshot** the customer's display fields (name, bill-to address, contact) onto quotes / jobs / invoices at creation; (b) keep a **nullable `customer_id` FK with `ON DELETE SET NULL`** for the live count/link; and (c) make **Archive** (`is_active`) the default verb with a gated **"Permanently delete"**. **This is not built yet** and must not be presented as shipped.
  - *Current shipped behavior (now documented as such):* a customer referenced by quotes or jobs cannot be deleted through the app — the detail-page Delete button is disabled off `quotes_count`/`jobs_count` (`getCustomerWithRelations`), and `bulkSoftDeleteCustomers` catches the FK `23503` and throws "Cannot delete some customers because they have associated parts, quotes, or jobs." At the DB the constraints are mixed: `quotes.customer_id` / `jobs.customer_id` are `ON DELETE SET NULL`, `customer_contacts` / `customer_addresses` are `ON DELETE CASCADE`, and `shipments.customer_id` is `NOT NULL` with `NO ACTION` — the FK that actually raises the `23503`. No `parts → customers` FK exists (the bulk error string's "parts" is inaccurate).
  - *Doc fix applied:* the old "Delete Behavior" prose — which falsely claimed customers can be deleted with related quotes/jobs and their `customer_id` NULLed via a warning dialog — is corrected to the block-when-referenced behavior, with the snapshot + archive model added as a clearly-labeled **Planned (see #550)** note. The delete-blocked AC's cross-reference was updated to point at that Planned note instead of this (now-resolved) item.

- **`softDeleteCustomer` name vs. hard delete: describe the actual behavior; rename tracked in #550.**
  - *Decision:* the function is misnamed — `softDeleteCustomer` / `bulkSoftDeleteCustomers` both issue a hard `.delete()`, and there is no soft-delete / `deleted_at` column on `customers`. Document the actual hard-delete; the rename is tracked in #550 (no real soft-delete is being introduced now).
  - *Doc state:* the delete AC and the "Delete Behavior" section describe the hard delete and note the misnomer plus the #550 rename. No behavior change is claimed.

- **`CustomerStatusChip` / active-inactive filter is dead: remove it; no customer-status feature is planned (code removal #550).**
  - *Decision:* there is **no** customer-status feature planned and **no** status / `is_active` column on `customers`. Remove the dead `components/customers/CustomerStatusChip.tsx` and the `'active' | 'inactive'` `CustomerFilter` type / ignored `_filter` arg on `getCustomers` / `getAllCustomers` (code removal tracked in #550).
  - *Doc fix applied:* the doc never claimed a status feature; the only implied surface — the "List, search & filter" AC heading — is renamed to "List & search" so no non-existent filter is implied.

## Decision needed

_None — all previously-open items are resolved by owner decision above (tracked for code cleanup in #550)._

## Informational / aligned

- **Name uniqueness** ("unique per company") matches `customers_company_name_unique` and the `checkCustomerNameExists` pre-check; kept as-is.
- **AI CSV import** flow (5 steps), endpoints (`/api/customers/import/analyze|validate|execute`), confidence colour bands, conflict = duplicate-name, and the `ai_config` provider-selection table all match `api/routes/import_routes.py` and `types/import.ts`. The import UI components (`MappingReviewTable`, `ConflictDialog`, `ConfidenceChip`) are the shared `components/import/*` set the customer import page renders; their tests are cited in the ACs.
- **Import field mapping** — `CUSTOMER_FIELDS` (`types/import.ts`) maps `name`, `website`, `contact_name/phone/email`, and `address_line1/2`, `city`, `state`, `postal_code`, `country`; the execute handler splits each row into a customer row plus optional contact + address rows. Aligned with the (now-corrected) three-table model.
- **Routes** — `/customers`, `/customers/new`, `/customers/{id}`, `/customers/{id}/edit`, `/customers/import` all exist as documented.
- **Empty state** copy ("Create your first customer or import from CSV") matches the list page.
- There is **no** customer-specific CSV-import E2E spec — `e2e/csv-import.spec.ts` covers **parts** ("import parts from CSV file"), so it is not cited for customers.
