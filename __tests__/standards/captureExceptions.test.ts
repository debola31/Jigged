import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * **PostHog must not capture exceptions — and the intent has to be WRITTEN, not just described.**
 *
 * Sentry owns errors; PostHog owns behaviour (docs/telemetry.md § "Overlap 1"). When
 * `capture_exceptions` is left unset in `posthog.init`, the SDK follows the project's server-side
 * exception-autocapture setting instead of that rule. The option lived only inside a comment until
 * 2026-09-08, so the posthog-js 1.427.2 upgrade silently turned on a second error-capture path and
 * filed a stackless cross-origin `Script error.` — the exact class of noise the team filters
 * elsewhere.
 *
 * This guard exists so the rule stops living in prose. It strips comments before matching, so
 * deleting the option and keeping the explanatory comment fails here rather than shipping green.
 */
const INSTRUMENTATION_CLIENT = path.resolve(__dirname, '../../instrumentation-client.ts');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
}

describe('PostHog does not capture exceptions', () => {
  it('instrumentation-client.ts writes capture_exceptions: false in the init', () => {
    const code = stripComments(fs.readFileSync(INSTRUMENTATION_CLIENT, 'utf8'));
    expect(code).toMatch(/capture_exceptions\s*:\s*false/);
    expect(code).not.toMatch(/capture_exceptions\s*:\s*true/);
  });
});
