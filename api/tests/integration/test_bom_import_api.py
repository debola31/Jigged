"""
Integration tests for the BOM Import API endpoints.

Covers happy path plus the conflict types: missing parent/child, self-reference,
csv_duplicate, duplicate_bom_line, and would_create_cycle (2-cycle and 3-cycle).
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
from routes.bom_import_routes import get_supabase, validate_import
from models.bom_import_models import BomValidateRequest

async def call_validate(request_data: dict):
    """Exercise validate_import() the way execute_import does.

    /validate stopped being an HTTP route when the per-entity import wizards were removed,
    but the function is still load-bearing: execute_import calls it for the conflict report
    before it writes. This mirrors httpx's response surface (`.status_code`, `.json()`) so
    the rule assertions below did not have to change shape.
    """
    supabase = app.dependency_overrides[get_supabase]()
    try:
        result = await validate_import(BomValidateRequest(**request_data), supabase=supabase)
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
    def is_(self, *a, **k): return self
    def range(self, *a, **k): return self
    def delete(self): return self

    def insert(self, data):
        self._inserted = data
        if self._on_insert is not None:
            self._on_insert(data)
        return self

    def upsert(self, data, on_conflict=None):
        # parts_bom now upserts on (parent_part_id, child_part_id). Treat like insert.
        self._inserted = data
        if self._on_insert is not None:
            self._on_insert(data)
        return self

    def execute(self):
        result = MagicMock()
        result.data = self._data
        if self._inserted is not None:
            items = self._inserted if isinstance(self._inserted, list) else [self._inserted]
            result.data = [{**dict(r), "id": f"bom-{i}"} for i, r in enumerate(items)]
        return result


class MockSupabase:
    def __init__(self, parts=None, bom=None, insert_log=None):
        self._parts = parts or []
        self._bom = bom or []
        self._insert_log = insert_log if insert_log is not None else []

    def table(self, name):
        cb = lambda d: self._insert_log.append({"table": name, "data": d})
        if name == "parts":
            return MockSupabaseTable(data=self._parts, on_insert=cb)
        if name == "parts_bom":
            return MockSupabaseTable(data=self._bom, on_insert=cb)
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
    {"id": "p-A", "part_name": "PART_A"},
    {"id": "p-B", "part_name": "PART_B"},
    {"id": "p-C", "part_name": "PART_C"},
    {"id": "p-D", "part_name": "PART_D"},
]


class TestBomValidate:
    @pytest.mark.unit
    async def test_happy_path(self, test_client):
        request = {
            "company_id": "co1",
            "mappings": {
                "Parent": "parent_part_name",
                "Child": "child_part_name",
                "Qty": "quantity",
                "Unit": "unit",
            },
            "rows": [
                {"Parent": "PART_A", "Child": "PART_B", "Qty": "2", "Unit": "pcs"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override(parts=PARTS)
        r = await call_validate(request)
        app.dependency_overrides.clear()
        data = r.json()
        assert data["has_conflicts"] is False
        assert data["valid_rows_count"] == 1

    @pytest.mark.unit
    async def test_unknown_parent(self, test_client):
        request = {
            "company_id": "co1",
            "mappings": {
                "Parent": "parent_part_name",
                "Child": "child_part_name",
                "Qty": "quantity",
                "Unit": "unit",
            },
            "rows": [
                {"Parent": "MISSING", "Child": "PART_B", "Qty": "1", "Unit": "pcs"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override(parts=PARTS)
        r = await call_validate(request)
        app.dependency_overrides.clear()
        data = r.json()
        assert any(
            c["conflict_type"] == "unknown_parent_part" for c in data["conflicts"]
        )

    @pytest.mark.unit
    async def test_unknown_child(self, test_client):
        request = {
            "company_id": "co1",
            "mappings": {
                "Parent": "parent_part_name",
                "Child": "child_part_name",
                "Qty": "quantity",
                "Unit": "unit",
            },
            "rows": [
                {"Parent": "PART_A", "Child": "MISSING", "Qty": "1", "Unit": "pcs"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override(parts=PARTS)
        r = await call_validate(request)
        app.dependency_overrides.clear()
        data = r.json()
        assert any(
            c["conflict_type"] == "unknown_child_part" for c in data["conflicts"]
        )

    @pytest.mark.unit
    async def test_self_reference(self, test_client):
        request = {
            "company_id": "co1",
            "mappings": {
                "Parent": "parent_part_name",
                "Child": "child_part_name",
                "Qty": "quantity",
                "Unit": "unit",
            },
            "rows": [
                {"Parent": "PART_A", "Child": "PART_A", "Qty": "1", "Unit": "pcs"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override(parts=PARTS)
        r = await call_validate(request)
        app.dependency_overrides.clear()
        data = r.json()
        assert any(
            c["conflict_type"] == "bom_self_reference" for c in data["conflicts"]
        )

    @pytest.mark.unit
    async def test_2_cycle(self, test_client):
        """Existing edge A→B; CSV adds B→A. Must flag would_create_cycle."""
        existing_bom = [
            {"id": "b1", "parent_part_id": "p-A", "child_part_id": "p-B"},
        ]
        request = {
            "company_id": "co1",
            "mappings": {
                "Parent": "parent_part_name",
                "Child": "child_part_name",
                "Qty": "quantity",
                "Unit": "unit",
            },
            "rows": [
                {"Parent": "PART_B", "Child": "PART_A", "Qty": "1", "Unit": "pcs"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS, bom=existing_bom
        )
        r = await call_validate(request)
        app.dependency_overrides.clear()
        data = r.json()
        assert any(
            c["conflict_type"] == "would_create_cycle" for c in data["conflicts"]
        )

    @pytest.mark.unit
    async def test_3_cycle(self, test_client):
        """CSV alone forms A→B→C→A. Last edge must close the cycle."""
        request = {
            "company_id": "co1",
            "mappings": {
                "Parent": "parent_part_name",
                "Child": "child_part_name",
                "Qty": "quantity",
                "Unit": "unit",
            },
            "rows": [
                {"Parent": "PART_A", "Child": "PART_B", "Qty": "1", "Unit": "pcs"},
                {"Parent": "PART_B", "Child": "PART_C", "Qty": "1", "Unit": "pcs"},
                {"Parent": "PART_C", "Child": "PART_A", "Qty": "1", "Unit": "pcs"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override(parts=PARTS)
        r = await call_validate(request)
        app.dependency_overrides.clear()
        data = r.json()
        cycle_conflicts = [
            c for c in data["conflicts"] if c["conflict_type"] == "would_create_cycle"
        ]
        assert len(cycle_conflicts) == 1


class TestBomExecute:
    @pytest.mark.unit
    async def test_execute_inserts_valid_rows(self, test_client):
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {
                "Parent": "parent_part_name",
                "Child": "child_part_name",
                "Qty": "quantity",
                "Unit": "unit",
            },
            "rows": [
                {"Parent": "PART_A", "Child": "PART_B", "Qty": "2", "Unit": "pcs"},
                {"Parent": "PART_C", "Child": "PART_D", "Qty": "5", "Unit": "lbs"},
            ],
            "skip_conflicts": False,
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS, insert_log=insert_log
        )
        r = await test_client.post("/api/bom/import/execute", json=request)
        app.dependency_overrides.clear()
        assert r.status_code == 200
        data = r.json()
        assert data["imported_count"] == 2

    @pytest.mark.unit
    async def test_reimport_updates_existing_line_no_500(self, test_client):
        # Regression: an existing (parent, child) BOM line used to be skipped (or, if forced,
        # 500 on the unique key). Now it upserts on (parent_part_id, child_part_id) — updates
        # quantity/unit in place, reported as updated not created.
        request = {
            "company_id": "co1",
            "mappings": {
                "Parent": "parent_part_name",
                "Child": "child_part_name",
                "Qty": "quantity",
                "Unit": "unit",
            },
            "rows": [
                {"Parent": "PART_A", "Child": "PART_B", "Qty": "9", "Unit": "pcs"},  # exists → update
                {"Parent": "PART_C", "Child": "PART_D", "Qty": "5", "Unit": "lbs"},  # new → create
            ],
            "skip_conflicts": True,
        }
        app.dependency_overrides[get_supabase] = create_override(
            parts=PARTS,
            bom=[{"id": "b1", "parent_part_id": "p-A", "child_part_id": "p-B"}],
        )
        r = await test_client.post("/api/bom/import/execute", json=request)
        app.dependency_overrides.clear()
        assert r.status_code == 200  # not a duplicate-key 500
        data = r.json()
        assert data["updated_count"] == 1
        assert data["imported_count"] == 1
        assert data["skipped_count"] == 0
