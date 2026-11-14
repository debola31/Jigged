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

The same rule holds for vendor purchase orders. The claim on
quickbooks_purchase_order_links, the request-id rules, the probe-and-park for an
unknown QuickBooks Desktop outcome, and the Sentry rules all live once, in
routes/quickbooks_purchasing_routes.py. This Protocol only gains the provider
PRIMITIVES that sequence calls (vendors, purchase items, the PO itself), and the pure
payload builder.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:  # pragma: no cover - typing only; purchase_order imports nothing from here
    from .purchase_order import PurchaseOrderProjection


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


@dataclass(frozen=True)
class PushedPurchaseOrder:
    """What QuickBooks answered to a purchase-order create or update.

    Unlike an invoice, Jigged OWNS the number: it is sent as DocNumber / refNumber.
    `doc_number` is still what QuickBooks reports back, because QuickBooks Online
    replaces it with its own when the company's custom transaction numbers are off --
    the PO page then shows "In QuickBooks as 1043".
    """

    id: str
    doc_number: str | None
    #: QBO SyncToken | QBD revisionNumber -- the version token the NEXT update needs.
    sync_token: str | None
    #: QuickBooks' ids of the item lines, in the order they were sent. Mapped back to
    #: Jigged lines BY POSITION, which is why the payload's line order is fixed.
    line_ids: tuple[str, ...] = ()
    #: Whether QuickBooks now holds the PO closed. None when the answer did not say
    #: (a fake, or a header-only response); the route then keeps what it knew.
    closed: bool | None = None


@dataclass(frozen=True)
class QbPurchaseOrderLine:
    """One item line as QuickBooks holds it, read inside an explicit Update or Close.

    The received / billed figures exist only on QuickBooks Desktop (receivedQuantity,
    isBilled). QuickBooks Online's API exposes neither per line, so they stay 0/False
    there and QuickBooks itself refuses an edit to a billed line.
    """

    id: str
    item_id: str | None = None
    quantity: Decimal | None = None
    rate: Decimal | None = None
    received_quantity: Decimal = Decimal(0)
    billed: bool = False
    closed: bool = False

    @property
    def in_use(self) -> bool:
        """Received or billed in QuickBooks: it can be closed, never removed."""
        return self.billed or self.received_quantity > 0

    @property
    def fully_received(self) -> bool:
        return self.quantity is not None and self.received_quantity >= self.quantity


