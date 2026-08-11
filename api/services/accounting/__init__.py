"""Which accounting system is this company connected to?

A company connects EXACTLY ONE -- QuickBooks Online or QuickBooks Desktop --
enforced in the database by assert_single_accounting_provider() (BEFORE INSERT on
both connection tables), not merely by the routes.
"""
from __future__ import annotations

from supabase import Client

import services.quickbooks as qb

# Aliased with a _service suffix on purpose. `from .qbd import QbdProvider` below
# binds the SUBMODULE services.accounting.qbd onto this package's namespace, so a
# plain `as qbd` alias for the service module is silently overwritten and every
# call through it becomes an AttributeError at runtime.
import services.quickbooks_desktop as qbd_service

from .base import AccountingProvider, CreatedInvoice
from .qbd import QbdProvider
from .qbo import QboProvider

__all__ = [
    "AccountingProvider",
    "CreatedInvoice",
    "QbdProvider",
    "QboProvider",
    "get_provider",
]


def get_provider(db: Client, company_id: str) -> AccountingProvider | None:
    """The company's connected accounting system, or None.

    Environment is part of "connected": a sandbox connection is never usable
    against production and vice versa. That check already existed for QBO
    (_is_connected in the routes) and is applied here for both, so a stale row
    from the other environment reads as "not connected" rather than being used.

    QBO is checked first only because it is the older table. The single-provider
    invariant means the order cannot change the answer.
    """
    conn = qb.get_connection(db, company_id)
    if conn and conn.get("environment") == qb._environment():
        return QboProvider(db, company_id, conn)

    dconn = qbd_service.get_connection(db, company_id)
    if dconn and dconn.get("environment") == qbd_service._environment():
        return QbdProvider(db, company_id, dconn)

    return None
