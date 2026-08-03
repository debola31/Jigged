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
import re
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


class QuickBooksValidationError(ValueError):
    """A caller-supplied invoice request is invalid (e.g. billing more than has
    shipped, or a part not on the job) -> HTTP 400. Distinct from
    QuickBooksApiError (a QBO-side rejection -> 502): this is our own guard."""


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


def list_qb_terms(db: Client, company_id: str) -> list[dict]:
    """Every active Term in the connected company: [{id, name, due_days}, ...].

    QBO ships five (Due on receipt, Net 10/15/30/60) and a shop may have added
    more. Jigged offers these as the payment-terms picker options so that any
    term chosen on a quote already exists in QBO and SalesTermRef always
    resolves — no mapping table, no drift."""
    rows = qb_query(db, company_id, "select * from Term where Active = true").get("Term", [])
    return [
        {"id": t["Id"], "name": t.get("Name", ""), "due_days": t.get("DueDays")}
        for t in rows
        if t.get("Name")
    ]


# Intuit's documented maximum length for Term.Name.
_QB_TERM_NAME_MAX = 31


def resolve_term_id(db: Client, company_id: str, term_name: str) -> str | None:
    """Jigged's free-text payment term -> a QBO Term Id, creating the Term if absent.

    CASE-INSENSITIVE on purpose. QBO ships "Due on receipt" (lowercase r) while
    Jigged's preset reads "Due on Receipt"; a case-sensitive compare would decide
    the term is missing and try to create it — and creating a Term whose name
    already exists is REJECTED with HTTP 400 (verified live), so the push would
    fail on the single most common term in the list.

    Returns None rather than raising when the term cannot be resolved or created:
    a mis-typed term must not block an invoice, it just means QBO derives the due
    date the way it did before any of this existed."""
    wanted = (term_name or "").strip()
    if not wanted:
        return None

    # Intuit documents a 31-character cap on Term.Name, so a longer Jigged term
    # is created truncated. The lookup therefore has to accept BOTH spellings:
    # matching only the full string would miss the truncated row we ourselves
    # created, re-POST the identical name, and take QBO's duplicate-name 400 —
    # so push #1 on a job would carry a SalesTermRef and every push after it
    # would silently carry none.
    #
    # (The sandbox actually accepted 32- and 40-character names when probed, so
    # the cap may not be enforced everywhere. Truncating is still the safer
    # direction: a truncated label that resolves every time beats a full label
    # that stops resolving the moment some environment does enforce it.)
    qb_name = wanted[:_QB_TERM_NAME_MAX]
    accepted = {wanted.casefold(), qb_name.casefold()}

    try:
        for t in list_qb_terms(db, company_id):
            if t["name"].strip().casefold() in accepted:
                return t["id"]
    except Exception:  # noqa: BLE001
        logger.warning("QuickBooks term lookup failed for %r", wanted, exc_info=True)
        return None

    # Not in QBO yet — create it. Only plain net-days terms can be expressed;
    # anything else still creates as a NAME with a due date, which is enough for
    # SalesTermRef to resolve and for the label to print. QBO's Term entity has
    # no concept of a deposit or an instalment schedule, so a term like
    # "50% Deposit / Balance Net 30" keeps its name and its net-30 date and
    # loses only the 50% — which Jigged does not model either.
    due_days = _parse_net_days(wanted)
    try:
        created = qb_request(
            db, company_id, "POST", "term",
            json_body={"Name": qb_name, "DueDays": due_days},
        )
        return created.get("Term", {}).get("Id")
    except Exception:  # noqa: BLE001
        logger.warning("Could not create QuickBooks term %r", wanted, exc_info=True)
        return None


def _parse_net_days(term_name: str) -> int:
    """Best-effort net-days from a free-text term. Falls back to 0 (due on
    receipt), which is the conservative direction: a term we cannot read should
    ask for payment sooner rather than silently extending credit."""
    m = re.search(r"net\s*(\d{1,3})", term_name, re.IGNORECASE)
    if m:
        return min(int(m.group(1)), 999)
    return 0


# A shop's own label for the PO field — "PO Number", "Customer PO #", "PO #".
_PO_FIELD_PATTERN = re.compile(r"\bp\.?\s?o\.?\b|purchase\s*order", re.IGNORECASE)


