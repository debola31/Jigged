# Frontend Testing Setup

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
