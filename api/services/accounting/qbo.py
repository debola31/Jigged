"""QuickBooks Online as an AccountingProvider.

A delegation shell over api/services/quickbooks.py and nothing more. That module
is NOT modified by the provider work: it carries a lot of behaviour that was
established against the live Intuit sandbox and is documented in place --
SalesTermRef sent without DueDate, the /login?deeplinkcompanyid= deep-link shape,
the case-insensitive term match, the PO custom-field discovery. Wrapping rather
than moving it keeps all of that untouched and keeps its existing unit tests
meaningful.
"""
from __future__ import annotations

from supabase import Client

import services.quickbooks as qb

from .base import CreatedInvoice


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

    # ── customers ────────────────────────────────────────────────────────────
    def find_customer_candidates(self, name: str) -> dict:
        return qb.find_customer_candidates(self._db, self._company_id, name)

    def create_customer(self, display_name: str, address: dict | None) -> str:
        return qb.create_customer(self._db, self._company_id, display_name, address)

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
        return qb.resolve_term_id(self._db, self._company_id, term_name)

    # ── the invoice ──────────────────────────────────────────────────────────
    def build_invoice_payload(self, **kwargs) -> dict:
        return qb.quote_to_invoice_payload(**kwargs)

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
