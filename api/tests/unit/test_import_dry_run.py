"""`dry_run` on the seven `/api/<entity>/import/execute` routes.

A dry run is how an assistant previews an import (lib/mcp/tools/imports.ts): the route runs its
whole validation and conflict detection, then returns the counts a real run would report, and
writes nothing. Two things have to hold, and each test here checks both against the same data:

  - nothing is written: no insert, upsert, update, delete or RPC reaches the database;
  - the answer is the real run's answer: the same created / updated / skipped counts, the same
    skipped rows and the same per-row errors as the route reports when it does write.

Each route runs over ASGI against an in-memory Supabase double that answers reads from fixed
tables and records every write, so the real run can go all the way through too.
"""
import copy
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

import routes.company_auth as company_auth
import services.uom_normalizer as uom_normalizer
from index import app
from routes import (
    bom_import_routes,
    import_routes,
    parts_import_routes,
    routings_import_routes,
    vendor_services_import_routes,
    vendors_import_routes,
    work_centers_import_routes,
)

pytestmark = pytest.mark.unit

COMPANY = "11111111-1111-1111-1111-111111111111"


class FakeQuery:
    """One PostgREST call: filters and paging for reads; writes are recorded by the client."""

    def __init__(self, db: "FakeSupabase", table: str):
        self._db = db
        self._table = table
        self._op = "select"
        self._payload = None
        self._on_conflict = None
        self._filters = []
        self._range = None
        self._single = False

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, column, value):
        self._filters.append(lambda r: r.get(column) == value)
        return self

    def in_(self, column, values):
        allowed = set(values)
        self._filters.append(lambda r: r.get(column) in allowed)
        return self

    def gt(self, column, value):
        self._filters.append(lambda r: (r.get(column) or 0) > value)
        return self

    def is_(self, column, _value):  # only ever `.is_(col, "null")` in these routes
        self._filters.append(lambda r: r.get(column) is None)
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def limit(self, _n):
        return self

    def single(self):
        self._single = True
        return self

    def insert(self, rows):
        self._op, self._payload = "insert", rows
        return self

    def upsert(self, rows, on_conflict=None):
        self._op, self._payload, self._on_conflict = "upsert", rows, on_conflict
        return self

    def update(self, values):
        self._op, self._payload = "update", values
        return self

    def delete(self):
        self._op = "delete"
        return self

    def execute(self):
        if self._op == "select":
            rows = [r for r in self._db.tables.get(self._table, []) if all(f(r) for f in self._filters)]
            if self._range:
                rows = rows[self._range[0] : self._range[1] + 1]
            if self._single:
                return SimpleNamespace(data=dict(rows[0]) if rows else None)
            return SimpleNamespace(data=[dict(r) for r in rows])
        self._db.writes.append((self._op, self._table))
        if self._op in ("insert", "upsert"):
            rows = self._payload if isinstance(self._payload, list) else [self._payload]
            return SimpleNamespace(data=[self._db.persist(self._table, r, self._on_conflict) for r in rows])
        return SimpleNamespace(data=[])


class FakeSupabase:
    """The service-role client a route writes with. `writes` lists every write, RPCs included."""

    def __init__(self, tables: dict[str, list[dict]]):
        self.tables = copy.deepcopy(tables)
        self.writes: list[tuple[str, str]] = []

    def table(self, name):
        return FakeQuery(self, name)

    def rpc(self, name, _params):
        self.writes.append(("rpc", name))
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=None))

    def persist(self, table, row, on_conflict):
        """Store a written row the way insert/upsert would; an upsert keeps the matched row's id."""
        rows = self.tables.setdefault(table, [])
        keys = on_conflict.split(",") if on_conflict else []
        for existing in rows:
            if keys and all(existing.get(k) == row.get(k) for k in keys):
                existing.update(row)
                return dict(existing)
        stored = {"id": str(uuid.uuid4()), **row}
        rows.append(stored)
        return dict(stored)


def _identity(*fields: str) -> dict[str, str]:
    """The mapping an assistant's rows arrive with: each column already named for its field."""
    return {f: f for f in fields}


def _co(**row) -> dict:
    return {"company_id": COMPANY, **row}


