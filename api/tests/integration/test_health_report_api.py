"""API tests for the read-only Data Health report endpoints (routes/health_report_routes.py).

Fully mocked (no DB, no AI). Covers the two-phase flow (/structure then /findings),
caller-authorization, the opt-in feature gate, size caps, and — critically for #523 —
the write-free guarantee (a static AST check + a runtime mock that raises on any write).
"""

import ast
import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

import routes.health_report_routes as hr
from index import app
from services.ai.base_provider import ErpDetectionResult, FileStructure, HealthNarrativeResult, StructureResult

pytestmark = pytest.mark.unit


# --------------------------------------------------------------------------- mocks
class _Resp:
    def __init__(self, data):
        self.data = data


class _Table:
    """Chainable read mock. Any write method raises — enforces the no-write guarantee."""

    def __init__(self, name, data, on_write):
        self.name = name
        self._data = data
        self._on_write = on_write

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def single(self):
        return self

    def maybe_single(self):
        return self

    def execute(self):
        return _Resp(self._data)

    def insert(self, *a, **k):
        self._on_write(f"insert:{self.name}")

    def update(self, *a, **k):
        self._on_write(f"update:{self.name}")

    def upsert(self, *a, **k):
        self._on_write(f"upsert:{self.name}")

    def delete(self, *a, **k):
        self._on_write(f"delete:{self.name}")


class _Auth:
    def __init__(self, user_id):
        self._user_id = user_id

    def get_user(self, token):
        if not self._user_id:
            return SimpleNamespace(user=None)
        return SimpleNamespace(user=SimpleNamespace(id=self._user_id))


class MockClient:
    def __init__(self, has_access=True, features=None, user_id="user-1"):
        self._has_access = has_access
        self._features = features if features is not None else {"data_health_report": True}
        self.auth = _Auth(user_id)
        self.writes: list[str] = []

    def _record_write(self, what):
        self.writes.append(what)
        raise AssertionError(f"Unexpected write attempted: {what}")

    def table(self, name):
        if name == "user_company_access":
            data = [{"id": "acc-1"}] if self._has_access else []
        elif name == "companies":
            data = {"settings": {"features": self._features}}
        else:
            data = []
        return _Table(name, data, self._record_write)


class MockProvider:
    provider_name = "mock"
    model = "mock-model"

    async def analyze_structure(self, files, entity_schemas, erp_catalog):
        structs = []
        for f in files:
            name = f["filename"]
            if "vendor" in name:
                structs.append(FileStructure(filename=name, entity_type="vendors",
                                             entity_confidence=0.9, column_roles={"name": "VendName"}))
            else:
                structs.append(FileStructure(filename=name, entity_type="parts", entity_confidence=0.9,
                                             column_roles={"part_name": "PartNo", "preferred_vendor_name": "Vendor"}))
        return StructureResult(
            erp=ErpDetectionResult(source="tangle", display_name="Tangle", confidence=0.8,
                                   matched_headers=[{"header": "PartNo", "signal": "job-shop id"}]),
            files=structs,
        )

    async def generate_health_narrative(self, erp, findings, file_summaries):
        return HealthNarrativeResult(
            summary="Your data is mostly ready to import.",
            recommendations=["Add the missing vendor 'Ghost Co'."],
            gotchas=[{"title": "Check units", "detail": "verify", "recommended_action": "review"}],
            available=True,
        )


_STRUCTURE_BODY = {
    "company_id": "co-1",
    "files": [
        {"filename": "parts.csv", "headers": ["PartNo", "Vendor"], "row_count": 2,
         "sample_rows": [["A", "Acme"], ["B", "Ghost Co"]]},
        {"filename": "vendors.csv", "headers": ["VendName"], "row_count": 1,
         "sample_rows": [["Acme"]]},
    ],
}

# Full rows the client holds locally and subsets for /findings.
_FULL_ROWS = {
    "parts.csv": [{"PartNo": "A", "Vendor": "Acme"}, {"PartNo": "B", "Vendor": "Ghost Co"}],
    "vendors.csv": [{"VendName": "Acme"}],
}


def _client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://testserver")


async def _post(path, body, client_mock, headers=None):
    headers = headers if headers is not None else {"Authorization": "Bearer test-token"}
    with patch.object(hr, "_service_client", return_value=client_mock), \
         patch.object(hr, "get_provider", new=AsyncMock(return_value=MockProvider())):
        async with _client() as ac:
            return await ac.post(path, json=body, headers=headers)


