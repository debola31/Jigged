"""Vendor purchase orders as QuickBooks sees them: the pure half of the push.

PURE: no database, no network, no FastAPI. The route loads the rows; this module turns
them into a projection, hashes it, describes its lines, and decides what a push must
refuse and in what words. Both providers' payload builders read the projection, so
they cannot disagree about what a PO says.

"PO" alone means the CUSTOMER's PO in this codebase (jobs.customer_po_number), so
everything here says vendor purchase order. See plan §3.1.

THE HASH IS OF JIGGED'S PROJECTION, NEVER OF THE RESOLVED QUICKBOOKS PAYLOAD. Building
the payload resolves a term and a ship method, and each of those is a QuickBooks call;
hashing the payload would mean making those calls just to learn that nothing changed.
Hashing the projection is what lets a push with no changes make zero provider calls
(plan §3.11, QB4).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Iterable, Mapping

# ───────────────────────── vocabulary ─────────────────────────
LINE_KINDS: tuple[str, ...] = ("part", "outside_service", "other")
ITEM_SETUP_KEYS: dict[str, str] = {kind: f"item:{kind}" for kind in LINE_KINDS}
AP_ACCOUNT_KEY = "ap_account"
QBO_PREFERENCES_KEY = "qbo_preferences"
KIND_LABELS = {
    "part": "parts and material",
    "outside_service": "outside services",
    "other": "other purchases",
}

# QuickBooks field caps that decide a refusal or a cut.
QBD_PO_NUMBER_MAX = 11          # Conductor refNumber
QBD_VENDOR_NAME_MAX = 41
QBO_VENDOR_NAME_MAX = 500       # Intuit Vendor.DisplayName
QBO_COMPANY_NAME_MAX = 100
QBD_VENDOR_MESSAGE_MAX = 99     # prints on the PO
QBD_MEMO_MAX = 4095             # internal
QBO_TEXT_MAX = 4000             # Memo, PrivateNote, Line.Description
QBD_DESCRIPTION_MAX = 4095
QBD_ITEM_NAME_MAX = 31
QBO_ITEM_NAME_MAX = 100

# The item every INVOICE line posts under (services/quickbooks.py DEFAULT_ITEM_NAME,
# services/quickbooks_desktop.py DEFAULT_ITEM_NAME). It posts to income, so a purchase
# on it would book a cost as negative revenue.
INVOICE_ITEM_NAME = "Machined Parts"
# One general purchases item is the default (founder decision, plan §2); the per-kind
# names are used only when a shop splits them.
DEFAULT_PURCHASE_ITEM_NAME = "Jigged purchases"
PURCHASE_ITEM_NAME_BY_KIND = {
    "part": "Jigged parts & material",
    "outside_service": "Jigged outside services",
    "other": "Jigged other purchases",
}

# ───────────────────────── the error map (plan §3.11) ─────────────────────────
# Shop-fixable conditions are 409s with a code and a sentence saying where to fix
# them, and never reach Sentry. The order is the plan's.
PO_ERROR_CODES: tuple[str, ...] = (
    # connection and plan
    "qb_not_connected", "qbd_offline", "qbo_purchase_orders_unavailable", "qbo_busy",
    # the PO
    "vendor_po_draft", "vendor_po_unsent_revision", "vendor_po_archived",
    "vendor_po_line_unpriced", "qbd_po_number_too_long",
    # setup
    "qb_setup_required", "qb_item_name_taken", "qb_reference_inactive",
    # vendors
    "qb_vendor_choice_required", "qb_vendor_name_invalid", "qb_vendor_name_taken",
    "qb_vendor_inactive",
    # QuickBooks state
    "qb_po_missing", "qb_foreign_lines", "qb_line_in_use", "qb_cannot_reopen",
    "qb_changed_in_quickbooks",
    # unconfirmed attempts
    "qbd_verify", "qbd_blocked_unverified",
)

PO_ERROR_SENTENCES: dict[str, str] = {
    "qb_not_connected": (
        "QuickBooks isn't connected to Jigged. An admin can connect it in Settings → QuickBooks."
    ),
    "qbd_offline": (
        "QuickBooks Desktop didn't answer — the QuickBooks computer may be off or asleep, or "
        "QuickBooks may be closed. Open QuickBooks on that computer, then try again."
    ),
    "qbo_purchase_orders_unavailable": (
        "Purchase orders are turned off in QuickBooks Online (they need the Plus or Advanced "
        "plan). Turn them on in QuickBooks under Settings → Account and settings → Expenses, "
        "then try again."
    ),
    "qbo_busy": "QuickBooks Online is asking Jigged to slow down. Wait a minute, then try again.",
    "vendor_po_draft": (
        "{po_number} hasn't been sent to the vendor yet. Mark it as sent on the PO page, then "
        "send it to QuickBooks."
    ),
    "vendor_po_unsent_revision": (
        "Rev {revision} of {po_number} hasn't gone to {vendor} — send it to them first (Mark as "
        "sent on the PO page), so QuickBooks matches what they have."
    ),
    "vendor_po_archived": (
        "{po_number} is archived in Jigged, so it can't be sent to QuickBooks. If it's still "
        "open in QuickBooks, close it there."
    ),
    "vendor_po_line_unpriced": (
        "Line {line_number} of {po_number} has no price yet. Add its price on the PO, then send "
        "it to QuickBooks."
    ),
    "qbd_po_number_too_long": (
        "QuickBooks Desktop takes PO numbers of up to 11 characters, and {po_number} has "
        "{length}, so this PO can't go to QuickBooks Desktop."
    ),
    "qb_setup_required": (
        "Finish the QuickBooks purchasing setup first: choose {missing} in Settings → "
        "QuickBooks → Purchasing. An admin can do it."
    ),
    "qb_item_name_taken": (
        "QuickBooks already has an item named “{name}” that posts to {account}, not to the "
        "account you chose. Pick that item instead, or choose {account}, in Settings → "
        "QuickBooks → Purchasing."
    ),
    "qb_reference_inactive": (
        "Something this PO uses in QuickBooks — the vendor, an item or a payment term — is "
        "inactive or no longer there. Make it active in QuickBooks, or choose another item in "
        "Settings → QuickBooks → Purchasing, then try again."
    ),
    "qb_vendor_choice_required": (
        "QuickBooks has more than one vendor with a name like “{name}”. Choose which one this "
        "is, then send it to QuickBooks again."
    ),
    "qb_vendor_name_invalid": (
        "QuickBooks can't take the vendor name “{name}” because {problem}. Link an existing "
        "QuickBooks vendor instead, or change the vendor's name in Jigged."
    ),
    "qb_vendor_name_taken": (
        "QuickBooks already uses the name “{name}” for a customer or an employee, so it can't "
        "be a vendor too. Link an existing QuickBooks vendor instead, or change the vendor's "
        "name in Jigged."
    ),
    "qb_vendor_inactive": (
        "The vendor “{name}” is inactive in QuickBooks. Make it active in QuickBooks, then send "
        "the PO again."
    ),
    "qb_po_missing": (
        "{po_number} isn't in QuickBooks any more — it may have been deleted there — so Jigged "
        "changed nothing. Check QuickBooks; if it should be there, enter it there by hand."
    ),
    "qb_foreign_lines": (
        "{po_number} has lines in QuickBooks that Jigged didn't send, so Jigged changed nothing "
        "there. Make this change in QuickBooks instead, or remove those lines in QuickBooks "
        "and try again."
    ),
    "qb_line_in_use": (
        "Line {line_number} of {po_number} has already been received or billed in QuickBooks, "
        "so it can't be removed or cut below {quantity}. Close the line short in Jigged "
        "instead, then send it to QuickBooks again."
    ),
    "qb_cannot_reopen": (
        "QuickBooks Desktop has received {po_number} in full, so it can't be reopened there "
        "and nothing was changed in QuickBooks. If more is coming, put it on a new PO."
    ),
    "qb_changed_in_quickbooks": (
        "{po_number} changed in QuickBooks while Jigged was updating it, so nothing was sent. "
        "Try again; if it keeps happening, make the change in QuickBooks."
    ),
    "qbd_verify": (
        "We couldn't confirm whether QuickBooks Desktop recorded {po_number}. Look for it in "
        "QuickBooks, then use Check again on the PO before sending it again."
    ),
    "qbd_blocked_unverified": (
        "An earlier send of {po_number} to QuickBooks couldn't be confirmed. Use Check again on "
        "the PO before sending it again."
    ),
}

# Used only when a caller forgot a value; every route call passes its own.
_DEFAULT_CONTEXT = {
    "po_number": "this PO", "vendor": "the vendor", "revision": "the latest revision",
    "line_number": "?", "length": "more", "name": "that name",
    "problem": "QuickBooks won't accept it", "account": "another account",
    "quantity": "what QuickBooks has recorded", "missing": "the purchasing items",
}


def po_error_message(code: str, **ctx: Any) -> str:
    """The sentence for `code`. An unknown code is a KeyError: a blank or generic
    message for a refusal is worse than a crash in development."""
    template = PO_ERROR_SENTENCES[code]
    message = template.format_map({**_DEFAULT_CONTEXT, **{k: v for k, v in ctx.items() if v is not None}})
    return message[:1].upper() + message[1:]


class PurchasingRefusal(Exception):
    """A condition the shop can fix. The route turns it into a 409 carrying the code,
    the sentence, and any `extra` fields (candidates, missing, link_id)."""

    def __init__(self, code: str, *, extra: Mapping[str, Any] | None = None, **ctx: Any):
        if code not in PO_ERROR_SENTENCES:
            raise KeyError(code)
        self.code = code
        self.ctx = ctx
        self.extra = dict(extra or {})
        super().__init__(self.message)

    @property
    def message(self) -> str:
        return po_error_message(self.code, **self.ctx)

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message, **self.extra}


# ───────────────────────── numbers ─────────────────────────
_CENT = Decimal("0.01")
_RATE = Decimal("0.00001")


def to_decimal(value: Any) -> Decimal | None:
    """PostgREST hands numeric columns over as JSON numbers; str() first so a float's
    shortest repr (what was stored) is what gets parsed, not its binary expansion."""
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"Not a number: {value!r}") from exc


def line_amount(quantity: Any, unit_price: Any) -> Decimal:
    """round(qty x price, 2), half away from zero -- SQL's round(numeric, 2), the
    TypeScript mirror and this one are pinned by __tests__/fixtures/vendorPoAmountCases.json.
    Python's round() on floats is NOT that rule (0.015 is stored as 0.01499...)."""
    q = to_decimal(quantity)
    p = to_decimal(unit_price)
    if q is None or p is None:
        raise ValueError("A line amount needs a quantity and a price.")
    return (q * p).quantize(_CENT, rounding=ROUND_HALF_UP)


