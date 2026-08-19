"""
Integration tests for the unified Parts Import API endpoints.

Tests the parts CSV import workflow: analyze, validate, and execute.

The unified parts importer absorbs the prior `inventory_items` import path,
so this file also covers stockable/sub-assembly cases that used to live in
`test_inventory_import_api.py`.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from httpx import AsyncClient, ASGITransport

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from index import app
from routes.parts_import_routes import get_supabase


# Mock AI provider for analyze endpoint
class MockAIProvider:
    """Mock AI provider that returns predictable mappings."""

    provider_name = "mock-ai"

    async def suggest_column_mappings(self, csv_headers, sample_rows, target_schema, column_samples=None):
        """Return mock column mapping suggestions."""
        suggestions = []

        # Map common column names to DB fields
        mapping_rules = {
            "part name": ("part_name", 0.95),
            "part_no": ("part_name", 0.90),
            "customer name": ("customer_name", 0.95),
            "description": ("description", 0.90),
            "notes": ("notes", 0.85),
            "primary unit": ("primary_unit", 0.90),
            "unit": ("primary_unit", 0.85),
            "quantity": ("quantity", 0.90),
            "qty on hand": ("quantity", 0.85),
            "cost per unit": ("cost_per_unit", 0.90),
            "cost": ("cost_per_unit", 0.80),
            "preferred vendor": ("preferred_vendor_name", 0.85),
        }

        class Suggestion:
            def __init__(self, csv_column, db_field, confidence, reasoning):
                self.csv_column = csv_column
                self.db_field = db_field
                self.confidence = confidence
                self.reasoning = reasoning

        for header in csv_headers:
            header_lower = header.lower().strip()
            if header_lower in mapping_rules:
                db_field, confidence = mapping_rules[header_lower]
                suggestions.append(Suggestion(
                    csv_column=header,
                    db_field=db_field,
                    confidence=confidence,
                    reasoning=f"Matched '{header}' to {db_field}",
                ))
            else:
                suggestions.append(Suggestion(
                    csv_column=header,
                    db_field=None,
                    confidence=0.0,
                    reasoning=f"No matching field for '{header}'",
                ))

        return suggestions


# Mock Supabase client for validate/execute endpoints
class MockSupabaseTable:
    """Mock Supabase table with chainable methods."""

    def __init__(self, data=None, error=None, on_upsert=None):
        self._data = data or []
        self._error = error
        self._inserted = None
        self._upserted = None
        self._on_upsert = on_upsert  # Callback for tracking upserts

    def select(self, *args, **kwargs):
        return self

    def eq(self, field, value):
        return self

    def is_(self, field, value):
        return self

    def in_(self, field, values):
        return self

    def gt(self, field, value):
        # The importer filters balance rows with .gt("quantity", 0) — a part that once passed
        # through a shelf keeps a zero row there. Applied for real so a seeded zero row behaves
        # like the database's, not like stock.
        self._data = [r for r in self._data if float(r.get(field) or 0) > value]
        return self

    def range(self, start, end):
        # Paged reads (fetch_all_by_company): the mock returns its full data on the first
        # page; since test fixtures are < 1000 rows, the paging loop stops after one call.
        return self

    def insert(self, data):
        self._inserted = data
        return self

    def upsert(self, data, on_conflict=None):
        self._upserted = data
        if self._on_upsert is not None:
            self._on_upsert(data, on_conflict)
        return self

    def delete(self):
        return self

    def execute(self):
        result = MagicMock()
        result.data = self._data
        result.error = self._error
        if self._inserted is not None:
            inserted_with_ids = []
            items = self._inserted if isinstance(self._inserted, list) else [self._inserted]
            for i, row in enumerate(items):
                row_copy = dict(row)
                row_copy['id'] = f"inserted-id-{i}"
                inserted_with_ids.append(row_copy)
            result.data = inserted_with_ids
        elif self._upserted is not None:
            upserted_with_ids = []
            items = self._upserted if isinstance(self._upserted, list) else [self._upserted]
            for i, row in enumerate(items):
                row_copy = dict(row)
                row_copy['id'] = f"upserted-id-{i}"
                upserted_with_ids.append(row_copy)
            result.data = upserted_with_ids
        return result


class MockSupabase:
    """Mock Supabase client."""

    def __init__(
        self,
        existing_parts=None,
        existing_customers=None,
        existing_vendors=None,
        upsert_log=None,
        insert_log=None,
        existing_balances=None,
        unassigned_id="loc-unassigned",
    ):
        self._existing_parts = existing_parts or []
        # part_location_stock rows the company already has, as {part_id, location_id, quantity}.
        self._existing_balances = existing_balances or []
        self._unassigned_id = unassigned_id
        self.rpc_calls: list[tuple[str, dict]] = []
        self._existing_customers = existing_customers or []
        self._existing_vendors = existing_vendors or []
        self._upsert_log = upsert_log if upsert_log is not None else []
        self._insert_log = insert_log if insert_log is not None else []
        self._table_instance = None

    def _record_upsert(self, data, on_conflict):
        self._upsert_log.append({"data": data, "on_conflict": on_conflict})

    def _record_insert_factory(self, table_name):
        # Wrap the table to also record inserts AND upserts so tests can
        # introspect both. The parts importer writes parts via insert/upsert
        # and procurement tiers via upsert, all into the same insert_log.
        def _wrap(table):
            original_insert = table.insert
            original_upsert = table.upsert
            insert_log = self._insert_log

            def _insert(data):
                insert_log.append({"table": table_name, "data": data})
                return original_insert(data)

            def _upsert(data, on_conflict=None):
                items = data if isinstance(data, list) else [data]
                insert_log.append({"table": table_name, "data": items})
                return original_upsert(data, on_conflict=on_conflict)

            table.insert = _insert
            table.upsert = _upsert
            return table
        return _wrap

    def table(self, name):
        if name == "parts":
            self._table_instance = MockSupabaseTable(
                data=self._existing_parts,
                on_upsert=self._record_upsert,
            )
        elif name == "customers":
            self._table_instance = MockSupabaseTable(data=self._existing_customers)
        elif name == "vendors":
            self._table_instance = MockSupabaseTable(data=self._existing_vendors)
        elif name == "part_location_stock":
            self._table_instance = MockSupabaseTable(
                data=[dict(b) for b in self._existing_balances]
            )
        else:
            self._table_instance = MockSupabaseTable()
        # Wrap insert for inspection
        self._record_insert_factory(name)(self._table_instance)
        return self._table_instance

    def rpc(self, name, params=None):
        """Only `inv_get_or_create_unassigned` is called from the import path."""
        self.rpc_calls.append((name, params or {}))
        return MockSupabaseTable(data=self._unassigned_id)


def create_mock_supabase_override(
    existing_parts=None,
    existing_customers=None,
    existing_vendors=None,
    upsert_log=None,
    insert_log=None,
    existing_balances=None,
):
    """Create a dependency override function for get_supabase."""
    mock = MockSupabase(
        existing_parts=existing_parts,
        existing_customers=existing_customers,
        existing_vendors=existing_vendors,
        upsert_log=upsert_log,
        insert_log=insert_log,
        existing_balances=existing_balances,
    )
    def override():
        return mock
    return override


@pytest.fixture
async def test_client():
    """Create async HTTP client for testing."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
    app.dependency_overrides.clear()


