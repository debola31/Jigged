"""
QuickBooks Online (QBO) integration service.

Why this lives in the FastAPI backend (per CLAUDE.md):
  - The OAuth client secret and the per-company refresh tokens are secrets
    that must never reach the browser. They are stored in
    quickbooks_connections, a table REVOKE'd from anon/authenticated so only
    the service-role backend can read them.
  - QBO API calls require those secrets, so all QBO HTTP happens here.

Scope: one-directional push (Jigged -> QBO). We READ QBO customer/item/account
reference data only to resolve ids and avoid duplicates; we never sync QBO
transactions back into Jigged.

Concurrency (the backend is serverless, so invocations can overlap):
  - Token refresh uses compare-and-set on quickbooks_connections.token_version
    so two concurrent refreshes can't false-disconnect a healthy connection.
  - Invoice creation is idempotent: a server-minted request_id is replayed to
    QBO (?requestid=) so a lost ack or a double-submit never duplicates.
"""
from __future__ import annotations

import base64
import logging
import os
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from supabase import Client

logger = logging.getLogger(__name__)

# OAuth + API endpoints. The authorize/token/revoke URLs are identical for
# sandbox and production — only the API base (data) differs.
AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2"
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"
SCOPE = "com.intuit.quickbooks.accounting"
SANDBOX_API_BASE = "https://sandbox-quickbooks.api.intuit.com"
PROD_API_BASE = "https://quickbooks.api.intuit.com"

REFRESH_BUFFER_SECONDS = 120
# A pending invoice link younger than this means a sibling request is likely
# still in flight (Vercel functions cap at 60s) -> the loser should NOT also
# POST. Older than this means the original worker died -> safe to resume.
PENDING_STALE_SECONDS = 90
DEFAULT_MINOR_VERSION = "75"
# The single QBO Product/Service that every pushed invoice line posts under
# (a bucket for the income account; the part name lives in the line Description).
DEFAULT_ITEM_NAME = "Machined Parts"


# ───────────────────────── Exceptions ─────────────────────────
class QuickBooksServiceUnavailable(RuntimeError):
    """Missing client id/secret/redirect config -> surfaces as HTTP 503."""


class QuickBooksNotConnected(RuntimeError):
    """No connection, wrong environment, or reconnect required -> HTTP 409."""


class QuickBooksApiError(RuntimeError):
    """A QBO API call returned a non-2xx response -> HTTP 502."""

    def __init__(self, message: str, status: int | None = None, fault: Any = None, tid: str | None = None):
        super().__init__(message)
        self.status = status
        self.fault = fault
        self.tid = tid  # Intuit transaction id (intuit_tid) for support troubleshooting


class _InvalidGrant(RuntimeError):
    """Internal: the OAuth token endpoint returned invalid_grant."""


# ───────────────────────── Config readers (functions so tests can monkeypatch) ─────────────────────────
def _environment() -> str:
    return (os.getenv("QUICKBOOKS_ENVIRONMENT") or "sandbox").strip().lower()


def _api_base() -> str:
    return PROD_API_BASE if _environment() == "production" else SANDBOX_API_BASE


def _minor_version() -> str:
    return os.getenv("QUICKBOOKS_MINOR_VERSION") or DEFAULT_MINOR_VERSION


def _client_credentials() -> tuple[str, str]:
    if _environment() == "production":
        cid = os.getenv("QUICKBOOKS_PROD_CLIENT_ID") or os.getenv("QUICK_BOOKS_CLIENT_ID")
        secret = os.getenv("QUICKBOOKS_PROD_CLIENT_SECRET") or os.getenv("QUICK_BOOKS_CLIENT_SECRET")
    else:
        cid = os.getenv("QUICK_BOOKS_CLIENT_ID") or os.getenv("QUICKBOOKS_CLIENT_ID")
        secret = os.getenv("QUICK_BOOKS_CLIENT_SECRET") or os.getenv("QUICKBOOKS_CLIENT_SECRET")
    if not cid or not secret:
        raise QuickBooksServiceUnavailable(
            "QuickBooks is not configured (set QUICK_BOOKS_CLIENT_ID and "
            "QUICK_BOOKS_CLIENT_SECRET)."
        )
    return cid, secret


