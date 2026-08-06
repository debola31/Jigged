/**
 * rpcCaptureCheck — every `.rpc()` in the access layer must report its own failures.
 *
 * WHY THIS RULE IS SMALL, AND WHY THAT IS THE POINT. Issue #708 proposed a repo-wide standard
 * ("every access-layer write captures before it throws") backed by a scanner. Applied literally
 * that is ~174 call sites. Instead the Supabase integration reports every `.from()` read and
 * write as configuration — nothing per-call-site, so nothing to enforce and nothing to decay.
 *
 * What it cannot see is `.rpc()`, which is deliberately excluded from the net because only the
 * call site can tell a `P0001` raised FOR the user ("Insufficient stock…") from a `P0001` that
 * is a bug. That judgement is the one thing a human must still write down, so it is the one
 * thing worth guarding — roughly 30 sites rather than 174, which is a rule that can actually be
 * held to.
 *
 * Storage is checked for the same reason: `supabase.storage` is not instrumented either.
 *
 * Mirrors scripts/interactionStandardsCheck.ts and scripts/docLinkCheck.ts: a pure scan
 * function the test drives, plus a main() for `pnpm exec tsx`.
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

export interface RpcCaptureViolation {
  file: string;
  line: number;
  /** The enclosing exported function, or '<module>' if it could not be determined. */
  fn: string;
  message: string;
}

/**
 * Deliberate exceptions, keyed `relativePath::functionName`.
 *
 * Each entry needs a reason. An allowlist is the cheap way to green this check, so an entry
 * without a stated reason should not survive review — that is exactly how an enforced rule
 * becomes a decorative one.
 */
export const ALLOWLIST = new Map<string, string>([
  // Empty, and worth keeping that way. Every `.rpc()` and storage call in the access layer
  // currently reports. If you are about to add an entry, check first whether
  // `expectedCodes` says what you actually mean — "this RPC raises for the user" is a
  // property of some failures, not of the call site.
]);

/** `.rpc(` or a `supabase.storage` operation — the two things the net does not instrument. */
const UNCOVERED_CALL = /\.rpc\(|\.storage\s*$|\.storage\./;

/** Reporting helper, or an explicit Sentry capture, either counts. */
const REPORTS = /reportWriteFailure\(|Sentry\.captureException\(/;

/**
 * Split a source file into top-level function bodies by brace depth.
 *
 * Deliberately simple, and it does not need to be a parser: access modules are flat lists of
 * exported `async function`s. A nested arrow inside one is still attributed to its enclosing
 * top-level function, which is the granularity the rule cares about.
 */
interface FunctionBody {
  name: string;
  startLine: number;
  endLine: number;
  text: string;
}

export function splitTopLevelFunctions(source: string): FunctionBody[] {
  const lines = source.split('\n');
  const out: FunctionBody[] = [];
  const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/;

  let current: { name: string; startLine: number; depth: number; buf: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!current) {
      const m = declaration.exec(line);
      if (m) current = { name: m[1], startLine: i + 1, depth: 0, buf: [] };
    }
    if (!current) continue;

    current.buf.push(line);
    for (const ch of line) {
      if (ch === '{') current.depth++;
      else if (ch === '}') current.depth--;
    }
    // depth returns to 0 only once the body has opened and closed.
    if (current.depth === 0 && current.buf.some((l) => l.includes('{'))) {
      out.push({
        name: current.name,
        startLine: current.startLine,
        endLine: i + 1,
        text: current.buf.join('\n'),
      });
      current = null;
    }
  }
  return out;
}

export function findRpcCaptureViolations(source: string, relPath: string): RpcCaptureViolation[] {
  const out: RpcCaptureViolation[] = [];

  for (const fn of splitTopLevelFunctions(source)) {
    // Strip comments so a `.rpc()` mentioned in prose doesn't trip the rule.
    const code = fn.text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');

    if (!UNCOVERED_CALL.test(code)) continue;
    if (REPORTS.test(code)) continue;
    if (ALLOWLIST.has(`${relPath}::${fn.name}`)) continue;

    out.push({
      file: relPath,
      line: fn.startLine,
      fn: fn.name,
      message:
        `${fn.name} calls .rpc() or storage but never reports a failure. The Supabase ` +
        `integration does not cover either — call reportWriteFailure (lib/sentryEventPolicy.ts) ` +
        `in the error branch, passing expectedCodes for any raise meant for the user. If it ` +
        `genuinely should not report, add it to ALLOWLIST in scripts/rpcCaptureCheck.ts with a reason.`,
    });
  }
  return out;
}

/** Every `utils/*Access.ts`, plus the hooks that call RPCs directly. */
export function filesToScan(repoRoot: string): string[] {
  const utils = path.join(repoRoot, 'utils');
  const found = readdirSync(utils)
    .filter((f) => f.endsWith('Access.ts'))
    .map((f) => path.join('utils', f));
  found.push('utils/storageHelpers.ts');
  return found;
}

export function scanRepo(repoRoot: string): RpcCaptureViolation[] {
  const out: RpcCaptureViolation[] = [];
  for (const rel of filesToScan(repoRoot)) {
    const source = readFileSync(path.join(repoRoot, rel), 'utf8');
    out.push(...findRpcCaptureViolations(source, rel));
  }
  return out;
}

function main(): void {
  const violations = scanRepo(process.cwd());
  if (violations.length === 0) {
    console.log('rpcCaptureCheck: no unreported .rpc()/storage calls.');
    return;
  }
  for (const v of violations) {
    console.error(`${v.file}:${v.line}  ${v.message}`);
  }
  console.error(`\n${violations.length} unreported call site(s).`);
  process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('rpcCaptureCheck.ts')) main();
