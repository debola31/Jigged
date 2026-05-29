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