def rate_string(unit_price: Any) -> str:
    """QuickBooks Desktop's `rate`: a decimal string with at most 5 places."""
    p = to_decimal(unit_price)
    if p is None:
        raise ValueError("A rate needs a price.")
    return str(p.quantize(_RATE, rounding=ROUND_HALF_UP))


def decimal_text(value: Any) -> str:
    """Trailing zeros trimmed: 144.000000 -> "144", 2.50 -> "2.5"."""
    d = to_decimal(value)
    if d is None:
        return ""
    return format(d.normalize(), "f")


def json_number(value: Any) -> int | float:
    """A Decimal as a JSON-serialisable number: int when whole, float otherwise."""
    d = to_decimal(value)
    if d is None:
        raise ValueError("Not a number.")
    return int(d) if d == d.to_integral_value() else float(d)


def _text(value: Any) -> str | None:
    if value is None:
        return None
    stripped = str(value).strip()
    return stripped or None


# ───────────────────────── the projection ─────────────────────────
@dataclass(frozen=True)
class PurchaseOrderLineProjection:
    line_id: str
    line_number: int
    line_kind: str
    description: str
    quantity: Decimal
    unit: str
    unit_price: Decimal | None
    stock_unit: str | None = None
    stock_factor: Decimal | None = None
    part_number: str | None = None
    vendor_part_number: str | None = None
    job_number: str | None = None
    operation_label: str | None = None
    service_name: str | None = None
    work_center_name: str | None = None
    #: Closed short in Jigged (closed_at set).
    closed: bool = False


