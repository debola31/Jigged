"""
Integration tests for the Routings Import API endpoints.

Covers happy path, unknown_work_center, MISCELLANEOUS fallback success and
failure, per-op labor_rate_override, and external work_center cost fields.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from httpx import AsyncClient, ASGITransport

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from index import app
from routes.routings_import_routes import get_supabase


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
        # routing_operations now upsert on (routing_id, sequence). Treat like insert for the mock.
        self._inserted = data
        if self._on_insert is not None:
            self._on_insert(data)
        return self

    def execute(self):
        result = MagicMock()
        result.data = self._data
        if self._inserted is not None:
            items = self._inserted if isinstance(self._inserted, list) else [self._inserted]
            payload = []
            for i, r in enumerate(items):
                row = dict(r)
                row["id"] = f"new-{i}"
                if "part_id" in row and "name" in row:
                    pass  # routings row
                payload.append(row)
            result.data = payload
        return result


class MockSupabase:
    def __init__(self, parts=None, work_centers=None, routings=None, ops=None, insert_log=None):
        self._parts = parts or []
        self._wcs = work_centers or []
        self._routings = routings or []
        self._ops = ops or []
        self._insert_log = insert_log if insert_log is not None else []

    def table(self, name):
        cb = lambda d: self._insert_log.append({"table": name, "data": d})
        if name == "parts":
            return MockSupabaseTable(data=self._parts, on_insert=cb)
        if name == "work_centers":
            return MockSupabaseTable(data=self._wcs, on_insert=cb)
        if name == "routings":
            return MockSupabaseTable(data=self._routings, on_insert=cb)
        if name == "routing_operations":
            return MockSupabaseTable(data=self._ops, on_insert=cb)
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


PARTS = [
    {"id": "p-1", "part_name": "PART001"},
    {"id": "p-2", "part_name": "PART002"},
]
WCS_INTERNAL = [
    {"id": "wc-mill", "name": "HURCO Mill", "kind": "internal"},
]
WCS_EXTERNAL = [
    {"id": "wc-perform", "name": "PerformCoat", "kind": "external"},
]
WCS_MISC = [
    {"id": "wc-misc", "name": "MISCELLANEOUS", "kind": "internal"},
]


class TestRoutingsValidate:
    @pytest.mark.unit
    async def test_happy_path(self, test_client):
        request = {
            "company_id": "co1",
            "mappings": {
                "Part": "part_name",
                "WC": "work_center_name",
                "Setup": "setup_minutes",
                "Cycle": "cycle_minutes_per_unit",
            },
            "rows": [
                {"Part": "PART001", "WC": "HURCO Mill", "Setup": "10", "Cycle": "0.5"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS, work_centers=WCS_INTERNAL
        )
        r = await test_client.post("/api/routings/import/validate", json=request)
        app.dependency_overrides.clear()
        data = r.json()
        assert data["has_conflicts"] is False
        assert data["valid_rows_count"] == 1

    @pytest.mark.unit
    async def test_unknown_work_center_fails(self, test_client):
        request = {
            "company_id": "co1",
            "mappings": {"Part": "part_name", "WC": "work_center_name"},
            "rows": [{"Part": "PART001", "WC": "NotARealWC"}],
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS, work_centers=WCS_INTERNAL
        )
        r = await test_client.post("/api/routings/import/validate", json=request)
        app.dependency_overrides.clear()
        data = r.json()
        assert any(
            c["conflict_type"] == "unknown_work_center" for c in data["conflicts"]
        )

    @pytest.mark.unit
    async def test_miscellaneous_fallback_when_present(self, test_client):
        """Row with no WC name routes to MISCELLANEOUS when it exists."""
        request = {
            "company_id": "co1",
            "mappings": {"Part": "part_name", "WC": "work_center_name"},
            "rows": [{"Part": "PART001", "WC": ""}],
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS, work_centers=WCS_INTERNAL + WCS_MISC
        )
        r = await test_client.post("/api/routings/import/validate", json=request)
        app.dependency_overrides.clear()
        data = r.json()
        assert data["has_conflicts"] is False
        assert len(data["fallbacks"]) == 1
        assert data["fallbacks"][0]["fallback_work_center_name"] == "MISCELLANEOUS"

    @pytest.mark.unit
    async def test_miscellaneous_fallback_fails_when_absent(self, test_client):
        """No WC name AND no MISCELLANEOUS in DB → unknown_work_center."""
        request = {
            "company_id": "co1",
            "mappings": {"Part": "part_name", "WC": "work_center_name"},
            "rows": [{"Part": "PART001", "WC": ""}],
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS, work_centers=WCS_INTERNAL  # no MISCELLANEOUS
        )
        r = await test_client.post("/api/routings/import/validate", json=request)
        app.dependency_overrides.clear()
        data = r.json()
        unknown = [
            c for c in data["conflicts"] if c["conflict_type"] == "unknown_work_center"
        ]
        assert len(unknown) == 1
        assert "MISCELLANEOUS" in unknown[0]["existing_value"]

    @pytest.mark.unit
    async def test_external_field_on_internal_rejected(self, test_client):
        request = {
            "company_id": "co1",
            "mappings": {
                "Part": "part_name",
                "WC": "work_center_name",
                "Ext Price": "external_unit_price",
            },
            "rows": [
                {"Part": "PART001", "WC": "HURCO Mill", "Ext Price": "5.00"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS, work_centers=WCS_INTERNAL
        )
        r = await test_client.post("/api/routings/import/validate", json=request)
        app.dependency_overrides.clear()
        data = r.json()
        errors = [
            e for e in data["validation_errors"]
            if e["error_type"] == "external_field_on_internal"
        ]
        assert len(errors) == 1


class TestRoutingsExecute:
    @pytest.mark.unit
    async def test_execute_internal_with_labor_rate_override(self, test_client):
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {
                "Part": "part_name",
                "WC": "work_center_name",
                "Setup": "setup_minutes",
                "Cycle": "cycle_minutes_per_unit",
                "Rate": "labor_rate_override",
            },
            "rows": [
                {
                    "Part": "PART001",
                    "WC": "HURCO Mill",
                    "Setup": "10",
                    "Cycle": "0.25",
                    "Rate": "150.00",
                }
            ],
            "skip_conflicts": False,
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS, work_centers=WCS_INTERNAL, insert_log=insert_log
        )
        r = await test_client.post("/api/routings/import/execute", json=request)
        app.dependency_overrides.clear()
        assert r.status_code == 200
        op_inserts = [x for x in insert_log if x["table"] == "routing_operations"]
        assert len(op_inserts) == 1
        op = op_inserts[0]["data"][0]
        assert op["work_center_id"] == "wc-mill"
        assert op["setup_minutes"] == 10.0
        assert op["cycle_minutes_per_unit"] == 0.25
        assert op["labor_rate_override"] == 150.0

    @pytest.mark.unit
    async def test_execute_external_uses_external_fields(self, test_client):
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {
                "Part": "part_name",
                "WC": "work_center_name",
                "Ext Unit": "external_unit_price",
                "Ext Setup": "external_setup_cost",
            },
            "rows": [
                {
                    "Part": "PART001",
                    "WC": "PerformCoat",
                    "Ext Unit": "12.50",
                    "Ext Setup": "75.00",
                }
            ],
            "skip_conflicts": False,
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS, work_centers=WCS_EXTERNAL, insert_log=insert_log
        )
        r = await test_client.post("/api/routings/import/execute", json=request)
        app.dependency_overrides.clear()
        assert r.status_code == 200
        op_inserts = [x for x in insert_log if x["table"] == "routing_operations"]
        op = op_inserts[0]["data"][0]
        assert op["work_center_id"] == "wc-perform"
        assert op["external_unit_price"] == 12.5
        assert op["external_setup_cost"] == 75.0
        assert "setup_minutes" not in op
        assert "cycle_minutes_per_unit" not in op

    @pytest.mark.unit
    async def test_reimport_upserts_existing_operation_no_500(self, test_client):
        # Regression: a re-import used to plain-INSERT operations that already existed and
        # 500 the whole batch (the "N errors" in the summary). Now an existing
        # (routing_id, sequence) upserts in place — no error, reported as updated not created.
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {"Part": "part_name", "WC": "work_center_name"},
            "rows": [{"Part": "PART001", "WC": "HURCO Mill"}],
            "skip_conflicts": True,
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS,
            work_centers=WCS_INTERNAL,
            routings=[{"id": "r-1", "part_id": "p-1"}],  # PART001 already has a routing
            ops=[{"id": "op-1", "routing_id": "r-1", "sequence": 1}],  # ...and sequence 1
            insert_log=insert_log,
        )
        r = await test_client.post("/api/routings/import/execute", json=request)
        app.dependency_overrides.clear()
        assert r.status_code == 200  # not a duplicate-key 500
        body = r.json()
        assert body["updated_count"] == 1
        assert body["imported_operations_count"] == 0
        assert body["skipped_count"] == 0