def _redirect_uri() -> str:
    uri = os.getenv("QUICKBOOKS_REDIRECT_URI")
    if not uri:
        raise QuickBooksServiceUnavailable("QUICKBOOKS_REDIRECT_URI is not configured.")
    return uri


def _basic_auth_header() -> str:
    cid, secret = _client_credentials()
    return "Basic " + base64.b64encode(f"{cid}:{secret}".encode()).decode("ascii")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ───────────────────────── OAuth ─────────────────────────
@dataclass
class TokenBundle:
    access_token: str
    refresh_token: str
    access_expires_at: datetime
    refresh_expires_at: Optional[datetime]


def build_authorize_url(state: str) -> str:
    cid, _ = _client_credentials()
    params = {
        "client_id": cid,
        "response_type": "code",
        "scope": SCOPE,
        "redirect_uri": _redirect_uri(),
        "state": state,
    }
    return AUTH_BASE + "?" + urllib.parse.urlencode(params)


def _parse_token_response(data: dict) -> TokenBundle:
    now = _now()
    refresh_expires = None
    if data.get("x_refresh_token_expires_in"):
        refresh_expires = now + timedelta(seconds=int(data["x_refresh_token_expires_in"]))
    return TokenBundle(
        access_token=data["access_token"],
        refresh_token=data["refresh_token"],
        access_expires_at=now + timedelta(seconds=int(data.get("expires_in", 3600))),
        refresh_expires_at=refresh_expires,
    )