# (id, path, module, existing tables, request body, the counts a run reports, skipped (row, type))
CASES = [
    (
        "customers",
        "/api/customers/import/execute",
        import_routes,
        {"customers": [_co(id="c1", name="Acme Corp")]},
        {
            "mappings": _identity("name", "city", "contact_name"),
            "rows": [
                {"name": "acme corp", "city": "Detroit"},  # existing, any case: updates
                {"name": "Bolt Works", "contact_name": "Pat"},  # new
                {"name": ""},  # missing_name
                {"name": "Dup"},  # csv_duplicate_name, every occurrence
                {"name": "dup"},
            ],
        },
        {"imported_count": 1, "updated_count": 1, "skipped_count": 3},
        [(3, "missing_name"), (4, "csv_duplicate_name"), (5, "csv_duplicate_name")],
    ),
    (
        "vendors",
        "/api/vendors/import/execute",
        vendors_import_routes,
        {"vendors": [_co(id="v1", name="Great Lakes Plating")]},
        {
            "mappings": _identity("name", "primary_contact_name", "primary_contact_email"),
            "rows": [
                {"name": "Great Lakes Plating", "primary_contact_name": "Sam"},  # existing: no contact
                {"name": "Apex Anodize", "primary_contact_name": "Lee", "primary_contact_email": "l@a.test"},
                {"name": "Quiet Co", "primary_contact_email": "x@q.test"},  # missing_contact_name
                {"name": ""},  # missing_name
            ],
        },
        {"imported_count": 1, "updated_count": 1, "skipped_count": 2, "contacts_imported_count": 1},
        [(3, "missing_contact_name"), (4, "missing_name")],
    ),
    (
        "vendor-services",
        "/api/vendor-services/import/execute",
        vendor_services_import_routes,
        {
            "vendors": [_co(id="v1", name="Great Lakes Plating")],
            "vendor_services": [_co(id="s1", vendor_id="v1", name="Anodize")],
        },
        {
            "mappings": _identity("vendor_name", "service_name", "unit_price"),
            "rows": [
                {"vendor_name": "Great Lakes Plating", "service_name": "anodize", "unit_price": "4.5"},
                {"vendor_name": "Great Lakes Plating", "service_name": "Passivate"},
                {"vendor_name": "Nobody Inc", "service_name": "Paint"},  # unknown_vendor
                {"vendor_name": "Great Lakes Plating", "service_name": "Heat treat", "unit_price": "-1"},
            ],
        },
        {"imported_count": 1, "updated_count": 1, "skipped_count": 2},
        [(3, "unknown_vendor"), (4, "invalid_price")],
    ),
    (
        "work-centers",
        "/api/work-centers/import/execute",
        work_centers_import_routes,
        {"work_centers": [_co(id="w1", name="Haas VF-2")]},
        {
            "mappings": _identity("name", "labor_rate"),
            "rows": [
                {"name": "haas vf-2", "labor_rate": "95"},
                {"name": "Deburr Bench"},
                {"name": "Lathe", "labor_rate": "abc"},  # invalid_rate
                {"name": ""},  # missing_name
            ],
        },
        {"imported_count": 1, "updated_count": 1, "skipped_count": 2},
        [(3, "invalid_rate"), (4, "missing_name")],
    ),
    (
        "parts",
        "/api/parts/import/execute",
        parts_import_routes,
        {
            "parts": [_co(id="p1", part_name="BRK-100", quantity=5, primary_unit="each")],
            "vendors": [_co(id="v1", name="Great Lakes Plating")],
            "inventory_locations": [
                _co(id="L1", name="Shelf A", parent_id=None),
                _co(id="L2", name="Shelf B", parent_id=None),
            ],
            "part_location_stock": [_co(part_id="p1", location_id="L2", quantity=5)],
        },
        {
            "pricing_columns": [],
            "mappings": _identity(
                "part_name", "primary_unit", "quantity", "location_name", "preferred_vendor_name", "cost_per_unit"
            ),
            "rows": [
                # Existing, its stock already on Shelf B: updates, the quantity is not written.
                {"part_name": "BRK-100", "primary_unit": "ea", "quantity": "10", "location_name": "Shelf A"},
                {
                    "part_name": "PIN-7",
                    "primary_unit": "pcs",
                    "quantity": "20",
                    "location_name": "Shelf A",
                    "preferred_vendor_name": "Great Lakes Plating",
                    "cost_per_unit": "1.25",
                },
                {"part_name": "NUT-3", "primary_unit": "each", "quantity": "4"},  # no place: not written
                {"part_name": "WASHER", "primary_unit": "each", "preferred_vendor_name": "Nobody"},
                {"part_name": "", "primary_unit": "each"},  # missing_part_name
                {"part_name": "BAR-1", "primary_unit": "furlongs"},  # unknown_unit
            ],
            # How the assistant's tool sends units: resolved up front, so no row asks the AI.
            "uom_resolutions": {"1": "each", "2": "pieces", "3": "each", "4": "each", "5": "each"},
        },
        {
            "imported_count": 2,
            "updated_count": 1,
            "skipped_count": 3,
            "quantity_skipped_already_placed": ["BRK-100", "NUT-3"],
        },
        [(4, "unknown_vendor"), (5, "missing_part_name"), (6, "unknown_unit")],
    ),
    (
        "bom",
        "/api/bom/import/execute",
        bom_import_routes,
        {
            "parts": [
                _co(id="p1", part_name="ASSY-1"),
                _co(id="p2", part_name="BRK-100"),
                _co(id="p3", part_name="PIN-7"),
            ],
            "parts_bom": [{"id": "b1", "parent_part_id": "p1", "child_part_id": "p2", "quantity": 1, "unit": "each"}],
        },
        {
            "mappings": _identity("parent_part_name", "child_part_name", "quantity", "unit"),
            "rows": [
                {"parent_part_name": "ASSY-1", "child_part_name": "BRK-100", "quantity": "2", "unit": "each"},
                {"parent_part_name": "ASSY-1", "child_part_name": "PIN-7", "quantity": "4", "unit": "each"},
                {"parent_part_name": "PIN-7", "child_part_name": "ASSY-1", "quantity": "1", "unit": "each"},
                {"parent_part_name": "ASSY-1", "child_part_name": "GHOST", "quantity": "1", "unit": "each"},
                {"parent_part_name": "BRK-100", "child_part_name": "PIN-7", "quantity": "0", "unit": "each"},
            ],
        },
        {"imported_count": 1, "updated_count": 1, "skipped_count": 3},
        [(3, "would_create_cycle"), (4, "unknown_child_part"), (5, "invalid_quantity")],
    ),
    (
        "routings",
        "/api/routings/import/execute",
        routings_import_routes,
        {
            "parts": [_co(id="p1", part_name="BRK-100"), _co(id="p2", part_name="PIN-7")],
            "work_centers": [_co(id="w1", name="Haas VF-2", deleted_at=None)],
            "vendor_services": [
                _co(id="s1", name="Anodize", unit_price=4.5, deleted_at=None, vendors={"name": "Great Lakes Plating"})
            ],
            "routings": [_co(id="r1", part_id="p1", name="Routing for BRK-100")],
            "routing_operations": [{"id": "o1", "routing_id": "r1", "sequence": 1}],
        },
        {
            "mappings": _identity(
                "part_name",
                "work_center_name",
                "sequence",
                "setup_minutes",
                "cycle_minutes_per_unit",
                "external_unit_price",
            ),
            "rows": [
                {"part_name": "BRK-100", "work_center_name": "Haas VF-2", "sequence": "1", "setup_minutes": "30"},
                {"part_name": "BRK-100", "work_center_name": "Anodize", "sequence": "2", "external_unit_price": "5"},
                {"part_name": "PIN-7", "work_center_name": "Haas VF-2", "sequence": "1", "cycle_minutes_per_unit": "2.5"},
                {"part_name": "GHOST", "work_center_name": "Haas VF-2", "sequence": "1"},
                {"part_name": "PIN-7", "work_center_name": "Nowhere", "sequence": "2"},
                {"part_name": "PIN-7", "work_center_name": "Anodize", "sequence": "3", "setup_minutes": "10"},
            ],
        },
        {
            "imported_routings_count": 1,
            "imported_operations_count": 2,
            "updated_count": 1,
            "skipped_count": 3,
        },
        [(4, "unknown_part"), (5, "unknown_work_center"), (6, "internal_field_on_external")],
    ),
]
IDS = [case[0] for case in CASES]

