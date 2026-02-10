# E2E Tests (Playwright)

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
