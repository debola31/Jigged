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

- **Delete = archive (soft-delete), never blocks — supersedes the #333 / #550 hard-delete decision.**
  - *Shipped (PR #580):* per `docs/architecture.md` §16, `customers` has a nullable `deleted_at`, and "Delete" sets it via `.update()` — never a SQL `DELETE`, and never blocked. `softDeleteCustomer` / `bulkSoftDeleteCustomers` `UPDATE deleted_at = now()`; the list/bulk flow confirms through `DeleteImpactDialog` (impact/warn, not a block). A customer referenced by quotes / jobs / shipments archives fine — the row survives so those FKs still resolve, and history is retained. Reads filter `deleted_at IS NULL` (`getAllCustomers`, `checkCustomerNameExists`); by-id reads (`getCustomer`) don't, so a retained FK still resolves an archived row.
  - *Revive-by-name:* name stays the natural identity (`customers_company_name_unique` full `(company_id, name)` constraint → one row per name). Re-creating an archived name revives the row — `createCustomer` catches `23505` → `reviveArchivedCustomerByName` (clears `deleted_at`) — and the CSV import upsert sets `deleted_at = NULL`. `checkCustomerNameExists` is live-scoped so archived names don't falsely block.
  - *Supersedes:* the prior #333 / #550 "hard delete is the model, no archive, history not retained, block-when-referenced, snapshot + hard-delete Planned" decision is no longer accurate — archive is shipped and history is retained. Restore/Trash UI + permanent purge are deferred (not built). (Contacts/addresses deleted individually from the detail page are still real deletes — sub-entities, not archived.)
  - *Doc fix applied:* the customers.md "Delete Behavior" section and the Delete acceptance criteria were rewritten to the archive model (never blocks, revive-by-name, history kept) with a pointer to §16; the old block-when-referenced / snapshot-+-hard-delete framing was removed.
  - *Remaining UI cleanup (owed, not a doc issue):* the customer **detail page** (`app/dashboard/[companyId]/customers/[customerId]/page.tsx`) still carries pre-archive leftovers — the Delete button is `disabled` when `quotes_count`/`jobs_count` > 0 with a stale "Cannot delete — customer is referenced by quotes or jobs" tooltip, and the confirm dialog still says the customer + contacts/addresses are "permanently delete[d]… can't be undone." Both contradict the archive access layer (which never blocks and keeps the rows). The list page already uses the archive flow correctly; the detail page's guard + copy are pending cleanup.

- **`softDeleteCustomer` name is now accurate (no longer a misnomer).**
  - *Shipped:* `softDeleteCustomer` / `bulkSoftDeleteCustomers` genuinely soft-delete — they stamp the real `customers.deleted_at` column, which now exists. The earlier note that the name was a misnomer for a hard `.delete()` (rename tracked in #550) is obsolete.
  - *Test:* `__tests__/utils/customerAccess.test.ts > 'customerAccess utilities' > 'softDeleteCustomer' > 'archives customer by ID (stamps deleted_at)'` asserts the `.update({ deleted_at })`.

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
