# Test Registry

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
