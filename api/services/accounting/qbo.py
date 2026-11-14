"""QuickBooks Online as an AccountingProvider.

A delegation shell over api/services/quickbooks.py (invoices) and
api/services/quickbooks_purchasing.py (vendor purchase orders), and nothing more. The
invoice module is NOT modified by the provider work: it carries a lot of behaviour that
was established against the live Intuit sandbox and is documented in place --
SalesTermRef sent without DueDate, the /login?deeplinkcompanyid= deep-link shape, the
case-insensitive term match. Wrapping rather than moving it keeps all of that untouched
and keeps its existing unit tests meaningful.
"""
from __future__ import annotations

from supabase import Client

import services.quickbooks as qb
import services.quickbooks_purchasing as qbp

from .base import CreatedInvoice, PushedPurchaseOrder, QbPurchaseOrderState


class QboProvider:
    name = "qbo"
    #: Intuit dedupes on ?requestid=, so a replayed create is safe and the
    #: recovery path below is never needed.
    dedupes_replayed_creates = True

    def __init__(self, db: Client, company_id: str, conn: dict):
        self._db = db
        self._company_id = company_id
        self._conn = conn

    @property
    def scope_id(self) -> str:
        return self._conn["realm_id"]

    @property
    def requires_reconnect(self) -> bool:
        """Set on a genuine invalid_grant: the refresh token is dead and only the
        shop can re-authorise."""
        return bool(self._conn.get("reconnect_required"))

    @property
    def connection_id(self) -> str | None:
        return self._conn.get("id")

    @property
    def invoice_item_ids(self) -> tuple[str, ...]:
        """quickbooks_connections.default_item_id: the "Machined Parts" item every
        invoice line posts under, which posts to income."""
        item = self._conn.get("default_item_id")
        return (str(item),) if item else ()

    # ── customers ────────────────────────────────────────────────────────────
    def find_customer_candidates(self, name: str) -> dict:
        return qb.find_customer_candidates(self._db, self._company_id, name)

    def create_customer(self, display_name: str, address: dict | None) -> str:
        # Raw row in, Intuit's shape out.
        return qb.create_customer(
            self._db, self._company_id, display_name, qb._to_qb_addr(address or {})
        )

    def customer_tax_code_id(self, qb_customer_id: str) -> str | None:
        """Always None -- and that is not a stub.

        QBO pins TaxCodeRef='NON' on every line inside quote_to_invoice_payload,
        because on an Automated-Sales-Tax company an OMITTED code is TAXABLE and
        would inflate the total. QuickBooks Desktop has the opposite default
        (omitted means non-taxable), which is why only the QBD provider reads the
        customer's own code. Do not "unify" these; the asymmetry is the fix.
        """
        return None

    # ── reference data ───────────────────────────────────────────────────────
    def resolve_default_item(self) -> str:
        return qb.resolve_default_item(self._db, self._company_id, self._conn)

    def list_terms(self) -> list[dict]:
        return qb.list_qb_terms(self._db, self._company_id)

    def resolve_term_id(self, term_name: str) -> str | None:
        """Best-effort. Under QUICKBOOKS_FAKE it answers None -- the answer an
        unresolvable term already gets -- without reaching Intuit, so a faked push
        makes no network call at all."""
        if qbp.is_fake():
            return None
        return qb.resolve_term_id(self._db, self._company_id, term_name)

    # ── the invoice ──────────────────────────────────────────────────────────
    def build_invoice_payload(self, **kwargs) -> dict:
        """Maps the shared push path's canonical kwargs onto the QBO body.

        Selects rather than forwards: the canonical set carries fields that only
        QuickBooks Desktop has (`transaction_date`, which QBO derives server-side;
        `sales_tax_code_id`, which QBO deliberately replaces with a pinned 'NON';
        `request_id`, which QBO passes as ?requestid= instead of as an externalId).
        Forwarding them would be a TypeError on every push.
        """
        return qb.quote_to_invoice_payload(
            customer_ref=kwargs["customer_ref"],
            item_ref=kwargs["item_ref"],
            job_number=kwargs.get("job_number"),
            customer_po_number=kwargs.get("customer_po_number"),
            bill_addr=kwargs.get("bill_addr"),
            lines=kwargs["lines"],
            sales_term_id=kwargs.get("sales_term_id"),
        )

    def create_invoice(self, payload: dict, *, request_id: str) -> CreatedInvoice:
        result = qb.create_invoice(self._db, self._company_id, payload, request_id)
        return CreatedInvoice(
            id=result["id"],
            doc_number=result.get("doc_number"),
            sync_token=result.get("sync_token"),
        )

    def find_created_invoice(self, link_row: dict) -> CreatedInvoice | None:
        """Never needed: ?requestid= makes a replay return the original invoice,
        so an ambiguous outcome resolves itself on retry."""
        return None

    def invoice_deep_link(self, invoice_id: str) -> str | None:
        return qb.invoice_deep_link(
            self._conn.get("environment", ""), invoice_id, self._conn.get("realm_id")
        )

    # ── vendors (vendor purchase orders) ─────────────────────────────────────
    def vendor_name_problem(self, name: str) -> str | None:
        return qbp.vendor_name_problem(name)

    def find_vendor_candidates(self, name: str) -> dict:
        return qbp.find_vendor_candidates(self._db, self._company_id, name)

    def create_vendor(self, display_name: str, address: dict | None, *, request_id: str) -> str:
        return qbp.create_vendor(self._db, self._company_id, display_name, address,
                                 request_id=request_id)

    # ── purchasing reference data ────────────────────────────────────────────
    def list_purchase_accounts(self) -> list[dict]:
        return qbp.list_purchase_accounts(self._db, self._company_id)

    def list_ap_accounts(self) -> list[dict]:
        return qbp.list_ap_accounts(self._db, self._company_id)

    def list_purchase_items(self) -> list[dict]:
        return qbp.list_purchase_items(self._db, self._company_id)

    def create_purchase_item(self, name: str, account_id: str, *, request_id: str) -> dict:
        return qbp.create_purchase_item(self._db, self._company_id, name, account_id,
                                        request_id=request_id)

    def check_purchasing_preferences(self) -> dict:
        return qbp.check_purchasing_preferences(self._db, self._company_id)

    def resolve_ship_method_id(self, name: str) -> str | None:
        return qbp.resolve_ship_method_id(name)

    # ── the vendor purchase order ────────────────────────────────────────────
    def build_purchase_order_payload(self, po, **kwargs) -> dict:
        return qbp.purchase_order_payload(po, **kwargs)

    def create_purchase_order(self, payload: dict, *, request_id: str) -> PushedPurchaseOrder:
        return qbp.create_purchase_order(self._db, self._company_id, payload,
                                         request_id=request_id)

    def read_purchase_order(self, qb_po_id: str) -> QbPurchaseOrderState | None:
        return qbp.read_purchase_order(self._db, self._company_id, qb_po_id)

    def update_purchase_order(self, qb_po_id: str, payload: dict, *,
                              request_id: str) -> PushedPurchaseOrder:
        return qbp.update_purchase_order(self._db, self._company_id, qb_po_id, payload,
                                         request_id=request_id)

    def find_created_purchase_order(self, link_row: dict) -> PushedPurchaseOrder | None:
        """Never needed: a stale or ambiguous attempt resumes with the SAME
        ?requestid=, and Intuit answers with the original purchase order."""
        return None

    def purchase_order_deep_link(self, qb_po_id: str) -> str | None:
        return qbp.purchase_order_deep_link(
            self._conn.get("environment", ""), qb_po_id, self._conn.get("realm_id")
        )
