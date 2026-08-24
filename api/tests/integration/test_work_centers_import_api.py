"""
Integration tests for the Work Centers Import API endpoints.

Covers analyze / validate / execute for both internal and external work_centers,
including vendor name resolution and the kind/vendor pairing constraints.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from httpx import AsyncClient, ASGITransport

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from index import app
from types import SimpleNamespace
from fastapi import HTTPException
from routes.work_centers_import_routes import get_supabase, validate_import
from models.work_centers_import_models import WorkCenterValidateRequest

async def call_validate(request_data: dict):
    """Exercise validate_import() the way execute_import does.

    /validate stopped being an HTTP route when the per-entity import wizards were removed,
    but the function is still load-bearing: execute_import calls it for the conflict report
    before it writes. This mirrors httpx's response surface (`.status_code`, `.json()`) so
    the rule assertions below did not have to change shape.
    """
    supabase = app.dependency_overrides[get_supabase]()
    try:
        result = await validate_import(WorkCenterValidateRequest(**request_data), supabase=supabase)
    except HTTPException as exc:
        # Bind before the lambda: Python unbinds `exc` at the end of the except block.
        status, detail = exc.status_code, exc.detail
        return SimpleNamespace(status_code=status, json=lambda: {"detail": detail})
    return SimpleNamespace(status_code=200, json=result.model_dump)




class MockSupabaseTable:
    def __init__(self, data=None, on_insert=None):
        self._data = data or []
        self._inserted = None
        self._on_insert = on_insert

    def select(self, *a, **k): return self
    def eq(self, *a, **k): return self
    def in_(self, *a, **k): return self
    def range(self, *a, **k): return self
    def is_(self, *a, **k): return self
    def delete(self): return self

    def insert(self, data):
        self._inserted = data
        if self._on_insert is not None:
            self._on_insert(data)
        return self

    def upsert(self, data, on_conflict=None):
        # Work centers now upsert on (company_id, name). Treat it like insert for the mock.
        self._inserted = data
        if self._on_insert is not None:
            self._on_insert(data)
        return self

    def execute(self):
        result = MagicMock()
        result.data = self._data
        if self._inserted is not None:
            items = self._inserted if isinstance(self._inserted, list) else [self._inserted]
            result.data = [{**dict(r), "id": f"wc-{i}"} for i, r in enumerate(items)]
        return result


class MockSupabase:
    def __init__(self, existing_wcs=None, existing_vendors=None, insert_log=None):
        self._existing_wcs = existing_wcs or []
        self._existing_vendors = existing_vendors or []
        self._insert_log = insert_log if insert_log is not None else []

    def table(self, name):
        cb = lambda d: self._insert_log.append({"table": name, "data": d})
        if name == "work_centers":
            return MockSupabaseTable(data=self._existing_wcs, on_insert=cb)
        if name == "vendors":
            return MockSupabaseTable(data=self._existing_vendors, on_insert=cb)
        return MockSupabaseTable(on_insert=cb)


def create_override(**kwargs):
    mock = MockSupabase(**kwargs)
    return lambda: mock


@pytest.fixture
async def test_client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
    app.dependency_overrides.clear()


class TestWorkCentersValidate:
    @pytest.mark.unit
    async def test_internal_no_vendor_ok(self, test_client):
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name", "Kind": "kind", "Labor Rate": "labor_rate"},
            "rows": [{"Name": "Mazak Lathe", "Labor Rate": "135"}],
        }
        app.dependency_overrides[get_supabase] = create_override()
        r = await call_validate(request)
        app.dependency_overrides.clear()
        assert r.status_code == 200
        data = r.json()
        assert data["has_conflicts"] is False
        assert data["valid_rows_count"] == 1

    @pytest.mark.unit
    async def test_a_kind_column_is_rejected_not_ignored(self, test_client):
        """A file written for the old two-kind model must be REFUSED.

        Silently dropping the column would import an outsourced process as an
        in-house station with nobody's name on it — a wrong row that looks
        right, which is worse than a rejected one.
        """
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name", "Kind": "kind"},
            "rows": [{"Name": "PerformCoat", "Kind": "external"}],
        }
        app.dependency_overrides[get_supabase] = create_override()
        r = await call_validate(request)
        app.dependency_overrides.clear()
        data = r.json()
        errors = [
            e for e in data["validation_errors"]
            if e["error_type"] == "kind_no_longer_supported"
        ]
        assert len(errors) == 1
        assert "vendor service" in errors[0]["message"]

    @pytest.mark.unit
    async def test_a_vendor_column_is_rejected_not_ignored(self, test_client):
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name", "Vendor": "vendor_name"},
            "rows": [{"Name": "PerformCoat", "Vendor": "Acme"}],
        }
        app.dependency_overrides[get_supabase] = create_override(
            existing_vendors=[{"id": "v1", "name": "Acme"}]
        )
        r = await call_validate(request)
        app.dependency_overrides.clear()
        data = r.json()
        errors = [
            e for e in data["validation_errors"]
            if e["error_type"] == "vendor_no_longer_supported"
        ]
        assert len(errors) == 1


class TestWorkCentersExecute:
    @pytest.mark.unit
    async def test_execute_internal(self, test_client):
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name", "Labor Rate": "labor_rate"},
            "rows": [{"Name": "HURCO Mill", "Labor Rate": "120.00"}],
            "skip_conflicts": False,
        }
        app.dependency_overrides[get_supabase] = create_override(insert_log=insert_log)
        r = await test_client.post(
            "/api/work-centers/import/execute", json=request
        )
        app.dependency_overrides.clear()
        assert r.status_code == 200
        wc_inserts = [x for x in insert_log if x["table"] == "work_centers"]
        assert len(wc_inserts) == 1
        row = wc_inserts[0]["data"][0]
        assert row["labor_rate"] == 120.0
        # Neither column exists on work_centers any more, so writing either
        # would be writing a column that is not there.
        assert "kind" not in row
        assert "vendor_id" not in row