# Everything a run reports about what it did, compared between the dry run and the real one.
REPORTED = (
    "imported_count",
    "updated_count",
    "skipped_count",
    "merged_count",
    "contacts_imported_count",
    "imported_routings_count",
    "imported_operations_count",
    "quantity_skipped_already_placed",
    "skipped_rows",
    "errors",
)


@pytest.fixture(autouse=True)
def no_ai_units(monkeypatch):
    """A preview must not spend AI credits; every unit in these cases resolves without it."""

    def refuse(*_args, **_kwargs):
        raise AssertionError("an import asked the AI to infer a unit")

    monkeypatch.setattr(uom_normalizer, "infer_uom_with_ai", refuse)


@pytest.fixture(autouse=True)
def clear_overrides():
    yield
    app.dependency_overrides.clear()


def _office(monkeypatch, *, role: str = "user", entitled: bool = True) -> MagicMock:
    """A member of COMPANY with `role`; the returned client answers the billing check."""
    monkeypatch.setattr(
        company_auth,
        "verify_company_access",
        AsyncMock(return_value=("user-1", {"id": "access-1", "role": role})),
    )
    auth_client = MagicMock(name="auth-service-client")
    auth_client.rpc.return_value.execute.return_value.data = entitled
    monkeypatch.setattr(company_auth, "service_client", lambda: auth_client)
    return auth_client


