# Customers Module

## Overview

> **A shop CRM is not a sales pipeline. It is the customer's standing commercial contract, made machine-readable so it stops being retyped onto every document.**

`customers` was a 7-column identity stub until August 2026. It now carries the small set of facts that govern how every quote, job, packing slip and invoice for that customer must be produced: **what terms we agreed**, **whether they're clear to ship to**, and **who pays the freight, on whose account**.

The operating rule for all of it:

> Store only what cannot be derived. Resolve it **at document-create time**, freeze it into the document's own column, and **never read it back at render time**. Show which level a value came from.

That last clause is the whole safety argument, and the reason this is not the `markup_rates` module deleted in July 2026 — that one resolved a shared named default at *read* time with nothing on screen to say where the number came from, so it silently rewrote finished documents.

**Priority:** Must Have · **Dependencies:** none (foundational) · **Tables:** `customers`, `customer_contacts`, `customer_addresses`, `customer_carrier_accounts`

---

## Data model

### `customers` — 12 columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `company_id` | uuid NOT NULL | tenant key |
| `name` | text NOT NULL | unique per company — **`customers_company_name_unique (company_id, name)`, FULL, no `WHERE`** |
| `website` | text | |
| `created_at` / `updated_at` | timestamptz | `updated_at` maintained by the `customers_updated_at` trigger (no column list — fires on every update) |
| `deleted_at` | timestamptz | archive marker |
| `default_payment_terms` | text | standing terms ↓ |
| `default_lead_time_text` | text | |
| `default_fob_point` | text | |
| `credit_status` | text NOT NULL DEFAULT `'open'` | `CHECK (credit_status IN ('open','hold'))` |
| `credit_hold_note` | text | |