def discover_po_custom_field(db: Client, company_id: str) -> dict:
    """Find the sales custom field this shop uses for the customer PO number.

    Returns {"id": "1"|"2"|"3"|None, "name": str|None, "candidates": [...]}.

    Matches on the field's LABEL, never on its position: Intuit states custom
    field definitions "may not appear in numeric order in the Preferences
    response body", so index-based access is a latent bug.

    Returning id=None is the normal case, not an error — an unconfigured company
    reports only three booleans (UseSalesCustom1/2/3), all false, with no name
    entries at all. Jigged then sends no CustomField, because writing to a
    guessed DefinitionId silently overwrites whatever the shop actually keeps in
    that slot and the mapping cannot be reassigned afterwards.

    Jigged CANNOT create the field. Verified live: the legacy Preferences write
    returns HTTP 200 and changes nothing, and the GraphQL Custom Fields API
    answers 403 without a paid partner tier.

    RAISES rather than returning id=None when the Preferences read itself fails.
    "Couldn't check" is not "there is no field": swallowing the error here would
    hand the caller a definitive negative for a question that was never answered,
    and the caller persists this result — so a momentary Intuit outage would wipe
    a correctly discovered field id and silently stop the PO reaching invoices."""
    out: dict = {"id": None, "name": None, "candidates": []}
    prefs = qb_query(db, company_id, "select * from Preferences").get("Preferences", [])
    if not prefs:
        return out

    blocks = (prefs[0].get("SalesFormsPrefs") or {}).get("CustomField") or []
    enabled: dict[str, bool] = {}
    names: dict[str, str] = {}
    for block in blocks:
        for f in block.get("CustomField", []) or []:
            name = f.get("Name") or ""
            slot = name[-1]
            if slot not in "123":
                continue
            if name.startswith("SalesFormsPrefs.UseSalesCustom"):
                enabled[slot] = bool(f.get("BooleanValue"))
            elif name.startswith("SalesFormsPrefs.SalesCustomName"):
                names[slot] = f.get("StringValue") or ""

    for slot, label in sorted(names.items()):
        if not enabled.get(slot):
            continue
        out["candidates"].append({"id": slot, "name": label})
        if out["id"] is None and _PO_FIELD_PATTERN.search(label):
            out["id"], out["name"] = slot, label
    return out


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


def sum_shipped_by_part(db: Client, job_id: str) -> dict[str, float]:
    """Non-voided shipped quantity per job_part for a job. Mirrors the TS
    getJobPartShipmentSummaries (voided slips contribute zero)."""
    parts = db.table("job_parts").select("id").eq("job_id", job_id).execute().data or []
    part_ids = [p["id"] for p in parts]
    out: dict[str, float] = {pid: 0.0 for pid in part_ids}
    if not part_ids:
        return out
    rows = (
        db.table("shipment_line_items")
        .select("job_part_id, quantity, shipment:shipments!inner(voided_at)")
        .in_("job_part_id", part_ids)
        .execute()
        .data
        or []
    )
    for r in rows:
        ship = r.get("shipment") or {}
        if ship.get("voided_at") is not None:
            continue
        out[r["job_part_id"]] = out.get(r["job_part_id"], 0.0) + float(r["quantity"])
    return out


def sum_invoiced_by_part(db: Client, job_id: str, realm: str) -> dict[str, float]:
    """Created, non-voided invoiced quantity per job_part for a job in this realm.
    The Jigged-side source of truth for 'how much of each part is already billed'."""
    parts = db.table("job_parts").select("id").eq("job_id", job_id).execute().data or []
    part_ids = [p["id"] for p in parts]
    out: dict[str, float] = {pid: 0.0 for pid in part_ids}
    if not part_ids:
        return out
    rows = (
        db.table("quickbooks_invoice_line_items")
        .select("job_part_id, quantity, link:quickbooks_invoice_links!inner(status, voided_at, realm_id)")
        .in_("job_part_id", part_ids)
        .execute()
        .data
        or []
    )
    for r in rows:
        link = r.get("link") or {}
        if link.get("status") != "created" or link.get("voided_at") is not None:
            continue
        if realm is not None and link.get("realm_id") != realm:
            continue
        out[r["job_part_id"]] = out.get(r["job_part_id"], 0.0) + float(r["quantity"])
    return out


