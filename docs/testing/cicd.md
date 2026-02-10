# CI/CD Integration

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
