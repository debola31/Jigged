/**
 * Stryker mutation-testing config for the Vitest Node-mode unit suite.
 *
 * Mutation testing answers: "if the production code did X wrong, would a
 * test fail?" Coverage tells you what's executed; this tells you what's
 * actually asserted. The first runtime validation target is the
 * quote-edit reconcile block in utils/quotesAccess.ts — see issue #320
 * (the parent #320 tracks tooling; #323 records the baseline score).
 *
 * Playwright specs (e2e/**) are intentionally excluded — mutation testing
 * is a unit/integration concept; running it across the E2E layer would
 * blow up the runtime without surfacing useful signal.
 *
 * Vitest is in Node mode (environment: 'jsdom'), which is the supported
 * Stryker pairing. Only `vitest --browser` would be incompatible.
 *
 * Usage:
 *   pnpm exec stryker run                   # full run (slow)
 *   pnpm exec stryker run --mutate utils/quotesAccess.ts   # one file
 *   open reports/mutation/index.html        # view HTML report
 */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  // Explicit plugin load — pnpm's symlinked node_modules trips Stryker's
  // glob-based auto-discovery, so we name the runner directly.
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: {
    configFile: 'vitest.config.ts',
  },

  // What to mutate. Start with the access + lib layer where the
  // business logic lives. Expand as coverage grows.
  mutate: [
    'utils/**/*.ts',
    'lib/**/*.ts',
    '!**/*.test.ts',
    '!**/*.spec.ts',
    '!**/*.d.ts',
  ],

  // Anything in here is never read, mutated, or run.
  // `public/**` is excluded because Stryker's HTML preprocessor chokes on
  // legal/marketing HTML that isn't meant for type-check disable rewriting.
  ignorePatterns: [
    'e2e/**',
    'api/**',
    'supabase/**',
    'scripts/**',
    'reports/**',
    '.next/**',
    '.stryker-tmp/**',
    'node_modules/**',
    'types/**',
    'dist/**',
    'coverage/**',
    'public/**',
  ],

  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },

  // Thresholds gate runs but don't block PRs until the baseline lands
  // (issue #323). Once the baseline is set, treat these as a ratchet.
  thresholds: {
    high: 80,
    low: 60,
    break: 0,
  },

  // perTest analysis is slower to start but lets Stryker run only the
  // tests that touched a mutated line — much faster per mutant.
  coverageAnalysis: 'perTest',

  // Per-mutant timeout. A failing test usually finishes in <2s; bumping
  // to 60s handles slow integration cases without false survivors.
  timeoutMS: 60000,

  // Parallelism. 4 is a safe default on most laptops; bump locally if
  // the run is slow and CPU/RAM allow.
  concurrency: 4,
};
