# Backend API Tests

## Customer API Tests

Create `api/tests/integration/test_customers_`[`[api.py](http://api.py/)`](http://api.py/):

```python
import pytest
from httpx import AsyncClient
from api.tests.factories.customer_factory import CustomerFactory

pytestmark = pytest.mark.asyncio


class TestCustomerList:
    """GET /api/customers"""
    
    async def test_returns_company_customers_only(
        self, client, test_company, supabase_admin
    ):
        """Users only see their company's customers."""
        # Create customer in user's company
        my_cust = CustomerFactory(company_id=test_company["id"])
        supabase_admin.table("customers").insert(
            my_[cust.to](http://cust.to/)_dict()
        ).execute()
        
        # Create in different company
        other = supabase_admin.table("companies").insert({
            "name": "Other", "slug": "other"
        }).execute()
        other_cust = CustomerFactory(
            company_id=[other.data](http://other.data/)[0]["id"]
        )
        supabase_admin.table("customers").insert(
            other_[cust.to](http://cust.to/)_dict()
        ).execute()
        
        response = await client.get(
            f"/api/customers?company_id={test_company['id']}"
        )
        
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 1
        assert data[0]["name"] == my_[cust.name](http://cust.name/)
    
    async def test_filters_by_active_status(
        self, client, test_company, supabase_admin
    ):
        """is_active filter works correctly."""
        active = CustomerFactory(
            company_id=test_company["id"], 
            is_active=True
        )
        inactive = CustomerFactory(
            company_id=test_company["id"], 
            is_active=False
        )
        supabase_admin.table("customers").insert([
            [active.to](http://active.to/)_dict(), 
            [inactive.to](http://inactive.to/)_dict()
        ]).execute()
        
        response = await client.get(
            f"/api/customers"
            f"?company_id={test_company['id']}"
            f"&is_active=true"
        )
        
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 1
        assert data[0]["is_active"] is True
    
    async def test_search_matches_name_and_code(
        self, client, test_company, supabase_admin
    ):
        """Search works on both fields."""
        cust = CustomerFactory(
            company_id=test_company["id"],
            customer_code="ACME01",
            name="Acme Corporation"
        )
        supabase_admin.table("customers").insert(
            [cust.to](http://cust.to/)_dict()
        ).execute()
        
        # Search by code
        r1 = await client.get(
            f"/api/customers"
            f"?company_id={test_company['id']}"
            f"&search=ACME"
        )
        assert len(r1.json()["data"]) == 1
        
        # Search by name
        r2 = await client.get(
            f"/api/customers"
            f"?company_id={test_company['id']}"
            f"&search=Corporation"
        )
        assert len(r2.json()["data"]) == 1


class TestCustomerCreate:
    """POST /api/customers"""
    
    async def test_creates_with_valid_data(
        self, client, test_company
    ):
        response = await [client.post](http://client.post/)(
            "/api/customers",
            json={
                "company_id": test_company["id"],
                "customer_code": "NEW01",
                "name": "New Customer Inc"
            }
        )
        
        assert response.status_code == 201
        data = response.json()
        assert data["customer_code"] == "NEW01"
        assert data["id"] is not None
    
    async def test_rejects_duplicate_code(
        self, client, test_company, supabase_admin
    ):
        """Customer codes must be unique."""
        existing = CustomerFactory(
            company_id=test_company["id"],
            customer_code="DUPE01"
        )
        supabase_admin.table("customers").insert(
            [existing.to](http://existing.to/)_dict()
        ).execute()
        
        response = await [client.post](http://client.post/)(
            "/api/customers",
            json={
                "company_id": test_company["id"],
                "customer_code": "DUPE01",
                "name": "Different Name"
            }
        )
        
        assert response.status_code == 409
    
    async def test_requires_customer_code(
        self, client, test_company
    ):
        response = await [client.post](http://client.post/)(
            "/api/customers",
            json={
                "company_id": test_company["id"],
                "name": "Missing Code"
            }
        )
        
        assert response.status_code == 422
    
    async def test_requires_authentication(
        self, anon_client, test_company
    ):
        """Unauthenticated requests are rejected."""
        response = await anon_[client.post](http://client.post/)(
            "/api/customers",
            json={
                "company_id": test_company["id"],
                "customer_code": "ANON01",
                "name": "Anon Customer"
            }
        )
        
        assert response.status_code == 401
```

---

## Import API Tests

Create `api/tests/integration/test_import_`[`[api.py](http://api.py/)`](http://api.py/):

```python
import pytest

pytestmark = pytest.mark.asyncio


class TestImportAnalyze:
    """POST /api/customers/import/analyze"""
    
    async def test_suggests_mappings_for_headers(
        self, client, test_company, mocker
    ):
        # Mock AI provider
        mock_provider = mocker.patch(
            "[api.services.ai](http://api.services.ai/).factory.get_provider"
        )
        mock_provider.return_value.suggest_mappings.return_value = {
            "mappings": [
                {
                    "csv_column": "Company Name",
                    "db_field": "name",
                    "confidence": 0.95
                }
            ]
        }
        
        response = await [client.post](http://client.post/)(
            "/api/customers/import/analyze",
            json={
                "company_id": test_company["id"],
                "headers": ["Company Name", "Code"],
                "sample_rows": [["Acme", "ACM01"]]
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "mappings" in data
        assert data["mappings"][0]["confidence"] == 0.95


class TestImportValidate:
    """POST /api/customers/import/validate"""
    
    async def test_detects_duplicate_codes(
        self, client, test_company, supabase_admin
    ):
        # Create existing customer
        supabase_admin.table("customers").insert({
            "company_id": test_company["id"],
            "customer_code": "EXIST01",
            "name": "Existing"
        }).execute()
        
        response = await [client.post](http://client.post/)(
            "/api/customers/import/validate",
            json={
                "company_id": test_company["id"],
                "mappings": {
                    "Code": "customer_code",
                    "Name": "name"
                },
                "rows": [
                    {"Code": "EXIST01", "Name": "Dup"},
                    {"Code": "NEW01", "Name": "New"}
                ]
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["has_conflicts"] is True
        assert data["conflict_rows_count"] == 1
        assert data["valid_rows_count"] == 1
```