def _token_request(body: dict) -> TokenBundle:
    headers = {
        "Authorization": _basic_auth_header(),
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(TOKEN_URL, data=body, headers=headers)
    except httpx.HTTPError as exc:
        raise QuickBooksApiError(f"QuickBooks token request failed: {exc}") from exc
    tid = _capture_tid(resp, "OAuth token")
    if resp.status_code == 400 and "invalid_grant" in resp.text:
        raise _InvalidGrant("invalid_grant")
    if resp.status_code >= 400:
        raise QuickBooksApiError(
            f"QuickBooks token request failed ({resp.status_code})",
            status=resp.status_code,
            fault=_safe_json(resp),
            tid=tid,
        )
    return _parse_token_response(resp.json())


def exchange_code_for_tokens(code: str) -> TokenBundle:
    return _token_request(
        {"grant_type": "authorization_code", "code": code, "redirect_uri": _redirect_uri()}
    )


def refresh_tokens(refresh_token: str) -> TokenBundle:
    return _token_request({"grant_type": "refresh_token", "refresh_token": refresh_token})


def revoke_token(token: str) -> None:
    """Best-effort revoke at Intuit on disconnect; never raises."""
    try:
        with httpx.Client(timeout=15.0) as client:
            client.post(
                REVOKE_URL,
                json={"token": token},
                headers={
                    "Authorization": _basic_auth_header(),
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
            )
    except Exception as exc:  # noqa: BLE001 - revoke is best-effort
        logger.warning("QuickBooks token revoke failed (ignored): %s", exc)


# ───────────────────────── Connection persistence + token lifecycle ─────────────────────────
def get_connection(db: Client, company_id: str) -> Optional[dict]:
    resp = (
        db.table("quickbooks_connections")
        .select("*")
        .eq("company_id", company_id)
        .limit(1)
        .execute()
    )
    return resp.data[0] if resp.data else None


def persist_connection(
    db: Client,
    company_id: str,
    realm_id: str,
    bundle: TokenBundle,
    connected_by: str | None = None,
    qb_company_name: str | None = None,
) -> dict:
    """Upsert the connection on a (re)connect. Clears reconnect_required and
    bumps token_version so any in-flight CAS from before reconnect is voided."""
    existing = get_connection(db, company_id)
    payload = {
        "company_id": company_id,
        "realm_id": realm_id,
        "environment": _environment(),
        "access_token": bundle.access_token,
        "access_expires_at": bundle.access_expires_at.isoformat(),
        "refresh_token": bundle.refresh_token,
        "refresh_expires_at": bundle.refresh_expires_at.isoformat()
        if bundle.refresh_expires_at
        else None,
        "reconnect_required": False,
        "token_version": ((existing.get("token_version") or 0) + 1) if existing else 0,
        "updated_at": _now().isoformat(),
    }
    if connected_by:
        payload["connected_by"] = connected_by
    if qb_company_name is not None:
        payload["qb_company_name"] = qb_company_name
    if existing:
        db.table("quickbooks_connections").update(payload).eq("company_id", company_id).execute()
    else:
        db.table("quickbooks_connections").insert(payload).execute()
    return get_connection(db, company_id)  # type: ignore[return-value]


def _is_expiring(access_expires_at_iso: str) -> bool:
    return _parse_dt(access_expires_at_iso) <= _now() + timedelta(seconds=REFRESH_BUFFER_SECONDS)


def ensure_fresh_access_token(db: Client, company_id: str) -> tuple[str, str]:
    """Return (access_token, realm_id), refreshing if near expiry. Raises
    QuickBooksNotConnected when there is no usable connection."""
    conn = get_connection(db, company_id)
    if not conn:
        raise QuickBooksNotConnected("QuickBooks is not connected for this company.")
    if conn.get("environment") != _environment():
        raise QuickBooksNotConnected(
            "This QuickBooks connection is for a different environment; please reconnect."
        )
    if conn.get("reconnect_required"):
        raise QuickBooksNotConnected("QuickBooks needs to be reconnected.")
    if not _is_expiring(conn["access_expires_at"]):
        return conn["access_token"], conn["realm_id"]
    return _refresh_and_store(db, company_id, conn)


def _refresh_and_store(db: Client, company_id: str, conn: dict) -> tuple[str, str]:
    """Refresh the access token, persisting the rotated token via compare-and-set
    on token_version. On invalid_grant, only flag reconnect_required if no sibling
    rotated (version unchanged) after one retry — otherwise use the sibling's token."""
    for attempt in (1, 2):
        old_version = conn.get("token_version") or 0
        old_refresh = conn["refresh_token"]
        try:
            bundle = refresh_tokens(old_refresh)
        except _InvalidGrant:
            fresh = get_connection(db, company_id)
            if not fresh:
                raise QuickBooksNotConnected("QuickBooks is not connected for this company.")
            if (fresh.get("token_version") or 0) != old_version:
                # A sibling rotated. Use its stored token if usable, else retry with it.
                if not _is_expiring(fresh["access_expires_at"]):
                    return fresh["access_token"], fresh["realm_id"]
                conn = fresh
                continue
            if attempt == 1:
                conn = fresh
                continue
            db.table("quickbooks_connections").update({"reconnect_required": True}).eq(
                "company_id", company_id
            ).execute()
            raise QuickBooksNotConnected("QuickBooks authorization expired; please reconnect.")

        update = {
            "access_token": bundle.access_token,
            "access_expires_at": bundle.access_expires_at.isoformat(),
            "refresh_token": bundle.refresh_token,
            "refresh_expires_at": bundle.refresh_expires_at.isoformat()
            if bundle.refresh_expires_at
            else None,
            "token_version": old_version + 1,
            "updated_at": _now().isoformat(),
        }
        resp = (
            db.table("quickbooks_connections")
            .update(update)
            .eq("company_id", company_id)
            .eq("token_version", old_version)
            .execute()
        )
        if not resp.data:
            # Lost the CAS — a sibling persisted first. Use the stored token.
            fresh = get_connection(db, company_id)
            if fresh and not _is_expiring(fresh["access_expires_at"]):
                return fresh["access_token"], fresh["realm_id"]
        return bundle.access_token, conn["realm_id"]

    raise QuickBooksNotConnected("QuickBooks authorization expired; please reconnect.")


def _force_refresh(db: Client, company_id: str) -> tuple[str, str]:
    conn = get_connection(db, company_id)
    if not conn:
        raise QuickBooksNotConnected("QuickBooks is not connected for this company.")
    return _refresh_and_store(db, company_id, conn)


# ───────────────────────── QBO HTTP ─────────────────────────
def _safe_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:  # noqa: BLE001
        return resp.text


def _capture_tid(resp: httpx.Response, label: str) -> str | None:
    """Capture Intuit's transaction id (intuit_tid) from the response headers and
    log it. Intuit support uses this value to locate the exact request/response in
    their logs when troubleshooting, so we always log it on errors."""
    tid = resp.headers.get("intuit_tid")
    log = logger.warning if resp.status_code >= 400 else logger.info
    log("QuickBooks %s -> HTTP %s (intuit_tid=%s)", label, resp.status_code, tid)
    return tid


def qb_request(
    db: Client,
    company_id: str,
    method: str,
    path: str,
    json_body: dict | None = None,
    params: dict | None = None,
) -> dict:
    access_token, realm_id = ensure_fresh_access_token(db, company_id)
    return _do_qb_request(
        db, company_id, access_token, realm_id, method, path, json_body, params, retry_on_401=True
    )


def _do_qb_request(
    db: Client,
    company_id: str,
    access_token: str,
    realm_id: str,
    method: str,
    path: str,
    json_body: dict | None,
    params: dict | None,
    retry_on_401: bool,
) -> dict:
    url = f"{_api_base()}/v3/company/{realm_id}/{path.lstrip('/')}"
    query = dict(params or {})
    query.setdefault("minorversion", _minor_version())
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    if json_body is not None:
        headers["Content-Type"] = "application/json"
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.request(method, url, params=query, json=json_body, headers=headers)
    except httpx.HTTPError as exc:
        raise QuickBooksApiError(f"QuickBooks request failed: {exc}") from exc

    tid = _capture_tid(resp, f"{method.upper()} {path}")
    if resp.status_code == 401 and retry_on_401:
        access_token, realm_id = _force_refresh(db, company_id)
        return _do_qb_request(
            db, company_id, access_token, realm_id, method, path, json_body, params, retry_on_401=False
        )
    if resp.status_code >= 400:
        raise QuickBooksApiError(
            f"QuickBooks API error ({resp.status_code})",
            status=resp.status_code,
            fault=_safe_json(resp),
            tid=tid,
        )
    return resp.json() if resp.content else {}


def _escape_qb_literal(value: str) -> str:
    """Escape a string literal for the QBO query language: backslash, then quote."""
    return value.replace("\\", "\\\\").replace("'", "\\'")


def qb_query(db: Client, company_id: str, query: str) -> dict:
    """Run a QBO query. httpx URL-encodes the (already QBO-escaped) query string."""
    resp = qb_request(db, company_id, "GET", "query", params={"query": query})
    return resp.get("QueryResponse", {})


# ───────────────────────── Reference data resolvers ─────────────────────────
def resolve_income_account(db: Client, company_id: str, conn: dict | None = None) -> str:
    conn = conn or get_connection(db, company_id)
    if conn and conn.get("default_income_account_id"):
        return conn["default_income_account_id"]
    qr = qb_query(
        db, company_id, "select * from Account where AccountType = 'Income' and Active = true MAXRESULTS 5"
    )
    accounts = qr.get("Account", [])
    if not accounts:
        raise QuickBooksApiError("No active income account found in QuickBooks for the default item.")
    acct_id = accounts[0]["Id"]
    db.table("quickbooks_connections").update({"default_income_account_id": acct_id}).eq(
        "company_id", company_id
    ).execute()
    return acct_id


def resolve_default_item(db: Client, company_id: str, conn: dict | None = None) -> str:
    """The single QBO item every invoice line posts under. Reuse-or-create a
    DEDICATED item by name (DEFAULT_ITEM_NAME) so behaviour is deterministic across
    companies — never an arbitrary existing item. Resolved lazily on first push and
    cached on the connection; the shop can re-point its income account in QBO."""
    conn = conn or get_connection(db, company_id)
    if conn and conn.get("default_item_id"):
        return conn["default_item_id"]
    name = _escape_qb_literal(DEFAULT_ITEM_NAME)
    existing = qb_query(db, company_id, f"select * from Item where Name = '{name}'").get("Item", [])
    if existing:
        item_id = existing[0]["Id"]
    else:
        income = resolve_income_account(db, company_id, conn)
        created = qb_request(
            db,
            company_id,
            "POST",
            "item",
            json_body={
                "Name": DEFAULT_ITEM_NAME,
                "Type": "Service",
                "IncomeAccountRef": {"value": income},
            },
        )
        item_id = created["Item"]["Id"]
    db.table("quickbooks_connections").update({"default_item_id": item_id}).eq(
        "company_id", company_id
    ).execute()
    return item_id


def _customer_summary(c: dict) -> dict:
    return {"qb_id": c["Id"], "display_name": c.get("DisplayName")}


def find_customer_candidates(db: Client, company_id: str, name: str) -> dict:
    """Resolve a Jigged customer name against QBO: exact DisplayName, then fuzzy."""
    escaped = _escape_qb_literal(name)
    exact = qb_query(
        db, company_id, f"select * from Customer where DisplayName = '{escaped}'"
    ).get("Customer", [])
    if exact:
        return {
            "status": "exact_match",
            "qb_customer_id": exact[0]["Id"],
            "candidates": [_customer_summary(exact[0])],
        }
    fuzzy = qb_query(
        db, company_id, f"select * from Customer where DisplayName LIKE '%{escaped}%' MAXRESULTS 10"
    ).get("Customer", [])
    if fuzzy:
        return {
            "status": "candidates",
            "qb_customer_id": None,
            "candidates": [_customer_summary(c) for c in fuzzy],
        }
    return {"status": "unmatched", "qb_customer_id": None, "candidates": []}


def create_customer(db: Client, company_id: str, display_name: str, bill_addr: dict | None = None) -> str:
    body: dict = {"DisplayName": display_name}
    if bill_addr:
        body["BillAddr"] = bill_addr
    try:
        created = qb_request(db, company_id, "POST", "customer", json_body=body)
        return created["Customer"]["Id"]
    except QuickBooksApiError as exc:
        # Race / pre-existing: a duplicate-name fault means it already exists. Re-query + link.
        if exc.fault and "Duplicate Name Exists" in str(exc.fault):
            existing = qb_query(
                db, company_id, f"select * from Customer where DisplayName = '{_escape_qb_literal(display_name)}'"
            ).get("Customer", [])
            if existing:
                return existing[0]["Id"]
        raise


# ───────────────────────── Jigged data loading (firm, post-conversion) ─────────────────────────
def get_job_for_quote(db: Client, company_id: str, quote_id: str) -> Optional[dict]:
    resp = (
        db.table("jobs")
        .select("id, billing_address_id, customer_id, quote_id")
        .eq("quote_id", quote_id)
        .eq("company_id", company_id)
        .order("created_at", desc=False)
        .limit(1)
        .execute()
    )
    return resp.data[0] if resp.data else None


def _to_qb_addr(a: dict) -> Optional[dict]:
    out: dict = {}
    if a.get("address_line1"):
        out["Line1"] = a["address_line1"]
    if a.get("address_line2"):
        out["Line2"] = a["address_line2"]
    if a.get("city"):
        out["City"] = a["city"]
    if a.get("state"):
        out["CountrySubDivisionCode"] = a["state"]
    if a.get("postal_code"):
        out["PostalCode"] = a["postal_code"]
    if a.get("country"):
        out["Country"] = a["country"]
    return out or None


def load_firm_invoice_lines(db: Client, company_id: str, job: dict) -> tuple[list[dict], Optional[dict]]:
    """Firm invoice lines from the JOB (job_parts.quantity is the chosen firm qty),
    priced from the linked quote_line_items.unit_price. Returns (lines, bill_addr)."""
    job_parts = (
        db.table("job_parts")
        .select("part_id, quantity, source_quote_line_item_id, sequence")
        .eq("job_id", job["id"])
        .order("sequence", desc=False)
        .execute()
        .data
        or []
    )
    qli_ids = [r["source_quote_line_item_id"] for r in job_parts if r.get("source_quote_line_item_id")]
    part_ids = [r["part_id"] for r in job_parts if r.get("part_id")]

    price_by_qli: dict[str, Any] = {}
    if qli_ids:
        for r in db.table("quote_line_items").select("id, unit_price").in_("id", qli_ids).execute().data or []:
            price_by_qli[r["id"]] = r["unit_price"]
    part_by_id: dict[str, dict] = {}
    if part_ids:
        for r in db.table("parts").select("id, part_name, description").in_("id", part_ids).execute().data or []:
            part_by_id[r["id"]] = r

    lines: list[dict] = []
    for r in job_parts:
        unit_price = price_by_qli.get(r.get("source_quote_line_item_id"))
        part = part_by_id.get(r["part_id"], {})
        lines.append(
            {
                "quantity": r["quantity"],
                "unit_price": float(unit_price) if unit_price is not None else None,
                "part_name": part.get("part_name") or "Part",
                "description": part.get("description"),
            }
        )

    bill_addr = None
    if job.get("billing_address_id"):
        addr = (
            db.table("customer_addresses")
            .select("address_line1, address_line2, city, state, postal_code, country")
            .eq("id", job["billing_address_id"])
            .limit(1)
            .execute()
            .data
        )
        if addr:
            bill_addr = _to_qb_addr(addr[0])
    return lines, bill_addr


# ───────────────────────── Mapping + invoice creation ─────────────────────────
def invoice_deep_link(environment: str, invoice_id: str) -> str:
    """Deep link into the QBO web app for a specific invoice."""
    base = "https://app.qbo.intuit.com" if environment == "production" else "https://app.sandbox.qbo.intuit.com"
    return f"{base}/app/invoice?txnId={invoice_id}"


def quote_to_invoice_payload(
    *,
    customer_ref: str,
    item_ref: str,
    quote_number: str | None,
    bill_addr: dict | None,
    lines: list[dict],
) -> dict:
    """Pure transform: firm lines -> QBO Invoice JSON. Every line references the one
    shared item; the part identity lives in the Description. TaxCodeRef=NON because an
    omitted code is TAXABLE on Automated-Sales-Tax companies, which would inflate the total.

    DocNumber is intentionally omitted -> QBO auto-assigns the next invoice number, so
    Jigged never collides with the shop's existing/manual/previous-system numbering. The
    Jigged quote number is stamped into PrivateNote for traceability + QBO-side search."""
    qb_lines: list[dict] = []
    for ln in lines:
        unit_price = ln.get("unit_price")
        if unit_price is None:
            raise QuickBooksApiError(
                f"Cannot push: line '{ln.get('part_name')}' has no unit price."
            )
        qty = ln["quantity"]
        amount = round(qty * unit_price, 2)
        description = ln.get("part_name") or "Part"
        if ln.get("description"):
            description = f"{description} — {ln['description']}"
        qb_lines.append(
            {
                "DetailType": "SalesItemLineDetail",
                "Amount": amount,
                "Description": description[:4000],
                "SalesItemLineDetail": {
                    "ItemRef": {"value": item_ref},
                    "Qty": qty,
                    "UnitPrice": unit_price,
                    "TaxCodeRef": {"value": "NON"},
                },
            }
        )
    payload: dict = {"CustomerRef": {"value": customer_ref}, "Line": qb_lines}
    if quote_number:
        payload["PrivateNote"] = f"Jigged quote {quote_number}"
    if bill_addr:
        payload["BillAddr"] = bill_addr
    return payload


def create_invoice(db: Client, company_id: str, payload: dict, request_id: str) -> dict:
    created = qb_request(
        db, company_id, "POST", "invoice", json_body=payload, params={"requestid": str(request_id)}
    )
    inv = created["Invoice"]
    return {
        "id": inv["Id"],
        "doc_number": inv.get("DocNumber"),
        "sync_token": inv.get("SyncToken"),
    }