@dataclass(frozen=True)
class PurchaseOrderProjection:
    """One vendor PO as Jigged would describe it to QuickBooks, plus the few
    Jigged-only facts the push's preconditions read (status, revision, archived)."""

    vendor_po_id: str
    company_id: str
    po_number: str
    revision: int
    sent_revision: int | None
    vendor_id: str
    vendor_name: str
    vendor_address: Mapping[str, Any] | None
    ordered_on: str
    need_by_on: str | None
    payment_terms: str | None
    ship_via: str | None
    notes_to_vendor: str | None
    ship_to_name: str | None
    ship_to_address: Mapping[str, Any] | None
    #: From vendor_purchase_order_status: draft | sent | partially_received | received | closed.
    status: str
    content_version: int
    archived: bool
    closed: bool
    lines: tuple[PurchaseOrderLineProjection, ...]

    @property
    def kinds(self) -> frozenset[str]:
        return frozenset(line.line_kind for line in self.lines)


def _line_projection(row: Mapping[str, Any]) -> PurchaseOrderLineProjection:
    quantity = to_decimal(row.get("quantity"))
    if quantity is None:
        raise ValueError(f"PO line {row.get('id')} has no quantity.")
    return PurchaseOrderLineProjection(
        line_id=str(row["id"]),
        line_number=int(row["line_number"]),
        line_kind=str(row["line_kind"]),
        description=_text(row.get("description")) or "",
        quantity=quantity,
        unit=_text(row.get("unit")) or "",
        unit_price=to_decimal(row.get("unit_price")),
        stock_unit=_text(row.get("stock_unit")),
        stock_factor=to_decimal(row.get("stock_factor")),
        # vendor_purchase_order_lines.part_name is the frozen parts.part_name -- the shop's
        # part number (20261110043600). Parts carry no revision column to add to it.
        part_number=_text(row.get("part_name")),
        vendor_part_number=_text(row.get("vendor_part_number")),
        job_number=_text(row.get("job_number")),
        operation_label=_text(row.get("operation_label")),
        service_name=_text(row.get("service_name")),
        work_center_name=_text(row.get("work_center_name")),
        closed=row.get("closed_at") is not None,
    )


