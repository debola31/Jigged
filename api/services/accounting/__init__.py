"""Which accounting system is this company connected to?

A company connects EXACTLY ONE -- QuickBooks Online or QuickBooks Desktop --
enforced in the database by assert_single_accounting_provider() (BEFORE INSERT on
both connection tables), not merely by the routes.
"""
from __future__ import annotations

from supabase import Client

import services.quickbooks as qb

from .base import AccountingProvider, CreatedInvoice
from .qbo import QboProvider

__all__ = ["AccountingProvider", "CreatedInvoice", "QboProvider", "get_provider"]


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

    # QuickBooks Desktop lands here in Phase 3 (services/quickbooks_desktop.py).
    return None
