"""API tests for the read-only Data Health report endpoint (routes/health_report_routes.py).

Fully mocked (no DB, no AI). Covers the happy path, caller-authorization, the opt-in
feature gate, size caps, and — critically for #523 — the write-free guarantee (both a
static source check and a runtime mock that raises on any write).
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

    def order(self, *a, **k):
        return self

    def gte(self, *a, **k):
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


_BUNDLE = {
    "company_id": "co-1",
    "files": [
        {"filename": "parts.csv", "headers": ["PartNo", "Vendor"],
         "rows": [{"PartNo": "A", "Vendor": "Acme"}, {"PartNo": "B", "Vendor": "Ghost Co"}]},
        {"filename": "vendors.csv", "headers": ["VendName"],
         "rows": [{"VendName": "Acme"}]},
    ],
}


async def _post(client_mock, body=None, headers=None):
    body = body if body is not None else _BUNDLE
    headers = headers if headers is not None else {"Authorization": "Bearer test-token"}
    with patch.object(hr, "_service_client", return_value=client_mock), \
         patch.object(hr, "get_provider", new=AsyncMock(return_value=MockProvider())):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            return await ac.post("/api/health-report/analyze", json=body, headers=headers)


# --------------------------------------------------------------------------- tests
async def test_happy_path_returns_report_with_orphan_and_narrative():
    resp = await _post(MockClient())
    assert resp.status_code == 200
    report = resp.json()["report"]
    assert report["erp_detection"]["source"] == "tangle"
    assert report["erp_detection"]["header_signature"]  # signature stamped
    assert report["narrative_available"] is True
    assert "ready" in report["summary"].lower()
    ids = {f["id"] for f in report["findings"]}
    assert "orphan.parts.preferred_vendor_name" in ids  # Ghost Co has no vendor row
    # AI gotcha appended as an unverified finding
    assert any(f["category"] == "erp_gotcha" and f["verified"] is False for f in report["findings"])


async def test_missing_token_is_401():
    resp = await _post(MockClient(), headers={})
    assert resp.status_code == 401


async def test_no_company_access_is_403():
    resp = await _post(MockClient(has_access=False))
    assert resp.status_code == 403
    assert "access" in resp.json()["detail"].lower()


async def test_feature_flag_off_is_403():
    resp = await _post(MockClient(features={}))
    assert resp.status_code == 403
    assert "not enabled" in resp.json()["detail"].lower()


async def test_too_many_files_is_413():
    body = {"company_id": "co-1",
            "files": [{"filename": f"f{i}.csv", "headers": ["A"], "rows": []} for i in range(13)]}
    resp = await _post(MockClient(), body=body)
    assert resp.status_code == 413


async def test_run_attempts_no_writes():
    client = MockClient()
    resp = await _post(client)
    assert resp.status_code == 200
    assert client.writes == []  # no insert/update/upsert/delete on any table


# --------------------------------------------------------------------------- static write-free guard
def test_route_module_has_no_write_calls_or_import_route_imports():
    """AST-level guarantee: the route makes no write calls and imports no write path.

    Parses the real code (not comments/docstrings) so the mention of these terms in the
    module docstring doesn't cause a false positive.
    """
    tree = ast.parse(inspect.getsource(hr))
    write_attrs = {"insert", "upsert", "update", "delete", "rpc"}
    bad = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in write_attrs:
                bad.append(node.func.attr)
        # `client.auth.admin...` chain
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
