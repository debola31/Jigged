# Testing Strategy

## Overview

This document outlines the comprehensive testing strategy for Jigged, tailored to the current codebase structure:

- **Frontend**: Next.js App Router + TypeScript + Material UI (pnpm)

- **Backend**: FastAPI (Python) deployed as Vercel serverless functions

- **Database**: Supabase PostgreSQL with Row Level Security

- **Repo**: [https://github.com/debola31/Jigged](https://github.com/debola31/Jigged)

**Goals:**

1. Document expected behavior through readable tests



1. Prevent regressions as modules are added

2. Enable confident refactoring

3. Automate testing in CI/CD pipeline

---

## Testing Pyramid

```javascript
         /\
        /  \         E2E (10%)
       /    \        Playwright - 5-10 critical flows
      /------\
     /        \      Integration (25%)
    /          \     API + DB + Components
   /------------\
  /              \   Unit (65%)
 /                \  Functions, hooks, utils
/------------------\
```

**Philosophy:** More unit tests (fast, isolated, cheap), fewer E2E tests (slow, expensive). Integration tests bridge the gap.

---

## Tech Stack Summary

| Layer | Frontend | Backend |
|---|---|---|
| Unit | Vitest + RTL | pytest |
| Integration | Vitest + MSW | pytest + httpx |
| E2E | Playwright | Playwright |
| Coverage | v8 | pytest-cov |

---

## Directory Structure

### Frontend

```javascript
Jigged/
├── __tests__/
│   ├── setup.ts              # Global setup
│   ├── test-utils.tsx        # Custom render
│   ├── mocks/
│   │   ├── handlers.ts       # MSW handlers
│   │   └── server.ts         # MSW server
│   ├── unit/
│   ├── components/
│   └── integration/
├── e2e/
│   ├── fixtures/
│   └── *.spec.ts
├── vitest.config.ts
└── playwright.config.ts
```

### Backend

```javascript
api/
├── tests/
│   ├── [conftest.py](http://conftest.py/)           # Shared fixtures
│   ├── factories/            # Test data
│   ├── unit/
│   ├── integration/
│   └── database/             # RLS tests
├── pytest.ini
└── requirements-test.txt
```

---

## Detailed Guides

See the sub-pages below for implementation details:

- [Frontend Testing Setup (Vitest + RTL + MSW)](frontend-setup.md)
- [Frontend Component Tests](frontend-components.md)
- [Backend Testing Setup (pytest)](backend-setup.md)
- [Backend API Tests](backend-api.md)
- [Database RLS Policy Tests](database-rls.md)
- [E2E Tests (Playwright)](e2e.md)
- [CI/CD Integration (GitHub Actions)](cicd.md)
- [Implementation Priority & Checklist](checklist.md)

---

## Quick Start Commands

```bash
# Frontend tests
pnpm test              # Run all
pnpm test:coverage     # With coverage
pnpm test:ui           # Visual runner

# Backend tests
cd api && pytest       # Run all
pytest -m unit         # Unit only
pytest --cov           # With coverage

# E2E tests
pnpm test:e2e          # Run all
pnpm test:e2e:ui       # Visual runner
```

---

## Coverage Targets

| Area | Target |
|---|---|
| Overall | 70% |
| Business Logic | 80% |
| RLS Policies | 100% |
| Critical Flows | E2E cover |

[Frontend Testing Setup](frontend-setup.md)
## Step 1: Install Dependencies

  ```bash
  pnpm add -D vitest @vitest/coverage-v8 @vitest/ui \
    @testing-library/react @testing-library/jest-dom \
    @testing-library/user-event jsdom \
    msw @types/testing-library__jest-dom
  ```

  ---

## Step 2: Vitest Configuration

  Create `vitest.config.ts` in project root:

  ```typescript
  import { defineConfig } from 'vitest/config'
  import react from '@vitejs/plugin-react'
  import path from 'path'
  
  export default defineConfig({
    plugins: [react()],
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./__tests__/setup.ts'],
      include: ['__tests__/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['e2e/**', 'node_modules/**'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        exclude: [
          'node_modules/', '__tests__/', 'e2e/',
          '**/*.d.ts', '**/*.config.*',
        ],
        thresholds: {
          statements: 60, branches: 60,
          functions: 60, lines: 60,
        }
      },
    },
    resolve: {
      alias: { '@': path.resolve(__dirname, './') },
    },
  })
  ```

  ---

## Step 3: Test Setup File

  Create `__tests__/setup.ts`:

  ```typescript
  import '@testing-library/jest-dom'
  import { beforeAll, afterEach, afterAll } from 'vitest'
  import { server } from './mocks/server'
  
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())
  ```

  ---

## Step 4: Custom Render with Providers

  Create `__tests__/test-utils.tsx`:

  ```typescript
  import { ReactElement, ReactNode } from 'react'
  import { render, RenderOptions } from '@testing-library/react'
  import { ThemeProvider, createTheme } from '@mui/material/styles'
  
  const theme = createTheme({})
  
  function AllProviders({ children }: { children: ReactNode }) {
    return (
      <ThemeProvider theme={theme}>
        {children}
      </ThemeProvider>
    )
  }
  
  function customRender(
    ui: ReactElement,
    options?: Omit<RenderOptions, 'wrapper'>
  ) {
    return render(ui, { wrapper: AllProviders, ...options })
  }
  
  export * from '@testing-library/react'
  export { customRender as render }
  ```

  ---

## Step 5: MSW Handlers

  Create `__tests__/mocks/handlers.ts`:

  ```typescript
  import { http, HttpResponse } from 'msw'
  
  export const handlers = [
    // GET /api/customers
    http.get('/api/customers', ({ request }) => {
      const url = new URL(request.url)
      const search = url.searchParams.get('search')
      
      let customers = [
        { id: '1', customer_code: 'ACME01', 
          name: 'Acme Corp', is_active: true },
        { id: '2', customer_code: 'AJAX02', 
          name: 'Ajax Inc', is_active: true },
      ]
      
      if (search) {
        const s = search.toLowerCase()
        customers = customers.filter(c => 
          [c.name](http://c.name/).toLowerCase().includes(s) ||
          c.customer_code.toLowerCase().includes(s)
        )
      }
      
      return HttpResponse.json({ data: customers })
    }),
  
    // POST /api/customers
    [http.post](http://http.post/)('/api/customers', async ({ request }) => {
      const body = await request.json()
      
      if (body.customer_code === 'DUPE01') {
        return HttpResponse.json(
          { detail: 'Customer code exists' },
          { status: 409 }
        )
      }
      
      return HttpResponse.json(
        { id: 'new-id', ...body },
        { status: 201 }
      )
    }),
  
    // Import analyze
    [http.post](http://http.post/)('/api/customers/import/analyze', async ({ request }) => {
      const body = await request.json()
      const mappings = [body.headers.map](http://body.headers.map/)((h: string) => ({
        csv_column: h,
        db_field: guessField(h),
        confidence: 0.85,
        needs_review: false,
      }))
      return HttpResponse.json({ mappings })
    }),
  ]
  
  function guessField(header: string) {
    const h = header.toLowerCase()
    if (h.includes('name')) return 'name'
    if (h.includes('code')) return 'customer_code'
    if (h.includes('phone')) return 'phone'
    if (h.includes('email')) return 'email'
    return null
  }
  ```

  Create `__tests__/mocks/server.ts`:

  ```typescript
  import { setupServer } from 'msw/node'
  import { handlers } from './handlers'
  
  export const server = setupServer(...handlers)
  ```

  ---

## Step 6: Package.json Scripts

  ```json
  {
    "scripts": {
      "test": "vitest",
      "test:ui": "vitest --ui",
      "test:coverage": "vitest run --coverage"
    }
  }
  ```

[Frontend Component Tests](frontend-components.md)
## Testing Patterns

  Tests should read like documentation. Use descriptive names that explain the expected behavior.

  ---

## CustomerForm Tests

  Create `__tests__/components/customers/CustomerForm.test.tsx`:

  ```typescript
  import { describe, it, expect, vi } from 'vitest'
  import { render, screen, waitFor } from '../../test-utils'
  import userEvent from '@testing-library/user-event'
  import { CustomerForm } from '@/components/customers/CustomerForm'
  import { server } from '../../mocks/server'
  import { http, HttpResponse } from 'msw'
  
  describe('CustomerForm', () => {
    const defaultProps = {
      companyId: 'test-company',
      onSuccess: vi.fn(),
      onCancel: vi.fn(),
    }
  
    describe('validation', () => {
      it('shows error when customer_code is empty', async () => {
        const user = userEvent.setup()
        render(<CustomerForm {...defaultProps} />)
        
        await user.type(
          screen.getByLabelText(/company name/i), 
          'Acme Corp'
        )
        await [user.click](http://user.click/)(
          screen.getByRole('button', { name: /save/i })
        )
        
        expect(
          await screen.findByText(/customer code.*required/i)
        ).toBeInTheDocument()
      })
  
      it('shows error when name is empty', async () => {
        const user = userEvent.setup()
        render(<CustomerForm {...defaultProps} />)
        
        await user.type(
          screen.getByLabelText(/customer code/i), 
          'ACME01'
        )
        await [user.click](http://user.click/)(
          screen.getByRole('button', { name: /save/i })
        )
        
        expect(
          await screen.findByText(/name.*required/i)
        ).toBeInTheDocument()
      })
    })
  
    describe('create mode', () => {
      it('creates customer and calls onSuccess', async () => {
        const user = userEvent.setup()
        const onSuccess = vi.fn()
        render(
          <CustomerForm {...defaultProps} onSuccess={onSuccess} />
        )
        
        await user.type(
          screen.getByLabelText(/customer code/i), 
          'NEW01'
        )
        await user.type(
          screen.getByLabelText(/company name/i), 
          'New Corp'
        )
        await [user.click](http://user.click/)(
          screen.getByRole('button', { name: /save/i })
        )
        
        await waitFor(() => {
          expect(onSuccess).toHaveBeenCalledWith(
            expect.objectContaining({
              customer_code: 'NEW01',
              name: 'New Corp'
            })
          )
        })
      })
  
      it('shows API error for duplicate code', async () => {
        const user = userEvent.setup()
        render(<CustomerForm {...defaultProps} />)
        
        await user.type(
          screen.getByLabelText(/customer code/i), 
          'DUPE01'
        )
        await user.type(
          screen.getByLabelText(/company name/i), 
          'Dupe Corp'
        )
        await [user.click](http://user.click/)(
          screen.getByRole('button', { name: /save/i })
        )
        
        expect(
          await screen.findByText(/already exists/i)
        ).toBeInTheDocument()
      })
    })
  
    describe('edit mode', () => {
      it('pre-fills form with existing data', () => {
        const customer = {
          id: '123',
          customer_code: 'EXIST01',
          name: 'Existing Corp',
          phone: '555-1234'
        }
        
        render(
          <CustomerForm {...defaultProps} customer={customer} />
        )
        
        expect(
          screen.getByLabelText(/customer code/i)
        ).toHaveValue('EXIST01')
        expect(
          screen.getByLabelText(/company name/i)
        ).toHaveValue('Existing Corp')
      })
    })
  })
  ```

  ---

## CustomerList Tests

  Create `__tests__/components/customers/CustomerList.test.tsx`:

  ```typescript
  import { describe, it, expect } from 'vitest'
  import { render, screen, waitFor } from '../../test-utils'
  import userEvent from '@testing-library/user-event'
  import { CustomerList } from '@/components/customers/CustomerList'
  
  describe('CustomerList', () => {
    it('displays customers from API', async () => {
      render(<CustomerList companyId="test" />)
      
      expect(
        await screen.findByText('Acme Corp')
      ).toBeInTheDocument()
      expect(
        screen.getByText('Ajax Inc')
      ).toBeInTheDocument()
    })
  
    it('filters customers by search term', async () => {
      const user = userEvent.setup()
      render(<CustomerList companyId="test" />)
      
      await screen.findByText('Acme Corp')
      
      await user.type(
        screen.getByPlaceholderText(/search/i),
        'Acme'
      )
      
      await waitFor(() => {
        expect(screen.getByText('Acme Corp')).toBeInTheDocument()
        expect(screen.queryByText('Ajax Inc')).not.toBeInTheDocument()
      })
    })
  
    it('shows empty state when no customers', async () => {
      server.use(
        http.get('/api/customers', () => {
          return HttpResponse.json({ data: [] })
        })
      )
      
      render(<CustomerList companyId="test" />)
      
      expect(
        await screen.findByText(/no customers/i)
      ).toBeInTheDocument()
    })
  })
  ```

  ---

## Import Components Tests

  Create `__tests__/components/customers/import/ConfidenceChip.test.tsx`:

  ```typescript
  import { describe, it, expect } from 'vitest'
  import { render, screen } from '../../../test-utils'
  import { ConfidenceChip } from '@/components/customers/import/ConfidenceChip'
  
  describe('ConfidenceChip', () => {
    it('shows green for high confidence (>=0.8)', () => {
      render(<ConfidenceChip confidence={0.95} />)
      
      const chip = screen.getByTestId('confidence-chip')
      expect(chip).toHaveAttribute('data-confidence', 'high')
    })
  
    it('shows yellow for medium confidence (0.5-0.79)', () => {
      render(<ConfidenceChip confidence={0.65} />)
      
      const chip = screen.getByTestId('confidence-chip')
      expect(chip).toHaveAttribute('data-confidence', 'medium')
    })
  
    it('shows red for low confidence (<0.5)', () => {
      render(<ConfidenceChip confidence={0.3} />)
      
      const chip = screen.getByTestId('confidence-chip')
      expect(chip).toHaveAttribute('data-confidence', 'low')
    })
  })
  ```

[Backend Testing Setup](backend-setup.md)
## Step 1: Install Dependencies

  Create `api/requirements-test.txt`:

  ```javascript
  pytest>=7.4.0
  pytest-asyncio>=0.21.0
  pytest-cov>=4.1.0
  pytest-mock>=3.11.0
  httpx>=0.24.0
  factory-boy>=3.3.0
  responses>=0.23.0
  ```

  Install:

  ```bash
  pip install -r api/requirements-test.txt
  ```

  ---

## Step 2: Pytest Configuration

  Create `api/pytest.ini`:

  ```plain text
  [pytest]
  asyncio_mode = auto
  testpaths = tests
  python_files = test_*.py
  python_classes = Test*
  python_functions = test_*
  addopts = -v --tb=short
  markers =
      unit: Unit tests (no external dependencies)
      integration: Integration tests (requires DB)
      slow: Slow tests
  ```

  ---

## Step 3: Shared Fixtures

  Create `api/tests/`[`[conftest.py](http://conftest.py/)`](http://conftest.py/):

  ```python
  import pytest
  import os
  from httpx import AsyncClient, ASGITransport
  from supabase import create_client, Client
  from uuid import uuid4
  
  # Import your FastAPI app
  from api.index import app
  
  # Test Supabase credentials
  TEST_SUPABASE_URL = os.environ.get("TEST_SUPABASE_URL")
  TEST_SUPABASE_KEY = os.environ.get("TEST_SUPABASE_SERVICE_KEY")
  
  
  @pytest.fixture(scope="session")
  def supabase_admin() -> Client:
      """Admin client that bypasses RLS."""
      return create_client(TEST_SUPABASE_URL, TEST_SUPABASE_KEY)
  
  
  @pytest.fixture
  async def test_company(supabase_admin):
      """Create isolated test company."""
      company = supabase_admin.table("companies").insert({
          "name": f"Test Company {uuid4().hex[:8]}",
          "slug": f"test-{uuid4().hex[:8]}"
      }).execute()
      
      yield [company.data](http://company.data/)[0]
      
      # Cleanup
      supabase_admin.table("companies").delete().eq(
          "id", [company.data](http://company.data/)[0]["id"]
      ).execute()
  
  
  @pytest.fixture
  async def test_user(supabase_admin, test_company):
      """Create test user with company access."""
      email = f"test-{uuid4().hex[:8]}@[test.com](http://test.com/)"
      
      user = supabase_admin.auth.admin.create_user({
          "email": email,
          "password": "testpassword123",
          "email_confirm": True
      })
      
      supabase_admin.table("user_company_access").insert({
          "user_id": [user.user.id](http://user.user.id/),
          "company_id": test_company["id"],
          "role": "owner"
      }).execute()
      
      yield user.user
      
      supabase_admin.auth.admin.delete_user([user.user.id](http://user.user.id/))
  
  
  @pytest.fixture
  async def auth_token(supabase_admin, test_user):
      """Get JWT for test user."""
      # Sign in to get token
      session = supabase_admin.auth.sign_in_with_password({
          "email": test_[user.email](http://user.email/),
          "password": "testpassword123"
      })
      return session.session.access_token
  
  
  @pytest.fixture
  async def client(auth_token):
      """Authenticated HTTP client."""
      transport = ASGITransport(app=app)
      async with AsyncClient(
          transport=transport,
          base_url="[http://test](http://test/)",
          headers={"Authorization": f"Bearer {auth_token}"}
      ) as ac:
          yield ac
  
  
  @pytest.fixture
  async def anon_client():
      """Unauthenticated HTTP client."""
      transport = ASGITransport(app=app)
      async with AsyncClient(
          transport=transport,
          base_url="[http://test](http://test/)"
      ) as ac:
          yield ac
  ```

  ---

## Step 4: Test Data Factories

  Create `api/tests/factories/customer_`[`[factory.py](http://factory.py/)`](http://factory.py/):

  ```python
  from dataclasses import dataclass, field
  from uuid import uuid4
  from typing import Optional
  
  
  @dataclass
  class CustomerFactory:
      """Generate test customer data."""
      
      company_id: str
      customer_code: str = field(
          default_factory=lambda: f"TST-{uuid4().hex[:6].upper()}"
      )
      name: str = field(
          default_factory=lambda: f"Test Customer {uuid4().hex[:8]}"
      )
      phone: Optional[str] = "555-0100"
      email: Optional[str] = None
      is_active: bool = True
      
      def __post_init__(self):
          if [self.email](http://self.email/) is None:
              [self.email](http://self.email/) = f"{self.customer_code.lower()}@[test.com](http://test.com/)"
      
      def to_dict(self) -> dict:
          return {
              "company_id": [self.company](http://self.company/)_id,
              "customer_code": self.customer_code,
              "name": [self.name](http://self.name/),
              "phone": [self.phone](http://self.phone/),
              "email": [self.email](http://self.email/),
              "is_active": [self.is](http://self.is/)_active
          }
      
      @classmethod
      def batch(cls, company_id: str, count: int) -> list:
          return [cls(company_id=company_id) for _ in range(count)]
  ```

  ---

## Step 5: Running Tests

  ```bash
  # Run all tests
  cd api && pytest
  
  # Run with coverage
  pytest --cov=. --cov-report=html
  
  # Run specific markers
  pytest -m unit
  pytest -m integration
  
  # Run specific file
  pytest tests/integration/test_customers_[api.py](http://api.py/)
  ```

[Backend API Tests](backend-api.md)
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

[Database RLS Tests](database-rls.md)
## Why Test RLS?

  Row Level Security is critical for multi-tenant applications. These tests verify that users can only access data from their authorized companies.

  ---

## RLS Policy Tests

  Create `api/tests/database/test_rls_`[`[policies.py](http://policies.py/)`](http://policies.py/):

  ```python
  import pytest
  from supabase import create_client
  import os
  
  pytestmark = pytest.mark.asyncio
  
  TEST_SUPABASE_URL = os.environ.get("TEST_SUPABASE_URL")
  TEST_SUPABASE_ANON_KEY = os.environ.get("TEST_SUPABASE_ANON_KEY")
  
  
  class TestCustomerRLS:
      """RLS policies for customers table."""
      
      async def test_user_cannot_read_other_company(
          self, supabase_admin, test_user, test_company
      ):
          """Users cannot see other companies' customers."""
          # Create another company with customer
          other = supabase_admin.table("companies").insert({
              "name": "Other Corp",
              "slug": "other-corp"
          }).execute()
          
          secret = supabase_admin.table("customers").insert({
              "company_id": [other.data](http://other.data/)[0]["id"],
              "customer_code": "SECRET",
              "name": "Secret Customer"
          }).execute()
          
          # Get user session
          session = supabase_admin.auth.sign_in_with_password({
              "email": test_[user.email](http://user.email/),
              "password": "testpassword123"
          })
          
          # Create client as user
          user_client = create_client(
              TEST_SUPABASE_URL, 
              TEST_SUPABASE_ANON_KEY
          )
          user_client.auth.set_session(
              session.session.access_token,
              session.session.refresh_token
          )
          
          # Try to read secret customer
          result = user_client.table("customers").select("*").eq(
              "id", [secret.data](http://secret.data/)[0]["id"]
          ).execute()
          
          # RLS should block - returns empty
          assert len([result.data](http://result.data/)) == 0
      
      async def test_user_cannot_insert_other_company(
          self, supabase_admin, test_user
      ):
          """Users cannot insert into unauthorized companies."""
          # Create company user has NO access to
          other = supabase_admin.table("companies").insert({
              "name": "Other",
              "slug": "other"
          }).execute()
          
          session = supabase_admin.auth.sign_in_with_password({
              "email": test_[user.email](http://user.email/),
              "password": "testpassword123"
          })
          
          user_client = create_client(
              TEST_SUPABASE_URL,
              TEST_SUPABASE_ANON_KEY
          )
          user_client.auth.set_session(
              session.session.access_token,
              session.session.refresh_token
          )
          
          # Attempt unauthorized insert
          with pytest.raises(Exception) as exc_info:
              user_client.table("customers").insert({
                  "company_id": [other.data](http://other.data/)[0]["id"],
                  "customer_code": "HACK01",
                  "name": "Unauthorized"
              }).execute()
          
          assert "policy" in str(exc_info.value).lower()
      
      async def test_user_can_read_own_company(
          self, supabase_admin, test_user, test_company
      ):
          """Users CAN see their company's customers."""
          my_customer = supabase_admin.table("customers").insert({
              "company_id": test_company["id"],
              "customer_code": "MINE01",
              "name": "My Customer"
          }).execute()
          
          session = supabase_admin.auth.sign_in_with_password({
              "email": test_[user.email](http://user.email/),
              "password": "testpassword123"
          })
          
          user_client = create_client(
              TEST_SUPABASE_URL,
              TEST_SUPABASE_ANON_KEY
          )
          user_client.auth.set_session(
              session.session.access_token,
              session.session.refresh_token
          )
          
          result = user_client.table("customers").select("*").eq(
              "id", my_[customer.data](http://customer.data/)[0]["id"]
          ).execute()
          
          assert len([result.data](http://result.data/)) == 1
          assert [result.data](http://result.data/)[0]["name"] == "My Customer"
  
  
  class TestPartsRLS:
      """RLS policies for parts table."""
      
      async def test_parts_inherit_customer_company(
          self, supabase_admin, test_user, test_company
      ):
          """Parts are visible based on company access."""
          # Create customer and part
          customer = supabase_admin.table("customers").insert({
              "company_id": test_company["id"],
              "customer_code": "CUST01",
              "name": "Customer"
          }).execute()
          
          part = supabase_admin.table("parts").insert({
              "company_id": test_company["id"],
              "customer_id": [customer.data](http://customer.data/)[0]["id"],
              "part_name": "PART-001",
              "description": "Test Part"
          }).execute()
          
          session = supabase_admin.auth.sign_in_with_password({
              "email": test_[user.email](http://user.email/),
              "password": "testpassword123"
          })
          
          user_client = create_client(
              TEST_SUPABASE_URL,
              TEST_SUPABASE_ANON_KEY
          )
          user_client.auth.set_session(
              session.session.access_token,
              session.session.refresh_token
          )
          
          result = user_client.table("parts").select("*").eq(
              "id", [part.data](http://part.data/)[0]["id"]
          ).execute()
          
          assert len([result.data](http://result.data/)) == 1
  ```

  ---

## Test Checklist

  - [ ] Users cannot SELECT from other companies

  - [ ] Users cannot INSERT into other companies

  - [ ] Users cannot UPDATE other companies' data

  - [ ] Users cannot DELETE other companies' data

  - [ ] Service role key bypasses RLS (for admin operations)

  - [ ] Anon key with no auth sees nothing

[E2E Tests](e2e.md)
## Setup

  ```bash
  pnpm add -D @playwright/test
  npx playwright install chromium
  ```

  ---

## Configuration

  Create `playwright.config.ts`:

  ```typescript
  import { defineConfig, devices } from '@playwright/test'
  
  export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !![process.env.CI](http://process.env.ci/),
    retries: [process.env.CI](http://process.env.ci/) ? 2 : 0,
    workers: [process.env.CI](http://process.env.ci/) ? 1 : undefined,
    reporter: 'html',
    
    use: {
      baseURL: process.env.TEST_URL || '[http://localhost:3000](http://localhost:3000/)',
      trace: 'on-first-retry',
      screenshot: 'only-on-failure',
    },
  
    projects: [
      {
        name: 'chromium',
        use: { ...devices['Desktop Chrome'] },
      },
    ],
  
    webServer: {
      command: 'pnpm dev',
      url: '[http://localhost:3000](http://localhost:3000/)',
      reuseExistingServer: ![process.env.CI](http://process.env.ci/),
    },
  })
  ```

  ---

## Auth Helper

  Create `e2e/fixtures/auth.ts`:

  ```typescript
  import { Page } from '@playwright/test'
  
  export async function login(
    page: Page,
    email = '[test@example.com](mailto:test@example.com)',
    password = 'testpassword'
  ) {
    await page.goto('/login')
    await page.fill('[name="email"]', email)
    await page.fill('[name="password"]', password)
    await [page.click](http://page.click/)('button[type="submit"]')
    await page.waitForURL(/\/dashboard\//)
  }
  ```

  ---

## Customer CRUD Test

  Create `e2e/customer-crud.spec.ts`:

  ```typescript
  import { test, expect } from '@playwright/test'
  import { login } from './fixtures/auth'
  
  test.describe('Customer CRUD', () => {
    test.beforeEach(async ({ page }) => {
      await login(page)
    })
  
    test('create new customer', async ({ page }) => {
      await [page.click](http://page.click/)('text=Customers')
      await [page.click](http://page.click/)('text=New Customer')
      
      await page.fill(
        '[name="customer_code"]', 
        'E2E-001'
      )
      await page.fill(
        '[name="name"]', 
        'E2E Test Customer'
      )
      await page.fill(
        '[name="phone"]', 
        '555-0123'
      )
      
      await [page.click](http://page.click/)('button:has-text("Save")')
      
      await expect(
        page.getByText('E2E Test Customer')
      ).toBeVisible()
    })
  
    test('search customers', async ({ page }) => {
      await [page.click](http://page.click/)('text=Customers')
      
      await page.fill(
        '[placeholder*="Search"]', 
        'E2E'
      )
      
      await expect(
        page.getByText('E2E Test Customer')
      ).toBeVisible()
    })
  
    test('edit customer', async ({ page }) => {
      await [page.click](http://page.click/)('text=Customers')
      await [page.click](http://page.click/)('text=E2E Test Customer')
      await [page.click](http://page.click/)('button:has-text("Edit")')
      
      await page.fill(
        '[name="phone"]', 
        '555-9999'
      )
      await [page.click](http://page.click/)('button:has-text("Save")')
      
      await expect(
        page.getByText('555-9999')
      ).toBeVisible()
    })
  })
  ```

  ---

## Quote to Job Flow

  Create `e2e/quote-to-job.spec.ts`:

  ```typescript
  import { test, expect } from '@playwright/test'
  import { login } from './fixtures/auth'
  
  test.describe('Quote to Job Workflow', () => {
    test.beforeEach(async ({ page }) => {
      await login(page)
    })
  
    test('complete flow', async ({ page }) => {
      // 1. Create quote
      await [page.click](http://page.click/)('text=Quotes')
      await [page.click](http://page.click/)('text=New Quote')
      
      await page.getByLabel('Customer').click()
      await page.getByRole('option').first().click()
      
      await page.fill('[name="quantity"]', '100')
      await page.fill('[name="unit_price"]', '50')
      await [page.click](http://page.click/)('button:has-text("Save")')
      
      const quoteNum = await page
        .getByText(/Q-\d{4}/)
        .textContent()
      
      // 2. Send quote
      await [page.click](http://page.click/)('button:has-text("Send")')
      await expect(
        page.getByText('Sent')
      ).toBeVisible()
      
      // 3. Accept quote
      await [page.click](http://page.click/)('button:has-text("Accept")')
      await expect(
        page.getByText('Accepted')
      ).toBeVisible()
      
      // 4. Convert to job
      await [page.click](http://page.click/)('button:has-text("Convert to Job")')
      await page.fill('[name="due_date"]', '2025-02-15')
      await [page.click](http://page.click/)('button:has-text("Create Job")')
      
      await expect(
        page.getByText(/J-\d{4}/)
      ).toBeVisible()
      
      // 5. Start job
      await [page.click](http://page.click/)('button:has-text("Start")')
      await expect(
        page.getByText('In Progress')
      ).toBeVisible()
      
      // 6. Complete job
      await [page.click](http://page.click/)('button:has-text("Update Progress")')
      await page.fill('[name="qty_completed"]', '100')
      await [page.click](http://page.click/)('button:has-text("Update")')
      await [page.click](http://page.click/)('button:has-text("Complete")')
      
      await expect(
        page.getByText('Complete')
      ).toBeVisible()
      
      // 7. Ship
      await [page.click](http://page.click/)('button:has-text("Ship")')
      await expect(
        page.getByText('Shipped')
      ).toBeVisible()
    })
  })
  ```

  ---

## CSV Import Test

  Create `e2e/csv-import.spec.ts`:

  ```typescript
  import { test, expect } from '@playwright/test'
  import { login } from './fixtures/auth'
  import path from 'path'
  
  test.describe('CSV Import', () => {
    test.beforeEach(async ({ page }) => {
      await login(page)
    })
  
    test('imports customers with AI mapping', async ({ page }) => {
      await [page.click](http://page.click/)('text=Customers')
      await [page.click](http://page.click/)('text=Import')
      
      // Upload file
      await page.setInputFiles(
        'input[type="file"]',
        path.join(__dirname, 'fixtures/customers.csv')
      )
      
      // Wait for AI analysis
      await expect(
        page.getByText(/analyzing/i)
      ).toBeVisible()
      await expect(
        page.getByText(/mapping/i)
      ).toBeVisible({ timeout: 10000 })
      
      // Check confidence indicators
      await expect(
        page.locator('[data-confidence="high"]')
      ).toBeVisible()
      
      // Proceed
      await [page.click](http://page.click/)('button:has-text("Validate")')
      await [page.click](http://page.click/)('button:has-text("Import")')
      
      // Verify success
      await expect(
        page.getByText(/imported/i)
      ).toBeVisible()
    })
  })
  ```

  ---

## Test Fixture CSV

  Create `e2e/fixtures/customers.csv`:

  ```javascript
  Company Name,Code,Phone,Email
  Acme Corp,ACME01,555-1234,[info@acme.com](mailto:info@acme.com)
  Ajax Inc,AJAX02,555-5678,[sales@ajax.com](mailto:sales@ajax.com)
  ```

[CI/CD Integration](cicd.md)
## Workflow Configuration

  Create `.github/workflows/test.yml`:

  ```yaml
  name: Test Suite
  
  on:
    push:
      branches: [main, develop]
    pull_request:
      branches: [main]
  
  env:
    TEST_SUPABASE_URL: ${{ secrets.TEST_SUPABASE_URL }}
    TEST_SUPABASE_SERVICE_KEY: ${{ secrets.TEST_SUPABASE_SERVICE_KEY }}
    TEST_SUPABASE_ANON_KEY: ${{ secrets.TEST_SUPABASE_ANON_KEY }}
  
  jobs:
    frontend-tests:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        
        - name: Setup pnpm
          uses: pnpm/action-setup@v2
          with:
            version: 8
        
        - name: Setup Node.js
          uses: actions/setup-node@v4
          with:
            node-version: '20'
            cache: 'pnpm'
        
        - name: Install dependencies
          run: pnpm install
        
        - name: Run tests
          run: pnpm test:coverage
        
        - name: Upload coverage
          uses: codecov/codecov-action@v4
          with:
            files: ./coverage/coverage-final.json
            flags: frontend
  
    backend-tests:
      runs-on: ubuntu-latest
      defaults:
        run:
          working-directory: ./api
      
      steps:
        - uses: actions/checkout@v4
        
        - name: Setup Python
          uses: actions/setup-python@v5
          with:
            python-version: '3.11'
            cache: 'pip'
        
        - name: Install dependencies
          run: |
            pip install -r requirements.txt
            pip install -r requirements-test.txt
        
        - name: Run unit tests
          run: pytest tests/unit -v --cov
        
        - name: Run integration tests
          run: pytest tests/integration -v --cov --cov-append
        
        - name: Run RLS tests
          run: pytest tests/database -v
        
        - name: Upload coverage
          uses: codecov/codecov-action@v4
          with:
            files: ./api/coverage.xml
            flags: backend
  
    e2e-tests:
      runs-on: ubuntu-latest
      needs: [frontend-tests, backend-tests]
      
      steps:
        - uses: actions/checkout@v4
        
        - name: Setup pnpm
          uses: pnpm/action-setup@v2
          with:
            version: 8
        
        - name: Setup Node.js
          uses: actions/setup-node@v4
          with:
            node-version: '20'
            cache: 'pnpm'
        
        - name: Install dependencies
          run: pnpm install
        
        - name: Install Playwright
          run: npx playwright install chromium
        
        - name: Run E2E tests
          run: pnpm test:e2e
          env:
            TEST_URL: ${{ secrets.TEST_PREVIEW_URL }}
        
        - name: Upload results
          uses: actions/upload-artifact@v4
          if: failure()
          with:
            name: playwright-report
            path: playwright-report/
  ```

  ---

## Required Secrets

  Add these to GitHub repository settings:

  | Secret Name | Description |
  |---|---|
  | TEST_SUPABASE_URL | Test project URL |
  | TEST_SUPABASE_SERVICE_KEY | Service role key (bypasses RLS) |
  | TEST_SUPABASE_ANON_KEY | Anon key for user simulation |
  | TEST_PREVIEW_URL | Vercel preview URL for E2E |

  ---

## Test Environment Strategy

  ```javascript
  ┌─────────────────────────────────────────┐
  │         ENVIRONMENT STRATEGY          │
  ├─────────────────────────────────────────┤
  │                                         │
  │  LOCAL      PR/PREVIEW    PRODUCTION   │
  │  ─────      ──────────    ──────────   │
  │                                         │
  │  Supabase   Supabase      Supabase     │
  │  (test)     (test)        (prod)       │
  │                                         │
  │  Unit ✓     Unit ✓                      │
  │  Integ ✓    Integ ✓       Smoke ✓      │
  │  E2E ✓      E2E ✓                       │
  │                                         │
  │  Mock AI    Mock AI       Real AI      │
  │                                         │
  └─────────────────────────────────────────┘
  ```

  **Key decisions:**

  - Separate Supabase project for testing

  - Mock AI in tests (deterministic, no cost)

  - Real AI only in production

  - E2E runs on Vercel preview URLs

  ---

## Vercel Preview Integration

  Vercel automatically creates preview URLs for each PR. Use this for E2E:

  ```yaml
  # In e2e-tests job
  env:
    TEST_URL: ${{ github.event.deployment_[status.target](http://status.target/)_url }}
  ```

  Or trigger on deployment:

  ```yaml
  on:
    deployment_status:
      states: [success]
  ```

[Implementation Checklist](checklist.md)
## Implementation Status

  ✅ **Testing Infrastructure Complete** - Merged December 29, 2025

  ---

## Implementation Order

  | Priority | Task | Est. Time | Status |
  |---|---|---|---|
  | 1 | Frontend: Vitest + RTL + MSW setup | 2 hrs | ✅ Complete |
  | 2 | Frontend: CustomerForm tests | 2 hrs | ✅ Complete (5 tests) |
  | 3 | Frontend: customerAccess utility tests | 1 hr | ✅ Complete (11 tests) |
  | 4 | Backend: pytest + fixtures setup | 2 hrs | ✅ Complete |
  | 5 | Backend: Import API tests | 2 hrs | ✅ Complete (14+ tests) |
  | 6 | Backend: RLS policy tests | 2 hrs | ⬜ Deferred to Phase 1 |
  | 7 | GitHub Actions: CI workflow | 1 hr | ✅ Complete |
  | 8 | Playwright: Setup + auth fixture | 1 hr | ⬜ Deferred to Phase 1 |
  | 9 | E2E: Customer CRUD test | 1 hr | ⬜ Deferred to Phase 1 |
  | 10 | E2E: Quote-to-Job flow test | 2 hrs | ⬜ Deferred to Phase 1 |

  ---

## Current Test Counts

  | Suite | Tests | Status |
  |---|---|---|
  | Frontend (Vitest) | 20 | ✅ All passing |
  | Backend (pytest) | 19+ | ✅ All passing |
  | E2E (Playwright) | 0 | ⬜ Not started |

  ---

## Setup Checklist

### Frontend ✅

  - [x] Install Vitest, RTL, MSW dependencies

  - [x] Create vitest.config.ts

  - [x] Create **tests**/setup.ts

  - [x] Create **tests**/test-utils.tsx

  - [x] Create **tests**/mocks/handlers.ts

  - [x] Create **tests**/mocks/server.ts

  - [x] Add test scripts to package.json

  - [x] Run first test successfully

  - [x] CustomerForm tests passing

  - [x] customerAccess utility tests passing

### Backend ✅

  - [x] Create api/requirements-test.txt

  - [x] Create api/pytest.ini

  - [x] Create api/tests/[conftest.py](http://conftest.py/)

  - [x] Create test factories

  - [x] Run first test successfully

  - [x] Import API integration tests passing

  - [ ] Set up test Supabase project (using prod for now)

### E2E ⬜ (Deferred)

  - [ ] Install Playwright

  - [ ] Create playwright.config.ts

  - [ ] Create e2e/fixtures/auth.ts

  - [ ] Create test CSV fixtures

  - [ ] Run first E2E test successfully

### CI/CD ✅

  - [x] Create .github/workflows/test.yml

  - [x] Frontend tests run on PR

  - [x] Backend tests run on PR

  - [ ] Add secrets to GitHub repo (if needed)

  - [ ] Set up Codecov (optional)

  ---

## Coverage Targets

  | Module | Target | Current |
  |---|---|---|
  | Customers | 80% | ~70% ✅ |
  | Parts | 80% | 0% |
  | Quotes | 80% | 0% |
  | Jobs | 80% | 0% |
  | Import (AI) | 70% | ~60% ✅ |
  | RLS Policies | 100% | 0% |

  ---

## Test Naming Conventions

  **Frontend:**

  ```javascript
  __tests__/components/{module}/{Component}.test.tsx
  __tests__/hooks/use{Hook}.test.ts
  __tests__/utils/{util}.test.ts
  ```

  **Backend:**

  ```javascript
  api/tests/unit/test_{module}.py
  api/tests/integration/test_{module}_[api.py](http://api.py/)
  ```

  **E2E:**

  ```javascript
  e2e/{feature}.spec.ts
  ```

  ---

## Quick Reference Commands

  ```bash
  # Frontend
  pnpm test              # Run all tests
  pnpm test:ui           # Visual test runner
  pnpm test:coverage     # With coverage report
  pnpm test CustomerForm # Run specific test
  
  # Backend
  cd api
  pytest                 # Run all tests
  pytest -m unit         # Only unit tests
  pytest -m integration  # Only integration
  pytest --cov           # With coverage
  pytest -k customer     # Run matching tests
  
  # E2E (when set up)
  pnpm test:e2e          # Run all E2E
  pnpm test:e2e:ui       # Visual runner
  ```

  ---

## Next Steps

  1. **Add tests as modules are built** - Parts, Quotes, Jobs should follow the Customers testing pattern

  2. **RLS policy tests** - Add before going to production with real multi-tenant data

  3. **E2E tests** - Add for critical flows (quote-to-job) before MVP launch

  ---

## When to Write Tests

  **Always write tests for:**

  - New API endpoints

  - Form validation logic

  - Business logic (status transitions, calculations)

  - RLS policies

  - Critical user flows (quote-to-job)

  **Optional (lower priority):**

  - Pure presentation components

  - Third-party library wrappers

  - One-off admin scripts



[Test Registry](test-registry.md)
## Coverage Dashboard

  Current test coverage metrics:

  | Metric | Target | Current |
  |---|---|---|
  | Statements | 45% | ~65% |
  | Branches | 45% | ~59% |
  | Functions | 45% | ~67% |
  | Lines | 45% | ~66% |

  ---

## Coverage Roadmap

  - Phase 1: 45% (achieved)

  - Phase 2: 50%

  - Phase 3: 55%

  - Phase 4: 60%

  ---

## Test Files Inventory

### Unit Tests - Utilities

  | Module | File | Tests | Coverage |
  |---|---|---|---|
  | quotesAccess | __tests__/utils/quotesAccess.test.ts | 58 | ~67% |
  | companyAccess | __tests__/utils/companyAccess.test.ts | 23 | 100% |
  | operationsAccess | __tests__/utils/operationsAccess.test.ts | 35 | ~70% |
  | csvParser | __tests__/utils/csvParser.test.ts | 24 | 100% |
  | storageHelpers | __tests__/utils/storageHelpers.test.ts | 28 | 100% |
  | customerAccess | __tests__/utils/customerAccess.test.ts | 12 | ~34% |
  | partsAccess | __tests__/utils/partsAccess.test.ts | 26 | ~68% |

### Component Tests

  | Component | File | Tests | Coverage |
  |---|---|---|---|
  | AuthGuard | __tests__/components/auth/AuthGuard.test.tsx | 11 | 93% |
  | CustomerForm | __tests__/components/customers/CustomerForm.test.tsx | 5 | ~58% |
  | PartForm | __tests__/components/parts/PartForm.test.tsx | 9 | ~52% |

### Backend Tests (pytest)

  | Module | File | Description |
  |---|---|---|
  | Customer Import | api/tests/integration/test_import_api.py | 3-phase import flow |
  | Parts Import | api/tests/integration/test_parts_import_api.py | Parts CSV import |
  | Smoke | api/tests/test_smoke.py | Basic sanity checks |

  ---

## Running Tests

### Frontend (Vitest)

  ```bash
  # Run all tests
  pnpm test
  
  # Run with UI dashboard
  pnpm test:ui
  
  # Run with coverage report
  pnpm test:coverage
  
  # Run specific test file
  pnpm test __tests__/utils/quotesAccess.test.ts
  ```

### Backend (pytest)

  ```bash
  cd api
  
  # Run all tests
  pytest
  
  # Run with verbose output
  pytest -v
  
  # Run specific test file
  pytest tests/integration/test_import_api.py
  
  # Run with coverage
  pytest --cov=.
  ```

  ---

## Known Gaps

### Not Yet Tested (Frontend)

  - utils/jobAttachmentsAccess.ts

  - components/quotes/QuoteForm.tsx

  - components/auth/Login.tsx

  - components/auth/SignUp.tsx

  - components/auth/CompanySelector.tsx

  - components/operations/OperationForm.tsx

  - Import components (MappingReviewTable, ConflictDialog, etc.)

### Not Yet Tested (Backend)

  - api/routes/operations_import_routes.py

  - AI provider unit tests

  - Import framework service unit tests

### E2E Tests (Not Implemented)

  - Authentication flow

  - Quote lifecycle

  - Import workflows

[Database: Test Case Matrix](test-matrix.md)

---

## Related local docs

- [Test Registry](test-registry.md) - Coverage metrics, test file inventory, commands reference
- [Test Case Matrix](test-matrix.md) - Filterable list of test cases with pass/fail criteria