@dataclass(frozen=True)
class QbPurchaseOrderState:
    """The ONE read the founder allowed (plan §2, "QB read"): taken inside the
    explicit Update / Close / Reopen click, for the version token, the line ids and
    the QuickBooks Desktop received/billed flags.

    Never stored and never shown. The only thing that outlives the request is the new
    token the write returns.
    """

    id: str
    sync_token: str
    doc_number: str | None
    #: Item lines, in QuickBooks' order.
    lines: tuple[QbPurchaseOrderLine, ...] = ()
    #: Lines that are not item lines (a category line or item group the bookkeeper
    #: added). Jigged never sends those, so any present makes the PO "foreign".
    other_line_ids: tuple[str, ...] = ()
    fully_received: bool = False
    closed: bool = False

    @property
    def line_ids(self) -> tuple[str, ...]:
        return tuple(line.id for line in self.lines)

    @property
    def lines_in_use(self) -> frozenset[str]:
        return frozenset(line.id for line in self.lines if line.in_use)


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

    def create_customer(self, display_name: str, address: dict | None) -> str:
        """`address` is the RAW customer_addresses row, not a provider-shaped one.

        QuickBooks Online and Desktop use different address key names, and passing
        one to the other is rejected outright. Shaping it inside each provider is
        what stops that being possible.
        """
        ...

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

    # ── the connection row, as the purchasing setup needs it ─────────────────
    #: quickbooks_connections.id | quickbooks_desktop_connections.id. The purchasing
    #: setup rows reference it ON DELETE CASCADE, so Disconnect clears them.
    connection_id: str | None

    #: The item(s) INVOICES post under. Never a purchase item: they post to income.
    invoice_item_ids: tuple[str, ...]

    # ── vendors (vendor purchase orders) ─────────────────────────────────────
    def vendor_name_problem(self, name: str) -> str | None:
        """PURE. Why QuickBooks cannot take this vendor name, or None.

        Refuses -- NEVER truncates -- a Desktop name over 41 characters, and any name
        with a colon, tab or line break. Two vendors can share their first 41
        characters, and a truncated name links the PO to the wrong one.
        """
        ...

    def find_vendor_candidates(self, name: str) -> dict:
        """-> {"status": "exact_match"|"candidates"|"unmatched",
               "qb_vendor_id": str|None,
               "candidates": [{"qb_id", "display_name"}]}

        The customer contract, for vendors. Desktop searches with nameContains only:
        `names` / `fullNames` fail the whole request on a miss."""
        ...

    def create_vendor(self, display_name: str, address: dict | None, *, request_id: str) -> str:
        """`address` is the raw AddressSnapshot (address_line1 ...). Raises
        PurchasingRefusal for a name QuickBooks will not take, or one a customer,
        employee or inactive vendor already holds."""
        ...

    # ── purchasing reference data (explicit admin clicks only) ───────────────
    def list_purchase_accounts(self) -> list[dict]:
        """-> [{"id", "full_name", "type"}]: expense, cost-of-goods-sold and
        other-expense accounts -- the only accounts a purchase item may post to."""
        ...

    def list_ap_accounts(self) -> list[dict]:
        """-> [{"id", "full_name", "type"}]. QuickBooks Online only; Desktop POs take
        no accounts-payable account and return []."""
        ...

    def list_purchase_items(self) -> list[dict]:
        """-> [{"id", "name", "type", "posting_account_id", "posting_account_name"}]:
        non-inventory and service items that post somewhere. Never inventory items --
        Jigged owns stock."""
        ...

    def create_purchase_item(self, name: str, account_id: str, *, request_id: str) -> dict:
        """Create -- or reuse a same-named item ONLY when it posts to `account_id` --
        one purchase item. -> the list_purchase_items shape plus "created"."""
        ...

    def check_purchasing_preferences(self) -> dict:
        """-> {"purchase_orders_enabled": bool|None, "custom_txn_numbers": bool|None}.
        None means QuickBooks did not say; it is reported, never guessed."""
        ...

    def resolve_ship_method_id(self, name: str) -> str | None:
        """Best-effort, like resolve_term_id. QBO has no ship-method entity and
        returns the text itself; QBD matches by name only and NEVER creates one."""
        ...

    # ── the vendor purchase order ────────────────────────────────────────────
    def build_purchase_order_payload(
        self,
        po: "PurchaseOrderProjection",
        *,
        vendor_ref: str,
        item_refs: dict[str, str],
        ap_account_id: str | None,
        term_id: str | None,
        ship_method_id: str | None,
        request_id: str,
        operation: str = "create",
        existing: QbPurchaseOrderState | None = None,
        qb_line_id_by_line: dict[str, str] | None = None,
        include_content: bool = True,
        jigged_url: str | None = None,
    ) -> dict:
        """PURE. `item_refs` maps each Jigged line id to its QuickBooks item;
        `existing` is the state read inside this same click (update/close/reopen)."""
        ...

    def create_purchase_order(self, payload: dict, *, request_id: str) -> PushedPurchaseOrder:
        """QBO sends `request_id` as ?requestid= (Intuit replays a duplicate). QBD has
        no idempotency key: a lost answer raises QbdUnknownOutcome, never a retry."""
        ...

    def read_purchase_order(self, qb_po_id: str) -> QbPurchaseOrderState | None:
        """The one allowed read. None means QuickBooks no longer has the PO."""
        ...

    def update_purchase_order(
        self, qb_po_id: str, payload: dict, *, request_id: str
    ) -> PushedPurchaseOrder: ...

    def find_created_purchase_order(self, link_row: dict) -> PushedPurchaseOrder | None:
        """Did the create for this link land? QBO: always None (requestid replays).
        QBD: lists by vendor + a one-day window and matches externalId client-side --
        never by refNumbers or ids, which fail the whole request on a miss."""
        ...

    def purchase_order_deep_link(self, qb_po_id: str) -> str | None:
        """QBD returns None: QuickBooks Desktop has no web app to link into."""
        ...
