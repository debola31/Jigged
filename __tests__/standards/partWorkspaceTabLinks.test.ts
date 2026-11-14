import { describe, it, expect } from 'vitest';
import path from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';
import { blankComments } from '../../scripts/analyticsEventsCheck';
import { PART_WORKSPACE_TABS } from '@/lib/partWorkspaceTabs';

/**
 * A LINK INTO THE PART WORKSPACE NAMES A TAB THE WORKSPACE HAS.
 *
 * An unknown `?tab=` does not 404 — the workspace falls back to its first tab — so a link to a
 * removed tab keeps working, onto the wrong page, and nothing fails. When the Storage tab went on
 * 2026-09-09, `/activity`'s stock rows and the count worksheet's "Back to part" both went on naming
 * its slug for two months, landing on Workspace instead of anything about stock.
 *
 * The slugs come from PART_WORKSPACE_TABS, the list the workspace itself renders, never a copy.
 * Only literal slugs are checkable: a `?tab=${x}` built at runtime is left to review.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['app', 'components', 'utils', 'lib'];

/** `/parts/<id>?tab=<slug>`, or `tab` later in the query. Group 1 is the slug. */
const PART_TAB_LINK = /\/parts\/[^\s'"`?]*\?(?:[^\s'"`#]*&)?tab=([A-Za-z0-9_-]+)/g;

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFilesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function tabLinksIn(source: string): Array<{ line: number; slug: string }> {
  // CODE ONLY: a comment recording what a link USED to say is history, not a link.
  const code = blankComments(source);
  return [...code.matchAll(PART_TAB_LINK)].map((m) => ({
    line: code.slice(0, m.index).split('\n').length,
    slug: m[1],
  }));
}

const LINKS = SCAN_DIRS.flatMap((dir) => sourceFilesUnder(path.join(REPO_ROOT, dir))).flatMap(
  (file) =>
    tabLinksIn(readFileSync(file, 'utf8')).map((link) => ({
      file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
      ...link,
    })),
);

const REAL_SLUGS: ReadonlySet<string> = new Set(PART_WORKSPACE_TABS.map((t) => t.slug));

describe('links into the part workspace name a real tab', () => {
  it('every literal ?tab= on a /parts/ link is one of the workspace tabs', () => {
    const offenders = LINKS.filter((l) => !REAL_SLUGS.has(l.slug));

    expect(
      offenders.map((l) => `${l.file}:${l.line} ?tab=${l.slug}`),
      `The part workspace has no such tab, so these links land on its first tab instead.\n` +
        `Real slugs: ${[...REAL_SLUGS].join(', ')} (lib/partWorkspaceTabs.ts).`,
    ).toEqual([]);
  });

  /** Guards the guard: a pattern that matched nothing would make the test above vacuous. */
  it('finds the links it was written for', () => {
    expect(LINKS).toContainEqual(
      expect.objectContaining({ file: 'utils/dashboardAccess.ts', slug: 'history' }),
    );
  });

  it('reads a slug out of a template-literal link, and only out of code', () => {
    const source = [
      "// used to be `/parts/${id}?tab=gone` — a comment is not a link",
      'const a = `/dashboard/${companyId}/parts/${r.part_id}?tab=inventory`;',
      "const b = `/parts/${id}?from=parts&tab=usage`;",
      "const c = `/parts/${id}?tab=${slug}`;",
    ].join('\n');

    expect(tabLinksIn(source)).toEqual([
      { line: 2, slug: 'inventory' },
      { line: 3, slug: 'usage' },
    ]);
  });
});