def projection_from_rows(
    header: Mapping[str, Any], lines: Iterable[Mapping[str, Any]], *, status: str
) -> PurchaseOrderProjection:
    """`status` comes from the vendor_purchase_order_status view: "closed" also covers
    "nothing outstanding and a line closed short", which only the view can compute."""
    projected = tuple(sorted((_line_projection(r) for r in lines), key=lambda ln: ln.line_number))
    sent_revision = header.get("sent_revision")
    return PurchaseOrderProjection(
        vendor_po_id=str(header["id"]),
        company_id=str(header["company_id"]),
        po_number=str(header["po_number"]),
        revision=int(header.get("revision") or 0),
        sent_revision=int(sent_revision) if sent_revision is not None else None,
        vendor_id=str(header["vendor_id"]),
        vendor_name=_text(header.get("vendor_name")) or "",
        vendor_address=header.get("vendor_address") if isinstance(header.get("vendor_address"), Mapping) else None,
        ordered_on=str(header["ordered_on"]),
        need_by_on=_text(header.get("need_by_on")),
        payment_terms=_text(header.get("payment_terms")),
        ship_via=_text(header.get("ship_via")),
        notes_to_vendor=_text(header.get("notes_to_vendor")),
        ship_to_name=_text(header.get("ship_to_name")),
        ship_to_address=header.get("ship_to_address") if isinstance(header.get("ship_to_address"), Mapping) else None,
        status=str(status),
        content_version=int(header.get("content_version") or 0),
        archived=header.get("deleted_at") is not None,
        closed=status == "closed",
        lines=projected,
    )


def with_lines_open(po: PurchaseOrderProjection) -> PurchaseOrderProjection:
    """The PO as QuickBooks Desktop holds it right after a create: Conductor's create
    takes no isManuallyClosed, so every PO and line starts open there."""
    return replace(po, closed=False, lines=tuple(replace(ln, closed=False) for ln in po.lines))


# ───────────────────────── the hash (QB9) ─────────────────────────
_HASH_VERSION = 1
_ADDRESS_KEYS = ("attention_to", "address_line1", "address_line2", "city", "state",
                 "postal_code", "country")


def address_parts(address: Mapping[str, Any] | None) -> dict[str, str]:
    """An AddressSnapshot reduced to its non-empty, stripped parts."""
    if not isinstance(address, Mapping):
        return {}
    out: dict[str, str] = {}
    for key in _ADDRESS_KEYS:
        value = _text(address.get(key))
        if value:
            out[key] = value
    return out