Everything unmarked is nullable. `customers_credit_status_check` is the **only** CHECK on the table. There is no `phone`, `email`, `notes`, `tax_status`, `customer_number`, or credit limit — see [Explicitly not built](#explicitly-not-built).

Contacts and addresses live in their own tables so a customer can have many of each.

**`customer_contacts`** — `name` (req), `role` (`buyer` / `accounts_payable` / `engineering` / `quality` / `shipping_receiving` / `other`), `role_label` (required by CHECK when role is `other`), `email`, `phone`, `is_primary` (at most one per customer, `customer_contacts_one_primary` partial unique index).

**`customer_addresses`** — `address_line1`/`2`, `city`, `state`, `postal_code`, `country` (default `USA`), `attention_to` (the "ATTN:" line printed above the address on packing slips), `default_billing`, `default_shipping`.

### `customer_carrier_accounts` — the customer's own UPS/FedEx account

| Column | Type | Notes |
|---|---|---|
| `id` / `company_id` / `customer_id` | uuid NOT NULL | both FKs `ON DELETE CASCADE` |
| `carrier` | text NOT NULL | **free text**, not an enum — an enum regresses the first time a shop uses a regional LTL carrier. UI offers UPS/FedEx/USPS + "Other" |
| `bill_to_party` | text NOT NULL | `CHECK IN ('recipient','third_party')` |
| `account_number` | text | **nullable on purpose** ↓ |
| `account_postal_code` | text | the postal code **of the account**, not of any address on the shipment — UPS validates the pair and rejects a mismatch |
| `account_country_code` | text NOT NULL | default `'US'` |
| `notes` | text | |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | **no `updated_at` trigger** — the access layer sets it explicitly on update and archive |

Three CHECKs. The one worth reading:

```sql
CONSTRAINT customer_carrier_accounts_account_required
  CHECK (bill_to_party <> 'third_party'
         OR (account_number IS NOT NULL AND length(btrim(account_number)) > 0))
```

**A `recipient` row may legally have no account number** — null, empty, or whitespace. LTL bills the payer by name and address on the bill of lading, and FedEx Ground Collect needs no account at all. A blanket `NOT NULL` here is how the column gets poisoned with "N/A" in week one.

`bill_to_party` is not cosmetic: UPS levies a third-party billing surcharge (~5% of base plus accessorials) that bill-receiver does not carry, so storing only "collect" would hide the cheaper legal option. `toBillToParty` falls back to **`recipient`** — the option *without* the surcharge — so an impossible value can never cost the customer money.

One index besides the PK: `idx_customer_carrier_accounts_customer ON (customer_id) WHERE deleted_at IS NULL`. **No unique constraint on `(customer_id, carrier)`** — a customer may hold several accounts with one carrier. No `customer_address_id` and no `scope` enum: the pilot shop had exactly one account, and both would be columns nobody fills. Adding either later is purely additive.

**Security posture.** RLS on, four company-scoped policies for `authenticated`, `GRANT SELECT/INSERT/UPDATE/DELETE` to `authenticated` + `service_role`, **no `anon` grant**, `SELECT public.apply_billing_write_gate(...)`, and an explicit `REVOKE ALL … FROM jigged_ai_readonly`. That REVOKE is load-bearing, not decorative: the baseline's `ALTER DEFAULT PRIVILEGES` grants `SELECT` on **every** new public table to the AI role.

---

## Standing terms

Three customer columns seed three quote columns. All optional; a shop that fills nothing sees byte-identical behaviour to before the feature existed.

| Customer column | Quote column | Levels |
|---|---|---|
| `default_payment_terms` | `quotes.payment_terms` | **two** — customer, then shop-wide |
| `default_lead_time_text` | `quotes.lead_time_text` | one (customer only) |
| `default_fob_point` | `quotes.fob_point` *(new)* | one (customer only) |

**Why payment terms gets a second level and the others don't.** A shop typically has one house term with a handful of exceptions, so customer-only would mean retyping the house term onto nearly every customer. Lead time and FOB are on the discovery watch list — building a shop-wide default for a field we may delete would be spending the effort twice.

`default_fob_point` is **free text naming a place** ("FOB Cleveland, OH"), never an origin/destination enum. FOB governs where title and risk transfer; who *pays* is `freight_terms`, a separate axis on the job and shipment. Conflating them is the classic error in this domain, which is why the two never share a control.

`default_lead_time_text` is, by its own migration comment, the weakest of the three: lead time is a function of shop load and the specific part, so a standing value can become a stale promise.

### Resolution chain

> **customer's own terms → shop-wide default → leave empty**

The shop-wide default lives at **`companies.settings.default_payment_terms`** — a **jsonb key, not a column**. Its writer read-modify-writes the whole `settings` object; writing the key alone would silently drop every feature flag on the company. Blank stores `null`, never `''`, so "unset" has one representation.

It is deliberately **not** in `KNOWN_DEFAULTS` (`lib/companyDefaults.ts`): that registry is numeric to the floor (`coerceInt`, numeric `fallback`, `readCompanyDefault(): number`, a card rendering `type="number"`), so threading one string through it would need a discriminated union across five call sites. `custom_payment_terms` set the precedent for a string setting living beside the numeric block.

Resolution happens **once**, in `QuoteForm.handleCustomerChange`, at customer-select time — never in the access-layer resolvers (`pickPaymentTerms` and friends each read one column, trim, and return `null`; none of them knows about a shop default). The value is copied into the quote's own column and never read from the customer again.

### Provenance — the visible half

A prefilled field carries a helper line naming **which level** it came from:

- `From Acme Corp's standing terms — edit to override`
- `From your shop default — edit to override`

Two answers to "why does this say Net 30?" means the user must not have to go looking for which. Editing the field drops the line and hands ownership to the user permanently.

### Ownership on a customer switch

A field is **ours** (overwritable) when it is empty/whitespace **or** still recorded as prefilled. Anything the user typed or picked is theirs and survives a switch.

**A field we own follows the new customer all the way, including to empty.** Pick Acme (lead time "4 weeks"), realise it's the wrong customer, pick Beta (none) → the field **clears**. Clearing matters as much as filling: a stranded value would also lose its provenance marker, thereafter read as hand-typed, and no later switch would correct it.

Two deliberate asymmetries:
- **Clearing the customer entirely** resets the contact and address FKs but does **not** touch the terms fields or their provenance — previously prefilled terms stay on screen.
- **Edit mode never seeds provenance.** An existing quote owns its terms outright, so opening one for edit shows no "From …" lines even where the values originally came from the customer.

Inline customer creation from the quote form hands the new row **directly** to `handleCustomerChange` rather than reading it back from state, because the `setCustomersById` in the same event handler has not committed yet — reading the map there would miss the customer and quietly prefill the shop default over the terms just typed into the modal.

### Drift — reported, never applied

Computed **on the quote detail page only** (`QuoteForm`'s drift state is a separate, per-line *price* mechanism). Three pairs, each against the customer's **current** value:

| Chip | Compares |
|---|---|
| `Payment terms differs from standing terms` | `quote.payment_terms` vs `customers.default_payment_terms` |
| `Lead time differs from standing terms` | `quote.lead_time_text` vs `default_lead_time_text` |
| `FOB differs from standing terms` | `quote.fob_point` vs `default_fob_point` |

`hasTermDrift` compares trimmed and case-insensitively (`net 30` ≡ `Net 30`), returns **false** when the customer has no standing value (nothing to drift from), and returns **true** when the customer has a value and the quote's field is empty.

**A change to the shop-wide default produces no chip anywhere, and must not.** Shop policy moving is not a per-customer promise changing; chipping every open quote the day a shop edits its house term would train people to ignore the chip. The guarantee is structural rather than conditional — `hasTermDrift` takes the customer's standing terms as its second argument and nothing else, so there is no parameter through which a shop default could reach it.

The chip has **no "update to current" action**, deliberately: re-agreeing terms is a conversation, not a button. (Contrast the price-drift banner directly below it, which does offer repricing.) Its tooltip reads: *This quote says "X". Acme Corp is now set to "Y". The quote keeps what it was issued with.*

### The picker

Options in priority order, deduped **case-insensitively with first-wins**:

1. **In QuickBooks** — terms the shop already has (so `SalesTermRef` always resolves)
2. **Your saved terms** — `companies.settings.custom_payment_terms`, each removable, capped at 15
3. **Standard terms** — `Due on Receipt, Net 15, Net 30, Net 60, 2/10 Net 30, 50% Deposit / Balance Net 30, Prepay, Cash on Delivery`

QuickBooks' spelling wins on a collision — it ships `Due on receipt` (lowercase r) against our `Due on Receipt`, and one term must not occupy two rows. The group names drive ordering and the remove-icon branch only; they are **not** rendered as headers. An "Add New" row is pinned last and survives typing.

QuickBooks terms are fetched in their **own effect**, outside the form's main load, so the quote form never waits on Intuit. `listQuickBooksTerms` resolves to `{connected:false, terms:[]}` on any error, so a shop with no QuickBooks and a shop whose connection is momentarily down take the identical path — the local list. A term typed here is created in QuickBooks at push time, so an unlisted term is never a dead end.

---

## Credit hold

`credit_status` (`'open'` | `'hold'`) + `credit_hold_note`. A human decision, typed by a human. **No balance, no automation, no QuickBooks sync, nothing computed.**

**It warns and never gates.** No code path may block on it — a held customer's quote, job and shipment all proceed.

| Surface | Treatment |
|---|---|
| Customer detail | `Chip "On credit hold"` (warning) beside the name, note beneath in warning colour — placed there because it changes how you read everything else on the page |
| Quote form | `Alert` below the customer picker: *"{name} is on credit hold."* + note |
| Shipment form | Same alert |
| Customer **list** | **Nothing** — a held customer is visually identical to any other row |
| Quote **detail** | **Nothing** |

The guarantee is proved by comparing the submit button's disabled state between a `hold` render and an `open` render — not by asserting it is enabled, which would pass even if the hold did gate, because a blank form disables submit for unrelated reasons.

`credit_hold_note` is **deliberately not cleared when a hold is lifted**, so the next person to place one can see what happened last time. It renders only while `credit_status = 'hold'`, so a leftover note is invisible in the UI while surviving in the DB.

Two states, not E2's three: the design partner could not explain the third, and a state nobody can define is a state nobody sets correctly.

`NOT NULL DEFAULT 'open'` means every pre-existing row satisfied the invariant the moment the migration finished — no backfill, and no "if null, assume open" branch anywhere.

---

## Freight — three grains

> customer's carrier account → **job (set when the PO is read)** → shipment (frozen at pack time)

The middle grain is the point. The freight instruction arrives *on the customer's PO* ("Ship UPS Ground, collect, acct 4A72W9"). Resolving only at shipment creation, days later, means the packer re-derives a customer-level default that may contradict the PO — the sticky note, moved later in the process.

**There is no customer-level `freight_terms` column.** The customer grain is expressed entirely by the account's `bill_to_party`: a single live account resolves to `third_party` or, otherwise, `collect`. A shop cannot store a customer-level standing "prepaid".

| Grain | Columns |
|---|---|
| `jobs` | `freight_terms`, `customer_carrier_account_id`, `ship_via`, `shipping_instructions` |
| `shipments` | `freight_terms`, `customer_carrier_account_id`, `freight_account_snapshot` (jsonb) |

Shipments get no `ship_via` — they already have `carrier`. `jobs.ship_via` holds *the PO's words* ("UPS Ground", "their truck"), which is not the same field.

`FREIGHT_TERMS` is four values, constrained identically at both grains (NULL allowed at both — the job column is constrained deliberately so a bad value cannot flow through the resolver and fail at pack time):

| Value | Label |
|---|---|
| `prepaid` | We pay (prepaid) |
| `collect` | Freight collect (their account) |
| `third_party` | Bill third party |
| `customer_arranged` | They collect it |

`prepaid_and_add` is **excluded**: it promises adding freight to the invoice, and there is no freight amount in the schema (`shipments.weight_lbs` was dropped June 2026). An enum value naming a mechanism the schema cannot execute is why the retired `default_shipping_arrangement` died of non-use. `customer_arranged` **is** included — "our truck will collect it" is a real answer.

Shipments carry one extra constraint jobs do not: `shipments_freight_terms_method_check` permits non-null freight terms only when `shipping_method IN ('shipment','dropship')`. `FREIGHT_TERMS_METHODS` mirrors it client-side and the form nulls both freight columns on submit when freight doesn't apply, so the shipper never meets a raw constraint error. (Switching method does not clear the React state — the panel just stops rendering and the payload nulls them, so switching back restores the earlier choices.)

### `resolveFreightLine`

Three inputs — `{ jobFreightTerms, jobCarrierAccountId, customerAccounts }`. No shipment, no company, no shipping method. Returns `{ terms, account, requiresChoice, source }` with `source ∈ 'job' | 'customer' | 'none'`.

| Case | Result |
|---|---|
| Job named an account | that account + the job's terms, `source: 'job'` |
| Job has terms but no account, terms `prepaid`/`customer_arranged` | terms, account null, `source: 'job'` |
| Job has terms but no account, terms `collect`/`third_party` | falls through to `pickCarrierAccount`, keeps `source: 'job'` |
| Nothing on the job | `pickCarrierAccount`; terms **derived** from `bill_to_party`, `source: 'customer'` |
| Otherwise | nulls, `source: 'none'` |

**`pickCarrierAccount` refuses to guess: it resolves only at exactly one live account.** Zero → null. One → that account. Two or more → null, and the caller must ask. There is deliberately no `is_default` column to break the tie — it was considered and cut because the one shop with data has exactly one account. The failure mode this prevents: a customer with both a parcel account and an LTL arrangement gets whichever row sorts first, and the freight bills to the wrong one — invisible in test data, which has one account. If shops routinely carry two or more, the remedy is to **add `is_default`**, not to pick arbitrarily.

Resolution happens at **form load**, not at submit, so the shipper sees and can override what will be recorded rather than discovering it on the printed slip.

Job-level freight is written **only by `JobEditForm`**, through `updateJobAddressContact`. `JobBillingShippingCard` displays it read-only and writes none of it — the job page renders that card with `readOnly`, so an earlier version that put the editor there was write-dead and left all four columns NULL for every job.

`convertQuoteToJob` deliberately leaves freight NULL (unlike addresses, contact and `payment_terms`, which are carried): prefilling would make the job assert something the PO may never have stated, and `resolveFreightLine` would then mis-report provenance as `'job'`.

### The redaction boundary

> **Redaction is a property of the printed document and the frozen snapshot — never of the packer-facing form.**

| Surface | Shows |
|---|---|
| `ShipmentForm` account picker | **full number** — the packer is at the bench keying it into WorldShip; redacting here sends them back to the sticky note |
| Customer detail, `JobEditForm` picker | **full number** — behind auth, and whoever ships must be able to read it |
| **Printed packing slip** | `••••1576`; `<carrier> (account on file)` when the number was too short to reveal any of; carrier alone when there is no account; **row omitted entirely** when there's no freight at all |
| `freight_account_snapshot` | `{ carrier, bill_to_party, has_account, account_last4 }` — **the full number is never stored** |
| AI SQL layer | **unreachable** |

`account_last4` is NULL when the trimmed number is ≤ 4 characters — showing 3 of 4 is not redaction. The snapshot deliberately does **not** duplicate the account id: `shipments.customer_carrier_account_id` is a real FK one column over, and a copy would diverge the moment the account is archived.

The snapshot trigger fires `BEFORE INSERT OR UPDATE OF customer_id, shipping_address_id, customer_carrier_account_id`, so **editing the underlying account later does not rewrite an existing shipment** — Document Snapshot Standard.

Four independent layers keep the AI out of `customer_carrier_accounts`: absent from `ALLOWED_TABLES`, present in `SENSITIVE_TABLES` (whole-word denylist), `REVOKE ALL FROM jigged_ai_readonly`, and no `ai_readonly_select` policy. `shipments` is not allowlisted either, so `freight_account_snapshot` is equally out of reach.

### Carrier vs account

The slip prints `Carrier:` and `Freight:` one above the other, so a mismatch reads as a contradiction to whoever opens the box. Two mechanisms, both keeping the packer in charge:

- **Seed** — when an account resolves, the carrier select starts on that account's carrier (case-insensitive match, else "Other" with the name filled in). A visible default they can change, not a forced value. A trigger cannot distinguish "stale" from "the packer deliberately corrected it" and would stomp the correction on every save.
- **Warn** — `carrierAccountMismatch` returns a *message*, never a verdict: *"Shipping FedEx but billing the UPS account — the packing slip will show both."* Shipping one carrier while billing another's account is legitimate.

It is computed **outside** the validation memo, which makes it structurally impossible for freight to reach `canSubmit`.

### Cross-customer freight is blocked in the DB

`enforce_job_address_contact_customer` and `enforce_shipment_address_contact_customer` both now reject a `customer_carrier_account_id` belonging to a different customer, raising with `ERRCODE = 'foreign_key_violation'`. A UI-filtered dropdown does not prevent this; billing Customer B's account on Customer A's shipment is the worst bug the feature could produce.

**The two triggers' `UPDATE OF` lists are asymmetric** — jobs watches five columns (`billing_address_id, shipping_address_id, contact_id, customer_id, customer_carrier_account_id`), shipments three (`shipping_address_id, customer_id, customer_carrier_account_id`). Missing the shipments list would mean an update changing *only* the carrier account never fires the guard, at precisely the grain where money moves. *(The migration's own "THE TRAP" comment says "four and two" — it predates the column it added and is stale. Trust the trigger definitions.)*

`create_shipment_with_line_items` went from 9 to 11 parameters, the two new ones trailing with `DEFAULT NULL`. Both hazards are guarded: the `DROP` names the exact old signature (a mismatched `DROP FUNCTION IF EXISTS` **succeeds and does nothing**, leaving the old `SECURITY DEFINER` overload callable), and a trailing `DO` block fails the migration unless exactly one overload exists. All defaulted params must stay trailing — the access layer passes ten named args and omits `p_notes`, and PostgREST resolves RPCs by supplied argument names.

---

## QuickBooks

The chain that carries a customer's terms to an invoice:

```
customers.default_payment_terms → quotes.payment_terms → jobs.payment_terms → SalesTermRef
```

`jobs.payment_terms` is frozen at quote→job conversion and backfilled from the originating quote in its own migration. **The push reads the job row, never the customer or the quote** — the quote may have been edited since.

**The payload sends `SalesTermRef` and deliberately omits `DueDate`.** Verified in the sandbox: supplying both lets `DueDate` win while the term is still stored, so an invoice prints "Terms: Net 60" beside a date seven days out. Sending *neither* — what the code did before this increment — was worst of all: five real invoices came back with `SalesTermRef` null and a due date of exactly `TxnDate + 30`, from a QuickBooks company default nothing in Jigged chose or could see. (Intuit's docs claim the fallback is the transaction date; observed behaviour is +30.)

`resolve_term_id` matches **case-insensitively** because QBO ships `Due on receipt` against our `Due on Receipt`, and creating a Term whose name already exists is rejected with HTTP 400 — a case-sensitive compare would fail the push on the most common term of all. Intuit documents a 31-character cap on `Term.Name`, so a longer term is created truncated and the lookup accepts **both** spellings; otherwise the truncated row we created would never match, we'd re-POST it, take the duplicate 400, and the first invoice on a job would carry a term while every later one silently carried none. It returns `None` rather than raising in every failure mode — a mis-typed term must not block an invoice.

**The customer PO reaches the invoice in four places** (it is `jobs.customer_po_number`, not a customer field):

| Placement | Prints? | Setup |
|---|---|---|
| Line `Description` suffix `(PO Number: X)` | yes | none — what the pilot shop's AP already pays from |
| `CustomerMemo` → "Note to customer" | yes *(verified on a real PDF)* | none |
| Sales `CustomField` | yes | **the shop must create the field by hand** |
| `PrivateNote` | **no** — Intuit documents it as not appearing to the customer | none; internal search only |

**Jigged cannot create the custom field**, verified on both paths: the legacy REST Preferences write returns HTTP 200 and silently changes nothing, and the GraphQL Custom Fields API answers 403 without a paid partner tier. Intuit's own matrix agrees — *"Create custom field names | UI: Yes | API: No."*

So `discover_po_custom_field` **finds** the shop's field, matching on its **label** (`\bp\.?\s?o\.?\b|purchase\s*order`), never its slot position — Intuit states definitions "may not appear in numeric order". Writing to a guessed `DefinitionId` overwrites whatever the shop keeps there and cannot be reassigned, so with no match we send no `CustomField` at all.

**Success-with-no-match and a failed read are different outcomes, deliberately.** No match returns `id: None` — the normal starting state. A failed Preferences read **raises**, and the route turns it into a 502 and writes nothing. "Couldn't check" is not "there is no field": the result is persisted, so swallowing the error would let one Intuit blip wipe a correctly discovered id and silently stop the PO reaching invoices.

**Nothing about terms is cached.** A stored term map would be a second list drifting from QuickBooks' own — the exact problem this removes — to save a four-row query. The PO field *is* cached on `quickbooks_connections`, because it changes only when a human edits QuickBooks settings; refreshing it is an explicit admin button, never a mount or a push.

---

## UI surfaces

### List — `/dashboard/{companyId}/customers`

Six columns: **Name** (pinned), **Contact**, **Email**, **Phone** (all three derived from `primary_contact`, em-dash when absent), **Payment terms**, **Location** (derived from the default-billing address, `sortable: false`).

Search is debounced 300 ms and matches **name only** — not website, contact or city. Sorting is server-side (the colId goes straight to `.order()`). Toolbar: Search · Import · New Customer, with Export CSV and Delete (n) appearing on selection. Empty state: *"No customers yet"* → *"Create your first customer or import from CSV."* (or *"No customers match your search."*).

### Detail — `/dashboard/{companyId}/customers/{id}`

Render order: **header** (name, credit chip + note, website, timestamps) → **Contacts** and **Addresses** side by side → **Terms** → **Shipping** → **Related**.

- **Terms** — read-only here (edited on the form). Shows the three values, `—` when unset. Caption: *"Applied to new quotes for this customer. Quotes you've already sent keep the terms they were created with."* It shows only the customer's own values and never mentions the shop default.
- **Shipping (n)** — carrier accounts. Named *Shipping*, not *Freight*: to a machinist "freight" means all shipping cost. Each row: carrier, bill-to chip, then `Account 4A72W9 · ZIP 97124` or *"No account number (billed on the BOL)"*, notes, Edit / Delete. Empty: *"No carrier accounts. Add one if this customer wants their shipments billed to their own UPS or FedEx account."* Delete **archives**: *"Shipments already billed to this account keep their record. It just stops being offered on new ones."*
- **Related** — Quotes and Jobs head-counts.

### Form — `/customers/new` · `/customers/{id}/edit`

Four sections: **Basic Information** (Company Name, Website) · **Terms & Lead Time** · **Credit** · **Initial Contact** (accordion, create mode only). Addresses and carrier accounts are not editable here.

Terms copy: *"Applied to new quotes for this customer. Changing them here never affects quotes you've already sent. Leave blank if you have no standing agreement."* All three are plain free-text fields — the preset picker lives on the quote form, not here.

Credit copy: *"Putting a customer on hold shows a warning when someone quotes or ships to them. It never stops the work — the decision stays yours."* Selecting **On hold** reveals a Reason field.

`CustomerFormModal` wraps the whole form for quick-create from the quote form, so a customer created there can carry standing terms, a credit hold and a first contact.

`CarrierAccountModal` — Carrier (required) · Who pays · Account number (*"Their account with the carrier. Leave blank for LTL billed on the bill of lading, or FedEx Ground Collect."*) · Account ZIP (*"Carriers check this against the account."*) · Country · Notes.

---

## Archive, revive, and multi-tenancy

Delete is **archive**, per [`docs/architecture.md` §16](../architecture.md). `softDeleteCustomer` stamps `deleted_at`; there is no hard `DELETE` and no reference check, so a customer used by quotes or jobs archives like any other and those documents keep resolving the retained row.

| Query | Filters `deleted_at IS NULL`? |
|---|---|
| `getCustomers`, `getAllCustomers`, `checkCustomerNameExists`, `getCarrierAccountsForCustomer` | yes |
| `getCustomer`, `getCustomerWithRelations` | **no** — by-id reads, so a detail page or a document's retained FK still resolves |

**Name is the identity — reuse revives.** The unique constraint is FULL `(company_id, name)`, covering archived rows, so re-creating an archived name raises `23505`; `createCustomer` catches it and revives. A collision with a *live* row re-throws as a genuine duplicate. A partial (`WHERE deleted_at IS NULL`) constraint would break this.

**A revive is not a fresh create wearing the same name.** It writes `name`, `deleted_at = null`, `updated_at`, and *only the non-blank* values of website and the three standing terms. The caller is always the create form, so a blank means "didn't say", never "deliberately cleared" — writing the whole column set would wipe the archived row's terms. It **never** writes `credit_status` or `credit_hold_note`: lifting a hold must be a deliberate act on the customer page, not a side effect of re-typing a name into a quick-create modal.

Archiving a customer does **not** archive its carrier accounts (a soft delete fires no cascade), so they return intact on revive. An archived carrier account keeps resolving everywhere it matters — shipments and jobs keep the FK (archiving is an UPDATE, so `ON DELETE SET NULL` never fires), the slip prints from the frozen snapshot, and both pickers keep a currently-selected archived row so editing an old document never silently blanks its freight. It loses only its place in the picker for *new* documents.

**RLS + billing gate.** `customers` carries four company-scoped browser policies plus `ai_readonly_select`; `customer_carrier_accounts` gets the write gate via its own `apply_billing_write_gate` call; contacts and addresses are parent-resolved children. A lapsed shop can still **read** every customer and carrier account but cannot create or edit one.

**Permissions.** The shop-wide default payment terms is admin-only (Settings sits behind `AdminGuard`). A customer's own terms and credit hold have no such gate — any member who can edit a customer can set them.

---

## CSV import

Two live paths, both hitting `/api/customers/import/execute`.

**Mappable fields (14):** `name` (required), `website`, `contact_name`, `contact_phone`, `contact_email`, `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `country`, **`default_payment_terms`**, **`default_lead_time_text`**, **`default_fob_point`**.

**Not mappable:** credit status or note (so an import can never set or lift a hold), and no carrier-account field.

The guided flow (`lib/dataImportSchema.ts`) exposes only `name` and `default_payment_terms` — a UI restriction, not a server limit.

The AI column mapper matches source headers against the schema *descriptions*, which deliberately carry legacy-ERP vocabulary: `default_payment_terms` notes *"Often exported as 'Terms', 'Terms Code' or 'Payment Terms'"*, and `default_fob_point` explicitly says it is **not** the freight payment terms, "which describe who PAYS and are not imported here."

Execute sets `deleted_at = None` on every row before upserting on `(company_id, name)`, so **a re-import revives an archived customer** rather than leaving it hidden. A blank cell omits the key entirely rather than writing null. Contacts and addresses attach only to a **new** customer — re-importing an existing one silently drops any contact/address columns in the CSV.

---

## Acceptance criteria

Each bullet cites a real test. Gaps are named as gaps rather than implied to be covered.

**Standing terms**
- Resolvers return the customer value, treat blank/whitespace as no agreement, and trim — `__tests__/utils/customerAccess.test.ts > standing terms — resolution for a NEW quote` (3 its).
- The chain prefers the customer, falls back to the shop default, and names the level — `__tests__/components/quotes/QuoteForm.test.tsx > QuoteForm — standing-terms resolution chain > 'falls back to the shop default and says so…'`, `'prefers the customer's own terms…'`, `'leaves the field empty when neither level has a value'`.
- A switch clears a prefill, survives a second hop, and never touches a hand-typed value — same describe, `'clears a prefilled term when the next customer has none'`, `'still applies the next customer's terms after a clear'`, `'leaves a hand-typed term alone when the customer changes'`.
- The shop default is read from `settings.default_payment_terms`, beside (not inside) the numeric block — `__tests__/lib/companyDefaults.test.ts > readCompanyDefaultPaymentTerms` (5 its, including the regression guard `'lives BESIDE the numeric defaults block, not inside it'`).

**Drift**
- Reported and never applied; no drift when the customer has no value; drift when the quote is empty and the customer now has terms — `__tests__/utils/customerAccess.test.ts > standing terms — drift is reported, never applied` (4 its).
- **Customer-scoped, not shop-scoped** — `> standing terms — drift is customer-scoped, not shop-scoped` (2 its).

**Credit hold**
- Narrowing resolves anything unexpected to `open`, never `hold` — `> credit status — narrowing at the DB boundary` (2 its).
- Warns on the quote form, silent for a customer in good standing, and **leaves the submit button exactly as it was** — `__tests__/components/quotes/QuoteForm.test.tsx` (3 its).

**Carrier accounts & freight**
- `pickCarrierAccount` resolves at exactly one and refuses to guess otherwise — `__tests__/utils/customerCarrierAccountsAccess.test.ts > pickCarrierAccount — refuses to guess` (3 its).
- `toBillToParty` falls back to the option without the surcharge — `> toBillToParty — narrowing at the DB boundary` (2 its).
- Masked for print, full for the bench — `> describeFreightAccount — masked for print, full for the bench` (3 its) and `> maskAccountNumber — for anything that leaves the building`.
- Job wins over customer default, across all seven precedence cases — `> resolveFreightLine — the job wins over the customer default` (7 its).
- Everything printed comes from the snapshot — `> describeShipmentFreight — everything printed comes from the snapshot` (5 its).
- Carrier/account mismatch returns a message, never a verdict — `__tests__/components/shipments/shipmentFormHelpers.test.ts > carrierAccountMismatch` (4 its).
- The table is billing-gated — `api/tests/integration/test_billing_enforcement.py::test_no_tenant_table_left_ungated`.

**Archive / revive**
- A revive never touches the credit hold, leaves unsupplied terms alone, and applies what was supplied — `__tests__/utils/customerAccess.test.ts > createCustomer > reviving an archived customer by name` (3 its).
- `softDeleteCustomer > archives customer by ID (stamps deleted_at)`.

**QuickBooks**
- Sends `SalesTermRef`, never a `DueDate`; omits the key entirely with no term — `api/tests/unit/test_quickbooks_service.py::test_payload_sends_sales_term_and_never_a_due_date`, `::test_payload_without_a_term_sends_no_sales_term_ref`.
- Term matching is case-insensitive and survives the 31-char cap — `::test_resolve_term_id_is_case_insensitive`, `::test_resolve_term_id_matches_the_truncated_name_it_created`, `::test_resolve_term_id_creates_within_the_name_cap`.
- Discovery matches on label, raises rather than reporting a false negative — `::test_po_field_pattern_matches_real_shop_labels`, `::test_discover_po_custom_field_raises_when_it_cannot_ask`.

### Coverage gaps — stated, not implied

| Gap | Consequence |
|---|---|
| **No render test for `ShipmentForm`** | The freight controls, the seeded carrier default and the mismatch alert have no component-level coverage. This is why `carrierAccountMismatch` was extracted to `shipmentMath.ts`. |
| **No test for the carrier-account authoring surface** | `CarrierAccountModal`, `DefaultPaymentTermsCard`, and the four Supabase-touching functions in `customerCarrierAccountsAccess.ts` are untested; only the pure `pickCarrierAccount` is. |
| **`CustomerForm.test.tsx` was not extended** | Its four tests predate the Terms and Credit sections the form now renders. |
| **No page-level test** for the customer list or detail page. |
| **No E2E spec touches the customer CRM.** `quote-detail-drift.spec.ts` covers *price* drift only. |
| **No backend freight test** — the `freight_account_snapshot` freeze is a DB trigger nothing exercises. |
| **`getCompanyDefaultPaymentTerms` / `setCompanyDefaultPaymentTerms` untested** — only the pure reader is covered, so the read-modify-write that actually persists the shop default has no test. |
| **No test for `packingSlipPdf.ts`** — the printed freight row is unverified in CI. |

---

## Known defects

Found by auditing the shipped code. Recorded here rather than fixed silently.

| # | Defect | Effect |
|---|---|---|
| 1 | The revive lookup is case-**sensitive** (`.eq('name', …)`) while the create pre-check is case-**insensitive** (`.ilike`) and the unique constraint is case-sensitive | Archive "Acme Corp", create "acme corp" → the pre-check passes, no `23505` fires, and a **second** customer row is inserted instead of reviving |
| 2 | The importer decides `is_new` on a **lowercased** name but upserts on the case-sensitive constraint | "acme corp" against an existing "Acme Corp" is counted as an update, gets no contact/address — and still inserts a second row |
| 3 | `defaultColDef` sets `sortable: true` and Contact/Email/Phone are not opted out | Clicking those headers sends non-existent columns (`primary_contact_name`, …) to PostgREST's `.order()` |
| 4 | A failed quotes/jobs count is `console.error`'d and reported as `0` | The Related card renders "Quotes 0 / Jobs 0" — a definitive negative for a question never answered, against the [CLAUDE.md](../../CLAUDE.md) rule that "couldn't check" is never "denied" |
| 5 | `hasTermDrift` returns true when the quote's field is empty and the customer has a value; `quotes.fob_point` is new, so every pre-existing quote has it NULL | The day a shop sets `default_fob_point`, every one of that customer's older quotes grows a "FOB differs" chip |
| 6 | An archived customer's detail page renders normally — no banner, Edit and Delete still offered — and quote/job pages link straight to it | An archived customer is reachable by an ordinary click, not just a hand-typed URL |
| 7 | `ShipmentForm` resolves freight **only in job mode**; the customer-mode query doesn't select `carrier_accounts` | A shipment created from the customer surface always saves NULL freight |
| 8 | `bulkImportCustomers` has no callers, discards standing terms, and **blocks** on an existing name instead of reviving | Dead code with semantics opposite to the live importer |
| 9 | Three stale comments | `customerAccess.ts`'s docblock still says rows hold "just identity"; `jobs.payment_terms` claims it is "editable on the job" (no UI writes it — only quote conversion does); the freight migration's "THE TRAP" comment says four/two columns where the triggers say five/three |
| 10 | `getCustomers` (paginated, `{data,total}`) has no callers, and the `filter` argument on both list functions is dead (`_filter`) | `CustomerFilter`'s `active`/`inactive` values have no effect |

---

## Explicitly not built

**Numeric credit limits** — QuickBooks Online has no `CreditLimit` field (Intuit marks it Desktop-only, and its official workaround is typing the number into a Notes field). A limit implies a balance to compare against, which implies the AR subledger this product refuses. The moment `credit_status` grows a threshold, it has become this.

**Customer pricing tiers / group codes** — E2's own manual admits a group code grays out the customer's own values; that is `markup_rates` written down by the vendor.

**An invoices table / AR subledger. Statements & dunning** — QuickBooks already ships three formats plus automated reminders; two engines means the AP clerk gets two past-due emails. **Sales tax calculation** — QBO Automated Sales Tax computes from the address and overwrites anything we send.

**Lead/prospect/opportunity pipeline** — quote-to-book is ~98% on repeat part numbers and below 10% for new customers. Build retention, not acquisition.

**Generic user-defined fields** — the highest-conviction trap, and the evidence is causal: JobBOSS's 69-vote, five-year-old "Add a Shipping tab to Customers" request exists *precisely because* JobBOSS has custom fields, so the UPS account went into one and nobody could report on it.

**Customer code as a second identity key** — imports JobBOSS's own worst problem (JBCORE-I-2022 "Allow Customer ID change", still open). Here a rename is an `UPDATE`.

**Merge/dedup tooling** — name is the identity and upsert-on-name already revives. **AI customer summaries** — banned by the no-AI-on-mount policy. **Trash/Restore UI and permanent purge** — archive plus reuse-by-name already brings a customer back.

⚠️ **Flagged, not fixed:** the invoice push hard-codes `TaxCodeRef: NON` on every line. If the pilot shop has *any* taxable work this is a live under-collection with seller-side audit liability, and it jumps ahead of everything else here.

---

## Open questions

| # | Question | Decides |
|---|---|---|
| 1 | Does any customer have more than one ship-to plant? | Whether address-level freight defaults (`fob_point`, `shipping_instructions`, `print_coc` per address) ever get built |
| 2 | Do shops routinely carry 2+ carrier accounts? | Whether to add `is_default` — the recorded remedy, as opposed to picking arbitrarily |
| 3 | Are `default_lead_time_text` and `default_fob_point` used after 60 days? | Both are on the watch list. Johnny on FOB: *"we sort of ignore that."* If both are still empty across every customer, remove the columns and their form fields together in one migration |
| 4 | Does the shop charge sales tax on any work? | Moves the `TaxCodeRef` fix between P0 and P3 — the highest-consequence unanswered question here |
