import { describe, it, expect } from 'vitest';
import path from 'path';
import { readFileSync } from 'fs';
import {
  findUnsortableViolations,
  formatViolations,
  isServerSorted,
  maskStrings,
  objectProperties,
  scanProject,
  type Violation,
} from '../../scripts/gridSortableColumnsCheck';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Deliberate exceptions, each needing a reason.
 *
 * Keyed `<repo-relative file>::<colId>`. The only legitimate entry is a ColDef
 * that writes `colId` explicitly where the colId happens to BE a real column on
 * the table the grid orders by — at which point the sort works and the check
 * cannot tell the difference from the outside. Write `field:` instead if you can;
 * AG Grid then derives the colId from it and the intent is readable without a
 * list. An entry here is a claim that a SQL `ORDER BY <colId>` succeeds against
 * that grid's table.
 *
 * Empty on purpose. The five columns that would have been in it are the bug
 * (see scripts/gridSortableColumnsCheck.ts) — they are now `sortable: false`.
 */
const ALLOWED: Record<string, string> = {};

const VIOLATIONS = scanProject(REPO_ROOT);

/**
 * A DERIVED GRID COLUMN MUST NOT BE SORTABLE WHEN THE GRID SORTS SERVER-SIDE.
 *
 * The full argument, the four times this has shipped, and what the check cannot
 * see are in scripts/gridSortableColumnsCheck.ts. The short version: these grids
 * pass the sorted column's `colId` into a PostgREST `.order()`, so a colId that
 * is not a real column turns a header click into `column <table>.<colId> does not
 * exist` (42703) and the grid renders nothing. Sentry JAVASCRIPT-NEXTJS-39 is
 * that failure, from the Jobs grid's Parts column.
 *
 * It is invisible in development: every real column sorts, and only the derived
 * headers break. Two pages carried a comment explaining the rule and two more
 * pages then shipped the same bug, which is why the rule is a test.
 */
