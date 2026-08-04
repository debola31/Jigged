import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  ALLOWLIST,
  slugify,
  headingSlugs,
  stripFencedBlocks,
  extractLinkCitations,
  extractCodePathCitations,
  resolveCitation,
  scanProject,
  unusedAllowlistEntries,
  type DocIssue,
} from '../../scripts/docLinkCheck';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('docLinkCheck — GitHub anchor slugs', () => {
  /**
   * THE CASE THIS CHECK EXISTS TO GET RIGHT. GitHub replaces each space with
   * one hyphen and does NOT collapse runs, so an em dash surrounded by spaces
   * is stripped and leaves a DOUBLE hyphen behind. A slugifier that collapses
   * whitespace produces a slug that looks correct and 404s — that bug cost real
   * time during #634, and this heading is a live anchor in CLAUDE.md.
   */
  it('leaves a double hyphen where a spaced em dash was', () => {
    expect(slugify('Who uses what, on what — the device model')).toBe(
      'who-uses-what-on-what--the-device-model',
    );
  });

  it('keeps underscores and hyphens, strips other punctuation', () => {
    expect(slugify('Data API grants (new tables in `public`)')).toBe(
      'data-api-grants-new-tables-in-public',
    );
    expect(slugify('§5.9 `job_materials` — RESOLVED: drop it')).toBe(
      '59-job_materials--resolved-drop-it',
    );
    expect(slugify('Delete = archive (soft-delete), never blocks')).toBe(
      'delete--archive-soft-delete-never-blocks',
    );
  });

  it('uses only the label of a link in the heading, never the URL', () => {
    expect(slugify('Known importer bug ([#549](https://example.com/549))')).toBe(
      'known-importer-bug-549',
    );
  });

  it('drops a trailing closing-hash sequence and surrounding space', () => {
    expect(slugify('  Scales  ')).toBe('scales');
  });
});

describe('docLinkCheck — heading extraction', () => {
  it('numbers duplicate headings the way GitHub does', () => {
    const slugs = headingSlugs('# Notes\n\n## Notes\n\n### Notes\n');
    expect([...slugs].sort()).toEqual(['notes', 'notes-1', 'notes-2']);
  });

  it('ignores `#` comment lines inside fenced code blocks', () => {
    // Every bash block in CLAUDE.md opens with one of these. Treating them as
    // headings would invent anchors that GitHub does not publish.
    const md = ['# Real heading', '', '```bash', '# Install dependencies', 'pnpm install', '```'].join(
      '\n',
    );
    expect([...headingSlugs(md)]).toEqual(['real-heading']);
  });

  it('blanks fenced blocks without shifting line numbers', () => {
    const md = ['a', '```', 'b', '```', 'c'].join('\n');
    expect(stripFencedBlocks(md).split('\n')).toEqual(['a', '', '', '', 'c']);
  });

  it('does not end a ~~~ fence on a shorter inner fence', () => {
    const md = ['~~~~', '```', '# not a heading', '```', '~~~~', '# heading'].join('\n');
    expect([...headingSlugs(md)]).toEqual(['heading']);
  });
});

describe('docLinkCheck — citation extraction', () => {
  it('takes relative link targets and skips external URLs', () => {
    const md =
      '[a](modules/parts.md) [b](https://example.com/x) [c](mailto:x@y.z) [d](../lib/theme.ts)';
    expect(extractLinkCitations(md, 'docs/README.md').map((c) => c.target)).toEqual([
      'modules/parts.md',
      '../lib/theme.ts',
    ]);
  });

  it('splits an #anchor off a link target', () => {
    const [c] = extractLinkCitations('[x](modules/jobs.md#material-cost)', 'docs/README.md');
    expect(c.target).toBe('modules/jobs.md');
    expect(c.anchor).toBe('material-cost');
  });

  /**
   * Real shape in docs/design-system.md. A `[^\]]*` label stops at the first
   * inner `]` and matches nothing, so links whose label is a Next.js route path
   * — the ones most likely to rot, since route folders get renamed — went
   * unchecked while the scan still looked clean.
   */
  it('reads a link whose label contains bracketed route segments', () => {
    const md = '[`app/operator/[companyId]/layout.tsx`](../app/operator/[companyId]/layout.tsx)';
    expect(extractLinkCitations(md, 'docs/design-system.md').map((c) => c.target)).toEqual([
      '../app/operator/[companyId]/layout.tsx',
    ]);
  });

  it('percent-decodes a link target', () => {
    // Next.js route segments get encoded by editors that auto-link paths.
    const [c] = extractLinkCitations(
      '[x](../../app/dashboard/%5BcompanyId%5D/import/page.tsx)',
      'docs/modules/data-import.md',
    );
    expect(c.target).toBe('../../app/dashboard/[companyId]/import/page.tsx');
  });

  it('keeps a bare #anchor link, to be checked against the doc itself', () => {
    const [c] = extractLinkCitations('[x](#status-model)', 'docs/modules/jobs.md');
    expect(c.target).toBe('');
    expect(c.anchor).toBe('status-model');
  });

  it('reads inline-code paths only for known repo prefixes', () => {
    const md = '`utils/jobsAccess.ts` and `deleted_at IS NULL` and `jobs/foo.ts`';
    expect(extractCodePathCitations(md, 'docs/x.md').map((c) => c.target)).toEqual([
      'utils/jobsAccess.ts',
    ]);
  });

  it('skips globs, brace expansions and placeholders', () => {
    const md = [
      '`utils/*Access.ts`',
      '`api/**/*.py`',
      '`__tests__/components/operator/{A,B}.test.tsx`',
      '`utils/<entity>Access.ts`',
    ].join(' ');
    expect(extractCodePathCitations(md, 'docs/x.md')).toHaveLength(0);
  });

  it('keeps Next.js [param] segments, which are real directory names', () => {
    const [c] = extractCodePathCitations('`app/dashboard/[companyId]/jobs/`', 'docs/x.md');
    expect(c.target).toBe('app/dashboard/[companyId]/jobs/');
  });

  it('strips a trailing test name, pytest node id, or symbol fragment', () => {
    const md = [
      '`__tests__/utils/customerAccess.test.ts > createCustomer > revives`',
      '`api/tests/integration/test_billing_enforcement.py::test_no_tenant_table_left_ungated`',
      '`utils/jobsAccess.ts#deleteJob`',
    ].join('\n');
    expect(extractCodePathCitations(md, 'docs/x.md').map((c) => c.target)).toEqual([
      '__tests__/utils/customerAccess.test.ts',
      'api/tests/integration/test_billing_enforcement.py',
      'utils/jobsAccess.ts',
    ]);
  });
});