async def _post(path, module, body, db):
    app.dependency_overrides[module.get_supabase] = lambda: db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as ac:
        return await ac.post(path, json=body, headers={"Authorization": "Bearer t"})


def _body(body: dict, *, dry_run: bool) -> dict:
    return {"company_id": COMPANY, "skip_conflicts": True, **body, "dry_run": dry_run}


@pytest.mark.parametrize("_id,path,module,tables,body,expected,skipped", CASES, ids=IDS)
async def test_a_dry_run_writes_nothing_and_reports_what_the_real_run_does(
    _id, path, module, tables, body, expected, skipped, monkeypatch
):
    _office(monkeypatch)

    dry_db = FakeSupabase(tables)
    dry = await _post(path, module, _body(body, dry_run=True), dry_db)
    assert dry.status_code == 200, dry.text
    assert dry_db.writes == []
    assert dry.json()["dry_run"] is True

    real_db = FakeSupabase(tables)
    real = await _post(path, module, _body(body, dry_run=False), real_db)
    assert real.status_code == 200, real.text
    assert real_db.writes, "the real run should have written"
    assert real.json()["dry_run"] is False

    dry_report = {k: v for k, v in dry.json().items() if k in REPORTED}
    real_report = {k: v for k, v in real.json().items() if k in REPORTED}
    assert dry_report == real_report
    # Both agreeing is not enough: they must agree on the right answer.
    for key, value in expected.items():
        assert dry_report[key] == value, key
    assert [(r["row_number"], r["type"]) for r in dry_report["skipped_rows"]] == skipped
    assert all(r["reason"] for r in dry_report["skipped_rows"])


@pytest.mark.parametrize("_id,path,module,tables,body,expected,skipped", CASES, ids=IDS)
async def test_a_lapsed_company_can_preview_but_not_import(
    _id, path, module, tables, body, expected, skipped, monkeypatch
):
    """A preview saves nothing, so the billing write-gate does not apply to it."""
    auth_client = _office(monkeypatch, entitled=False)

    dry = await _post(path, module, _body(body, dry_run=True), FakeSupabase(tables))
    assert dry.status_code == 200, dry.text
    auth_client.rpc.assert_not_called()

    real_db = FakeSupabase(tables)
    real = await _post(path, module, _body(body, dry_run=False), real_db)
    assert real.status_code == 403
    assert real.json()["detail"] == company_auth.BILLING_BLOCKED_DETAIL
    assert real_db.writes == []


@pytest.mark.parametrize("_id,path,module,tables,body,expected,skipped", CASES, ids=IDS)
async def test_an_operator_cannot_preview_either(_id, path, module, tables, body, expected, skipped, monkeypatch):
    _office(monkeypatch, role="operator")
    db = MagicMock(name="route-service-role-client")
    res = await _post(path, module, _body(body, dry_run=True), db)
    assert res.status_code == 403
    assert res.json()["detail"] == company_auth.OFFICE_ONLY_DETAIL
    assert db.mock_calls == []


@pytest.mark.parametrize("_id,path,module,tables,body,expected,skipped", CASES, ids=IDS)
async def test_a_dry_run_checks_the_company_named_in_the_body(
    _id, path, module, tables, body, expected, skipped, monkeypatch
):
    guard = AsyncMock(side_effect=company_auth.HTTPException(status_code=418, detail="stop here"))
    write_guard = AsyncMock()
    monkeypatch.setattr(company_auth, "verify_office_access", guard)
    monkeypatch.setattr(company_auth, "verify_office_write_access", write_guard)
    db = MagicMock(name="route-service-role-client")
    res = await _post(path, module, _body(body, dry_run=True), db)
    assert res.status_code == 418
    (_, company_id), _ = guard.await_args
    assert company_id == COMPANY
    write_guard.assert_not_awaited()
    assert db.mock_calls == []