describe('server-sorted grids never offer a sort that cannot reach the database', () => {
  it('has no derived column left sortable', () => {
    const offenders = VIOLATIONS.filter(
      (v) => !(`${v.file}::${v.colId}` in ALLOWED),
    );

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `\nA sortable column whose colId is not a database column:\n\n${formatViolations(offenders)}\n\n` +
          `Sorting in these grids is server-side — the colId becomes a SQL ORDER BY.\n` +
          `Add \`sortable: false\` to the ColDef, or (only if the colId really is a\n` +
          `column on that grid's table) add it to ALLOWED in this file with a reason.\n`,
    ).toEqual([]);
  });

  /**
   * The other direction, for the same reason the analytics registry is checked
   * both ways: an allowlist nobody prunes stops being read, and a stale entry is
   * a standing exemption for a column that no longer exists.
   */
  it('has no stale allowlist entries', () => {
    const live = new Set(VIOLATIONS.map((v) => `${v.file}::${v.colId}`));
    const stale = Object.keys(ALLOWED).filter((key) => !live.has(key));

    expect(
      stale,
      `These ALLOWED entries no longer match a sortable colId column. Delete them:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  /**
   * The check is only as good as its file selection. If a grid page stops
   * matching `onSortChanged` the scan silently skips it, so the five pages known
   * to sort server-side are asserted to still be in scope. A page that moves off
   * server-side sorting should be removed from this list in the same change.
   */
  it('still covers every page known to sort server-side', () => {
    const pages = [
      'app/dashboard/[companyId]/customers/page.tsx',
      'app/dashboard/[companyId]/jobs/page.tsx',
      'app/dashboard/[companyId]/parts/page.tsx',
      'app/dashboard/[companyId]/quotes/page.tsx',
      'app/dashboard/[companyId]/vendors/page.tsx',
    ];

    const outOfScope = pages.filter((rel) => {
      const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      return !isServerSorted(source);
    });

    expect(
      outOfScope,
      `These pages sort server-side but no longer match the scanner's file filter, so they are no longer checked:\n  ${outOfScope.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * PARSER TESTS.
 *
 * The scanner reads TypeScript with brace matching rather than a real AST, so its
 * failure mode is silence: a parser that loses depth finds no ColDefs and the
 * guard passes everything. Each case below is a shape that actually appears in
 * these pages.
 */
describe('the ColDef scanner', () => {
  const wrap = (defs: string) => `
    const handleSortChanged = (e) => e.api.getColumnState();
    const columnDefs = [${defs}];
    <AgGridReact onSortChanged={handleSortChanged} />;
  `;

  it('flags a colId column with no sortable', () => {
    const found = findUnsortableViolations('x.tsx', wrap(`
      { colId: 'parts', headerName: 'Parts', valueGetter: (p) => p.data.job_parts },
    `));
    expect(found.map((v) => v.colId)).toEqual(['parts']);
    expect(found[0].headerName).toBe('Parts');
  });

  it('accepts a colId column with sortable: false', () => {
    expect(findUnsortableViolations('x.tsx', wrap(`
      { colId: 'parts', headerName: 'Parts', sortable: false },
    `))).toEqual([]);
  });

  it('ignores a field column — AG Grid derives its colId from the database column', () => {
    expect(findUnsortableViolations('x.tsx', wrap(`
      { field: 'due_date', headerName: 'Due' },
    `))).toEqual([]);
  });

  /**
   * `applyColumnState({ state: [{ colId: 'created_at', sort: 'desc' }] })` names an
   * existing column rather than defining one. Every page in scope calls it, so a
   * scanner that counted these would report a violation on all five and the real
   * ones would be indistinguishable from the noise.
   */
  it('ignores applyColumnState entries, which have no headerName', () => {
    expect(findUnsortableViolations('x.tsx', `
      const handleSortChanged = () => {};
      api.applyColumnState({ state: [{ colId: 'created_at', sort: 'desc' }] });
      <AgGridReact onSortChanged={handleSortChanged} />;
    `)).toEqual([]);
  });

  /**
   * The reason `sortable` is read only at the object's own depth. A nested
   * `sortable: false` belongs to whatever nested it, and treating it as the
   * column's own would green-light the exact bug.
   */
  it('does not accept a sortable: false nested inside another object', () => {
    const found = findUnsortableViolations('x.tsx', wrap(`
      { colId: 'parts', headerName: 'Parts', cellRendererParams: { sortable: false } },
    `));
    expect(found.map((v) => v.colId)).toEqual(['parts']);
  });

  /** A cellRenderer's JSX and arrow bodies carry braces the depth walk must survive. */
  it('reads a ColDef that follows one with a JSX cellRenderer', () => {
    const found = findUnsortableViolations('x.tsx', wrap(`
      {
        colId: 'status',
        headerName: 'Status',
        sortable: false,
        cellRenderer: (params) => {
          if (!params.data) return null;
          return <Box sx={{ display: 'flex' }}>{params.value ?? '—'}</Box>;
        },
      },
      { colId: 'customer', headerName: 'Customer', valueGetter: (p) => p.data.customers.name },
    `));
    expect(found.map((v) => v.colId)).toEqual(['customer']);
  });

  /** Comments explaining the rule must not read as code that breaks it. */
  it('does not flag a colId written in a comment', () => {
    expect(findUnsortableViolations('x.tsx', wrap(`
      // { colId: 'parts', headerName: 'Parts' } was the bug — no sortable: false.
      { colId: 'parts', headerName: 'Parts', sortable: false },
    `))).toEqual([]);
  });

  it('skips files whose grid does not sort server-side', () => {
    expect(isServerSorted("const x = 1;")).toBe(false);
    expect(isServerSorted('<AgGridReact onSortChanged={h} />')).toBe(true);
  });
});

describe('maskStrings', () => {
  it('preserves length and offsets so a colId can still be read from the original', () => {
    const src = `{ colId: 'a}b', headerName: 'H' }`;
    expect(maskStrings(src)).toHaveLength(src.length);
  });

  /** An unbalanced brace inside a string is what would break the depth walk. */
  it('hides braces inside string literals', () => {
    expect(maskStrings(`const s = '}}}';`)).toBe(`const s = 'xxx';`);
  });

  it('keeps newlines inside template literals so line numbers survive', () => {
    const masked = maskStrings('const s = `a\nb`;');
    expect(masked.split('\n')).toHaveLength(2);
  });
});

describe('objectProperties', () => {
  it('returns only the object\'s own properties', () => {
    const code = `{ colId: 'p', headerName: 'P', nested: { sortable: false }, sortable: true }`;
    const props = objectProperties(maskStrings(code), code, 0, code.length - 1);
    expect([...props.keys()].sort()).toEqual(['colId', 'headerName', 'nested', 'sortable']);
    expect(props.get('sortable')!.value).toBe('true');
  });
});

/**
 * The report is what a failing author actually reads, so it is asserted to name
 * the file, the line, the header they clicked and the fix.
 */
describe('the failure report', () => {
  it('names the column, its location and what to do', () => {
    const v: Violation = { file: 'app/x/page.tsx', colId: 'parts', headerName: 'Parts', line: 42 };
    const out = formatViolations([v]);
    expect(out).toContain('app/x/page.tsx:42');
    expect(out).toContain('"Parts"');
    expect(out).toContain('sortable: false');
  });
});
