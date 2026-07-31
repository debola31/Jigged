import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./__tests__/setup.ts'],
    include: ['__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
    /**
     * 15s, not vitest's 5s default.
     *
     * The suite was intermittently red with `Error: Test timed out in 5000ms.` on a rotating
     * cast of tests — `VisualLocationBuilder`, `PartLocationActionModal`, `SignUp`,
     * `ChangePassword`, `QuoteForm`, `PartTransactionJobTag` — every one of which passed on its
     * own and every one of which is a multi-step `userEvent` flow. `userEvent` awaits React
     * settling between each interaction, so a dozen sequential interactions cost real wall-clock,
     * and under fork contention they crossed 5s.
     *
     * This does not hide hangs: a genuinely stuck test still fails, 10s later. What it stops is a
     * suite that goes red for reasons unrelated to the code — which is worse than slow, because a
     * red run you re-run out of habit is a red run you have stopped reading.
     *
     * Prefer a per-test timeout argument over raising this further; a test that needs more than
     * 15s is telling you something about the test.
     */
    testTimeout: 15_000,
    /**
     * ⚠️ DO NOT set `maxWorkers` here. It was added in #630 and reverted the same day, because
     * it turned main red on the first merge after eleven consecutive green runs.
     *
     * **`maxWorkers` is not a ceiling that defers to a smaller default — it is the number used.**
     * The reverted comment claimed 6 would be "above their default and therefore a no-op" on CI.
     * That is backwards. GitHub's hosted runners are small, so vitest's default
     * (`availableParallelism() - 1`) is 1–3 workers there; forcing 6 over-subscribed the runner
     * several times over and produced exactly the contention the setting was meant to remove.
     * `VisualLocationBuilder` then failed with `Unable to find role="button" and name
     * /create 16 locations/i`.
     *
     * **Correction:** that failure was recorded here as *"a state race, not a timeout."* It is a
     * timeout — just not this one. `findBy*` and `waitFor` are governed by Testing Library's
     * `asyncUtilTimeout` (1000ms by default), not by `testTimeout`, and when it expires the error
     * is a missing-element message that never mentions time. Setting `asyncUtilTimeout: 1`
     * reproduces that exact message from this exact test. `__tests__/setup.ts` now raises it to
     * 5s, which is the half of the contention fix this file could not reach. The `maxWorkers`
     * warning stands regardless — over-subscribing a small runner was real, and the mis-diagnosis
     * is why it looked like a component bug rather than the contention it caused.
     *
     * If local contention is ever worth capping again, it must be a genuine cap that cannot
     * inflate a small machine — `Math.min(6, availableParallelism() - 1)` — and it must be
     * proven on CI, not on a 10-core laptop. Two claims about CI behaviour were asserted without
     * checking during that change; the third attempt should measure instead.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        '__tests__/**',
        '**/*.d.ts',
        '**/*.config.{js,ts}',
        '**/types/**',
      ],
      thresholds: {
        // Ratchet: each 3f sub-PR that adds tests bumps these floors so the
        // gain is locked in. Never lowered without a documented reason.
        //
        // 2026-05-27 (3e baseline):  statements 47.4 / branches 42.3 /
        //                            functions 43.4 / lines 48.6
        // 2026-05-28 (3f auth):      statements 50.0 / branches 44.85 /
        //                            functions 45.95 / lines 51.36
        // 2026-05-28 (3f QuoteForm):   statements 50.37 / branches 45.65 /
        //                              functions 44.77 / lines 51.78
        // 2026-05-28 (3f StationQRCode): statements 50.83 / branches 45.89 /
        //                                functions 45.07 / lines 52.26
        // 2026-05-28 (3f import-ui + access files):
        //   statements 50.99 / branches 46.09 / functions 48.91 / lines 52.37
        statements: 50,
        branches: 45,
        functions: 47,
        lines: 51,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