def _line_canon(line: PurchaseOrderLineProjection) -> dict:
    return {
        "id": line.line_id,
        "number": line.line_number,
        "kind": line.line_kind,
        "description": line.description,
        "quantity": decimal_text(line.quantity),
        "unit": line.unit,
        "unit_price": decimal_text(line.unit_price) if line.unit_price is not None else None,
        "stock_unit": line.stock_unit,
        "stock_factor": decimal_text(line.stock_factor) if line.stock_factor is not None else None,
        "part_number": line.part_number,
        "vendor_part_number": line.vendor_part_number,
        "job_number": line.job_number,
        "operation_label": line.operation_label,
        "service_name": line.service_name,
        "work_center_name": line.work_center_name,
        "closed": line.closed,
    }


def payload_hash(po: PurchaseOrderProjection, *, closed: bool | None = None) -> str:
    """sha256 of exactly the fields a push sends. `closed` overrides the header's
    closed state, so the hash can be taken "as QuickBooks holds it"."""
    canon = {
        "v": _HASH_VERSION,
        "po_number": po.po_number,
        "revision": po.revision,
        "ordered_on": po.ordered_on,
        "need_by_on": po.need_by_on,
        "payment_terms": po.payment_terms,
        "ship_via": po.ship_via,
        "notes_to_vendor": po.notes_to_vendor,
        "ship_to_name": po.ship_to_name,
        "ship_to_address": address_parts(po.ship_to_address) or None,
        "closed": po.closed if closed is None else bool(closed),
        "lines": [_line_canon(line) for line in po.lines],
    }
    blob = json.dumps(canon, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def operation_for(po: PurchaseOrderProjection, link: Mapping[str, Any] | None) -> str:
    """What a push must do: create | close | reopen | update | none.

    Decided from the database alone. "none" is the zero-call path (QB4): the stored
    hash says QuickBooks already holds exactly this.
    """
    if not link or not link.get("qb_po_id"):
        return "create"
    qb_closed = bool(link.get("qb_closed"))
    if po.closed and not qb_closed:
        return "close"
    if not po.closed and qb_closed:
        return "reopen"
    if payload_hash(po) != link.get("pushed_payload_hash"):
        return "update"
    return "none"


def content_changed(po: PurchaseOrderProjection, link: Mapping[str, Any]) -> bool:
    """Has anything but the header's open/closed state changed since the last push?
    A close or reopen with nothing else changed sends no lines at all."""
    return payload_hash(po, closed=bool(link.get("qb_closed"))) != link.get("pushed_payload_hash")


# ───────────────────────── preconditions ─────────────────────────
def push_refusal(po: PurchaseOrderProjection, *, provider: str) -> PurchasingRefusal | None:
    """Plan §3.11, "What a push requires", in the order a person would want to hear it."""
    if po.archived:
        return PurchasingRefusal("vendor_po_archived", po_number=po.po_number)
    if po.status == "draft" or po.sent_revision is None:
        return PurchasingRefusal("vendor_po_draft", po_number=po.po_number)
    if po.revision != po.sent_revision:
        return PurchasingRefusal("vendor_po_unsent_revision", po_number=po.po_number,
                                 revision=po.revision, vendor=po.vendor_name or None)
    for line in po.lines:
        if line.unit_price is None:
            return PurchasingRefusal("vendor_po_line_unpriced", po_number=po.po_number,
                                     line_number=line.line_number)
    if provider == "qbd" and len(po.po_number) > QBD_PO_NUMBER_MAX:
        return PurchasingRefusal("qbd_po_number_too_long", po_number=po.po_number,
                                 length=len(po.po_number))
    return None


def vendor_name_problem(name: str | None, *, max_length: int) -> str | None:
    """Why QuickBooks can't take this vendor name, phrased to follow "because", or None.

    REFUSES; never offers a shortened version. Two vendors can share their first 41
    characters, and a truncated name would link the PO to the wrong one."""
    raw = name or ""
    if not raw.strip():
        return "it's blank"
    if ":" in raw:
        return "it contains a colon, which QuickBooks reads as a sub-name separator"
    if any(ch in raw for ch in "\t\r\n"):
        return "it contains a tab or a line break"
    length = len(raw.strip())
    if length > max_length:
        return f"it's {length} characters long, and QuickBooks allows {max_length}"
    return None


def is_invoice_item(item: Mapping[str, Any], *, invoice_item_ids: Iterable[str | None]) -> bool:
    """The invoice item, by id or by its fixed name. Never a purchase item."""
    ids = {str(i) for i in invoice_item_ids if i}
    if item.get("id") is not None and str(item.get("id")) in ids:
        return True
    return (_text(item.get("name")) or "").casefold() == INVOICE_ITEM_NAME.casefold()


def describe_missing(missing: Iterable[str]) -> str:
    """["item:part", "ap_account"] -> "the item for parts and material and the
    accounts-payable account"."""
    keys = list(missing)
    kinds = [KIND_LABELS[k.split(":", 1)[1]] for k in keys
             if k.startswith("item:") and k.split(":", 1)[1] in KIND_LABELS]
    parts: list[str] = []
    if kinds:
        noun = "the item for " if len(kinds) == 1 else "the items for "
        parts.append(noun + _and_join(kinds))
    if AP_ACCOUNT_KEY in keys:
        parts.append("the accounts-payable account")
    return " and ".join(parts) or "the purchasing items"


def _and_join(words: list[str]) -> str:
    if len(words) <= 1:
        return "".join(words)
    return ", ".join(words[:-1]) + " and " + words[-1]


# ───────────────────────── descriptions ─────────────────────────
def unit_label(line: PurchaseOrderLineProjection) -> str:
    """"bar (= 144 inches)" when the purchase unit is not the stock unit."""
    if (line.stock_unit and line.stock_factor is not None
            and line.unit and line.unit != line.stock_unit):
        return f"{line.unit} (= {decimal_text(line.stock_factor)} {line.stock_unit})"
    return line.unit or (line.stock_unit or "")


def _dash_join(first: str | None, second: str | None) -> str:
    """"BRKT-100 — 6061-T6 bar", unless the second part already starts with the first."""
    a = (first or "").strip()
    b = (second or "").strip()
    if not a or not b:
        return a or b
    if b.casefold().startswith(a.casefold()):
        return b
    return f"{a} — {b}"


def describe_line(line: PurchaseOrderLineProjection, *, max_length: int) -> str:
    """The QuickBooks line description.

    QuickBooks has no fields for a purchase unit, a vendor part number, a job or an
    operation, so they travel here (plan §3.11). The head is what the vendor's PDF
    says; each fact is appended only when the head does not already carry it, so a
    description Jigged prefilled ("Anodize — 1234-A — Job J-1042, Op 30") is not
    repeated back."""
    if line.line_kind == "part":
        head = _dash_join(line.part_number, line.description)
    elif line.line_kind == "outside_service":
        head = line.description or _dash_join(line.service_name, line.part_number)
    else:
        head = line.description
    folded = head.casefold()

    def absent(value: str | None) -> bool:
        return bool(value) and value.casefold() not in folded

    facts: list[str] = []
    if line.line_kind == "outside_service" and absent(line.part_number):
        facts.append(f"Part {line.part_number}")
    if absent(line.vendor_part_number):
        facts.append(f"Vendor P/N {line.vendor_part_number}")
    if line.line_kind == "other" and absent(line.work_center_name):
        facts.append(f"Machine: {line.work_center_name}")
    unit = unit_label(line)
    if unit:
        facts.append(f"Unit: {unit}")
    if absent(line.job_number):
        job = f"Job {line.job_number}"
        if line.line_kind == "outside_service" and line.operation_label:
            job = f"{job} op {line.operation_label}"
        facts.append(job)
    text = " · ".join(p for p in [head, *facts] if p)
    return text[:max_length]


def private_note(po: PurchaseOrderProjection, jigged_url: str | None = None) -> str:
    """`Jigged PO-1042 Rev 2 · <link>` -- internal on both providers (QBO
    PrivateNote, QBD memo). Rev 0 is not printed, matching the PDF."""
    text = f"Jigged {po.po_number}"
    if po.revision > 0:
        text += f" Rev {po.revision}"
    if jigged_url:
        text += f" · {jigged_url}"
    return text


def cut_with_ellipsis(text: str, limit: int) -> tuple[str, bool]:
    """Cut to `limit` characters, the last being "…". -> (text, was_cut)."""
    if len(text) <= limit:
        return text, False
    return text[: limit - 1] + "…", True
