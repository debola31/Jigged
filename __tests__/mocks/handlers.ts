import type { RequestHandler } from 'msw';

/**
 * Default MSW handlers, applied to every test via `__tests__/setup.ts`.
 *
 * Deliberately empty. The only handlers that ever lived here mocked
 * `/api/customers/import/{analyze,validate,execute}` for the per-entity customers import
 * wizard, which was retired along with the other per-entity importers — and no test rendered
 * that page even before then, so they were mocking a route nothing called.
 *
 * The harness stays because `setup.ts` runs `server.listen({ onUnhandledRequest: 'warn' })`,
 * which is the useful part on its own: an unexpected network call from a component under test
 * is surfaced rather than silently attempted. Add a handler here only for a request every test
 * should see stubbed; anything test-specific belongs in that test via `server.use()`.
 */
export const handlers: RequestHandler[] = [];
