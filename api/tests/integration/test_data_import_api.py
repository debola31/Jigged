"""API tests for the data-import endpoints (routes/data_import_routes.py).

The server is AI-only now (the deterministic analyzer runs in the browser). These cover
the two AI endpoints (/structure, /narrative), caller-authorization, the opt-in feature
gate, caps, and — for #523 — the write-free guarantee (static AST + runtime write-raising
mock). The deterministic findings logic is tested in the TS vitest suite.
"""

import ast
import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

import routes.data_import_routes as hr
from index import app
from services.ai.base_provider import ErpDetectionResult, FileStructure, ImportNarrativeResult, StructureResult

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
        self._features = features if features is not None else {"data_import": True}
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
        structs = [
            FileStructure(filename=f["filename"], entity_type="parts", entity_confidence=0.9,
                          column_roles={"part_name": "PartNo"})
            for f in files
        ]
        return StructureResult(
            erp=ErpDetectionResult(source="tangle", display_name="Tangle", confidence=0.8,
                                   matched_headers=[{"header": "PartNo", "signal": "job-shop id"}]),
            files=structs,
        )

    async def generate_import_narrative(self, erp, findings, file_summaries):
        return ImportNarrativeResult(
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
    ],
}

_NARRATIVE_BODY = {
    "company_id": "co-1",
    "erp_detection": {"source": "tangle", "display_name": "Tangle", "confidence": 0.8},
    "findings": [{"id": "orphan.parts.preferred_vendor_name", "category": "orphan_reference",
                  "severity": "critical", "title": "1 part references a missing vendor", "count": 1}],
    "file_summaries": [{"filename": "parts.csv", "entity_type": "parts", "row_count": 2}],
}


async def _post(path, body, client_mock, headers=None):
    headers = headers if headers is not None else {"Authorization": "Bearer test-token"}
    with patch.object(hr, "_service_client", return_value=client_mock), \
         patch.object(hr, "get_provider", new=AsyncMock(return_value=MockProvider())):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            return await ac.post(path, json=body, headers=headers)


# --------------------------------------------------------------------------- tests
async def test_structure_then_narrative_flow():
    client = MockClient()
    sresp = await _post("/api/data-import/structure", _STRUCTURE_BODY, client)
    assert sresp.status_code == 200
    sj = sresp.json()
    assert sj["erp_detection"]["source"] == "tangle"
    assert sj["erp_detection"]["header_signature"]
    assert sj["files"][0]["filename"] == "parts.csv"

    nresp = await _post("/api/data-import/narrative", _NARRATIVE_BODY, client)
    assert nresp.status_code == 200
    nj = nresp.json()
    assert nj["narrative_available"] is True
    assert "ready" in nj["summary"].lower()
    assert nj["gotchas"][0]["title"] == "Check units"
    assert client.writes == []  # neither endpoint attempted a write


async def test_structure_missing_token_is_401():
    resp = await _post("/api/data-import/structure", _STRUCTURE_BODY, MockClient(), headers={})
    assert resp.status_code == 401


async def test_structure_no_company_access_is_403():
    resp = await _post("/api/data-import/structure", _STRUCTURE_BODY, MockClient(has_access=False))
    assert resp.status_code == 403


async def test_structure_feature_flag_off_is_403():
    resp = await _post("/api/data-import/structure", _STRUCTURE_BODY, MockClient(features={}))
    assert resp.status_code == 403
    assert "not enabled" in resp.json()["detail"].lower()


async def test_narrative_feature_flag_off_is_403():
    resp = await _post("/api/data-import/narrative", _NARRATIVE_BODY, MockClient(features={}))
    assert resp.status_code == 403


async def test_structure_too_many_files_is_413():
    body = {"company_id": "co-1",
            "files": [{"filename": f"f{i}.csv", "headers": ["A"], "row_count": 0, "sample_rows": []}
                      for i in range(13)]}
    resp = await _post("/api/data-import/structure", body, MockClient())
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
