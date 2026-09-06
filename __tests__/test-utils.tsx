import React, { ReactElement, ReactNode } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import jiggedTheme from '@/lib/theme';

// Mock Next.js navigation
const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockBack = vi.fn();
const mockForward = vi.fn();
const mockRefresh = vi.fn();
const mockPrefetch = vi.fn();

// These hooks must return STABLE references, because Next.js's real ones do. Handing
// back a fresh object per call makes any effect with `router`/`params`/`searchParams` in
// its dependency array re-run on every single render — so components appear to thrash in
// tests while behaving fine in production, and genuine dependency bugs get masked by the
// noise. Built lazily (`??=`) so the vi.fn() references are read at call time rather than
// when this hoisted factory runs.
let routerStub: Record<string, unknown> | undefined;
let paramsStub: Record<string, string> | undefined;
let searchParamsStub: URLSearchParams | undefined;

vi.mock('next/navigation', () => ({
  useRouter: () =>
    (routerStub ??= {
      push: mockPush,
      replace: mockReplace,
      back: mockBack,
      forward: mockForward,
      refresh: mockRefresh,
      prefetch: mockPrefetch,
    }),
  useParams: () => (paramsStub ??= { companyId: 'test-company-id' }),
  usePathname: () => '/dashboard/test-company-id',
  useSearchParams: () => (searchParamsStub ??= new URLSearchParams()),
}));

// All providers wrapper
interface AllProvidersProps {
  children: ReactNode;
}

function AllProviders({ children }: AllProvidersProps) {
  return (
    <ThemeProvider theme={jiggedTheme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}

// Custom render function
const customRender = (
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) => render(ui, { wrapper: AllProviders, ...options });

// Re-export everything from testing-library
export * from '@testing-library/react';

// Export custom render as default render
export { customRender as render };

// Export router mocks for assertions
export const routerMocks = {
  push: mockPush,
  replace: mockReplace,
  back: mockBack,
  forward: mockForward,
  refresh: mockRefresh,
  prefetch: mockPrefetch,
};

/**
 * Set what `useSearchParams()` returns for the current test file.
 *
 * Needed by any component that reads a redirect result off the URL — the
 * QuickBooks card renders a different message per `?qb=` value, and without this
 * those branches are unreachable from a test. Additive on purpose: the stub is
 * still lazily created empty, so every test that does not call this behaves
 * exactly as before. Call `setSearchParams()` with no argument to clear.
 */
export const setSearchParams = (init?: string | Record<string, string>) => {
  searchParamsStub = new URLSearchParams(init);
};

// Helper to reset router mocks between tests
export const resetRouterMocks = () => {
  mockPush.mockClear();
  mockReplace.mockClear();
  mockBack.mockClear();
  mockForward.mockClear();
  mockRefresh.mockClear();
  mockPrefetch.mockClear();
};