def _build_findings_body(structure_json):
    """Mirror the frontend: subset to the needed columns and call /findings."""
    files = []
    for fc in structure_json["files"]:
        rows = _FULL_ROWS.get(fc["filename"], [])
        needed = set(fc["column_roles"].values())
        subset_headers = [h for h in fc["headers"] if h in needed]
        subset_rows = [{h: r.get(h, "") for h in subset_headers} for r in rows]
        files.append({
            "filename": fc["filename"],
            "entity_type": fc["entity_type"],
            "entity_confidence": fc["entity_confidence"],
            "column_roles": fc["column_roles"],
            "headers": subset_headers,
            "rows": subset_rows,
        })
    return {"company_id": "co-1", "erp_detection": structure_json["erp_detection"], "files": files}


# --------------------------------------------------------------------------- tests
async def test_full_flow_structure_then_findings():
    client = MockClient()
    sresp = await _post("/api/health-report/structure", _STRUCTURE_BODY, client)
    assert sresp.status_code == 200
    sj = sresp.json()
    assert sj["erp_detection"]["source"] == "tangle"
    assert sj["erp_detection"]["header_signature"]
    assert {f["filename"] for f in sj["files"]} == {"parts.csv", "vendors.csv"}

    fresp = await _post("/api/health-report/findings", _build_findings_body(sj), client)
    assert fresp.status_code == 200
    fj = fresp.json()
    assert fj["narrative_available"] is True
    assert "ready" in fj["summary"].lower()
    ids = {f["id"] for f in fj["findings"]}
    assert "orphan.parts.preferred_vendor_name" in ids  # "Ghost Co" has no vendor row
    assert any(f["category"] == "erp_gotcha" and f["verified"] is False for f in fj["findings"])
    assert client.writes == []  # neither phase attempted a write


async def test_structure_missing_token_is_401():
    resp = await _post("/api/health-report/structure", _STRUCTURE_BODY, MockClient(), headers={})
    assert resp.status_code == 401


async def test_structure_no_company_access_is_403():
    resp = await _post("/api/health-report/structure", _STRUCTURE_BODY, MockClient(has_access=False))
    assert resp.status_code == 403


async def test_structure_feature_flag_off_is_403():
    resp = await _post("/api/health-report/structure", _STRUCTURE_BODY, MockClient(features={}))
    assert resp.status_code == 403
    assert "not enabled" in resp.json()["detail"].lower()


async def test_structure_too_many_files_is_413():
    body = {"company_id": "co-1",
            "files": [{"filename": f"f{i}.csv", "headers": ["A"], "row_count": 0, "sample_rows": []}
                      for i in range(13)]}
    resp = await _post("/api/health-report/structure", body, MockClient())
    assert resp.status_code == 413


async def test_findings_too_many_rows_is_413():
    body = {
        "company_id": "co-1",
        "erp_detection": {"source": "unknown"},
        "files": [{"filename": "big.csv", "entity_type": "parts", "column_roles": {"part_name": "PartNo"},
                   "headers": ["PartNo"], "rows": [{"PartNo": str(i)} for i in range(0)]}],
    }
    # Force the cap without materializing 200k rows: patch the constant low.
    with patch.object(hr, "MAX_TOTAL_ROWS", 1):
        body["files"][0]["rows"] = [{"PartNo": "1"}, {"PartNo": "2"}]
        resp = await _post("/api/health-report/findings", body, MockClient())
    assert resp.status_code == 413


# --------------------------------------------------------------------------- static write-free guard
def test_route_module_has_no_write_calls_or_import_route_imports():
    """AST-level guarantee: the route makes no write calls and imports no write path."""
    tree = ast.parse(inspect.getsource(hr))
    write_attrs = {"insert", "upsert", "update", "delete", "rpc"}
    bad = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in write_attrs:
                bad.append(node.func.attr)
        if isinstance(node, ast.Attribute) and node.attr == "admin":
            if isinstance(node.value, ast.Attribute) and node.value.attr == "auth":
                bad.append("auth.admin")
    assert not bad, f"route contains forbidden write/admin calls: {bad}"

    modules = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
        elif isinstance(node, ast.Import):
            modules.extend(a.name for a in node.names)
    assert not any("_import_routes" in m or "execute_import" in m for m in modules), (
        f"route must not import a write/import path: {modules}"
    )
