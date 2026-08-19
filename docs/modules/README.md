# Module Specifications

> **Rewritten 2026-08-03** for [#634](https://github.com/debola31/Jigged/issues/634): **273 → 814 words**
> (`wc -w`) — the only file in this pass that **grew**, because an index that omits four of its eighteen
> entries costs more than it saves. The table was
> **missing four modules** — Billing, Invoicing, Vendors, and Work Centers (present only as the row saying
> Operations folded into it). The **Build Order** still listed "Operations" at step 5 while the same table
> called it folded. The **Priority** column mixed MoSCoW (`Must Have`) with build state (`Built`,
> `Built (unreleased)`), so the two meanings could not be read apart.
>
> Both columns are deleted rather than fixed: **[prd.md](../prd.md)'s FR table already carries requirement
> priority *and* a verified build status**, and a second copy here is a value living away from the thing that
> enforces it. Build Order is deleted too — every module below is built, so a recommended sequence for an app
> that exists is fiction.

Each doc is the source of truth for one module: its data model, its surfaces, the decisions behind them, and
the tests that pin them. **Priority and build status live in [prd.md](../prd.md)** (FR-1 … FR-20), not here.

## Index

| Module | What it owns |
|---|---|
| [AI Insights & Charts](ai-insights.md) | Natural-language questions over shop data (text-to-SQL), saved charts, and the allow/deny lists that keep sensitive tables out of the AI's reach. Flag `ai_insights` — **opt-out**, on unless a tenant disables it |
| [Billing & Subscriptions](billing.md) | Stripe-hosted Checkout + Customer Portal, and the DB-enforced entitlement gate (`company_can_write`) every tenant table must carry |
| [Customers](customers.md) | Customer identity, contacts, addresses, standing terms, credit status — and **the freight model** (`customer_carrier_accounts` → job → frozen shipment) |
| [Dashboard](dashboard.md) | The post-login overview: pinned metric scorecards, the Recent Activity feed, and the AI area it hosts |
| [Data Import](data-import.md) | Guided onboarding import (Upload → Map → Review & Fix → Import) with idempotent natural-identity upsert; PRD and technical design in one doc. Flag `data_import` — opt-in per tenant while onboarding |
| [Demo Mode](demo-mode.md) | The pre-populated sandbox inside a real company, and what Reset does and does not delete |
| [Inventory](inventory.md) | Stock, units and conversion, the eleven material journeys, and QR-addressable storage locations. **Locations** sit behind flag `inventory_locations` (opt-in); the base inventory list does not |
| [Invitation System](invitation-system.md) | Email invitations — the only way to add a team member. Referrals descoped (#338) |
| [Legal Acceptance](legal-acceptance.md) | Clickwrap consent, the frozen document versions, and the append-only acceptance record |
| [QuickBooks Desktop](quickbooks-desktop.md) | Pushing invoices into a locally installed QuickBooks Desktop via Conductor: the Web Connector round trip, the unknown-outcome state machine, and the four places its behaviour is the mirror image of QuickBooks Online |
| [Invoicing](invoicing.md) | Many invoices per job (progressive, ship-capped, price-locked) and the QuickBooks Online integration that owns the document and its numbering |
| [Jobs](jobs.md) | The job record and its three independent status axes; operations, outside-vendor steps, materials, attachments |
| [Machine Maintenance](machine-maintenance.md) | An operator-written logbook per machine, reached from the selected station. Flag `machine_maintenance` — one pilot shop at a time, with a kill criterion written in advance |
| [Operator View](operator-view.md) | The shop-floor app on the operator's own phone: station selection, the dispatch queue, quantity capture, the notes loop, and the surveillance guardrail |
| [Parts](parts.md) | The part-catalogue workspace, BOMs, pricing tiers, procurement tiers, attachments |
| [Quotes](quotes.md) | Quote creation, pricing, the customer-facing PDF, and conversion to a job against a required customer PO |
| [Routings](routings.md) | A part's linear operation sequence and its materials, cloned onto each job |
| [Shipments](shipments.md) | Packing slips (one job each) and the derived fulfillment status |
| [Vendors](vendors.md) | Suppliers and outsourced-process providers, their contacts, and the outside-processing worklist |
| [Work Centers](work-centers.md) | Units of production capacity, internal and external. **Owns the definitions other docs borrow:** a *station* (operator view) and a *machine* (maintenance) are both `work_centers` rows, plus the `operation_types` → `work_centers` terminology history |

*Operations is not a module.* `operation_types` was dropped when `work_centers` replaced it, and its spec was
folded into [Work Centers](work-centers.md).

## The acceptance-criteria convention

Stated once here, because the same preamble was copy-pasted verbatim into roughly nine module docs.

A module's acceptance-criteria / "verified behaviour" section states behaviour Given/When/Then, and **every
line carries a verification clause**: a citation, a named manual procedure, or an explicit
`automation-pending` tag naming the issue that tracks it — usually
[#367](https://github.com/debola31/Jigged/issues/367), the E2E reload convention. Every editable entity gets
at least one *edit → save → reload → persists* line. Untested behaviour gets the tag, never silence.

**A citation must be checkable.** Cite the **file plus the `describe` name** (or the pytest class), optionally
with an `it` count — never a nested `describe > 'it title'` string, and never a name truncated with an
ellipsis. A test title is a free-text string nothing checks: the 2026 audits found **up to two-thirds of such
citations dangling**. Those forms read as precise while pointing at nothing, and they break on any rename a
file-level citation would have survived.
