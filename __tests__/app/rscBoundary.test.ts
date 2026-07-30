import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guards the React Server Component boundary against a specific, silent break:
 * passing a *component reference* (a function) as a prop from a Server Component to a
 * Client Component.
 *
 * MUI components are all Client Components, so `<Button component={Link}>` inside a file
 * without `'use client'` throws at render time:
 *
 *   Functions cannot be passed directly to Client Components unless you explicitly
 *   expose it by marking it with "use server".
 *
 * TypeScript cannot see this — the prop types are perfectly valid — and it only fails on
 * the server, at request time, on whichever branch happens to render it. It shipped to
 * production on the marketing invite page's "Invalid Invite Link" branch, where it broke
 * the very error page meant to handle a bad link (Sentry JAVASCRIPT-NEXTJS-1K). One event
 * in ~2 months, because only invalid tokens reach that branch.
 *
 * The fix is either `href="/"` alone (MUI renders an <a> when href is set) or moving the
 * markup into a Client Component. 17 of the 18 call sites in this repo were already in
 * `'use client'` files and are entirely fine — this test exists so the 18th kind can't
 * come back unnoticed.
 */
const ROOTS = ['app', 'components'].map((d) => path.resolve(__dirname, '../..', d));

/** A `component={Foo}` prop — capitalised identifier, i.e. a component reference.
 *  `component="h1"` (a string tag) is serialisable and therefore fine. */
const COMPONENT_PROP = /component=\{\s*([A-Z][A-Za-z0-9_]*)/g;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
      return walk(full);
    }
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

/** `'use client'` must be the first statement, so only the file head matters. */
function isClientComponent(source: string): boolean {
  return /^\s*(['"])use client\1/m.test(source.slice(0, 200));
}

/**
 * Blank out comment bodies so prose describing the bad pattern isn't mistaken for the
 * bad pattern — the fix for this very rule documents `component={Link}` in a comment,
 * which the first version of this test dutifully flagged.
 *
 * Replaces comment characters with spaces rather than deleting them, so byte offsets and
 * therefore reported line numbers stay accurate.
 */
function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

describe('RSC boundary: no component references passed from Server Components', () => {
  // Walked once and reused — this crawls every .tsx under app/ and components/, so doing
  // it per-assertion would add real I/O to an already parallel suite.
  const files = ROOTS.flatMap(walk);
  const offenders: string[] = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    if (isClientComponent(raw)) continue;
    const source = blankComments(raw);

    for (const match of source.matchAll(COMPONENT_PROP)) {
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${path.relative(path.resolve(__dirname, '../..'), file)}:${line} — component={${match[1]}}`);
    }
  }

  it('finds no Server Component passing a component reference to a Client Component', () => {
    expect(offenders).toEqual([]);
  });

  it('actually scans a meaningful number of files (guards against a broken walk)', () => {
    // A silently-empty scan would make the assertion above pass forever. The repo has
    // hundreds of .tsx files; if this ever drops to near zero the walk or the roots are
    // wrong, not the codebase.
    expect(files.length).toBeGreaterThan(100);
  });
});
