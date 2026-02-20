"""
Integration tests for Parts Import API endpoints.

Tests the parts CSV import workflow: analyze, validate, and execute.
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
            "part number": ("part_number", 0.95),
            "part_no": ("part_number", 0.90),
            "customer name": ("customer_name", 0.95),
            "description": ("description", 0.90),
            "notes": ("notes", 0.85),
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
                # Discard unmapped columns
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

    def __init__(self, data=None, error=None):
        self._data = data or []
        self._error = error
        self._inserted = None
        self._conditions = {}

    def select(self, *args, **kwargs):
        return self

    def eq(self, field, value):
        self._conditions[field] = value
        return self

    def is_(self, field, value):
        """Handle NULL checks."""
        self._conditions[f"{field}_is"] = value
        return self

    def insert(self, data):
        self._inserted = data
        return self

    def delete(self):
        return self

    def in_(self, field, values):
        return self

    def execute(self):
        result = MagicMock()
        result.data = self._data
        result.error = self._error
        if self._inserted is not None:
            # For insert operations, return the inserted data with IDs
            inserted_with_ids = []
            items = self._inserted if isinstance(self._inserted, list) else [self._inserted]
            for i, row in enumerate(items):
                row_copy = dict(row)
                row_copy['id'] = f"inserted-id-{i}"
                inserted_with_ids.append(row_copy)
            result.data = inserted_with_ids
        return result


class MockSupabase:
    """Mock Supabase client."""

    def __init__(self, existing_parts=None, existing_customers=None):
        self._existing_parts = existing_parts or []
        self._existing_customers = existing_customers or []
        self._table_instance = None

    def table(self, name):
        if name == "parts":
            self._table_instance = MockSupabaseTable(data=self._existing_parts)
            return self._table_instance
        elif name == "customers":
            self._table_instance = MockSupabaseTable(data=self._existing_customers)
            return self._table_instance
        return MockSupabaseTable()


def create_mock_supabase_override(existing_parts=None, existing_customers=None):
    """Create a dependency override function for get_supabase."""
    mock = MockSupabase(existing_parts=existing_parts, existing_customers=existing_customers)
    def override():
        return mock
    return override


@pytest.fixture
async def test_client():
    """Create async HTTP client for testing."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
    # Clean up any dependency overrides
    app.dependency_overrides.clear()


