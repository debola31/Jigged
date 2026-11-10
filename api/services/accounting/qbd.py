"""QuickBooks Desktop (via Conductor) as an AccountingProvider.

A binding shell over api/services/quickbooks_desktop.py (invoices) and
api/services/quickbooks_desktop_purchasing.py (vendor purchase orders), mirroring
qbo.py so the shared push paths never learn which accounting system they talk to.
"""
from __future__ import annotations

from supabase import Client

import services.quickbooks_desktop as qbd
import services.quickbooks_desktop_purchasing as qbdp

from .base import CreatedInvoice, PushedPurchaseOrder, QbPurchaseOrderState


class QbdProvider:
    name = "qbd"
    #: Conductor has NO idempotency mechanism: it does not dedupe externalId and
    #: its List Invoices cannot filter on it. Verified that a create aborted
    #: client-side at 1s still produced an invoice, so the shared push path must
    #: never retry an ambiguous outcome here -- it parks the link as
    #: 'needs_verification' and waits for find_created_invoice or a human.
    dedupes_replayed_creates = False

    def __init__(self, db: Client, company_id: str, conn: dict):
        self._db = db
        self._company_id = company_id
        self._conn = conn
        self._end_user_id = qbd._end_user_id(conn)

    #: QuickBooks Desktop has no refresh token to expire. A connection either
    #: works or the shop PC is unreachable, and the latter is QbdOffline (a
    #: retryable warning) rather than a reconnect.
    requires_reconnect = False

    @property
    def scope_id(self) -> str:
        """The Conductor end-user id IS the connected company file, exactly as a
        realm id is for QBO. Written to quickbooks_invoice_links.realm_id."""
        return self._end_user_id

    @property
    def connection_id(self) -> str | None:
        return self._conn.get("id")

    @property
    def invoice_item_ids(self) -> tuple[str, ...]:
        """quickbooks_desktop_connections.default_service_item_id: the invoice item,
        which posts to the income account an admin chose."""
        item = self._conn.get("default_service_item_id")
        return (str(item),) if item else ()

    # ── customers ────────────────────────────────────────────────────────────
    def find_customer_candidates(self, name: str) -> dict:
        return qbd.find_customer_candidates(self._end_user_id, name)

    def create_customer(self, display_name: str, address: dict | None) -> str:
        # Raw row in, QuickBooks Desktop's shape out. Passing the QuickBooks
        # ONLINE shape here was rejected with 'Unrecognized keys: "Line1", ...'.
        return qbd.create_customer(
            self._end_user_id, display_name, qbd.to_qbd_address(address)
        )

    def customer_tax_code_id(self, qb_customer_id: str) -> str | None:
        return qbd.customer_tax_code_id(self._end_user_id, qb_customer_id)

    def list_customers(self, *, cursor: str | None = None, limit: int = 100) -> dict:
        return qbd.list_customers(self._end_user_id, cursor=cursor, limit=limit)

    # ── reference data ───────────────────────────────────────────────────────
    def resolve_default_item(self) -> str:
        return qbd.resolve_default_item(self._db, self._company_id, self._conn)

    def list_terms(self) -> list[dict]:
        return qbd.list_terms(self._end_user_id)

    def resolve_term_id(self, term_name: str) -> str | None:
        """Best-effort. Under QUICKBOOKS_FAKE it answers None without reaching
        Conductor, as the QuickBooks Online provider does."""
        if qbdp.is_fake():
            return None
        return qbd.resolve_term_id(self._end_user_id, term_name)

    # ── the invoice ──────────────────────────────────────────────────────────
    def build_invoice_payload(self, **kwargs) -> dict:
        """Maps the shared push path's canonical kwargs onto the QBD body.

        QuickBooks Desktop has a NATIVE purchaseOrderNumber field, so the PO goes
        straight into it.
        """
        return qbd.job_to_qbd_invoice_payload(
            customer_id=kwargs["customer_ref"],
            item_id=kwargs["item_ref"],
            transaction_date=kwargs["transaction_date"],
            lines=kwargs["lines"],
            external_id=kwargs["request_id"],
            job_number=kwargs.get("job_number"),
            customer_po_number=kwargs.get("customer_po_number"),
            # The shared push path hands over a QuickBooks ONLINE-shaped address
            # (Line1 / CountrySubDivisionCode). Desktop rejects it, so translate.
            billing_address=qbd.to_qbd_address(kwargs.get("raw_billing_address")),
            terms_id=kwargs.get("term_id"),
            sales_tax_code_id=kwargs.get("sales_tax_code_id"),
        )

    def create_invoice(self, payload: dict, *, request_id: str) -> CreatedInvoice:
        result = qbd.create_invoice(self._end_user_id, payload, request_id=request_id)
        return CreatedInvoice(
            id=result["id"],
            doc_number=result.get("doc_number"),
            sync_token=result.get("sync_token"),
        )

    def find_created_invoice(self, link_row: dict) -> CreatedInvoice | None:
        """The recovery primitive. Needs the customer and the transaction date to
        narrow the window, so the caller passes them on the link row."""
        qb_customer_id = link_row.get("qb_customer_id")
        transaction_date = link_row.get("transaction_date")
        if not qb_customer_id or not transaction_date:
            return None
        found = qbd.find_created_invoice(
            self._end_user_id,
            qb_customer_id=qb_customer_id,
            transaction_date=transaction_date,
            external_id=str(link_row["qb_request_id"]),
        )
        if not found:
            return None
        return CreatedInvoice(
            id=found["id"], doc_number=found.get("doc_number"),
            sync_token=found.get("sync_token"),
        )

    def invoice_deep_link(self, invoice_id: str) -> str | None:
        """None: QuickBooks Desktop has no web app to link into. The job page
        already renders a non-link row when this is absent."""
        return None

    # ── vendors (vendor purchase orders) ─────────────────────────────────────
    def vendor_name_problem(self, name: str) -> str | None:
        return qbdp.vendor_name_problem(name)

    def find_vendor_candidates(self, name: str) -> dict:
        return qbdp.find_vendor_candidates(self._end_user_id, name)

    def create_vendor(self, display_name: str, address: dict | None, *, request_id: str) -> str:
        """`request_id` is unused: Desktop has no request key. A duplicate cannot
        happen anyway -- QuickBooks refuses a second vendor of the same name, and
        create_vendor resolves that by name."""
        return qbdp.create_vendor(self._end_user_id, display_name, address)

    # ── purchasing reference data ────────────────────────────────────────────
    def list_purchase_accounts(self) -> list[dict]:
        return qbdp.list_purchase_accounts(self._end_user_id)

    def list_ap_accounts(self) -> list[dict]:
        return qbdp.list_ap_accounts(self._end_user_id)

    def list_purchase_items(self) -> list[dict]:
        return qbdp.list_purchase_items(self._end_user_id)

    def create_purchase_item(self, name: str, account_id: str, *, request_id: str) -> dict:
        return qbdp.create_purchase_item(self._end_user_id, name, account_id)

    def check_purchasing_preferences(self) -> dict:
        return qbdp.check_purchasing_preferences(self._end_user_id)

    def resolve_ship_method_id(self, name: str) -> str | None:
        return qbdp.resolve_ship_method_id(self._end_user_id, name)

    # ── the vendor purchase order ────────────────────────────────────────────
    def build_purchase_order_payload(self, po, **kwargs) -> dict:
        return qbdp.purchase_order_payload(po, **kwargs)

    def create_purchase_order(self, payload: dict, *, request_id: str) -> PushedPurchaseOrder:
        return qbdp.create_purchase_order(self._end_user_id, payload, request_id=request_id)

    def read_purchase_order(self, qb_po_id: str) -> QbPurchaseOrderState | None:
        return qbdp.read_purchase_order(self._end_user_id, qb_po_id, db=self._db,
                                        company_id=self._company_id)

    def update_purchase_order(self, qb_po_id: str, payload: dict, *,
                              request_id: str) -> PushedPurchaseOrder:
        return qbdp.update_purchase_order(self._end_user_id, qb_po_id, payload,
                                          request_id=request_id)

    def find_created_purchase_order(self, link_row: dict) -> PushedPurchaseOrder | None:
        """The recovery probe. Narrowed by the vendor and the PO date recorded on the
        link at claim time; without both it cannot run, and says so with None."""
        qb_vendor_id = link_row.get("qb_vendor_id")
        transaction_date = link_row.get("transaction_date")
        if not qb_vendor_id or not transaction_date:
            return None
        return qbdp.find_created_purchase_order(
            self._end_user_id,
            qb_vendor_id=str(qb_vendor_id),
            transaction_date=str(transaction_date),
            external_id=str(link_row["qb_request_id"]),
        )

    def purchase_order_deep_link(self, qb_po_id: str) -> str | None:
        """None: QuickBooks Desktop has no web app to link into."""
        return None