class TestPartsAnalyzeEndpoint:
    """Tests for POST /api/parts/import/analyze"""

    @pytest.mark.unit
    async def test_analyze_returns_mappings(self, test_client):
        """Returns 200 with column mappings when AI provider succeeds."""
        request_data = {
            "company_id": "test-company-id",
            "headers": ["Part Name", "Description", "Material Cost", "Extra Column"],
            "sample_rows": [
                ["PART001", "Test Part", "10.50", "ignored"],
                ["PART002", "Another Part", "15.00", "also ignored"],
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        with patch("routes.parts_import_routes.get_provider", new_callable=AsyncMock) as mock_get_provider:
            mock_get_provider.return_value = MockAIProvider()

            response = await test_client.post(
                "/api/parts/import/analyze",
                json=request_data,
            )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert "mappings" in data
        assert "pricing_columns" in data
        assert "ai_provider" in data
        assert data["ai_provider"] == "mock-ai"

    @pytest.mark.unit
    async def test_analyze_detects_pricing_columns(self, test_client):
        """Auto-detects pricing column pairs like qty1/price1."""
        request_data = {
            "company_id": "test-company-id",
            "headers": ["Part Name", "qty1", "price1", "qty2", "price2"],
            "sample_rows": [
                ["PART001", "1", "10.00", "10", "8.00"],
                ["PART002", "1", "15.00", "10", "12.00"],
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        with patch("routes.parts_import_routes.get_provider", new_callable=AsyncMock) as mock_get_provider:
            mock_get_provider.return_value = MockAIProvider()

            response = await test_client.post(
                "/api/parts/import/analyze",
                json=request_data,
            )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert len(data["pricing_columns"]) == 2

    @pytest.mark.unit
    async def test_analyze_unified_endpoint(self, test_client):
        """The /analyze-unified endpoint also returns mappings (uses UNIFIED_PART_SCHEMA)."""
        request_data = {
            "company_id": "test-company-id",
            "headers": ["Part Name", "Primary Unit", "Quantity"],
            "sample_rows": [
                ["PART001", "lbs", "100"],
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        with patch("routes.parts_import_routes.get_provider", new_callable=AsyncMock) as mock_get_provider:
            mock_get_provider.return_value = MockAIProvider()

            response = await test_client.post(
                "/api/parts/import/analyze-unified",
                json=request_data,
            )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()
        assert "mappings" in data


class TestPartsValidateEndpoint:
    """Tests for POST /api/parts/import/validate"""

    @pytest.mark.unit
    async def test_validate_returns_valid_count_when_no_conflicts(self, test_client):
        """Returns valid_rows_count when no conflicts exist."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Description": "description",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "NEW001", "Description": "New Part 1", "Unit": "ea"},
                {"Part Name": "NEW002", "Description": "New Part 2", "Unit": "ea"},
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["has_conflicts"] is False
        assert data["valid_rows_count"] == 2
        assert data["conflict_rows_count"] == 0

    @pytest.mark.unit
    async def test_validate_detects_missing_part_name(self, test_client):
        """Detects missing part_name validation error."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Description": "description",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "", "Description": "Part Without Name", "Unit": "ea"},
                {"Part Name": "VALID001", "Description": "Valid Part", "Unit": "ea"},
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["error_rows_count"] == 1
        assert data["validation_errors"][0]["error_type"] == "missing_part_name"

    @pytest.mark.unit
    async def test_validate_requires_unit_on_every_part(self, test_client):
        """A part with no unit is a validation error — for EVERY part, not just stocked.

        `parts` has an unconditional check constraint,
        CHECK (primary_unit IS NOT NULL). This check used to run only for rows
        inferred as stocked, so a unit-less row passed validate and then blew up
        execute's 500-row batch insert with a raw APIError — taking every good
        row in the batch with it, and surfacing as HTTP 500. These tests mock
        Supabase, so the constraint isn't there to catch it: assert it here.
        """
        request_data = {
            "company_id": "test-company-id",
            "mappings": {"Part Name": "part_name"},  # no unit column at all
            "pricing_columns": [],
            "rows": [{"Part Name": "NOUNIT001"}],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["error_rows_count"] == 1
        assert data["validation_errors"][0]["error_type"] == "missing_primary_unit"
        assert data["valid_rows_count"] == 0

    @pytest.mark.unit
    async def test_validate_resolves_unit_on_a_NON_stocked_part(self, test_client):
        """A filled unit on a made/non-stocked part must resolve — not be skipped as unknown_unit.

        UOM resolution used to run only for rows inferred as *stocked*. A "made"
        part (is_stocked=false) with a perfectly good unit like "each" therefore
        never got resolved, hit the "raw unit present but not resolved" branch,
        and was rejected as unknown_unit. That silently skipped ~7,700 parts of a
        real is_stocked=false export even after the owner filled every unit. Now
        resolution runs for every row; "each" resolves via the alias table.
        """
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Stocked": "is_stocked",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [{"Part Name": "MADE-001", "Stocked": "false", "Unit": "each"}],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])
        response = await test_client.post("/api/parts/import/validate", json=request_data)
        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()
        assert data["valid_rows_count"] == 1  # imports fine
        assert data["error_rows_count"] == 0
        assert not any(c["conflict_type"] == "unknown_unit" for c in data["conflicts"])

    @pytest.mark.unit
    async def test_execute_skips_unit_less_row_instead_of_failing_the_batch(
        self, test_client
    ):
        """A unit-less row is skipped; the good rows in its batch still import."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {"Part Name": "part_name", "Unit": "primary_unit"},
            "pricing_columns": [],
            "rows": [
                {"Part Name": "NOUNIT001", "Unit": ""},   # would violate the constraint
                {"Part Name": "GOOD001", "Unit": "ea"},   # must survive regardless
            ],
            "skip_conflicts": True,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200  # NOT a 500
        data = response.json()
        assert data["imported_count"] == 1
        assert data["skipped_count"] == 1

    @pytest.mark.unit
    async def test_validate_detects_duplicate_part_name_in_csv(self, test_client):
        """Detects duplicate part_name within CSV file."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "DUPE001", "Unit": "ea"},
                {"Part Name": "DUPE001", "Unit": "ea"},
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["has_conflicts"] is True
        csv_duplicate_conflicts = [
            c for c in data["conflicts"] if c["conflict_type"] == "csv_duplicate"
        ]
        assert len(csv_duplicate_conflicts) >= 1

    @pytest.mark.unit
    async def test_validate_treats_an_existing_part_as_an_update_not_a_conflict(self, test_client):
        """A re-imported part (name already exists) is NOT a conflict — it updates in place.

        The import upserts on (company_id, part_name), so re-importing the same export is
        idempotent: existing parts update, they don't skip or duplicate. No legacy_id needed.
        """
        existing_parts = [{"id": "p1", "part_name": "EXIST-001"}]
        request_data = {
            "company_id": "test-company-id",
            "mappings": {"Part Name": "part_name", "Unit": "primary_unit"},
            "pricing_columns": [],
            "rows": [
                {"Part Name": "EXIST-001", "Unit": "ea"},  # already in Jigged
                {"Part Name": "NEW-001", "Unit": "ea"},    # net new
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(existing_parts, [])
        response = await test_client.post("/api/parts/import/validate", json=request_data)
        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()
        # Neither row is a conflict — both are valid to write (one insert, one update).
        assert data["has_conflicts"] is False
        assert data["valid_rows_count"] == 2
        assert not any(c["conflict_type"] == "duplicate_part_name" for c in data["conflicts"])

    @pytest.mark.unit
    async def test_validate_rejects_customer_match_mode(self, test_client):
        """RAISES 400 when customer_match_mode is present.

        Parts no longer link to customers at the data layer (per the
        no-silent-fallbacks principle, accepting the field would let the
        frontend believe a customer link was saved when it wasn't).
        """
        request_data = {
            "company_id": "test-company-id",
            "mappings": {"Part Name": "part_name"},
            "pricing_columns": [],
            "rows": [{"Part Name": "PART001"}],
            "customer_match_mode": "all_generic",
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 400
        detail = response.json()["detail"]
        assert detail["error"] == "customer_link_removed"

    @pytest.mark.unit
    async def test_validate_rejects_selected_customer_id(self, test_client):
        """RAISES 400 when selected_customer_id is present."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {"Part Name": "part_name"},
            "pricing_columns": [],
            "rows": [{"Part Name": "PART001"}],
            "selected_customer_id": "cust-123",
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 400
        assert response.json()["detail"]["error"] == "customer_link_removed"

    @pytest.mark.unit
    async def test_validate_rejects_customer_name_mapping(self, test_client):
        """RAISES 400 when a CSV column is mapped to customer_name."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Customer": "customer_name",
            },
            "pricing_columns": [],
            "rows": [{"Part Name": "PART001", "Customer": "Acme"}],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 400
        assert response.json()["detail"]["error"] == "customer_link_removed"

    @pytest.mark.unit
    async def test_execute_rejects_customer_fields(self, test_client):
        """RAISES 400 on /execute when customer fields are present."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {"Part Name": "part_name"},
            "pricing_columns": [],
            "rows": [{"Part Name": "PART001"}],
            "customer_match_mode": "all_generic",
            "skip_conflicts": False,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 400
        assert response.json()["detail"]["error"] == "customer_link_removed"

    @pytest.mark.unit
    async def test_validate_unknown_vendor_fails(self, test_client):
        """Detects unknown vendor when preferred_vendor_name doesn't exist."""
        existing_vendors = [{"id": "v1", "name": "Acme Supplies"}]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Preferred Vendor": "preferred_vendor_name",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "PART001", "Preferred Vendor": "Nonexistent Vendor", "Unit": "ea"},
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[], existing_vendors=existing_vendors
        )

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()
        unknown_vendor = [
            c for c in data["conflicts"] if c["conflict_type"] == "unknown_vendor"
        ]
        assert len(unknown_vendor) == 1

    @pytest.mark.unit
    async def test_validate_invalid_quantity_fails(self, test_client):
        """Detects negative quantity as validation error."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Quantity": "quantity",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "PART001", "Quantity": "-5", "Unit": "lbs"},
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()
        invalid = [
            e for e in data["validation_errors"]
            if e["error_type"] == "invalid_quantity"
        ]
        assert len(invalid) == 1


class TestPartsExecuteEndpoint:
    """Tests for POST /api/parts/import/execute"""

    @pytest.mark.unit
    async def test_execute_imports_valid_rows(self, test_client):
        """Successfully imports valid rows."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Description": "description",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "NEW001", "Description": "New Part 1", "Unit": "ea"},
                {"Part Name": "NEW002", "Description": "New Part 2", "Unit": "ea"},
            ],
            "skip_conflicts": False,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["success"] is True
        assert data["imported_count"] == 2
        assert data["skipped_count"] == 0

    @pytest.mark.unit
    async def test_execute_updates_existing_creates_new(self, test_client):
        """Re-importing is idempotent: an existing part UPDATES, a new one is CREATED, no skips."""
        existing_parts = [
            {"id": "existing-1", "part_name": "EXIST001"},
        ]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "EXIST001", "Unit": "ea"},  # already exists -> updated
                {"Part Name": "NEW001", "Unit": "ea"},    # net new -> created
            ],
            "skip_conflicts": True,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(existing_parts, [])

        response = await test_client.post(
            "/api/parts/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["success"] is True
        assert data["imported_count"] == 1  # NEW001 created
        assert data["updated_count"] == 1   # EXIST001 updated in place
        assert data["skipped_count"] == 0   # nothing skipped

    @pytest.mark.unit
    async def test_execute_reclaims_archived_names_instead_of_reviving(self, test_client):
        """Re-importing a name CREATES a new part; it no longer revives the archived one.

        Each name in the batch is passed to `reclaim_part_name`, which renames an archived
        holder to "<name> (archived)" so ON CONFLICT finds nothing and inserts. The payload
        must NOT carry deleted_at=None any more — that was the revive, and leaving it in
        would un-archive the very row we just moved aside. See docs/architecture.md §16.
        """
        upsert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {"Part Name": "part_name", "Unit": "primary_unit"},
            "pricing_columns": [],
            "rows": [
                {"Part Name": "WIDGET-1", "Unit": "ea"},
                {"Part Name": "WIDGET-2", "Unit": "ea"},
            ],
            "skip_conflicts": True,
        }

        mock = MockSupabase(existing_parts=[], upsert_log=upsert_log)
        app.dependency_overrides[get_supabase] = lambda: mock

        response = await test_client.post("/api/parts/import/execute", json=request_data)

        app.dependency_overrides.clear()

        assert response.status_code == 200

        reclaimed = {
            params.get("p_name")
            for name, params in mock.rpc_calls
            if name == "reclaim_part_name"
        }
        assert reclaimed == {"WIDGET-1", "WIDGET-2"}

        parts_rows = [
            row
            for entry in upsert_log
            if entry.get("on_conflict") == "company_id,part_name"
            for row in (entry["data"] if isinstance(entry["data"], list) else [entry["data"]])
        ]
        assert parts_rows, "expected a parts upsert on (company_id, part_name)"
        # The revive is gone: no payload may clear deleted_at.
        assert all("deleted_at" not in row for row in parts_rows)

    @pytest.mark.unit
    async def test_execute_imports_stocked_part_with_unit_and_quantity(
        self, test_client
    ):
        """Importing a part with primary_unit + quantity sets is_stocked=true and source='bought'."""
        insert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Unit": "primary_unit",
                "Quantity": "quantity",
                "Cost": "cost_per_unit",
            },
            "pricing_columns": [],
            "rows": [
                {
                    "Part Name": "STEEL-4140",
                    "Unit": "lbs",
                    "Quantity": "250",
                    "Cost": "12.50",
                },
            ],
            "skip_conflicts": False,
            "uom_resolutions": {1: "pounds"},
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[],
            insert_log=insert_log,
        )

        response = await test_client.post(
            "/api/parts/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()
        assert data["imported_count"] == 1

        parts_inserts = [r for r in insert_log if r["table"] == "parts"]
        assert len(parts_inserts) == 1
        inserted = parts_inserts[0]["data"][0]
        assert inserted["is_stocked"] is True
        # Procurement-only row (no operation columns) ⇒ source='bought'.
        assert inserted["source"] == "bought"
        assert inserted["primary_unit"] == "pounds"
        # NOT on the part row — `parts.quantity` is a trigger-maintained rollup since
        # 20260802015837. It lands as a balance at the Unassigned bucket instead.
        assert "quantity" not in inserted
        balance = [r for r in insert_log if r["table"] == "part_location_stock"][0]["data"][0]
        assert balance["quantity"] == 250.0
        assert balance["location_id"] == "loc-unassigned"
        # cost_per_unit was dropped from parts in migration 20260514; the CSV
        # cost is routed into a NULL-vendor procurement tier instead. Assert
        # the tier was emitted with the right shape.
        assert "cost_per_unit" not in inserted
        tier_inserts = [r for r in insert_log if r["table"] == "part_procurement_tiers"]
        assert len(tier_inserts) == 1
        tier = tier_inserts[0]["data"][0]
        # vendor_id was dropped from part_procurement_tiers (migration 20260714173443 —
        # per-vendor tiers collapsed to part-level); the tier no longer carries it.
        assert "vendor_id" not in tier
        assert tier["min_quantity"] == 1
        assert tier["cost_per_unit"] == 12.5

    @pytest.mark.unit
    async def test_execute_omits_quantity_entirely_when_the_column_is_unmapped(
        self, test_client
    ):
        """An unmapped quantity must not write 0 — that zeroed stock on every re-import.

        parts.quantity is NOT NULL DEFAULT 0, so leaving the key out still inserts fine. The
        bug was on the UPDATE half of the upsert: an explicit 0 overwrote a real balance for
        any existing part whose CSV didn't happen to carry a quantity column.
        """
        insert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {"Part Name": "part_name", "Unit": "primary_unit"},
            "pricing_columns": [],
            "rows": [{"Part Name": "STEEL-4140", "Unit": "lbs"}],
            "skip_conflicts": False,
            "uom_resolutions": {1: "pounds"},
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[
                {
                    "id": "part-1",
                    "part_name": "STEEL-4140",
                    "quantity": 500,
                    "primary_unit": "pounds",
                }
            ],
            insert_log=insert_log,
        )

        response = await test_client.post("/api/parts/import/execute", json=request_data)
        app.dependency_overrides.clear()

        assert response.status_code == 200
        parts_inserts = [r for r in insert_log if r["table"] == "parts"]
        upserted = parts_inserts[0]["data"][0]
        assert "quantity" not in upserted, "unmapped quantity must be absent, not 0"

        # Nothing moved, so nothing to explain.
        assert [r for r in insert_log if r["table"] == "inventory_transactions"] == []

    @pytest.mark.unit
    async def test_execute_writes_an_adjustment_ledger_row_for_an_imported_balance(
        self, test_client
    ):
        """An imported quantity is a stock movement and needs provenance (J1).

        Shape mirrors adjustPartStock: abs(delta) in the primary unit, direction in the notes.
        """
        insert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Unit": "primary_unit",
                "Qty": "quantity",
            },
            "pricing_columns": [],
            "rows": [{"Part Name": "STEEL-4140", "Unit": "lbs", "Qty": "250"}],
            "skip_conflicts": False,
            "uom_resolutions": {1: "pounds"},
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[
                {
                    "id": "part-1",
                    "part_name": "STEEL-4140",
                    "quantity": 100,
                    "primary_unit": "pounds",
                }
            ],
            insert_log=insert_log,
        )

        response = await test_client.post("/api/parts/import/execute", json=request_data)
        app.dependency_overrides.clear()

        assert response.status_code == 200
        ledger = [r for r in insert_log if r["table"] == "inventory_transactions"]
        assert len(ledger) == 1
        entry = ledger[0]["data"][0]
        assert entry["type"] == "adjustment"
        assert entry["item_name"] == "STEEL-4140"
        # abs(250 - 100); the table's CHECK (quantity >= 0) makes a signed delta unstorable.
        assert entry["quantity"] == 150.0
        assert entry["converted_quantity"] == 150.0
        assert entry["unit"] == "pounds"
        # Direction is only recoverable from the notes, so it must be there.
        assert "100" in entry["notes"] and "250" in entry["notes"]

    @pytest.mark.unit
    async def test_execute_writes_no_ledger_row_when_the_quantity_is_unchanged(
        self, test_client
    ):
        """A re-import that moves no number shouldn't manufacture ledger noise."""
        insert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Unit": "primary_unit",
                "Qty": "quantity",
            },
            "pricing_columns": [],
            "rows": [{"Part Name": "STEEL-4140", "Unit": "lbs", "Qty": "250"}],
            "skip_conflicts": False,
            "uom_resolutions": {1: "pounds"},
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[
                {
                    "id": "part-1",
                    "part_name": "STEEL-4140",
                    "quantity": 250,
                    "primary_unit": "pounds",
                }
            ],
            insert_log=insert_log,
        )

        response = await test_client.post("/api/parts/import/execute", json=request_data)
        app.dependency_overrides.clear()

        assert response.status_code == 200
        assert [r for r in insert_log if r["table"] == "inventory_transactions"] == []

    @pytest.mark.unit
    async def test_execute_skips_and_reports_quantity_for_an_already_placed_part(
        self, test_client
    ):
        """A part already sitting on a real shelf keeps its balances; the CSV number is refused.

        "250 lbs on hand" cannot say which shelf to correct, and dumping it into `Unassigned`
        would silently inflate the total. Skipping is correct — silence is not, so the skip is
        reported back rather than the balance quietly not landing.
        """
        insert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Unit": "primary_unit",
                "Qty": "quantity",
            },
            "pricing_columns": [],
            "rows": [{"Part Name": "STEEL-4140", "Unit": "lbs", "Qty": "250"}],
            "skip_conflicts": False,
            "uom_resolutions": {1: "pounds"},
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[
                {
                    "id": "upserted-id-0",
                    "part_name": "STEEL-4140",
                    "quantity": 100,
                    "primary_unit": "pounds",
                }
            ],
            # 100 lbs on a real shelf, not in the Unassigned bucket.
            existing_balances=[
                {"part_id": "upserted-id-0", "location_id": "shelf-a", "quantity": 100}
            ],
            insert_log=insert_log,
        )

        response = await test_client.post("/api/parts/import/execute", json=request_data)
        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        # Reported, not silent.
        assert data["quantity_skipped_already_placed"] == ["STEEL-4140"]

        parts_upserts = [r for r in insert_log if r["table"] == "parts"]
        upserted = parts_upserts[0]["data"][0]
        # Never written on the part row — the trigger owns that column now.
        assert "quantity" not in upserted
        # No balance moved, so a provenance row would be a lie.
        assert [r for r in insert_log if r["table"] == "part_location_stock"] == []
        assert [r for r in insert_log if r["table"] == "inventory_transactions"] == []
        # Everything else about the row still imported.
        assert upserted["primary_unit"] == "pounds"

    @pytest.mark.unit
    async def test_execute_writes_an_opening_balance_at_unassigned(self, test_client):
        """The normal onboarding case: a quantity lands as a balance, never on the part row.

        `parts.quantity` became a trigger-maintained rollup of `part_location_stock` in
        20260802015837 — writing it directly raises on UPDATE, and on INSERT slips past the
        trigger to leave a part whose total has no balances behind it. So the importer writes
        the balance and lets the rollup follow.
        """
        insert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Unit": "primary_unit",
                "Qty": "quantity",
            },
            "pricing_columns": [],
            "rows": [{"Part Name": "BRAND-NEW", "Unit": "lbs", "Qty": "40"}],
            "skip_conflicts": False,
            "uom_resolutions": {1: "pounds"},
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[],
            insert_log=insert_log,
        )

        response = await test_client.post("/api/parts/import/execute", json=request_data)
        app.dependency_overrides.clear()

        assert response.status_code == 200
        assert response.json()["quantity_skipped_already_placed"] == []

        upserted = [r for r in insert_log if r["table"] == "parts"][0]["data"][0]
        assert "quantity" not in upserted

        balances = [r for r in insert_log if r["table"] == "part_location_stock"]
        assert len(balances) == 1
        row = balances[0]["data"][0]
        assert row["quantity"] == 40.0
        assert row["location_id"] == "loc-unassigned"

        # Prior is 0 for a new part, so the ledger row explains 0 -> 40.
    @pytest.mark.unit
    async def test_execute_resolves_preferred_vendor_to_id(self, test_client):
        """preferred_vendor_name resolves to vendor_id at execute time."""
        insert_log: list = []
        existing_vendors = [{"id": "vendor-abc", "name": "Acme Supplies"}]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Preferred Vendor": "preferred_vendor_name",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {
                    "Part Name": "PART001",
                    "Preferred Vendor": "Acme Supplies",
                    "Unit": "lbs",
                },
            ],
            "skip_conflicts": False,
            "uom_resolutions": {1: "pounds"},
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[],
            existing_vendors=existing_vendors,
            insert_log=insert_log,
        )

        response = await test_client.post(
            "/api/parts/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        parts_inserts = [r for r in insert_log if r["table"] == "parts"]
        inserted = parts_inserts[0]["data"][0]
        assert inserted.get("preferred_vendor_id") == "vendor-abc"

    @pytest.mark.unit
    async def test_execute_upserts_on_part_name_for_idempotency(self, test_client):
        """Every row is upserted ON CONFLICT (company_id, part_name) — the idempotency key."""
        upsert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "PART001", "Unit": "ea"},
            ],
            "skip_conflicts": False,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[],
            upsert_log=upsert_log,
        )

        response = await test_client.post(
            "/api/parts/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        # The parts write is an upsert keyed on (company_id, part_name), no legacy_id.
        parts_upserts = [u for u in upsert_log if u["on_conflict"] == "company_id,part_name"]
        assert len(parts_upserts) == 1

    @pytest.mark.unit
    async def test_execute_sub_assembly_classification_new_headers(self, test_client):
        """Explicit source='made' + is_stocked=true (sub-assembly) using the new headers."""
        insert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Source": "source",
                "Is Stocked": "is_stocked",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {
                    "Part Name": "SUB-ASSY-001",
                    "Source": "made",
                    "Is Stocked": "true",
                    "Unit": "pcs",
                },
            ],
            "skip_conflicts": False,
            "uom_resolutions": {1: "pieces"},
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[],
            insert_log=insert_log,
        )

        response = await test_client.post(
            "/api/parts/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        parts_inserts = [r for r in insert_log if r["table"] == "parts"]
        inserted = parts_inserts[0]["data"][0]
        assert inserted["source"] == "made"
        assert inserted["is_stocked"] is True

    @pytest.mark.unit
    async def test_execute_legacy_is_manufacturable_alias_maps_to_source(
        self, test_client
    ):
        """Legacy `is_manufacturable` header maps to source ('made'/'bought').

        One-version compat for CSVs already prepared with the old headers.
        See parts_import_routes module docstring.
        """
        insert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                # The legacy header (renamed in the 20260504 migration). The
                # importer should accept it and translate true→'made',
                # false→'bought'.
                "Is Manufacturable": "is_manufacturable",
                "Is Stockable": "is_stockable",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {
                    "Part Name": "SUB-ASSY-LEGACY",
                    "Is Manufacturable": "true",
                    "Is Stockable": "true",
                    "Unit": "pcs",
                },
                {
                    "Part Name": "BOUGHT-LEGACY",
                    "Is Manufacturable": "false",
                    "Is Stockable": "true",
                    "Unit": "pcs",
                },
            ],
            "skip_conflicts": False,
            "uom_resolutions": {1: "pieces", 2: "pieces"},
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(
            existing_parts=[],
            insert_log=insert_log,
        )

        response = await test_client.post(
            "/api/parts/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        parts_inserts = [r for r in insert_log if r["table"] == "parts"]
        # Both rows go in the same insert batch.
        rows = parts_inserts[0]["data"]
        sub_row = next(r for r in rows if r["part_name"] == "SUB-ASSY-LEGACY")
        bought_row = next(r for r in rows if r["part_name"] == "BOUGHT-LEGACY")

        assert sub_row["source"] == "made"
        assert sub_row["is_stocked"] is True
        assert bought_row["source"] == "bought"
        assert bought_row["is_stocked"] is True
        # New columns should be set on the inserted rows; the legacy boolean
        # columns must NOT be passed through to the parts table (they don't
        # exist anymore).
        assert "is_manufacturable" not in sub_row
        assert "is_stockable" not in sub_row