def load_billable_parts(db: Client, company_id: str, job: dict, realm: str) -> list[dict]:
    """Per-part billing context for the invoice picker + preflight: ordered,
    shipped, already-invoiced, and invoiceable (= shipped - invoiced, the ship-cap)
    quantities, plus the agreed unit price. Ordered by job_part sequence."""
    job_id = job["id"]
    job_parts = (
        db.table("job_parts")
        .select("id, part_id, quantity, unit_price, sequence, production_status")
        .eq("job_id", job_id)
        .order("sequence", desc=False)
        .execute()
        .data
        or []
    )
    part_ids = [r["part_id"] for r in job_parts if r.get("part_id")]
    part_by_id: dict[str, dict] = {}
    if part_ids:
        for r in db.table("parts").select("id, part_name, description").in_("id", part_ids).execute().data or []:
            part_by_id[r["id"]] = r

    shipped = sum_shipped_by_part(db, job_id)
    invoiced = sum_invoiced_by_part(db, job_id, realm)

    out: list[dict] = []
    for r in job_parts:
        jp_id = r["id"]
        part = part_by_id.get(r["part_id"], {})
        qty_shipped = shipped.get(jp_id, 0.0)
        qty_invoiced = invoiced.get(jp_id, 0.0)
        unit_price = r.get("unit_price")
        out.append(
            {
                "job_part_id": jp_id,
                "part_name": part.get("part_name") or "Part",
                "description": part.get("description"),
                "unit_price": float(unit_price) if unit_price is not None else None,
                "qty_ordered": float(r["quantity"]),
                "qty_shipped": qty_shipped,
                "qty_invoiced": qty_invoiced,
                # Invoicing is capped at the ORDERED quantity (not shipped): a packing
                # slip is a document, not a delivery, so we don't hard-gate billing on
                # it. The picker DEFAULTS to shipped-unbilled and warns when you bill
                # beyond it, but you may bill up to what's ordered.
                "qty_invoiceable": max(0.0, float(r["quantity"]) - qty_invoiced),
                "production_status": r.get("production_status"),
            }
        )
    return out


def load_firm_invoice_lines(
    db: Client, company_id: str, job: dict, selection: list[dict], realm: str
) -> tuple[list[dict], Optional[dict], list[dict]]:
    """Build QBO invoice lines from an explicit per-part quantity SELECTION
    ([{job_part_id, quantity}]) — the multi-invoice-per-job model. Enforces the
    ship-cap (each selected qty must be > 0 and <= shipped - already-invoiced) and
    snapshots each part's agreed unit_price. Returns (qbo_lines, bill_addr,
    snapshot_rows) where snapshot_rows are the quickbooks_invoice_line_items to
    persist on success. Raises QuickBooksValidationError (-> HTTP 400) for a bad
    selection.

    Note the SIGNATURE CHANGE from the old whole-job version: invoicing is no longer
    'all parts at full quantity, once' but 'a chosen quantity of chosen parts, many
    times' (see migration 20260702011324)."""
    if not selection:
        raise QuickBooksValidationError("Select at least one part quantity to invoice.")

    context = {c["job_part_id"]: c for c in load_billable_parts(db, company_id, job, realm)}

    lines: list[dict] = []
    snapshot_rows: list[dict] = []
    for sel in selection:
        jp_id = sel.get("job_part_id")
        ctx = context.get(jp_id)
        if ctx is None:
            raise QuickBooksValidationError("A selected part is not on this job.")
        try:
            qty = float(sel.get("quantity"))
        except (TypeError, ValueError):
            raise QuickBooksValidationError("Invalid invoice quantity.")
        if qty <= 0:
            continue  # skip zero-qty rows rather than erroring
        if ctx["unit_price"] is None:
            raise QuickBooksValidationError(
                f"{ctx['part_name']} has no unit price and can't be invoiced."
            )
        # Hard cap: can't bill more than is ordered-but-not-yet-invoiced. (The
        # shipped quantity only drives the picker's default + a soft warning, not this
        # gate.) Tiny epsilon absorbs 4dp fractional-unit rounding.
        if qty > ctx["qty_invoiceable"] + 1e-9:
            raise QuickBooksValidationError(
                f"Can't invoice {qty:g} of {ctx['part_name']}: only "
                f"{ctx['qty_invoiceable']:g} left to invoice."
            )
        up = float(ctx["unit_price"])
        lines.append(
            {
                "quantity": qty,
                "unit_price": up,
                "part_name": ctx["part_name"],
                "description": ctx["description"],
            }
        )
        snapshot_rows.append(
            {
                "job_part_id": jp_id,
                "quantity": qty,
                "unit_price": up,
                "total_price": round(qty * up, 4),
            }
        )

    if not lines:
        raise QuickBooksValidationError("Nothing to invoice — all selected quantities are zero.")

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
    return lines, bill_addr, snapshot_rows


