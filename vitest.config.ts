import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./__tests__/setup.ts'],
    include: ['__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
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
        // Floors set 3-5pp below measured-current on 2026-05-27 so natural
        // fluctuation doesn't break builds, but adding untested code does.
        // 3f sub-PRs ratchet these upward — bump in the same PR that adds
        // the tests, never as a separate "increase threshold" PR.
        //
        // Measured 2026-05-27: statements 47.4%, branches 42.3%,
        // functions 43.4%, lines 48.6%.
        statements: 45,
        branches: 38,
        functions: 40,
        lines: 45,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
