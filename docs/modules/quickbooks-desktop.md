# QuickBooks Desktop

How Jigged pushes invoices — and, since 2026-11, vendor purchase orders — into a **locally
installed** QuickBooks Desktop, via [Conductor](https://conductor.is). The companion to
[invoicing.md](invoicing.md), which owns the billing model, and to [purchasing.md](purchasing.md),
which owns the PO push — this doc owns only what is different about Desktop.

**A company connects EITHER QuickBooks Online OR QuickBooks Desktop, never both.** That is a
database invariant (`assert_single_accounting_provider()`, a BEFORE INSERT trigger on both
connection tables), not merely a route check.

---

## The shape of the integration

Conductor is a hosted API that relays to the **QuickBooks Web Connector**, a Windows program that
ships with QuickBooks and polls out to Conductor's servers. So every call is a round trip to a PC
in the shop.

```
Jigged (FastAPI)  →  api.conductor.is  →  Web Connector (shop PC)  →  QuickBooks Desktop
```

Consequences that shape everything below: **QuickBooks must be open on a machine that is powered on
and online**, latency is seconds rather than milliseconds, and "not reachable" is an ordinary state
rather than a fault.

| Observed on Enterprise 24 | |
|---|---|
| health check, cold | ~5.7 s |
| create invoice | ~3.0 s |
| filtered list | ~4.9 s |
| `INTEGRATION_CONNECTION_NOT_SET_UP` | 0.15 s (answered at Conductor's edge) |

Vercel kills a function at 60 s, so the client timeouts sit well under it — **our** code must decide
the outcome, because a platform kill runs no `except`.

---

## Connecting

There is **no OAuth redirect**. The backend creates a Conductor *end user* (`sourceId` = the Jigged
company id, so the mapping is 1:1 and connect is idempotent) and an *auth session*, which returns a
link the shop opens **in a browser on the computer that runs QuickBooks** — usually not the computer
the admin is sitting at. Jigged learns the outcome by asking, never by being called back.

**A connection record is not a working connection.** Conductor creates the `integration_connection`
the moment the flow *starts*, so a shop that downloaded the `.qwc` and stopped presents as connected
while every call returns 409. `linked` therefore keys on `lastSuccessfulRequestAt`.

At the shop PC: QuickBooks open, signed in as **Admin**, company file in **single-user mode** for the
first authorisation (the Application Certificate dialog does not appear otherwise — the commonest
"the auth flow just hangs"), and choose **"Yes, always; allow access even if QuickBooks is not
running"**.

---

## What is different from QuickBooks Online, and why

Each of these was **measured** against Enterprise 24 (Manufacturing & Wholesale edition, Rock Castle
Construction sample company) on 2026-08-10. Two contradict Conductor's documentation.

### Invoice numbering is QuickBooks' job
Posting with **no** `refNumber` makes QuickBooks assign the next one itself — file max was 1098, we
got 1100. Conductor documents the opposite. And a **duplicate** `refNumber` is accepted *silently*:
two invoices, one number, no error. So a reserved number is unnecessary for continuity and cannot
prove uniqueness. Jigged sends none.

### The recovery key is `externalId`, not the invoice number
Conductor has **no idempotency mechanism**: it does not deduplicate `externalId`, and List Invoices
cannot filter on it. It does not need to — listing by `customerIds` plus a one-day
`transactionDate` window returns a handful of rows and the match is client-side. `externalId` is the
draft's `qb_request_id`, unique by construction.

### A create that times out may still have landed
Verified by aborting one at 1 s: the invoice existed anyway. So a write timeout is an **unknown
outcome**, never a failure, and **is never retried automatically** — that is exactly how a customer
gets billed twice. See the state machine below.

### Every line carries the customer's own sales-tax code
A line sent with **no** `salesTaxCodeId` defaults to `Non` and is **not taxed**, even for a customer
whose record reads `Tax` and an invoice header showing 7.75%. Omitting it silently **under-bills** a
taxable sale. QuickBooks Online does the opposite — it pins `TaxCodeRef=NON`, because there an
omitted code is *taxable* under Automated Sales Tax. **Same intent, opposite mechanics; the asymmetry
is the fix, not an inconsistency to tidy away.**

Consequence: the QuickBooks invoice total can exceed Jigged's line total by the tax, so **no Jigged
surface may claim to show "the invoice total"**.

### Other differences
- **`purchaseOrderNumber` is a native field** (25 chars), so none of QBO's custom-field discovery
  applies.
- **`rate`, never `amount`** — Conductor ignores `rate` when `amount` is present, which erases the
  unit price and prints a lump sum. AP reconciles qty × unit price against a PO.
- **`transactionDate` is required** (QBO derives its own). It comes from the browser, which knows the
  shop's timezone, bounded server-side to ±1 day so nobody can backdate into a closed period.
- **`memo` does not print** — it is the Desktop analogue of QBO's `PrivateNote`.
- **No deep link, and this was checked properly — do not re-investigate.** There is no web app, so
  `qb_invoice_url` is null. Nor is there any local mechanism: Intuit publishes no URL scheme,
  command-line switch or qbXML request that navigates the QuickBooks UI to a transaction, and the
  one `QuickBooks:` protocol handler registered on a Windows box with Enterprise 24 installed
  belongs to `ConnectedServicesProtocolHandler.exe` (sign-in and entitlements), not to
  transactions. The Desktop SDK is data-only — Add/Mod/Query/Del — and its UI Extensions run the
  other way, putting a menu item *inside* QuickBooks that launches an external app. Anything that
  did work would mean shipping a signed Windows helper to every shop PC to drive QuickBooks by
  synthetic keystrokes, which breaks on any version change and is not worth it.
- **So the Invoices menu copies the number instead of navigating.** For a Desktop row the invoice
  number is the only handle a human has, and retyping it off the screen is where the digit gets
  transposed; clicking the row copies it and the menu stays open so the confirmation is seen. The
  matching gesture in QuickBooks is Ctrl+F → paste into **Invoice #** → Enter, and the menu says
  so. `copyText` ([utils/clipboard.ts](../../utils/clipboard.ts)) carries the `execCommand`
  fallback that plain-http localhost needs, and reports failure rather than claiming a copy that
  did not happen.
- **The income account is chosen by an admin, never guessed** — the one required setup step, and
  the first push is refused until it is done, because wrong revenue accounts are invisible until
  month end. When the company file has exactly one income account it is selected automatically:
  that is not a guess, it is a question with a single possible answer. Changing it later is
  [below](#changing-the-income-account).
- **There is no bulk customer-matching step.** Customers are resolved on the invoice being sent —
  link to an existing one or create it — exactly as the QuickBooks Online path does. Asking a shop
  to reconcile their whole customer list before they have invoiced anything is work without a
  reason, and an unmatched customer was never a problem: it is created at push time.
- **A customer name over 41 characters is refused, not truncated.** Two customers can share their
  first 41 characters, and a collision would invoice the wrong company. Terms *are* truncated — a
  term is a label, a customer is an identity.
- **Payment status is Online-only, and a Desktop row shows none.** The
  [QBO mirror](invoicing.md#payment-status-quickbooks-online-mirror) rests on two things Desktop does
  not have: an Intuit webhook to say an invoice changed, and a read that answers while somebody is
  waiting. Here a read is a **Web Connector round trip to the shop's PC** — it runs when that
  machine next polls, so a computer that is off, asleep or has QuickBooks closed answers nothing,
  and the same silence would have to render as both "not checked yet" and "we asked and it is
  open". Showing no chip is honest; a chip whose freshness depends on whether a PC in another
  building is awake is not. The reachability signal the Desktop path *does* have is the explicit
  Test connection button, which is a different question — is the file reachable at all — and it is
  already there.

---

## Changing the income account

**As built 2026-11-12.** Every invoice line posts under one service item, **"Machined Parts"**, and
the item — not the invoice — carries the income account. Saving a new account in Settings clears
`default_service_item_id`, so the next push re-resolves the item. **That re-resolve reuses the item
only when it is active and posts to the chosen account** (the income account of a two-way item);
otherwise the push answers **409 `qbd_invoice_item_conflict`** with a sentence naming where the item
posts and the two fixes, before any invoice exists, so the link is `error` and the same request
retries in place. A missing item is created on the chosen account. Nothing in QuickBooks is written to
settle it ([`resolve_default_item`](../../api/services/quickbooks_desktop.py)).

| Option | Verdict |
|---|---|
| Change the item's account from Jigged, future transactions only | **Rejected.** Conductor exposes it (`updateExistingTransactionsAccount: false`), but the item may be the shop's own, carrying hand-keyed invoices whose future revenue would move too, and the integration card promises Jigged changes nothing in QuickBooks but the POs it sent. An unspecified flag is documented as *"QuickBooks will prompt the user"* — no one is at the Web Connector to answer — and `false` is unverified on a company file |
| Create a second item named for the account | **Rejected.** A 31-character, colon-free name per account clutters the item list on every change, prints a different item on invoices, and still has to check the account it finds |
| **Refuse with a sentence; a person changes the item in QuickBooks, or picks its account in Settings** | **Chosen.** No transaction is touched and no account guessed; QuickBooks' own dialog asks about existing transactions, where the bookkeeper can answer it |

**Withdrawn:** *"a change must re-resolve it rather than keep pointing at the old one"* (the Settings
route, until 2026-11-12) — wrong because re-resolving by name found the same item, so revenue stayed in
the old account with nothing said. The same reuse also adopted a pre-existing "Machined Parts" on the
first push with no account chosen; the account is now required before the lookup.

**Named gaps.** Saving makes no QuickBooks call, so it works with the shop PC off — and the refusal
arrives at the next push, not in Settings. A **cached** item is not re-checked on every push: an
account changed in QuickBooks afterwards is the shop's own decision, and the next Settings save
re-resolves. Pinned by `test_quickbooks_desktop_service.py` (the invoice item section, 8 tests),
`test_quickbooks_routes_helpers.py` (1) and
`test_a_changed_income_account_is_never_posted_through_the_old_item` in
[`test_quickbooks_desktop_routes.py`](../../api/tests/integration/test_quickbooks_desktop_routes.py).

---

## Invoice state machine

`quickbooks_invoice_links.status` — only `created` counts toward invoiced quantity.

| Status | Meaning |
|---|---|
| `pending` | Claimed, not yet confirmed. Line items are already written (see below). |
| `created` | Confirmed. Counts toward invoiced quantity. |
| `error` | Provably did not happen. Reclaimable in place. |
| `needs_verification` | **Unknown.** May exist in QuickBooks. Blocks further invoices on that job. |

**Line items are written at claim time, while the link is still `pending`.** They count for nothing
until the status flips, so it is safe — and it is what makes an unknown outcome recoverable at all:
the billed quantities are the one thing that cannot be reconstructed from QuickBooks, because the
invoice there is denominated in its own lines, not in `job_part` ids.

**`needs_verification` blocks a new invoice on that job**, because a parked quantity counting for
nothing is precisely what would let the ordered cap pass it a second time.

**Reclaim:** the push dialog's retry reuses the same `request_id` — that is what makes a double-click
safe — so an `error` row still holding it is reclaimed *in place* rather than colliding with
`UNIQUE(realm_id, qb_request_id)`.

---

## Errors: which reach Sentry, and which must not

| Condition | HTTP | Sentry |
|---|---|---|
| Web Connector offline / QuickBooks closed (`qbd_offline`) | 409 | **no** — warning log only |
| Unknown outcome (`qbd_verify`) | 409 | one deliberate `capture_message` (a 409 is not auto-captured, and unconfirmed money must reach the queue) |
| Setup never finished | 409 | no |
| Invoice item posts to another income account, or is inactive (`qbd_invoice_item_conflict`) | 409 | no |
| QuickBooks rejected the request | 502 | yes (auto, via the Starlette integration) |
| Our Conductor key rejected | 503 | yes — this one is ours |

The status code is the mechanism: the Starlette integration captures 5xx only, so **a shop PC being
switched off stays out of the issue queue**. Conductor's own guidance says not to alert on these,
since only the end user can fix them. The UI renders them as a *warning with a retry*, never an
error — "nothing is broken, your connection is still set up".

---

## Terms are cached; QuickBooks Online's are not

[`PaymentTermsPicker`](../../components/common/PaymentTermsPicker.tsx) reads terms from a **mount
effect**, on every quote form and every customer detail page. Against Desktop a live read would be a
Web Connector round trip on page load, aimed at a PC that may be switched off — exactly the failure
the "no third-party call from a mount" rule exists to prevent. So Desktop reads
`quickbooks_terms_cache`, refreshed on an explicit **Refresh terms** and piggybacked on **Test
connection**. QBO stays live: four rows against Intuit, and a cache there would be a second list
drifting from QuickBooks' own.

A cold cache degrades to Jigged's presets rather than failing, and `resolve_term_id` still creates
whatever term is chosen at push time.

---

## Purchase orders

**Added 2026-11.** The push, its state machine and its error map are one implementation for both
providers ([purchasing.md](purchasing.md#quickbooks-push)); what differs on Desktop is below.
**What Jigged may change in QuickBooks is only the POs it sent there** — the integration card says
*"Jigged never deletes anything in QuickBooks, and changes only the POs it sent there"*, replacing
"never changes anything", which an Update made untrue.

| | Desktop | Why |
|---|---|---|
| PO number | **Jigged sends its own as `refNumber` — the opposite of invoices**, which QuickBooks numbers | The vendor holds a document with Jigged's number; the QuickBooks PO has to match it. A duplicate is still accepted silently, hence the bookkeeper's [numbering advice](purchasing.md#what-the-bookkeeper-does-differently) |
| 11 characters | `refNumber`'s limit, so it is the PO number's CHECK; numbers are fixed at `PO-0001` on, so `PO-99999999` is the last one minted | A longer number could never be sent. The push's `qbd_po_number_too_long` is a defensive second check; the column already holds every number to 11 |
| Notes to vendor | `vendorMessage` — **prints**, 99 characters, cut with "…" | The PDF carries the full text |
| `Jigged PO-1042 Rev 2 · link` | `memo` — **does not print**, 4,095 characters | The **names are the opposite of Online's**, where `Memo` prints and `PrivateNote` does not |
| Lines | `rate`, never `amount`; quantity and rate in the purchase unit | As for invoices: Conductor ignores `rate` when `amount` is sent |
| Need-by | `expectedDate` | Online has no field for it — its `DueDate` means payment due |
| Ship method | matched by name, **never created** | A typo in *ship via* would become a permanent entry in the company file |
| Ship-to | cut to QuickBooks' caps (lines 41, city 31, state 21, postal code 13, country 31), with a warning | An address is a label, so it is cut; a vendor name is an identity, so it is refused |
| AP account | none — Desktop POs carry no accounts-payable account | |

**Items:** a **one-way non-inventory item** posting to an expense, cost-of-goods-sold or other-expense
account — one general purchases item by default, all three line kinds on it, the founder's *"1
general thing"* ([purchasing.md](purchasing.md#decisions)). A name is 31 characters at most, with
no colon. Item names are unique across **every** item type, so both the non-inventory and service
lists are searched, and a same-named item is reused **only** when it already posts to the chosen
account — the rule the invoice item follows too since 2026-11-12
([above](#changing-the-income-account)). POs exist only while *Inventory and
purchase orders are active* is on (Edit → Preferences → Items & Inventory); **Check QuickBooks**
reads `purchasesAndVendors.isUsingInventory`. Custom numbering is not a question here: Desktop always
takes the `refNumber`.

**The read before the write.** Update, close and reopen read the PO once, by id, inside the click:
`revisionNumber`, the line ids, and each line's received and billed state. Sending `lines` replaces
them all, so existing ids are kept and a new line is `-1`. `isManuallyClosed` exists on **update
only** — a create cannot close — at header and line level, and **cannot return to false once the PO
is received in full**, which is `qb_cannot_reopen`. A QuickBooks line Jigged never sent, or a received
or billed line the edit would remove or shrink, refuses the push with nothing written.

**Recovery is the invoice path's, for a PO:** no idempotency key, so a create that times out is an
unknown outcome, **probed once** — `vendorIds` plus a one-day `transactionDate` window, matched on
`externalId` client-side, never `refNumbers` or `ids`, whose miss fails the request — then adopted or
parked `needs_verification` with one `capture_message`, and **never retried automatically**. It blocks
only that PO; **Check again** is the way out. An update whose outcome is unknown is read back: the
token unchanged means it did not land (released, and a retry is safe — an update cannot duplicate);
moved with every line as sent means it did (adopted); anything else waits for a person.

**Disconnecting clears the purchasing setup** (its rows hang off the connection row
`ON DELETE CASCADE`), and the Disconnect dialog says so; the vendor map is kept, like the customer
map.

**Unverified until manual check M-2 on a sample company file:** the stale-revision code (`3200` in the
qbXML SDK), the "not found" shape of a deleted PO, which edits a received line refuses, and whether
`vendorMessage` prints while `memo` does not.

---

## Scope

**v1 targets a locally installed QuickBooks Desktop.** Nothing server-side assumes that — the payload
builder, the idempotency machinery, the routes and the error translation only ever talk to
`api.conductor.is`. The only local-specific artifacts are the onboarding copy in
[`DesktopAuthHandoff`](../../components/settings/quickbooks/DesktopAuthHandoff.tsx) and the `.qwc`
instructions, which is why hosted QuickBooks (Rightworks) is a documentation change rather than a
code change.

**Cost:** Conductor bills **$49/month per active company file connection**. Sample files and trials
are free.

**Nothing gates connecting.** Any admin of any company can start a Desktop connection self-serve from
Settings. `verify_company_access(request, company_id, require_admin=True)` is the only check on
`POST /api/quickbooks-desktop/{id}/connect`, and the endpoint runs as `service_client()`, so the
[billing write-gate](billing.md) does not apply either — a tenant whose Stripe subscription lapsed can
still connect. The link it mints is a working one: the shop opens it on the Windows box, the Web
Connector completes, the connection is live and billable, and nothing downstream can refuse it.

**Withdrawn:** *the `quickbooks_desktop` flag gates the backend connect endpoint, not just the UI — the
first flag in the repo with a direct per-use bill attached* — the flag was retired in Aug 2026 with the
rest of the registry cleanup, an explicit accepted cost decision, so the sentence now describes a fence
that is not there.

Damage control is the `disconnect` route, which does call `qbd.delete_end_user` — a connection made by
mistake is recoverable for whatever Conductor prorates. **Nothing else watches the account:** no alert on
a new end user, no cap, and no reconciliation between Conductor's active connections and
`quickbooks_desktop_connections`, so the bill is discovered by reading the invoice. The flag's two backend
tests were deleted with it, which leaves `test_connect_requires_admin` in
[`test_quickbooks_desktop_lifecycle.py`](../../api/tests/integration/test_quickbooks_desktop_lifecycle.py)
load-bearing in a way it was not before: it is the only automated thing standing between a non-admin and a
billable connection.

---

## Configuration

Two backend-only variables, and **one name each whose value differs per deployment environment** —
the Stripe/Supabase/Anthropic convention here, and what Vercel's per-environment scoping is for.

| Variable | Value |
|---|---|
| `CONDUCTOR_API_KEY` | The secret key of the Conductor **project** for that environment — testing for local and preview, production for production |
| `CONDUCTOR_PUBLISHABLE_KEY` | That project's publishable key. Returned by the connect endpoint, never exposed as `NEXT_PUBLIC_*`, which is inlined at build time |

**Scope each variable to one Vercel environment.** Setting a single value for "All Environments"
points production at the testing project's books — the one misconfiguration worth guarding against,
and Vercel's scoping is what guards it.

**There is deliberately no `CONDUCTOR_PROD_*` variant**, and QuickBooks Online reads
`QUICK_BOOKS_CLIENT_ID` the same single-name way. It did not always: until **2026-08-15**
`_client_credentials` read `QUICKBOOKS_PROD_CLIENT_ID` in production and **fell back to the sandbox
name** when unset ([quickbooks.py](../../api/services/quickbooks.py)) — four names for two values,
spelling the prefix two ways. The prod pair was never set in Vercel, so the fallback *was* the live
path: the extra name bought no safety and offered a way to be silently wrong, which is the opposite
of what a separate production name is for. Both integrations now raise on an unset credential
instead.

What actually prevents a testing-project key from touching production books is
`quickbooks_desktop_connections.environment`, which pins every connection row to the environment it
was created under; a mismatch makes the row stop resolving rather than silently address the wrong
company file.

---

## Where the code lives

| Concern | File |
|---|---|
| Conductor HTTP, payload transform, recovery probe | [api/services/quickbooks_desktop.py](../../api/services/quickbooks_desktop.py) |
| Provider seam (protocol + both adapters) | [api/services/accounting/](../../api/services/accounting) |
| Connection lifecycle and terms refresh | [api/routes/quickbooks_desktop_routes.py](../../api/routes/quickbooks_desktop_routes.py) |
| Invoice push, including customer resolution (shared with QBO) | [api/routes/quickbooks_routes.py](../../api/routes/quickbooks_routes.py) |
| Vendor PO push and purchasing setup (shared with QBO) | [api/routes/quickbooks_purchasing_routes.py](../../api/routes/quickbooks_purchasing_routes.py) |
| Vendor PO payload, items, vendors and the recovery probe | [api/services/quickbooks_desktop_purchasing.py](../../api/services/quickbooks_desktop_purchasing.py) |
| Schema | [20260816043137_quickbooks_desktop_provider.sql](../../supabase/migrations/20260816043137_quickbooks_desktop_provider.sql) |
| Settings UI | [QuickBooksIntegrationCard.tsx](../../components/settings/QuickBooksIntegrationCard.tsx) |
| Frontend client | [utils/quickbooksDesktop.ts](../../utils/quickbooksDesktop.ts) |
