"""Paged reads that get PAST PostgREST's 1000-row default response cap.

Import collision-detection and reference resolution must see EVERY existing row for a company.
A company with >1000 parts (or vendors, work centers, …) would otherwise only be compared
against the first 1000 the API returns — so re-importing the rest tries a plain INSERT and
dies on the unique constraint (a 500 that aborts the batch), and reference lookups silently
mark real rows as "not found". Always page these company-scoped lookups.
"""

from typing import Any

from supabase import Client

_PAGE_SIZE = 1000


def fetch_all_by_company(supabase: Client, table: str, columns: str, company_id: str) -> list[dict[str, Any]]:
    """Return every row of `table` for `company_id`, paging in 1000-row windows."""
    start = 0
    out: list[dict[str, Any]] = []
    while True:
        resp = (
            supabase.table(table)
            .select(columns)
            .eq("company_id", company_id)
            .range(start, start + _PAGE_SIZE - 1)
            .execute()
        )
        batch = resp.data or []
        out.extend(batch)
        if len(batch) < _PAGE_SIZE:
            return out
        start += _PAGE_SIZE
