#!/usr/bin/env node
/**
 * E2E stack orchestrator: starts the Anthropic mock + FastAPI + Next.js,
 * waits for all three to be ready, runs Playwright, then tears them down.
 *
 * Replaces start-server-and-test because its 2.x CLI only supports up to
 * two parallel services. We have three (mock on 9876, FastAPI on 8000,
 * Next.js on 3000), so a small purpose-built runner is simpler than
 * compounding wrappers.
 *
 * Lifecycle:
 *   - Spawn each service with stdio inherited so logs stream live.
 *   - Poll each readiness URL until 2xx/3xx, with a per-service timeout.
 *   - Spawn `playwright test` (forwarding any CLI args after the script
 *     name, so `pnpm test:e2e:local --grep smoke` works).
 *   - Exit with Playwright's exit code; kill all background services on
 *     the way out.
 *
 * Run via the `test:e2e:local` npm script (or directly with `node`).
 */

import { spawn } from 'node:child_process';
import http from 'node:http';

const services = [
  {
    name: 'anthropic-mock',
    cmd: 'node',
    args: ['e2e/mocks/anthropic-server.mjs'],
    readyUrl: 'http://localhost:9876/health',
    timeoutMs: 10_000,
  },
  {
    name: 'fastapi',
    cmd: 'python',
    args: ['index.py'],
    cwd: 'api',
    readyUrl: 'http://localhost:8000/docs',
    timeoutMs: 30_000,
    // Hermetic QuickBooks: no Intuit call. create_invoice returns a deterministic
    // fake so the invoicing spec can exercise the full push against the real DB.
    // (Guarded off in production by QUICKBOOKS_ENVIRONMENT != 'production'.)
    env: { QUICKBOOKS_FAKE: '1', QUICKBOOKS_ENVIRONMENT: 'sandbox' },
  },
  {
    name: 'next',
    cmd: 'pnpm',
    args: ['next', 'dev'],
    readyUrl: 'http://localhost:3000',
    timeoutMs: 120_000,
    // Point the browser app at the local FastAPI (QuickBooks push goes through it).
    // Respect an existing value (dev .env.local); default to the stack's backend.
    env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000' },
  },
];

const procs = [];
let exiting = false;

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const p of procs) {
    if (!p.killed) p.kill('SIGTERM');
  }
  // Give them a beat to exit cleanly, then hard-exit.
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

function waitFor(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(url, (res) => {
        // Any non-5xx counts as "up" — Next.js dev returns 200/307 at /,
        // FastAPI returns 200 at /docs, the mock returns 200 at /health.
        if (res.statusCode && res.statusCode < 500) {
          res.resume();
          return resolve();
        }
        res.resume();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`${url} not ready after ${timeoutMs}ms`));
      }
      setTimeout(ping, 500);
    };
    ping();
  });
}

async function main() {
  for (const svc of services) {
    const child = spawn(svc.cmd, svc.args, {
      cwd: svc.cwd,
      stdio: 'inherit',
      env: { ...process.env, ...(svc.env || {}) },
    });
    child.on('exit', (code, signal) => {
      // If a backing service dies before Playwright runs, abort early —
      // otherwise Playwright will time out on every spec.
      if (!exiting) {
        console.error(
          `[run-stack] ${svc.name} exited (code=${code} signal=${signal}) before tests started`,
        );
        shutdown(1);
      }
    });
    procs.push(child);
  }

  try {
    console.log('[run-stack] waiting for services to be ready…');
    await Promise.all(
      services.map((s) =>
        waitFor(s.readyUrl, s.timeoutMs).then(() => console.log(`[run-stack] ${s.name} ready`)),
      ),
    );
  } catch (err) {
    console.error('[run-stack]', err.message);
    return shutdown(1);
  }

  console.log('[run-stack] running playwright…');
  const playwrightArgs = process.argv.slice(2);
  const test = spawn('pnpm', ['exec', 'playwright', 'test', ...playwrightArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  test.on('exit', (code) => shutdown(code ?? 1));
}

main().catch((err) => {
  console.error('[run-stack] fatal:', err);
  shutdown(1);
});
