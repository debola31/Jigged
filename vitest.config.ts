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
        // Ratchet: each 3f sub-PR that adds tests bumps these floors so the
        // gain is locked in. Never lowered without a documented reason.
        //
        // 2026-05-27 (3e baseline):  statements 47.4 / branches 42.3 /
        //                            functions 43.4 / lines 48.6
        // 2026-05-28 (3f auth):      statements 50.0 / branches 44.85 /
        //                            functions 45.95 / lines 51.36
        // 2026-05-28 (3f QuoteForm): statements 50.37 / branches 45.65 /
        //                            functions 44.77 / lines 51.78
        // (functions dropped because QuoteForm added more uncovered
        // functions than the 11 new tests covered. Floor stays at 43.)
        statements: 49,
        branches: 44,
        functions: 43,
        lines: 50,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
