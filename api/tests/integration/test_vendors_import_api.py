"""
Integration tests for the Vendors Import API endpoints.

Covers analyze / validate / execute plus:
  - the merge-confirmation step: validate returns proposed_merges; execute
    respects confirmed_merges
  - vendor multi-contact (iteration 2): the importer accepts optional
    primary_contact_* fields per row and creates one vendor_contacts row
    with is_primary=true per imported vendor that has them.
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
from routes.vendors_import_routes import get_supabase, validate_import
from models.vendors_import_models import VendorValidateRequest

async def call_validate(request_data: dict):
    """Exercise validate_import() the way execute_import does.

    /validate stopped being an HTTP route when the per-entity import wizards were removed,
    but the function is still load-bearing: execute_import calls it for the conflict report
    before it writes. This mirrors httpx's response surface (`.status_code`, `.json()`) so
    the rule assertions below did not have to change shape.
    """
    supabase = app.dependency_overrides[get_supabase]()
    try:
        result = await validate_import(VendorValidateRequest(**request_data), supabase=supabase)
    except HTTPException as exc:
        # Bind before the lambda: Python unbinds `exc` at the end of the except block.
        status, detail = exc.status_code, exc.detail
        return SimpleNamespace(status_code=status, json=lambda: {"detail": detail})
    return SimpleNamespace(status_code=200, json=result.model_dump)




class MockSupabaseTable:
    """Mock Supabase table chainable.

    Tracks insert / upsert calls. For the vendors table, populates returned
    `data` with synthetic ids + the original payload so the importer can read
    name → id back out for the contact-attach phase.
    """

    def __init__(self, table_name=None, data=None, on_upsert=None, on_insert=None):
        self._table_name = table_name
        self._data = data or []
        self._inserted = None
        self._upserted = None
        self._on_upsert = on_upsert
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
        self._upserted = data
        if self._on_upsert is not None:
            self._on_upsert(data, on_conflict)
        return self

    def execute(self):
        result = MagicMock()
        result.data = self._data
        if self._inserted is not None:
            items = self._inserted if isinstance(self._inserted, list) else [self._inserted]
            result.data = [{**dict(r), "id": f"new-{self._table_name}-{i}"} for i, r in enumerate(items)]
        elif self._upserted is not None:
            items = self._upserted if isinstance(self._upserted, list) else [self._upserted]
            result.data = [{**dict(r), "id": f"up-{self._table_name}-{i}"} for i, r in enumerate(items)]
        return result


class MockSupabase:
    def __init__(
        self,
        existing_vendors=None,
        insert_log=None,
        upsert_log=None,
    ):
        self._existing_vendors = existing_vendors or []
        self._insert_log = insert_log if insert_log is not None else []
        self._upsert_log = upsert_log if upsert_log is not None else []

    def table(self, name):
        on_insert = lambda d: self._insert_log.append({"table": name, "data": d})
        on_upsert = lambda d, oc: self._upsert_log.append({"table": name, "data": d, "on_conflict": oc})
        if name == "vendors":
            return MockSupabaseTable(
                table_name=name,
                data=self._existing_vendors,
                on_insert=on_insert,
                on_upsert=on_upsert,
            )
        return MockSupabaseTable(
            table_name=name,
            on_insert=on_insert,
            on_upsert=on_upsert,
        )


def create_override(**kwargs):
    mock = MockSupabase(**kwargs)
    return lambda: mock


@pytest.fixture
async def test_client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
    app.dependency_overrides.clear()




class TestVendorsValidate:
    @pytest.mark.unit
    async def test_validate_no_conflicts(self, test_client):
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name"},
            "rows": [{"Name": "Acme"}, {"Name": "Beta"}],
        }
        app.dependency_overrides[get_supabase] = create_override()
        response = await call_validate(request)
        app.dependency_overrides.clear()
        assert response.status_code == 200
        data = response.json()
        assert data["has_conflicts"] is False
        assert data["valid_rows_count"] == 2

    @pytest.mark.unit
    async def test_validate_proposes_merges(self, test_client):
        """Two vendor names that look like the same vendor produce a proposal."""
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name"},
            "rows": [
                {"Name": "PerformCoat of Michigan LL"},
                {"Name": "PerformCoat of Michigan LLC"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override()
        response = await call_validate(request)
        app.dependency_overrides.clear()
        assert response.status_code == 200
        data = response.json()
        proposals = data["proposed_merges"]
        assert len(proposals) >= 1
        match = [p for p in proposals if "LLC" in p["to_name"]]
        assert len(match) == 1
        assert match[0]["from_name"] == "PerformCoat of Michigan LL"

    @pytest.mark.unit
    async def test_validate_dissimilar_names_no_proposal(self, test_client):
        """Genuinely different vendor names don't produce false-positive merges."""
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name"},
            "rows": [
                {"Name": "Acme Hardware"},
                {"Name": "Zenith Steel"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override()
        response = await call_validate(request)
        app.dependency_overrides.clear()
        assert response.status_code == 200
        assert response.json()["proposed_merges"] == []

    @pytest.mark.unit
    async def test_validate_existing_vendor_is_an_update_not_a_conflict(self, test_client):
        """A vendor already in Jigged is not a conflict — execute upserts it on (company_id, name)."""
        existing = [{"id": "v-old", "name": "Acme"}]
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name"},
            "rows": [{"Name": "Acme"}],
        }
        app.dependency_overrides[get_supabase] = create_override(
            existing_vendors=existing
        )
        response = await call_validate(request)
        app.dependency_overrides.clear()
        data = response.json()
        assert data["has_conflicts"] is False
        assert not any(c["conflict_type"] == "duplicate_name" for c in data["conflicts"])

    @pytest.mark.unit
    async def test_validate_missing_contact_name_when_email_set(self, test_client):
        """primary_contact_email without primary_contact_name is a validation error.

        Mirrors the migration's data-quality NOTICE rule: never silently
        invent a contact name.
        """
        request = {
            "company_id": "co1",
            "mappings": {
                "Name": "name",
                "Contact Email": "primary_contact_email",
            },
            "rows": [
                {"Name": "Acme", "Contact Email": "orders@acme.example.com"},
            ],
        }
        app.dependency_overrides[get_supabase] = create_override()
        response = await call_validate(request)
        app.dependency_overrides.clear()
        assert response.status_code == 200
        data = response.json()
        assert data["error_rows_count"] == 1
        error_types = [e["error_type"] for e in data["validation_errors"]]
        assert "missing_contact_name" in error_types

    @pytest.mark.unit
    async def test_validate_invalid_contact_role(self, test_client):
        """primary_contact_role must be one of the allowed enum values."""
        request = {
            "company_id": "co1",
            "mappings": {
                "Name": "name",
                "Contact Name": "primary_contact_name",
                "Contact Role": "primary_contact_role",
            },
            "rows": [
                {
                    "Name": "Acme",
                    "Contact Name": "Pat",
                    "Contact Role": "ceo",
                },
            ],
        }
        app.dependency_overrides[get_supabase] = create_override()
        response = await call_validate(request)
        app.dependency_overrides.clear()
        data = response.json()
        assert data["error_rows_count"] == 1
        error_types = [e["error_type"] for e in data["validation_errors"]]
        assert "invalid_contact_role" in error_types


class TestVendorsExecute:
    @pytest.mark.unit
    async def test_execute_imports_rows(self, test_client):
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name", "City": "city"},
            "rows": [
                {"Name": "Acme", "City": "Detroit"},
                {"Name": "Beta", "City": "Chicago"},
            ],
            "skip_conflicts": False,
        }
        app.dependency_overrides[get_supabase] = create_override(
            insert_log=insert_log
        )
        response = await test_client.post(
            "/api/vendors/import/execute", json=request
        )
        app.dependency_overrides.clear()
        assert response.status_code == 200
        data = response.json()
        assert data["imported_count"] == 2
        # No contacts since no primary_contact_* fields were mapped
        assert data["contacts_imported_count"] == 0
        # Verify no vendor_contacts inserts were attempted
        contact_inserts = [i for i in insert_log if i["table"] == "vendor_contacts"]
        assert contact_inserts == []

    @pytest.mark.unit
    async def test_execute_with_primary_contact_creates_contact_row(self, test_client):
        """Primary contact name + email + role creates a vendor_contacts row."""
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {
                "Name": "name",
                "Contact Name": "primary_contact_name",
                "Contact Email": "primary_contact_email",
                "Contact Role": "primary_contact_role",
            },
            "rows": [
                {
                    "Name": "Acme",
                    "Contact Name": "Pat Reyes",
                    "Contact Email": "pat@acme.example.com",
                    "Contact Role": "accounts_payable",
                },
            ],
            "skip_conflicts": False,
        }
        app.dependency_overrides[get_supabase] = create_override(
            insert_log=insert_log
        )
        response = await test_client.post(
            "/api/vendors/import/execute", json=request
        )
        app.dependency_overrides.clear()
        assert response.status_code == 200
        data = response.json()
        assert data["imported_count"] == 1
        assert data["contacts_imported_count"] == 1

        contact_inserts = [i for i in insert_log if i["table"] == "vendor_contacts"]
        assert len(contact_inserts) == 1
        contact_payload = contact_inserts[0]["data"][0]
        assert contact_payload["name"] == "Pat Reyes"
        assert contact_payload["email"] == "pat@acme.example.com"
        assert contact_payload["role"] == "accounts_payable"
        assert contact_payload["is_primary"] is True
        # vendor_id should be the synthetic id from the vendors insert
        assert contact_payload["vendor_id"] == "up-vendors-0"

    @pytest.mark.unit
    async def test_execute_defaults_role_to_sales_when_omitted(self, test_client):
        """primary_contact_role defaults to 'sales' when not in the CSV."""
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {
                "Name": "name",
                "Contact Name": "primary_contact_name",
            },
            "rows": [
                {"Name": "Acme", "Contact Name": "Pat"},
            ],
            "skip_conflicts": False,
        }
        app.dependency_overrides[get_supabase] = create_override(
            insert_log=insert_log
        )
        response = await test_client.post(
            "/api/vendors/import/execute", json=request
        )
        app.dependency_overrides.clear()
        assert response.status_code == 200
        contact_inserts = [i for i in insert_log if i["table"] == "vendor_contacts"]
        assert len(contact_inserts) == 1
        assert contact_inserts[0]["data"][0]["role"] == "sales"

    @pytest.mark.unit
    async def test_execute_email_only_row_fails_validation(self, test_client):
        """Importing email/phone without contact_name fails as missing_contact_name.

        The vendor row itself is also skipped (the row is in
        validation_error_rows). The failure is surfaced in validation_errors,
        not as a silent zero-contact import.
        """
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {
                "Name": "name",
                "Contact Email": "primary_contact_email",
            },
            "rows": [
                {"Name": "Acme", "Contact Email": "orders@acme.example.com"},
            ],
            "skip_conflicts": True,  # skip the validation-error row
        }
        app.dependency_overrides[get_supabase] = create_override(
            insert_log=insert_log
        )
        response = await test_client.post(
            "/api/vendors/import/execute", json=request
        )
        app.dependency_overrides.clear()
        assert response.status_code == 200
        data = response.json()
        # Vendor was skipped; contact was never queued
        assert data["imported_count"] == 0
        assert data["contacts_imported_count"] == 0
        contact_inserts = [i for i in insert_log if i["table"] == "vendor_contacts"]
        assert contact_inserts == []

    @pytest.mark.unit
    async def test_execute_no_contact_fields_creates_vendor_with_no_contact(
        self, test_client
    ):
        """A vendor row with no contact fields creates the vendor and zero contacts.

        Legitimate empty-state — the vendor detail page renders "No contacts yet."
        and the user adds a contact via the Contacts card.
        """
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name", "City": "city"},
            "rows": [{"Name": "Acme", "City": "Detroit"}],
            "skip_conflicts": False,
        }
        app.dependency_overrides[get_supabase] = create_override(
            insert_log=insert_log
        )
        response = await test_client.post(
            "/api/vendors/import/execute", json=request
        )
        app.dependency_overrides.clear()
        assert response.status_code == 200
        data = response.json()
        assert data["imported_count"] == 1
        assert data["contacts_imported_count"] == 0
        contact_inserts = [i for i in insert_log if i["table"] == "vendor_contacts"]
        assert contact_inserts == []

    @pytest.mark.unit
    async def test_execute_mixed_contact_having_and_contactless_rows(
        self, test_client
    ):
        """Bulk import with mixed contact-having and contact-less vendors.

        Two vendors come in: one has a primary contact, one doesn't. The
        importer creates two vendors and exactly one vendor_contacts row,
        keyed to the right vendor.
        """
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {
                "Name": "name",
                "Contact Name": "primary_contact_name",
                "Contact Email": "primary_contact_email",
            },
            "rows": [
                {
                    "Name": "Acme",
                    "Contact Name": "Pat",
                    "Contact Email": "pat@acme.example.com",
                },
                {"Name": "Beta", "Contact Name": "", "Contact Email": ""},
            ],
            "skip_conflicts": False,
        }
        app.dependency_overrides[get_supabase] = create_override(
            insert_log=insert_log
        )
        response = await test_client.post(
            "/api/vendors/import/execute", json=request
        )
        app.dependency_overrides.clear()
        assert response.status_code == 200
        data = response.json()
        assert data["imported_count"] == 2
        assert data["contacts_imported_count"] == 1

        contact_inserts = [i for i in insert_log if i["table"] == "vendor_contacts"]
        assert len(contact_inserts) == 1
        # The single vendor_contacts insert batch should contain exactly one
        # row, keyed to Acme's synthetic vendor id (up-vendors-0).
        contact_rows = contact_inserts[0]["data"]
        assert len(contact_rows) == 1
        assert contact_rows[0]["vendor_id"] == "up-vendors-0"
        assert contact_rows[0]["name"] == "Pat"

    @pytest.mark.unit
    async def test_execute_respects_confirmed_merges(self, test_client):
        """Confirmed merges fold the duplicate row into the canonical row."""
        insert_log = []
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name"},
            "rows": [
                {"Name": "PerformCoat of Michigan LL"},
                {"Name": "PerformCoat of Michigan LLC"},
            ],
            "skip_conflicts": False,
            "confirmed_merges": [
                {
                    "from_name": "PerformCoat of Michigan LL",
                    "to_name": "PerformCoat of Michigan LLC",
                }
            ],
        }
        app.dependency_overrides[get_supabase] = create_override(
            insert_log=insert_log
        )
        response = await test_client.post(
            "/api/vendors/import/execute", json=request
        )
        app.dependency_overrides.clear()
        assert response.status_code == 200
        data = response.json()
        assert data["imported_count"] == 1
        assert data["merged_count"] == 1

    @pytest.mark.unit
    async def test_execute_upserts_on_name_for_idempotency(self, test_client):
        """Every vendor is upserted ON CONFLICT (company_id, name) — the idempotency key."""
        upsert_log = []
        request = {
            "company_id": "co1",
            "mappings": {"Name": "name"},
            "rows": [{"Name": "Acme"}],
            "skip_conflicts": False,
        }
        app.dependency_overrides[get_supabase] = create_override(
            upsert_log=upsert_log
        )
        response = await test_client.post(
            "/api/vendors/import/execute", json=request
        )
        app.dependency_overrides.clear()
        assert response.status_code == 200
        vendors_upserts = [u for u in upsert_log if u["table"] == "vendors"]
        assert len(vendors_upserts) == 1
        assert vendors_upserts[0]["on_conflict"] == "company_id,name"
