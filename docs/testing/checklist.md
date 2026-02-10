# Implementation Priority & Checklist

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