# ───────────────────────── Mapping + invoice creation ─────────────────────────
def invoice_deep_link(environment: str, invoice_id: str, realm_id: str | None = None) -> str:
    """Deep link into the QBO web app for a specific invoice.

    USES /login?pagereq=, NOT /app/invoice?txnId=, and the difference is the
    whole reason this function has a docstring.

    Opening a QBO deep link in a fresh tab — which is exactly what happens right
    after a push, when the user has been in Jigged and not in QuickBooks — hits
    an unauthenticated bounce to accounts.intuit.com. QBO carries the intended
    destination across that bounce in a `qbo.deeplink` cookie on .intuit.com,
    and the URL shape decides what goes into it. Traced live against sandbox:

        /app/invoice?txnId=172
            -> qbo.deeplink={"pagereq":"invoice"}          <- transaction lost

        /login?deeplinkcompanyid=<realm>&pagereq=invoice%3FtxnId%3D172
            -> qbo.deeplink={"pagereq":"invoice?txnId=172"} <- preserved
            -> and account_id_hint=<realm> added to the sign-in URL

    So the old blank-new-invoice symptom was not Intuit throwing the target
    away; it was QBO faithfully restoring "invoice" — the new-invoice page —
    because that was all we ever told it.

    CONFIRMED END TO END, not just on the wire: opened in a private window with
    no Intuit session, signed in, and landed on the intended invoice. The cookie
    trace above proves the id survives the bounce; that test proves QBO consumes
    it afterwards.

    `deeplinkcompanyid` also fixes a live correctness bug independent of the
    query string: the old link named no company, so a user signed into a
    DIFFERENT QBO company followed it straight into that company's invoice with
    the same numeric id — someone else's financial document — or an unhelpful
    "this transaction has been deleted". Shop owners routinely hold more than
    one QBO company (their shop, a second entity, their accountant's).

    Undocumented on developer.intuit.com, but first-party: Intuit's own
    SampleApp-TimeTracking_Invoicing-Java builds this exact shape, their help
    articles use it for signed-out users, and their ideas board names the
    endpoint. Treated as best-effort — the caller keeps the invoice id, so a
    plain /app/invoice?txnId= link remains reconstructible if Intuit ever
    retires `pagereq`.

    realm_id is optional only so existing callers keep compiling; pass it.
    """
    base = "https://qbo.intuit.com" if environment == "production" else "https://sandbox.qbo.intuit.com"
    if not realm_id:
        return f"{base}/app/invoice?txnId={invoice_id}"
    pagereq = urllib.parse.quote(f"invoice?txnId={invoice_id}", safe="")
    return f"{base}/login?deeplinkcompanyid={realm_id}&pagereq={pagereq}"


