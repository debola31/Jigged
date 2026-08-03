"""
Integration tests for Import API endpoints.

Tests the CSV import workflow: analyze, validate, and execute.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from httpx import AsyncClient, ASGITransport

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from index import app
from routes.import_routes import get_supabase


# Mock AI provider for analyze endpoint
class MockAIProvider:
    """Mock AI provider that returns predictable mappings."""

    provider_name = "mock-ai"

    async def suggest_column_mappings(self, csv_headers, sample_rows, target_schema, column_samples=None):
        """Return mock column mapping suggestions."""
        suggestions = []

        # Map common column names to DB fields
        mapping_rules = {
            "company name": ("name", 0.95),
            "name": ("name", 0.90),
            "city": ("city", 0.90),
            "state": ("state", 0.90),
            "phone": ("contact_phone", 0.85),
            "email": ("contact_email", 0.85),
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

    def select(self, *args, **kwargs):
        return self

    def eq(self, *args, **kwargs):
        return self

    def in_(self, *args, **kwargs):
        return self

    def range(self, *args, **kwargs):
        return self

    def insert(self, data):
        self._inserted = data
        return self

    def upsert(self, data, on_conflict=None):
        # Customers now upsert on (company_id, name). Treat like insert for the mock.
        self._inserted = data
        return self

    def delete(self):
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

    def __init__(self, existing_customers=None):
        self._existing_customers = existing_customers or []
        self._table_instance = None

    def table(self, name):
        if name == "customers":
            self._table_instance = MockSupabaseTable(data=self._existing_customers)
            return self._table_instance
        return MockSupabaseTable()


def create_mock_supabase_override(existing_customers=None):
    """Create a dependency override function for get_supabase."""
    mock = MockSupabase(existing_customers=existing_customers)
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


class TestAnalyzeEndpoint:
    """Tests for POST /api/customers/import/analyze"""

    @pytest.mark.unit
    async def test_analyze_returns_mappings(self, test_client):
        """Returns 200 with column mappings when AI provider succeeds."""
        request_data = {
            "company_id": "test-company-id",
            "headers": ["Company Name", "City", "Extra Column"],
            "sample_rows": [
                ["Acme Corp", "Springfield", "ignored"],
                ["Widget Inc", "Chicago", "also ignored"],
            ],
        }

        # Override get_supabase dependency
        app.dependency_overrides[get_supabase] = create_mock_supabase_override([])

        with patch("routes.import_routes.get_provider", new_callable=AsyncMock) as mock_get_provider:
            mock_get_provider.return_value = MockAIProvider()

            response = await test_client.post(
                "/api/customers/import/analyze",
                json=request_data,
            )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert "mappings" in data
        assert "ai_provider" in data
        assert data["ai_provider"] == "mock-ai"

        # Check that mappings were returned
        mappings = {m["csv_column"]: m["db_field"] for m in data["mappings"]}
        assert mappings["Company Name"] == "name"
        assert mappings["City"] == "city"
        assert mappings["Extra Column"] is None  # Discarded

    @pytest.mark.unit
    async def test_analyze_returns_429_when_rate_limited(self, test_client):
        """Returns 429 when rate limit is exceeded."""
        request_data = {
            "company_id": "rate-limited-company",
            "headers": ["Code", "Name"],
            "sample_rows": [["C1", "Test"]],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([])

        with patch("routes.import_routes.ai_rate_limiter") as mock_limiter:
            mock_limiter.check.return_value = False  # Rate limit exceeded

            response = await test_client.post(
                "/api/customers/import/analyze",
                json=request_data,
            )

        app.dependency_overrides.clear()

        assert response.status_code == 429
        assert "too many requests" in response.json()["detail"].lower()

    @pytest.mark.unit
    async def test_analyze_returns_500_when_ai_fails(self, test_client):
        """Returns 500 when AI provider raises an error."""
        request_data = {
            "company_id": "test-company-id",
            "headers": ["Code", "Name"],
            "sample_rows": [["C1", "Test"]],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([])

        with patch("routes.import_routes.get_provider", new_callable=AsyncMock) as mock_get_provider:
            mock_get_provider.side_effect = ValueError("AI provider not configured")

            response = await test_client.post(
                "/api/customers/import/analyze",
                json=request_data,
            )

        app.dependency_overrides.clear()

        assert response.status_code == 500
        assert "not configured" in response.json()["detail"]


class TestValidateEndpoint:
    """Tests for POST /api/customers/import/validate"""

    @pytest.mark.unit
    async def test_validate_returns_valid_count_when_no_conflicts(self, test_client):
        """Returns valid_rows_count when no conflicts exist."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Name": "name",
            },
            "rows": [
                {"Name": "New Company 1"},
                {"Name": "New Company 2"},
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([])

        response = await test_client.post(
            "/api/customers/import/validate",
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
    async def test_validate_detects_missing_name(self, test_client):
        """Detects missing name validation error."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Name": "name",
            },
            "rows": [
                {"Name": ""},
                {"Name": "Valid Company"},
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([])

        response = await test_client.post(
            "/api/customers/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["error_rows_count"] == 1
        assert data["validation_errors"][0]["error_type"] == "missing_name"

    @pytest.mark.unit
    async def test_validate_detects_duplicate_name_in_csv(self, test_client):
        """Detects duplicate name within CSV file."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Name": "name",
            },
            "rows": [
                {"Name": "Same Company"},
                {"Name": "Same Company"},  # Duplicate name
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([])

        response = await test_client.post(
            "/api/customers/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["has_conflicts"] is True
        csv_duplicate_conflicts = [
            c for c in data["conflicts"] if c["conflict_type"] == "csv_duplicate_name"
        ]
        assert len(csv_duplicate_conflicts) == 2

    @pytest.mark.unit
    async def test_validate_detects_conflict_with_existing_db_name(self, test_client):
        """Detects conflict with existing name in database."""
        existing_customers = [
            {"id": "existing-1", "name": "Existing Company"},
        ]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Name": "name",
            },
            "rows": [
                {"Name": "Existing Company"},  # Name conflicts
                {"Name": "Unique Company"},
            ],
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(existing_customers)

        response = await test_client.post(
            "/api/customers/import/validate",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["has_conflicts"] is True
        db_conflicts = [c for c in data["conflicts"] if c["conflict_type"] == "duplicate_name"]
        assert len(db_conflicts) == 1


class TestExecuteEndpoint:
    """Tests for POST /api/customers/import/execute"""

    @pytest.mark.unit
    async def test_execute_imports_valid_rows(self, test_client):
        """Successfully imports valid rows."""
        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Name": "name",
                "City": "city",
            },
            "rows": [
                {"Name": "New Company 1", "City": "Chicago"},
                {"Name": "New Company 2", "City": "Detroit"},
            ],
            "skip_conflicts": False,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override([])

        response = await test_client.post(
            "/api/customers/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["success"] is True
        assert data["imported_count"] == 2
        assert data["skipped_count"] == 0

    @pytest.mark.unit
    async def test_execute_returns_400_when_conflicts_exist(self, test_client):
        """Returns 400 when conflicts exist and skip_conflicts is False."""
        existing_customers = [
            {"id": "existing-1", "name": "Existing Company"},
        ]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Name": "name",
            },
            "rows": [
                {"Name": "Existing Company"},  # Name conflict
            ],
            "skip_conflicts": False,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(existing_customers)

        response = await test_client.post(
            "/api/customers/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 400
        assert "conflicts detected" in response.json()["detail"].lower()

    @pytest.mark.unit
    async def test_execute_updates_existing_creates_new(self, test_client):
        """An existing-name customer updates in place (upsert); a new one is created."""
        existing_customers = [
            {"id": "existing-1", "name": "Existing Company"},
        ]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Name": "name",
            },
            "rows": [
                {"Name": "Existing Company"},  # Updated in place (no longer skipped)
                {"Name": "New Company"},  # Created
            ],
            "skip_conflicts": True,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(existing_customers)

        response = await test_client.post(
            "/api/customers/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["success"] is True
        assert data["imported_count"] == 1  # New Company
        assert data["updated_count"] == 1  # Existing Company
        assert data["skipped_count"] == 0

    @pytest.mark.unit
    async def test_execute_matches_an_existing_customer_regardless_of_case(self, test_client):
        """A CSV row spelled differently is the SAME customer, not a second one.

        Issue #653 P1. is_new was decided on a lowercased name while the upsert
        ran on the case-sensitive (company_id, name) constraint — so "acme corp"
        against a stored "Acme Corp" was counted as an update, denied its
        contact and address, and still INSERTED a second customer row. The fix
        rewrites the payload to the stored spelling so the upsert lands on the
        row it was always meant to update.
        """
        existing_customers = [
            {"id": "existing-1", "name": "Acme Corp"},
        ]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {"Name": "name"},
            "rows": [
                {"Name": "  acme corp  "},  # same company: different case AND padding
            ],
            "skip_conflicts": True,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(existing_customers)

        response = await test_client.post(
            "/api/customers/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        # The row IS the existing customer. Nothing is created.
        assert data["imported_count"] == 0
        assert data["updated_count"] == 1
        assert data["skipped_count"] == 0

    @pytest.mark.unit
    async def test_execute_returns_correct_counts(self, test_client):
        """Returns correct imported_count and skipped_count."""
        existing_customers = [
            {"id": "existing-1", "name": "Existing One"},
            {"id": "existing-2", "name": "Existing Two"},
        ]

        request_data = {
            "company_id": "test-company-id",
            "mappings": {
                "Name": "name",
            },
            "rows": [
                {"Name": "Existing One"},  # Update - existing name (upsert)
                {"Name": "Existing Two"},  # Update - existing name (upsert)
                {"Name": ""},  # Skip - validation error (missing name)
                {"Name": "Valid Company 1"},  # Import
                {"Name": "Valid Company 2"},  # Import
                {"Name": "Valid Company 3"},  # Import
            ],
            "skip_conflicts": True,
        }

        app.dependency_overrides[get_supabase] = create_mock_supabase_override(existing_customers)

        response = await test_client.post(
            "/api/customers/import/execute",
            json=request_data,
        )

        app.dependency_overrides.clear()

        assert response.status_code == 200
        data = response.json()

        assert data["success"] is True
        assert data["imported_count"] == 3  # 3 new
        assert data["updated_count"] == 2  # 2 existing names updated in place
        assert data["skipped_count"] == 1  # only the missing-name validation error