describe('docLinkCheck — resolution bases', () => {
  const cite = (over: Partial<Parameters<typeof resolveCitation>[2]>) => ({
    raw: '',
    target: '',
    anchor: null,
    line: 1,
    base: 'repo-root' as const,
    ...over,
  });

  it('resolves a markdown link against the doc directory', () => {
    const found = resolveCitation(
      REPO_ROOT,
      'docs/modules/jobs.md',
      cite({ target: '../../utils/jobsAccess.ts', base: 'doc-dir' }),
    );
    expect(found).toBe(path.join(REPO_ROOT, 'utils/jobsAccess.ts'));
  });

  it('resolves an inline-code path against the repo root, from any doc depth', () => {
    const found = resolveCitation(
      REPO_ROOT,
      'docs/modules/jobs.md',
      cite({ target: 'utils/jobsAccess.ts' }),
    );
    expect(found).toBe(path.join(REPO_ROOT, 'utils/jobsAccess.ts'));
  });

  it('resolves an extensionless module reference, as the imports do', () => {
    const found = resolveCitation(
      REPO_ROOT,
      'docs/interaction-standards.md',
      cite({ target: 'components/common/DeleteIconButton' }),
    );
    expect(found).toBe(path.join(REPO_ROOT, 'components/common/DeleteIconButton.tsx'));
  });

  it('does NOT guess an extension for a markdown link — a link is a URL', () => {
    expect(
      resolveCitation(
        REPO_ROOT,
        'docs/interaction-standards.md',
        cite({ target: '../components/common/DeleteIconButton', base: 'doc-dir' }),
      ),
    ).toBeNull();
  });

  it('returns null for a path that does not exist', () => {
    expect(
      resolveCitation(REPO_ROOT, 'docs/README.md', cite({ target: 'utils/nopeAccess.ts' })),
    ).toBeNull();
  });
});

describe('docLinkCheck — docs are clean', () => {
  it('every cited path exists and every link anchor resolves', () => {
    const result = scanProject(REPO_ROOT);

    /**
     * Self-check: a scanner that found nothing must not pass. The floors sit
     * just under what the tree actually holds (32 docs / 1,072 citations / 143
     * anchors on 2026-08-03) rather than at 1, because every plausible way for
     * an extractor to break — stopping after the first doc, swallowing
     * everything after the first fenced block, dropping the anchor half —
     * still returns a positive number and would otherwise report a clean tree.
     */
    expect(result.docsScanned).toBeGreaterThan(25);
    expect(result.citationsChecked).toBeGreaterThan(800);
    expect(result.anchorsChecked).toBeGreaterThan(110);

    expect(format(result.issues), format(result.issues)).toBe('');
  });

  /**
   * Proves the case above is not trivially green: with the allowlist off, every
   * one of its entries must still raise the issue it excuses. It also fails an
   * entry that has gone stale — a standing licence to re-break that citation.
   */
  it('has no stale allowlist entry, and each one still suppresses a real miss', () => {
    expect(ALLOWLIST.size).toBeGreaterThan(0);
    const stale = unusedAllowlistEntries(REPO_ROOT);
    expect(stale, `stale ALLOWLIST entries:\n${stale.join('\n')}`).toEqual([]);
  });

  it('catches a synthetic rename of a heading another doc links to', () => {
    // A heading is an interface; renaming it must be detectable.
    expect(headingSlugs('## Stations (work centers)\n').has('stations-work-centers')).toBe(true);
    expect(headingSlugs('## Stations (work centres)\n').has('stations-work-centers')).toBe(false);
  });
});

function format(issues: DocIssue[]): string {
  return issues.map((i) => `${i.file}:${i.line} [${i.kind}] ${i.message}`).join('\n');
}