def quote_to_invoice_payload(
    *,
    customer_ref: str,
    item_ref: str,
    job_number: str | None,
    customer_po_number: str | None = None,
    bill_addr: dict | None,
    lines: list[dict],
    sales_term_id: str | None = None,
    po_custom_field_id: str | None = None,
    po_custom_field_name: str | None = None,
) -> dict:
    """Pure transform: firm lines -> QBO Invoice JSON. Every line references the one
    shared item; the part identity lives in the Description. TaxCodeRef=NON because an
    omitted code is TAXABLE on Automated-Sales-Tax companies, which would inflate the total.

    DocNumber is intentionally omitted -> QBO auto-assigns the next invoice number, so
    Jigged never collides with the shop's existing/manual/previous-system numbering. The
    Jigged job number is stamped into PrivateNote for traceability + QBO-side search, along
    with the customer's PO number (also appended to each line Description) when present.

    TERMS. `sales_term_id` becomes SalesTermRef, and DueDate is deliberately NOT sent:
    verified in the sandbox that when both are supplied DueDate WINS while the term is
    still stored, so an invoice can print "Terms: Net 60" beside a due date seven days
    out. Sending the term alone lets QBO derive the date (Net 60 on a 2026-08-01 invoice
    produced 2026-09-30, correctly). Sending NEITHER — what this code did until now — is
    the worst option: five real sandbox invoices all came back with SalesTermRef null and
    a due date of exactly TxnDate + 30 from a QBO company default that nobody in Jigged
    chose or could see.

    PO NUMBER lands in up to three places, because no single one is both universal and
    prominent:
      * every line's Description  — prints, needs no setup, works on every QBO plan, and
        is what the pilot shop's AP department is already paying from. Never removed.
      * CustomerMemo              — the QBO UI's "Message on invoice". VERIFIED printing:
        a probe invoice's PDF rendered it under "Note to customer". Free, no setup.
      * a sales CustomField       — only when the shop has created one and Jigged has
        DISCOVERED its DefinitionId. Never guessed: writing to an unmatched slot silently
        overwrites whatever the shop keeps there and the mapping cannot be reassigned.
        Jigged cannot create the field itself — verified that the legacy Preferences write
        returns HTTP 200 and does nothing, and that the GraphQL Custom Fields API answers
        403 without a paid partner tier.
    PrivateNote keeps the PO too, but only for internal traceability and QBO-side search:
    Intuit documents it as "does not appear on the invoice to the customer"."""
    po_suffix = f" (PO Number: {customer_po_number})" if customer_po_number else ""
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
        description = f"{description}{po_suffix}"
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

    # SalesTermRef only — never alongside DueDate. See the docstring: supplying
    # both lets them disagree on the printed invoice.
    if sales_term_id:
        payload["SalesTermRef"] = {"value": sales_term_id}

    if customer_po_number:
        # Prints as "Note to customer" — the one prominent placement that needs
        # no configuration on any QBO plan.
        payload["CustomerMemo"] = {"value": f"PO Number: {customer_po_number}"}
        # Only when discovery found a real field. A missing id means the shop has
        # not made one, and the correct behaviour is to send nothing at all.
        if po_custom_field_id:
            field: dict = {
                "DefinitionId": po_custom_field_id,
                "Type": "StringType",
                "StringValue": customer_po_number,
            }
            if po_custom_field_name:
                field["Name"] = po_custom_field_name
            payload["CustomField"] = [field]

    note_parts: list[str] = []
    if job_number:
        note_parts.append(f"Jigged job {job_number}")
    if customer_po_number:
        note_parts.append(f"PO Number: {customer_po_number}")
    if note_parts:
        payload["PrivateNote"] = " · ".join(note_parts)
    if bill_addr:
        payload["BillAddr"] = bill_addr
    return payload


def create_invoice(db: Client, company_id: str, payload: dict, request_id: str) -> dict:
    # Hermetic test escape hatch: when QUICKBOOKS_FAKE is set (E2E / local), skip the
    # Intuit call and return a deterministic fake invoice. Everything else (connection,
    # customer map, item, the link + line-item persistence, idempotency, triggers) runs
    # for real against the DB. Guarded off in production so a stray flag can't fake real
    # invoices. The fake id is derived from request_id → stable per draft, distinct across
    # drafts (so idempotency + multi-invoice behavior are exercised end-to-end).
    if os.getenv("QUICKBOOKS_FAKE") and _environment() != "production":
        rid = str(request_id)
        return {"id": f"E2E-{rid[:8]}", "doc_number": f"E2E-{rid[:4]}", "sync_token": "0"}
    created = qb_request(
        db, company_id, "POST", "invoice", json_body=payload, params={"requestid": str(request_id)}
    )
    inv = created["Invoice"]
    return {
        "id": inv["Id"],
        "doc_number": inv.get("DocNumber"),
        "sync_token": inv.get("SyncToken"),
    }
