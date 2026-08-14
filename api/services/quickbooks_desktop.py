"""QuickBooks Desktop integration, via Conductor (https://conductor.is).

Why this lives in the FastAPI backend (per CLAUDE.md): the Conductor secret key
is a third-party secret that must never reach the browser, and every QuickBooks
Desktop call needs it.

Scope: one-directional push (Jigged -> QuickBooks). We READ customer / item /
account / term reference data only to resolve ids and avoid duplicates; we never
sync QuickBooks transactions back into Jigged.

HOW THIS DIFFERS FROM services/quickbooks.py, and why the differences are not
inconsistencies to be tidied away. Each was measured against QuickBooks Desktop
Enterprise 24 (Manufacturing & Wholesale edition, Rock Castle Construction sample
company) on 2026-08-10:

  * NO refNumber IS SENT. Conductor's docs say a blank refNumber is left blank.
    It is not: QuickBooks assigned the next number itself (file's max was 1098,
    we got 1100). QuickBooks owns invoice numbering, exactly as QBO does.

  * REFNUMBER IS NOT AN IDENTITY. Posting an explicit DUPLICATE refNumber is
    accepted silently -- two invoices, same number, no error. So it can locate an
    invoice but can never prove one is unique.

  * EVERY LINE CARRIES THE CUSTOMER'S OWN salesTaxCode. A line sent with no tax
    code defaults to `Non` and is NOT taxed, even when the customer's record says
    `Tax` and the invoice header shows the tax item and rate. Omitting it would
    silently UNDER-BILL a taxable sale. QBO does the opposite -- it pins
    TaxCodeRef='NON' -- because there an omitted code is TAXABLE under Automated
    Sales Tax. Same intent, opposite mechanics.

  * A CREATE THAT TIMES OUT MAY STILL HAVE LANDED. A create aborted client-side
    at 1s produced an invoice anyway. There is no idempotency key: Conductor does
    not dedupe externalId, and its List Invoices cannot filter on it. So an
    ambiguous outcome is NEVER retried automatically -- see find_created_invoice.

  * NO SDK. `conductor-py` defaults to max_retries=2, and its retry triggers are
    exactly the failure modes above; an automatic retry of a create is a second
    invoice. Raw httpx has no retry layer to disarm, matches how
    services/quickbooks.py already talks to Intuit, and keeps the deployed bundle
    small. Timeouts sit well under Vercel's 60s function cap so that OUR code,
    not the platform, decides the outcome -- a platform kill runs no `except`.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any, Optional

import httpx
from supabase import Client

from services.quickbooks import _parse_net_days  # same free-text term parsing as QBO

logger = logging.getLogger(__name__)

API_BASE = "https://api.conductor.is/v1"
QBD_BASE = f"{API_BASE}/quickbooks-desktop"

# Observed latency: health-check 5.7s cold, create ~3.0s, filtered list ~4.9s.
# Vercel kills the function at 60s, so both budgets leave room for our own error
# handling to run. A timeout that can never fire is a timeout that hands the
# outcome to the platform.
READ_TIMEOUT = 20.0
WRITE_TIMEOUT = 30.0

# The single QuickBooks service item every pushed line posts under (a bucket for
# the income account; part identity lives in the line description). Mirrors QBO's
# DEFAULT_ITEM_NAME. QuickBooks caps a service item name at 31 characters.
DEFAULT_ITEM_NAME = "Machined Parts"

# QuickBooks Desktop field caps.
CUSTOMER_NAME_MAX = 41
ITEM_NAME_MAX = 31
TERM_NAME_MAX = 31
PO_NUMBER_MAX = 25
LINE_DESCRIPTION_MAX = 4095


# ───────────────────────── Exceptions ─────────────────────────
class QbdServiceUnavailable(RuntimeError):
    """Conductor is not configured for this environment -> HTTP 503."""


class QbdNotConnected(RuntimeError):
    """No connection, wrong environment, or the shop never finished the auth
    flow on the machine running QuickBooks -> HTTP 409."""


class QbdOffline(RuntimeError):
    """The Web Connector is not reachable: the shop PC is off, asleep, or
    QuickBooks is closed. HTTP 409, and NEVER reported to Sentry -- it is a
    user-side condition only the end user can fix, and alerting on it would page
    us every time someone shuts a laptop."""


class QbdUnknownOutcome(RuntimeError):
    """A CREATE ended without a definitive answer. The invoice may or may not
    exist. HTTP 409. Never auto-retried."""


class QbdApiError(RuntimeError):
    """QuickBooks rejected the request -> HTTP 502."""

    def __init__(self, message: str, *, code: str | None = None,
                 integration_code: str | None = None, request_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.integration_code = integration_code
        # Conductor's handle for support. The QBD analogue of Intuit's intuit_tid.
        self.request_id = request_id


# ───────────────────────── Config (functions so tests can monkeypatch) ─────────────────────────
def _environment() -> str:
    """Shares QUICKBOOKS_ENVIRONMENT with the QBO path: one company connects one
    provider, so one environment switch describes both. Conductor has no sandbox
    HOST -- it has separate PROJECTS -- so this selects which project's keys to
    use, and quickbooks_desktop_connections.environment pins each row to one."""
    return (os.getenv("QUICKBOOKS_ENVIRONMENT") or "sandbox").strip().lower()


def _secret_key() -> str:
    """No fallback between environments, deliberately.

    The testing and production Conductor projects mint DIFFERENT end-user ids, so
    falling back to the testing key in production would address an end user that
    does not exist there -- or, worse, the wrong company's books. Same reasoning
    as STRIPE_RESTRICTED_KEY having no fallback to STRIPE_SECRET_KEY.
    """
    var = "CONDUCTOR_PROD_API_KEY" if _environment() == "production" else "CONDUCTOR_API_KEY"
    key = os.getenv(var)
    if not key:
        raise QbdServiceUnavailable(f"QuickBooks Desktop is not configured ({var}).")
    return key


def _publishable_key() -> str:
    """Embedded in the auth-flow URL the shop opens in a browser on the machine
    running QuickBooks -- that is what 'publishable' means. It is returned by the
    connect endpoint rather than exposed as NEXT_PUBLIC_*, because a
    NEXT_PUBLIC_* var is inlined at BUILD time and a preview build that outran
    provisioning once baked in an empty value (see the local-dev runbook)."""
    var = (
        "CONDUCTOR_PROD_PUBLISHABLE_KEY"
        if _environment() == "production"
        else "CONDUCTOR_PUBLISHABLE_KEY"
    )
    key = os.getenv(var)
    if not key:
        raise QbdServiceUnavailable(f"QuickBooks Desktop is not configured ({var}).")
    return key


def _is_fake() -> bool:
    """Hermetic test escape hatch, shared with the QBO path so E2E needs one
    flag. Guarded off in production so a stray env var cannot fake real
    invoices."""
    return bool(os.getenv("QUICKBOOKS_FAKE")) and _environment() != "production"


# ───────────────────────── HTTP ─────────────────────────
def _error_from(resp: httpx.Response) -> dict:
    """Conductor's envelope is {"error": {...}} at the REST layer (the doubly
    nested error.error shape in their docs is an SDK artifact)."""
    try:
        body = resp.json()
    except Exception:  # noqa: BLE001
        return {}
    return body.get("error") or {}


_OFFLINE_CODES = {"INTEGRATION_CONNECTION_NOT_ACTIVE", "QBD_CONNECTION_ERROR"}
_NOT_SET_UP_CODES = {"INTEGRATION_CONNECTION_NOT_SET_UP"}


def _raise_for_error(resp: httpx.Response, *, is_write: bool) -> None:
    """Translate a Conductor error into this repo's exception vocabulary.

    `is_write` changes the ANSWER, not just the wording: a timeout on a read is a
    retryable failure, while the identical timeout on a create is an UNKNOWN
    OUTCOME that must never be retried.
    """
    if resp.status_code < 400:
        return

    err = _error_from(resp)
    code = err.get("code") or ""
    message = err.get("message") or f"QuickBooks Desktop request failed ({resp.status_code})"
    # userFacingMessage is genuinely user-ready for the connection classes -- it
    # names the shop PC and the Web Connector better than we would. It is NOT
    # trustworthy for INVALID_REQUEST_ERROR, where it reads "An internal server
    # error occurred" for what is actually our own malformed request.
    friendly = err.get("userFacingMessage") or message
    # ...EXCEPT for INVALID_REQUEST_ERROR, whose userFacingMessage reads "An
    # internal server error occurred. Please try again." That is worse than
    # useless: the fault is OUR malformed request, and the generic text sends a
    # shop chasing an outage that is not happening. Verified live -- it masked a
    # bad address payload during acceptance testing until this was changed.
    if err.get("type") == "INVALID_REQUEST_ERROR":
        friendly = message
    request_id = err.get("requestId")

    if resp.status_code in (401, 403):
        # OUR key is wrong or lacks scope. This one IS our bug.
        raise QbdServiceUnavailable(
            "Jigged's QuickBooks Desktop credentials were rejected by Conductor."
        )
    if code in _NOT_SET_UP_CODES:
        raise QbdNotConnected(friendly)
    if code in _OFFLINE_CODES:
        logger.warning("QuickBooks Desktop offline (%s, requestId=%s)", code, request_id)
        raise QbdOffline(friendly)
    if code == "QBD_REQUEST_TIMEOUT":
        if is_write:
            raise QbdUnknownOutcome(
                "We couldn't confirm whether QuickBooks recorded that invoice."
            )
        raise QbdApiError(friendly, code=code, request_id=request_id)

    raise QbdApiError(
        friendly,
        code=code,
        integration_code=err.get("integrationCode"),
        request_id=request_id,
    )


def _request(
    method: str,
    path: str,
    *,
    end_user_id: str | None = None,
    params: dict | None = None,
    json_body: dict | None = None,
    is_write: bool = False,
) -> Any:
    """One Conductor call. NO RETRY LAYER, by construction -- see the module
    docstring. A connection error or timeout on a write is an unknown outcome,
    not a failure, and the caller resolves it by looking for the invoice."""
    headers = {"Authorization": f"Bearer {_secret_key()}", "Accept": "application/json"}
    if end_user_id:
        headers["Conductor-End-User-Id"] = end_user_id
    if json_body is not None:
        headers["Content-Type"] = "application/json"

    timeout = WRITE_TIMEOUT if is_write else READ_TIMEOUT
    url = path if path.startswith("http") else f"{QBD_BASE}{path}"
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.request(method, url, params=params, json=json_body, headers=headers)
    except httpx.HTTPError as exc:
        if is_write:
            # The request may well have reached QuickBooks. Verified: a create
            # aborted at 1s still produced an invoice.
            raise QbdUnknownOutcome(
                "We lost contact with QuickBooks while creating that invoice."
            ) from exc
        raise QbdApiError(f"Couldn't reach QuickBooks Desktop: {exc}") from exc

    _raise_for_error(resp, is_write=is_write)
    return resp.json() if resp.content else {}


def _list(path: str, end_user_id: str, params: dict | None = None) -> list[dict]:
    return _request("GET", path, end_user_id=end_user_id, params=params).get("data", []) or []


# ───────────────────────── Connection ─────────────────────────
def get_connection(db: Client, company_id: str) -> Optional[dict]:
    resp = (
        db.table("quickbooks_desktop_connections")
        .select("*")
        .eq("company_id", company_id)
        .limit(1)
        .execute()
    )
    return resp.data[0] if resp.data else None


def _end_user_id(conn: dict) -> str:
    if not conn or not conn.get("conductor_end_user_id"):
        raise QbdNotConnected("QuickBooks Desktop is not connected for this company.")
    if conn.get("environment") != _environment():
        raise QbdNotConnected(
            "This QuickBooks Desktop connection belongs to a different environment; "
            "please reconnect."
        )
    return conn["conductor_end_user_id"]


def find_end_user_by_source_id(company_id: str) -> Optional[dict]:
    """Conductor requires sourceId to be unique, so company_id maps 1:1 to an end
    user. Looking it up makes connect idempotent and lets us recover an orphan --
    an end user created just before our own insert failed."""
    for user in _request("GET", f"{API_BASE}/end-users").get("data", []) or []:
        if user.get("sourceId") == company_id:
            return user
    return None


def ensure_end_user(company_id: str, *, company_name: str, email: str | None) -> dict:
    existing = find_end_user_by_source_id(company_id)
    if existing:
        return existing
    return _request(
        "POST",
        f"{API_BASE}/end-users",
        json_body={
            "companyName": company_name,
            "sourceId": company_id,
            "email": email or "",
        },
    )


def create_auth_session(end_user_id: str, *, link_expiry_mins: int = 1440) -> dict:
    """-> {"auth_flow_url": ..., "expires_at": ...}

    THE SHOP OPENS THIS URL ON THE WINDOWS MACHINE RUNNING QUICKBOOKS. There is
    no redirect back to Jigged (the API returns redirectUrl: null), so nothing
    here marks the connection live -- connection_state() answers that.
    """
    session = _request(
        "POST",
        f"{API_BASE}/auth-sessions",
        json_body={
            "publishableKey": _publishable_key(),
            "endUserId": end_user_id,
            "linkExpiryMins": link_expiry_mins,
        },
    )
    return {
        "auth_flow_url": session.get("authFlowUrl"),
        "expires_at": session.get("expiresAt"),
    }


def connection_state(end_user_id: str) -> dict:
    """-> {"linked": bool, "integration_connection_id": str|None,
           "last_successful_request_at": str|None}

    'linked' keys on lastSuccessfulRequestAt, NOT on integrationConnections being
    non-empty. Verified: Conductor creates the integration_connection row the
    moment the auth flow STARTS, so a half-finished setup (Web Connector never
    run) presents as a connection that has never worked while health-check
    returns 409 NOT_SET_UP.
    """
    user = _request("GET", f"{API_BASE}/end-users/{end_user_id}")
    for c in user.get("integrationConnections") or []:
        if c.get("integrationSlug") == "quickbooks_desktop":
            return {
                "linked": bool(c.get("lastSuccessfulRequestAt")),
                "integration_connection_id": c.get("id"),
                "last_successful_request_at": c.get("lastSuccessfulRequestAt"),
            }
    return {"linked": False, "integration_connection_id": None,
            "last_successful_request_at": None}


def health_check(end_user_id: str) -> dict:
    """'Is the shop PC reachable RIGHT NOW' -- a different question from
    connection_state's 'did they ever finish setup'.

    Never raises for a user-side condition: an offline connector returns
    ok=False, because "couldn't check" must never render as "not connected".
    """
    if _is_fake():
        return {"ok": True, "code": None, "message": "ok (fake)"}
    try:
        _request("GET", "/health-check", end_user_id=end_user_id)
        return {"ok": True, "code": None, "message": None}
    except QbdOffline as exc:
        return {"ok": False, "code": "qbd_offline", "message": str(exc)}
    except QbdNotConnected as exc:
        return {"ok": False, "code": "qbd_not_connected", "message": str(exc)}


def delete_end_user(end_user_id: str) -> None:
    """Best-effort, mirroring qb.revoke_token: disconnecting in Jigged must not
    fail because Conductor was unreachable."""
    try:
        _request("DELETE", f"{API_BASE}/end-users/{end_user_id}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Conductor end-user delete failed (ignored): %s", exc)


def company_info(end_user_id: str) -> dict:
    return _request("GET", "/company", end_user_id=end_user_id)


# ───────────────────────── Reference data ─────────────────────────
def list_income_accounts(end_user_id: str) -> list[dict]:
    rows = _list("/accounts", end_user_id,
                 {"accountType": "income", "status": "active", "limit": 150})
    return [{"id": a["id"], "full_name": a.get("fullName")} for a in rows]


def resolve_default_item(db: Client, company_id: str, conn: dict) -> str:
    """The one QuickBooks service item every pushed line posts under.

    Reuse-or-create a DEDICATED item by name so behaviour is deterministic across
    companies -- never an arbitrary existing item. The posting account is the one
    an ADMIN chose; unlike QBO's resolve_income_account we do not take
    accounts[0], because revenue landing in the wrong account is invisible until
    month end.
    """
    if conn.get("default_service_item_id"):
        return conn["default_service_item_id"]

    end_user_id = _end_user_id(conn)
    name = DEFAULT_ITEM_NAME[:ITEM_NAME_MAX]
    for item in _list("/service-items", end_user_id, {"nameContains": name, "limit": 10}):
        if (item.get("name") or "").strip().casefold() == name.casefold():
            item_id = item["id"]
            break
    else:
        account_id = conn.get("default_income_account_id")
        if not account_id:
            raise QbdNotConnected(
                "Choose which QuickBooks income account Jigged invoices should post to, "
                "in Settings, before creating an invoice."
            )
        created = _request(
            "POST", "/service-items", end_user_id=end_user_id, is_write=True,
            json_body={
                "name": name,
                "salesOrPurchaseDetails": {
                    "description": "Machined parts invoiced from Jigged",
                    "postingAccountId": account_id,
                },
            },
        )
        item_id = created["id"]

    db.table("quickbooks_desktop_connections").update(
        {"default_service_item_id": item_id}
    ).eq("company_id", company_id).execute()
    return item_id


def list_terms(end_user_id: str) -> list[dict]:
    rows = _list("/standard-terms", end_user_id, {"limit": 150})
    return [
        {"id": t["id"], "name": t.get("name", ""), "due_days": t.get("dueDays")}
        for t in rows
        if t.get("name")
    ]


def resolve_term_id(end_user_id: str, term_name: str) -> str | None:
    """Jigged's free-text payment term -> a QuickBooks term id, creating it if
    absent.

    CASE-INSENSITIVE for the same reason as the QBO path: QuickBooks ships
    "Due on receipt" (lowercase r) while Jigged's preset reads "Due on Receipt",
    and a standard term's name is documented as case-insensitively UNIQUE -- so a
    case-sensitive compare would try to create a duplicate and fail on the single
    most common term. Verified present in the sample file alongside Net 15/30 and
    two discount terms.

    Returns None rather than raising in every failure mode: a mistyped term must
    not block an invoice, it just means QuickBooks derives the due date from the
    customer's own default (verified: an invoice sent with no term came back Net
    15 with a matching due date).
    """
    wanted = (term_name or "").strip()
    if not wanted:
        return None
    qb_name = wanted[:TERM_NAME_MAX]
    accepted = {wanted.casefold(), qb_name.casefold()}

    try:
        for t in list_terms(end_user_id):
            if t["name"].strip().casefold() in accepted:
                return t["id"]
    except Exception:  # noqa: BLE001
        logger.warning("QuickBooks Desktop term lookup failed for %r", wanted, exc_info=True)
        return None

    try:
        created = _request(
            "POST", "/standard-terms", end_user_id=end_user_id, is_write=True,
            json_body={"name": qb_name, "dueDays": _parse_net_days(wanted)},
        )
        return created.get("id")
    except Exception:  # noqa: BLE001
        logger.warning("Could not create QuickBooks Desktop term %r", wanted, exc_info=True)
        return None


# ───────────────────────── Customers ─────────────────────────
def _customer_summary(c: dict) -> dict:
    return {"qb_id": c["id"], "display_name": c.get("fullName") or c.get("name")}


def list_customers(end_user_id: str, *, cursor: str | None = None,
                   limit: int = 100) -> dict:
    params: dict = {"limit": limit, "status": "active",
                    # Conductor's own advice for slow customer lists.
                    "excludeAlternateShippingAddresses": "true"}
    if cursor:
        params["cursor"] = cursor
    body = _request("GET", "/customers", end_user_id=end_user_id, params=params)
    return {
        "customers": [
            {
                "qb_id": c["id"],
                "full_name": c.get("fullName") or c.get("name"),
                "name": c.get("name"),
                "company_name": c.get("companyName"),
                "sales_tax_code_id": (c.get("salesTaxCode") or {}).get("id"),
            }
            for c in body.get("data", []) or []
        ],
        "next_cursor": body.get("nextCursor"),
    }


def _find_customers_by_name(end_user_id: str, name: str, limit: int = 10) -> list[dict]:
    """Search customers by name WITHOUT using the `fullNames` filter.

    `fullNames` is a LOOKUP, not a filter: QuickBooks treats a name it cannot find
    as a missing required element and fails the whole request with
    "The query request has not been fully completed. There was a required element
    (\"<name>\") that could not be found in QuickBooks." Verified on Enterprise 24 --
    a brand-new customer therefore turned the invoice dialog into a 500 instead of
    the "we'll create it" path it is supposed to take.

    `nameContains` returns an empty list for a miss, which is what a search should
    do, so exact matching happens here on the results.
    """
    wanted = (name or "").strip()
    if not wanted:
        return []
    return _list(
        "/customers", end_user_id,
        {"nameContains": wanted, "status": "active", "limit": limit},
    )


def _exact_customer(rows: list[dict], name: str) -> Optional[dict]:
    wanted = (name or "").strip().casefold()
    for c in rows:
        for candidate in (c.get("fullName"), c.get("name")):
            if (candidate or "").strip().casefold() == wanted:
                return c
    return None


def find_customer_candidates(end_user_id: str, name: str) -> dict:
    """Mirrors the QBO contract so the push dialog needs no provider branch.

    Never raises for "no such customer": an unmatched name is the ordinary path
    that ends in creating the customer at push time, exactly as QuickBooks Online
    behaves.
    """
    rows = _find_customers_by_name(end_user_id, name)
    exact = _exact_customer(rows, name)
    if exact:
        return {"status": "exact_match", "qb_customer_id": exact["id"],
                "candidates": [_customer_summary(exact)]}
    if rows:
        return {"status": "candidates", "qb_customer_id": None,
                "candidates": [_customer_summary(c) for c in rows]}
    return {"status": "unmatched", "qb_customer_id": None, "candidates": []}


def create_customer(end_user_id: str, display_name: str, address: dict | None = None) -> str:
    """QuickBooks caps a customer name at 41 characters, and uniqueness is on
    fullName. A name longer than the cap is REFUSED rather than truncated: two
    different customers can share their first 41 characters, and a truncation
    collision would silently invoice the wrong company. Long names go to the
    mapping screen, where a human picks the right record."""
    name = (display_name or "").strip()
    if len(name) > CUSTOMER_NAME_MAX:
        raise QbdApiError(
            f"\"{name}\" is longer than QuickBooks' {CUSTOMER_NAME_MAX}-character limit for "
            "customer names. Link it to an existing QuickBooks customer in Settings instead."
        )
    body: dict = {"name": name}
    if address:
        body["billingAddress"] = address
    try:
        return _request("POST", "/customers", end_user_id=end_user_id, is_write=True,
                        json_body=body)["id"]
    except QbdApiError as exc:
        # Race or pre-existing: re-resolve by name rather than creating a second.
        if re.search(r"already|duplicate|in use", str(exc), re.IGNORECASE):
            existing = _exact_customer(_find_customers_by_name(end_user_id, name), name)
            if existing:
                return existing["id"]
        raise


def customer_tax_code_id(end_user_id: str, qb_customer_id: str) -> str | None:
    """The sales-tax code governing this customer, walking up to the parent when
    the record does not carry its own.

    Every pushed line gets this code, which reproduces what QuickBooks' own UI
    does: Intuit documents that on a sales form the CUSTOMER's tax code overrides
    the item's. The API does NOT apply that defaulting -- verified on Enterprise
    24, a line sent with no code lands as `Non` and is not taxed even for a
    customer whose record reads `Tax` beside a header showing 7.75%. Sending it
    explicitly is what makes an API-created invoice match a hand-typed one.

    THE PARENT WALK IS NOT DEFENSIVE PADDING. A QuickBooks job (`Customer:Job`,
    the standard way shops track work) carries `salesTaxCode: null` and inherits
    its parent's, while still inheriting the tax ITEM -- verified, along with the
    consequence: invoicing such a job without a code produced $0.00 tax under a
    parent whose code is `Tax`. Reading only the mapped record would therefore
    silently UNDER-BILL every shop that invoices to jobs, which is most of them.

    Returns None only when nothing in the chain carries a code, leaving
    QuickBooks to apply its own default.
    """
    seen: set[str] = set()
    current: str | None = qb_customer_id
    # Bounded: QuickBooks nests Customer:Job:Sub-job only a few deep, and `seen`
    # rules out a cycle that should be impossible but costs nothing to exclude.
    for _ in range(5):
        if not current or current in seen:
            return None
        seen.add(current)
        rows = _list("/customers", end_user_id, {"ids": current, "limit": 1})
        if not rows:
            return None
        code = (rows[0].get("salesTaxCode") or {}).get("id")
        if code:
            return code
        current = (rows[0].get("parent") or {}).get("id")
    return None


# ───────────────────────── The invoice ─────────────────────────
def to_qbd_address(addr: dict | None) -> Optional[dict]:
    """Jigged's customer_addresses row -> a QuickBooks Desktop address.

    NOT interchangeable with services.quickbooks._to_qb_addr, which emits the
    QuickBooks ONLINE shape (Line1 / City / CountrySubDivisionCode / PostalCode).
    Passing that to Desktop is rejected -- caught in live acceptance, where the
    rejection arrived as a generic "internal server error".
    """
    if not addr:
        return None
    out: dict = {}
    if addr.get("address_line1"):
        out["line1"] = addr["address_line1"]
    if addr.get("address_line2"):
        out["line2"] = addr["address_line2"]
    if addr.get("city"):
        out["city"] = addr["city"][:31]
    if addr.get("state"):
        out["state"] = addr["state"][:21]
    if addr.get("postal_code"):
        out["postalCode"] = addr["postal_code"][:13]
    if addr.get("country"):
        out["country"] = addr["country"]
    return out or None


def job_to_qbd_invoice_payload(
    *,
    customer_id: str,
    item_id: str,
    transaction_date: str,
    lines: list[dict],
    external_id: str,
    job_number: str | None = None,
    customer_po_number: str | None = None,
    billing_address: dict | None = None,
    terms_id: str | None = None,
    sales_tax_code_id: str | None = None,
) -> dict:
    """PURE transform: firm lines -> a Conductor create-invoice body.

    NO refNumber. QuickBooks assigns the next one itself (verified), so sending
    one would only let Jigged fight the shop's own numbering.

    RATE, NEVER AMOUNT. Conductor documents that `rate` is ignored when `amount`
    is supplied, so sending both loses the unit price and the printed invoice
    shows a lump sum. An AP department reconciles qty x unit price against their
    PO, so we send quantity + rate and let QuickBooks extend it. Jigged's own
    authoritative figure stays in quickbooks_invoice_line_items.total_price.

    THE PO NUMBER IS A NATIVE FIELD here, so none of QBO's custom-field discovery
    is needed. It lands in two places: purchaseOrderNumber, and every line's
    description -- the latter prints unconditionally and is what the pilot shop's
    AP already pays from. `memo` carries the Jigged job number for internal
    search only; Conductor documents that memo does not print.

    externalId is the draft's request_id. It is NOT a dedup key -- Conductor does
    not dedupe on it -- it is the only field we control that identifies our own
    invoice when a create's outcome is unknown.
    """
    po_suffix = f" (PO Number: {customer_po_number})" if customer_po_number else ""
    qbd_lines: list[dict] = []
    for ln in lines:
        unit_price = ln.get("unit_price")
        if unit_price is None:
            raise QbdApiError(f"Cannot push: line '{ln.get('part_name')}' has no unit price.")
        description = ln.get("part_name") or "Part"
        if ln.get("description"):
            description = f"{description} — {ln['description']}"
        description = f"{description}{po_suffix}"[:LINE_DESCRIPTION_MAX]

        line: dict = {
            "itemId": item_id,
            "description": description,
            "quantity": ln["quantity"],
            "rate": f"{float(unit_price):.5f}",
        }
        if sales_tax_code_id:
            line["salesTaxCodeId"] = sales_tax_code_id
        qbd_lines.append(line)

    payload: dict = {
        "customerId": customer_id,
        "transactionDate": transaction_date,
        "externalId": external_id,
        "lines": qbd_lines,
    }
    if terms_id:
        payload["termsId"] = terms_id
    if customer_po_number:
        payload["purchaseOrderNumber"] = customer_po_number[:PO_NUMBER_MAX]
    if billing_address:
        payload["billingAddress"] = billing_address

    note_parts: list[str] = []
    if job_number:
        note_parts.append(f"Jigged job {job_number}")
    if customer_po_number:
        note_parts.append(f"PO Number: {customer_po_number}")
    if note_parts:
        payload["memo"] = " · ".join(note_parts)
    return payload


def create_invoice(end_user_id: str, payload: dict, *, request_id: str) -> dict:
    """-> {"id", "doc_number", "sync_token"}

    May raise QbdUnknownOutcome, which the caller must NOT treat as a failure:
    verified that a create aborted client-side still produced an invoice.
    """
    if _is_fake():
        rid = str(request_id)
        return {"id": f"E2E-QBD-{rid[:8]}", "doc_number": f"E2E-{rid[:4]}", "sync_token": "1"}
    created = _request("POST", "/invoices", end_user_id=end_user_id,
                       json_body=payload, is_write=True)
    return {
        "id": created["id"],
        "doc_number": created.get("refNumber"),
        "sync_token": created.get("revisionNumber"),
    }


def find_created_invoice(end_user_id: str, *, qb_customer_id: str,
                         transaction_date: str, external_id: str) -> Optional[dict]:
    """Did the invoice for this draft actually land? The recovery primitive.

    Conductor has no idempotency key and its List Invoices cannot filter on
    externalId -- but it does not need to. Listing by customerIds plus a one-day
    transactionDate window returns a handful of rows, and the match is
    client-side. Verified end to end: after a create aborted at 1s, the invoice
    was found on the first poll ~2s later, among 2 candidates.
    """
    rows = _list(
        "/invoices",
        end_user_id,
        {
            "customerIds": qb_customer_id,
            "transactionDateFrom": transaction_date,
            "transactionDateTo": transaction_date,
            "limit": 150,
        },
    )
    for inv in rows:
        if inv.get("externalId") == external_id:
            return {
                "id": inv["id"],
                "doc_number": inv.get("refNumber"),
                "sync_token": inv.get("revisionNumber"),
            }
    return None
