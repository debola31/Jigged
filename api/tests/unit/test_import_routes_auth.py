"""Who may run an import: the seven `/api/<entity>/import/execute` routes.

These routes write with the service-role key, which bypasses RLS and the billing write-gate,
and they take the company from the request BODY. Until this guard they also took no token, so
anyone could write any shop's customers, parts or routings. Each test drives a route over ASGI
with the real guard and a Supabase double that records every call, and asserts the double was
never touched when the caller is refused: the import must not start, not merely fail later.
"""
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

import routes.company_auth as company_auth
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
BASE = {"company_id": COMPANY, "mappings": {}, "rows": []}

# (path, module whose get_supabase the route depends on, the smallest valid body)
ROUTES = [
    ("/api/customers/import/execute", import_routes, BASE),
    ("/api/bom/import/execute", bom_import_routes, BASE),
    ("/api/parts/import/execute", parts_import_routes, {**BASE, "pricing_columns": []}),
    ("/api/routings/import/execute", routings_import_routes, BASE),
    ("/api/vendor-services/import/execute", vendor_services_import_routes, BASE),
    ("/api/vendors/import/execute", vendors_import_routes, BASE),
    ("/api/work-centers/import/execute", work_centers_import_routes, BASE),
]
IDS = [path.split("/")[2] for path, _, _ in ROUTES]


@pytest.fixture
def route_db():
    """The service-role client each route would write with. Untouched means nothing ran."""
    db = MagicMock(name="route-service-role-client")
    yield db
    app.dependency_overrides.clear()


async def _post(path, module, body, db, headers=None):
    app.dependency_overrides[module.get_supabase] = lambda: db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as ac:
        return await ac.post(path, json=body, headers=headers or {})


def _member(role: str):
    return AsyncMock(return_value=("user-1", {"id": "access-1", "role": role}))


def _entitlement(allowed):
    """A service client whose company_can_write RPC answers `allowed`."""
    client = MagicMock(name="auth-service-client")
    client.rpc.return_value.execute.return_value.data = allowed
    return client


@pytest.mark.parametrize("path,module,body", ROUTES, ids=IDS)
async def test_no_token_is_refused_before_anything_runs(path, module, body, route_db):
    res = await _post(path, module, body, route_db)
    assert res.status_code == 401
    assert route_db.mock_calls == []


@pytest.mark.parametrize("path,module,body", ROUTES, ids=IDS)
async def test_a_stranger_to_the_company_is_refused(path, module, body, route_db, monkeypatch):
    monkeypatch.setattr(
        company_auth,
        "verify_company_access",
        AsyncMock(side_effect=HTTPException(status_code=403, detail="No access to this company")),
    )
    res = await _post(path, module, body, route_db, {"Authorization": "Bearer t"})
    assert res.status_code == 403
    assert route_db.mock_calls == []


@pytest.mark.parametrize("path,module,body", ROUTES, ids=IDS)
async def test_an_operator_is_refused(path, module, body, route_db, monkeypatch):
    """RLS cannot tell an operator from an office user; the route has to."""
    monkeypatch.setattr(company_auth, "verify_company_access", _member("operator"))
    res = await _post(path, module, body, route_db, {"Authorization": "Bearer t"})
    assert res.status_code == 403
    assert res.json()["detail"] == company_auth.OFFICE_ONLY_DETAIL
    assert route_db.mock_calls == []


@pytest.mark.parametrize("path,module,body", ROUTES, ids=IDS)
async def test_a_lapsed_company_is_refused(path, module, body, route_db, monkeypatch):
    """The service role skips the billing RLS, so the route must ask company_can_write."""
    monkeypatch.setattr(company_auth, "verify_company_access", _member("admin"))
    auth_client = _entitlement(False)
    monkeypatch.setattr(company_auth, "service_client", lambda: auth_client)
    res = await _post(path, module, body, route_db, {"Authorization": "Bearer t"})
    assert res.status_code == 403
    assert res.json()["detail"] == company_auth.BILLING_BLOCKED_DETAIL
    auth_client.rpc.assert_called_once_with("company_can_write", {"check_company_id": COMPANY})
    assert route_db.mock_calls == []


@pytest.mark.parametrize("path,module,body", ROUTES, ids=IDS)
async def test_the_guard_checks_the_company_named_in_the_body(path, module, body, route_db, monkeypatch):
    guard = AsyncMock(side_effect=HTTPException(status_code=418, detail="stop here"))
    monkeypatch.setattr(company_auth, "verify_office_write_access", guard)
    res = await _post(path, module, body, route_db, {"Authorization": "Bearer t"})
    assert res.status_code == 418
    (_, company_id), _ = guard.await_args
    assert company_id == COMPANY
    assert route_db.mock_calls == []
