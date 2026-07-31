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
     * Cap concurrency below the machine's core count.
     *
     * Vitest defaults to `availableParallelism() - 1` forks, so a 10-core laptop runs 9 jsdom
     * workers, each with its own React renderer. The timeouts above are contention artefacts, so
     * this attacks the cause rather than only widening the deadline.
     *
     * **Measured, on this 10-core machine.** Wall-clock is unchanged — ~30s either way — but the
     * aggregate in-worker test time drops from **105–127s to 74–80s**. That figure is summed
     * across workers, so the fall is contention leaving the system: the same work, less of it
     * spent waiting on a core. Fewer workers costing no wall-clock is counter-intuitive enough to
     * be worth recording.
     *
     * CI runners have fewer cores than this, so 6 is usually above their default and therefore a
     * no-op there rather than a throttle.
     *
     * Note this is the **vitest 4** spelling, and getting it wrong fails quietly. The first
     * attempt used the v3 API, `poolOptions: { forks: { maxForks: 6 } }`, which no longer exists
     * on `InlineConfig`. Vitest **silently ignores an unknown key** — the suite ran green and the
     * setting did nothing, so the "before and after" timings I took were the same run twice.
     * Only `tsc` caught it. If you change concurrency here, confirm the aggregate test time
     * actually moves; a green suite proves nothing about whether the option took effect.
     *
     * Honest limitation: three clean runs after this change is not proof it fixed anything —
     * two runs *before* it were clean too, because the flake is intermittent. What is solid is
     * the captured error (`Test timed out in 5000ms`), which the timeout above definitively
     * addresses; this cap is belt-and-braces at no measured cost.
     */
    maxWorkers: 6,
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
