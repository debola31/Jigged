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
            "legacy id": ("legacy_id", 0.85),
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
    ):
        self._existing_parts = existing_parts or []
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
        else:
            self._table_instance = MockSupabaseTable()
        # Wrap insert for inspection
        self._record_insert_factory(name)(self._table_instance)
        return self._table_instance


def create_mock_supabase_override(
    existing_parts=None,
    existing_customers=None,
    existing_vendors=None,
    upsert_log=None,
    insert_log=None,
):
    """Create a dependency override function for get_supabase."""
    mock = MockSupabase(
        existing_parts=existing_parts,
        existing_customers=existing_customers,
        existing_vendors=existing_vendors,
        upsert_log=upsert_log,
        insert_log=insert_log,
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
    async def test_validate_detects_duplicate_legacy_id_in_csv(self, test_client):
        """Detects duplicate legacy_id within CSV file.

        Two rows sharing a legacy_id would cause Postgres 21000 ('ON CONFLICT
        DO UPDATE command cannot affect row a second time') at execute time,
        because the upsert path uses ON CONFLICT (company_id, legacy_id).
        """
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Legacy Id": "legacy_id",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "PART_A", "Legacy Id": "LEG-123", "Unit": "ea"},
                {"Part Name": "PART_B", "Legacy Id": "LEG-123", "Unit": "ea"},
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
        legacy_id_dupe_conflicts = [
            c
            for c in data["conflicts"]
            if c["conflict_type"] == "csv_duplicate_legacy_id"
        ]
        assert len(legacy_id_dupe_conflicts) == 2
        assert all("LEG-123" in c["existing_value"] for c in legacy_id_dupe_conflicts)

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
    async def test_execute_skips_conflicts_when_skip_conflicts_true(self, test_client):
        """Skips conflicting rows when skip_conflicts is True."""
        existing_parts = [
            {"id": "existing-1", "part_name": "EXIST001", "legacy_id": None},
        ]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "EXIST001", "Unit": "ea"},  # Will be skipped (duplicate)
                {"Part Name": "NEW001", "Unit": "ea"},    # Will be imported
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
        assert data["imported_count"] == 1
        assert data["skipped_count"] == 1

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
        assert inserted["quantity"] == 250.0
        # cost_per_unit was dropped from parts in migration 20260514; the CSV
        # cost is routed into a NULL-vendor procurement tier instead. Assert
        # the tier was emitted with the right shape.
        assert "cost_per_unit" not in inserted
        tier_inserts = [r for r in insert_log if r["table"] == "part_procurement_tiers"]
        assert len(tier_inserts) == 1
        tier = tier_inserts[0]["data"][0]
        assert tier["vendor_id"] is None
        assert tier["min_quantity"] == 1
        assert tier["cost_per_unit"] == 12.5

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
    async def test_execute_legacy_id_uses_upsert_path(self, test_client):
        """Rows with legacy_id are upserted via ON CONFLICT for idempotency."""
        upsert_log: list = []

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Name": "part_name",
                "Legacy Id": "legacy_id",
                "Unit": "primary_unit",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Name": "PART001", "Legacy Id": "old-system-001", "Unit": "ea"},
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
        # The route called upsert with on_conflict="company_id,legacy_id"
        assert len(upsert_log) == 1
        assert upsert_log[0]["on_conflict"] == "company_id,legacy_id"

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
