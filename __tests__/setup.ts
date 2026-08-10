import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';
import { server } from './mocks/server';

/**
 * 5s, not Testing Library's 1s default — the second half of the fix that `vitest.config.ts`'s
 * `testTimeout: 15_000` started.
 *
 * **`testTimeout` does not govern `findBy*` / `waitFor`.** Those use Testing Library's own
 * `asyncUtilTimeout`, which defaults to 1000ms
 * (`@testing-library/dom/dist/config.js`), and when it expires the error is
 * `Unable to find role="button" and name /…/` — it never says "timed out". So the same fork
 * contention that used to blow through vitest's 5s test timeout can still blow through this 1s
 * window, and it reports as a missing element instead of a slow one.
 *
 * That mis-reads as a component bug, and it did: #631 recorded the CI failure
 * `Unable to find role="button" and name /create 16 locations/i` as *"a state race, not a
 * timeout"*. It is a timeout. Setting `asyncUtilTimeout: 1` reproduces that exact message,
 * character for character, from `VisualLocationBuilder` — which otherwise passes on its own every
 * time. Comment corrected in `vitest.config.ts` alongside this.
 *
 * Raising it costs nothing on a passing run: `findBy*` resolves as soon as the element appears and
 * only the failing path waits longer. A genuinely absent element still fails, 4s later.
 */
configure({ asyncUtilTimeout: 5_000 });

// Start MSW server before all tests
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'warn' });
});

// Reset handlers after each test
afterEach(() => {
  server.resetHandlers();
});

// Close server after all tests
afterAll(() => {
  server.close();
});

/**
 * jsdom has no layout engine, so it implements no scrolling at all — `Element.scrollIntoView` is
 * simply absent and any component that calls it throws in tests while working perfectly in a
 * browser. A no-op is the honest stand-in: the call is a *side effect on the viewport*, and a
 * test that has no viewport has nothing to assert about it either way.
 *
 * Same family as `window.matchMedia`, which jsdom also omits — which is why responsive branches
 * here are written as CSS breakpoints rather than `useMediaQuery`, so they stay exercisable.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
