"""The seam between Jigged's billing logic and a specific accounting system.

Jigged supports two: QuickBooks Online (Intuit OAuth, api/services/quickbooks.py)
and QuickBooks Desktop (via Conductor, api/services/quickbooks_desktop.py). A
company connects EXACTLY ONE -- enforced in the database by
assert_single_accounting_provider().

WHAT IS DELIBERATELY *NOT* ON THIS PROTOCOL is as important as what is. The
money-critical sequence stays in one place, in the route, for both providers:

  * the idempotency claim on UNIQUE(realm_id, qb_request_id)
  * load_billable_parts / load_firm_invoice_lines (the ordered-cap guard)
  * the per-part price snapshot
  * inserting quickbooks_invoice_line_items BEFORE flipping status to 'created'
  * the Sentry rules around those failures

Those are the lines where a divergence between providers silently double-bills a
customer, so there is exactly one copy of them and this Protocol does not offer a
seam to fork them.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class CreatedInvoice:
    """The provider-neutral result of creating one invoice."""

    id: str
    #: QBO DocNumber | QBD refNumber. Both providers assign this themselves --
    #: verified for QBD against Enterprise 24 on 2026-08-10 (a blank refNumber is
    #: auto-assigned, contrary to Conductor's documentation).
    doc_number: str | None
    #: QBO SyncToken | QBD revisionNumber. Needed only to update the invoice later.
    sync_token: str | None


@runtime_checkable
class AccountingProvider(Protocol):
    """One connected accounting system for one Jigged company.

    Implementations bind (db, company_id, connection_row) at construction, so the
    route never threads provider-shaped arguments through the push sequence.
    """

    #: 'qbo' | 'qbd'. Persisted to quickbooks_invoice_links.provider.
    name: str

    #: The connected company file. A QBO realm id, or a Conductor end-user id.
    #: Persisted to quickbooks_invoice_links.realm_id / quickbooks_customer_map.realm_id.
    scope_id: str

    #: True when the connection exists but can no longer be used until the shop
    #: reconnects. QBO sets this on a genuine invalid_grant; QBD has no refresh
    #: token to expire, so it is always False there.
    requires_reconnect: bool

    #: True when the vendor deduplicates a replayed create (QBO's ?requestid=).
    #: False for QBD: Conductor has no idempotency mechanism and does not dedupe
    #: externalId, so an ambiguous outcome must never be retried automatically --
    #: it becomes 'needs_verification' and waits for a human. Verified: a create
    #: aborted client-side at 1s still produced an invoice.
    dedupes_replayed_creates: bool

    # ── customers ────────────────────────────────────────────────────────────
    def find_customer_candidates(self, name: str) -> dict:
        """-> {"status": "exact_match"|"candidates"|"unmatched",
               "qb_customer_id": str|None,
               "candidates": [{"qb_id", "display_name"}]}"""
        ...

    def create_customer(self, display_name: str, address: dict | None) -> str: ...

    def customer_tax_code_id(self, qb_customer_id: str) -> str | None:
        """The customer's OWN sales-tax code in the accounting system, or None.

        QBD needs this on every line. Verified on Enterprise 24: a line sent with
        no tax code defaults to 'Non' and is NOT taxed, even for a customer whose
        record says 'Tax' -- so omitting it silently under-bills a taxable sale.
        QBO returns None here and keeps pinning 'NON', because an omitted code is
        TAXABLE under Automated Sales Tax, which is the opposite hazard.
        """
        ...

    # ── reference data ───────────────────────────────────────────────────────
    def resolve_default_item(self) -> str: ...

    def list_terms(self) -> list[dict]:
        """-> [{"id", "name", "due_days"}]"""
        ...

    def resolve_term_id(self, term_name: str) -> str | None:
        """Best-effort by contract: a term that cannot be resolved or created
        returns None rather than raising, because a mistyped term must never
        block an invoice."""
        ...

    # ── the invoice ──────────────────────────────────────────────────────────
    def build_invoice_payload(self, **kwargs) -> dict:
        """PURE. No db, no network -- so it is unit-testable the way
        quote_to_invoice_payload already is."""
        ...

    def create_invoice(self, payload: dict, *, request_id: str) -> CreatedInvoice: ...

    def find_created_invoice(self, link_row: dict) -> CreatedInvoice | None:
        """Did the invoice for this link actually land? The recovery primitive.

        QBO: always None -- ?requestid= replays, so recovery is never needed.
        QBD: lists by customerIds + a one-day transactionDate window and matches
        the invoice's externalId against link_row['qb_request_id'] client-side.
        externalId is not a filterable field, but the window is small enough that
        it does not need to be.
        """
        ...

    def invoice_deep_link(self, invoice_id: str) -> str | None:
        """QBD returns None: QuickBooks Desktop has no web app to link into."""
        ...