class TestPartsAnalyzeEndpoint:
    """Tests for POST /api/parts/import/analyze"""

    @pytest.mark.unit
    async def test_analyze_returns_mappings(self, test_client):
        """Returns 200 with column mappings when AI provider succeeds."""
        request_data = {
            "company_id": "test-company-id",
            "headers": ["Part Number", "Description", "Material Cost", "Extra Column"],
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
            "headers": ["Part Number", "qty1", "price1", "qty2", "price2"],
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

        # Should detect 2 pricing column pairs
        assert len(data["pricing_columns"]) == 2
        assert data["pricing_columns"][0]["qty_column"] == "qty1"
        assert data["pricing_columns"][0]["price_column"] == "price1"
        assert data["pricing_columns"][1]["qty_column"] == "qty2"
        assert data["pricing_columns"][1]["price_column"] == "price2"


class TestPartsValidateEndpoint:
    """Tests for POST /api/parts/import/validate"""

    @pytest.mark.unit
    async def test_validate_returns_valid_count_when_no_conflicts(self, test_client):
        """Returns valid_rows_count when no conflicts exist."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Number": "part_number",
                "Description": "description",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Number": "NEW001", "Description": "New Part 1"},
                {"Part Number": "NEW002", "Description": "New Part 2"},
            ],
            "customer_match_mode": "all_generic",
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
        assert data["error_rows_count"] == 0

    @pytest.mark.unit
    async def test_validate_detects_missing_part_number(self, test_client):
        """Detects missing part_number validation error."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Number": "part_number",
                "Description": "description",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Number": "", "Description": "Part Without Number"},
                {"Part Number": "VALID001", "Description": "Valid Part"},
            ],
            "customer_match_mode": "all_generic",
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
        assert len(data["validation_errors"]) == 1
        assert data["validation_errors"][0]["error_type"] == "missing_part_number"
        assert data["validation_errors"][0]["row_number"] == 1

    @pytest.mark.unit
    async def test_validate_detects_duplicate_part_number_in_csv(self, test_client):
        """Detects duplicate part_number within CSV file."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Number": "part_number",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Number": "DUPE001"},
                {"Part Number": "DUPE001"},  # Duplicate
            ],
            "customer_match_mode": "all_generic",
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
        # Second row should be flagged as duplicate
        assert len(csv_duplicate_conflicts) >= 1

    @pytest.mark.unit
    async def test_validate_customer_match_mode_all_to_one_requires_customer_id(self, test_client):
        """Returns 400 when customer_match_mode is all_to_one but no customer_id provided."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {"Part Number": "part_number"},
            "pricing_columns": [],
            "rows": [{"Part Number": "PART001"}],
            "customer_match_mode": "all_to_one",
            # Missing selected_customer_id
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], [])

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 400
        assert "selected_customer_id is required" in response.json()["detail"]

    @pytest.mark.unit
    async def test_validate_customer_not_found_conflict(self, test_client):
        """Detects customer_not_found conflict when customer name doesn't exist."""
        existing_customers = [
            {"id": "customer-1", "name": "Acme Corp"},
        ]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Number": "part_number",
                "Customer Name": "customer_name",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Number": "PART001", "Customer Name": "Nonexistent Co"},
            ],
            "customer_match_mode": "by_column",
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], existing_customers)

        response = await test_client.post(
            "/api/parts/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["has_conflicts"] is True
        customer_conflicts = [
            c for c in data["conflicts"] if c["conflict_type"] == "customer_not_found"
        ]
        assert len(customer_conflicts) == 1


class TestPartsExecuteEndpoint:
    """Tests for POST /api/parts/import/execute"""

    @pytest.mark.unit
    async def test_execute_imports_valid_rows(self, test_client):
        """Successfully imports valid rows."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Number": "part_number",
                "Description": "description",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Number": "NEW001", "Description": "New Part 1"},
                {"Part Number": "NEW002", "Description": "New Part 2"},
            ],
            "customer_match_mode": "all_generic",
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
    async def test_execute_transforms_pricing_columns_to_jsonb(self, test_client):
        """Transforms pricing columns into JSONB array."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Number": "part_number",
            },
            "pricing_columns": [
                {"qty_column": "qty1", "price_column": "price1"},
                {"qty_column": "qty2", "price_column": "price2"},
            ],
            "rows": [
                {"Part Number": "PART001", "qty1": "1", "price1": "10.00", "qty2": "10", "price2": "8.00"},
            ],
            "customer_match_mode": "all_generic",
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
        assert data["imported_count"] == 1

    @pytest.mark.unit
    async def test_execute_skips_conflicts_when_skip_conflicts_true(self, test_client):
        """Skips conflicting rows when skip_conflicts is True."""
        existing_parts = [
            {"id": "existing-1", "part_number": "EXIST001", "customer_id": None},
        ]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Number": "part_number",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Number": "EXIST001"},  # Will be skipped (duplicate)
                {"Part Number": "NEW001"},    # Will be imported
            ],
            "customer_match_mode": "all_generic",
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
    async def test_execute_assigns_customer_in_all_to_one_mode(self, test_client):
        """Assigns selected customer to all parts in all_to_one mode."""
        existing_customers = [
            {"id": "customer-123", "name": "Acme Corp"},
        ]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Part Number": "part_number",
            },
            "pricing_columns": [],
            "rows": [
                {"Part Number": "PART001"},
                {"Part Number": "PART002"},
            ],
            "customer_match_mode": "all_to_one",
            "selected_customer_id": "customer-123",
            "skip_conflicts": False,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([], existing_customers)

        response = await test_client.post(
            "/api/parts/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["success"] is True
        assert data["imported_count"] == 2
