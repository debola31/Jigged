import { describe, it, expect } from 'vitest';
import { PARTS_SUBROUTES } from '@/lib/partsSubroutes';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every real page under /parts is named.
 *
 * The slot after `parts` is either a named page or a part ID, and nothing can tell
 * them apart by looking — so an unlisted page does not error, it silently titles
 * itself "Part Details" in the header AND the feedback dialog. That is how
 * /parts/drawings shipped calling itself Part Details.
 *
 * This reads the routes off disk, so adding a page without a title fails here
 * rather than in a screenshot.
 */
const PARTS_DIR = join(process.cwd(), 'app/dashboard/[companyId]/parts');

describe('PARTS_SUBROUTES', () => {
  it('names every static page directory under /parts', () => {
    const dirs = readdirSync(PARTS_DIR)
      .filter((name) => statSync(join(PARTS_DIR, name)).isDirectory())
      // A dynamic segment IS the part ID — that is the fallback, not a named page.
      .filter((name) => !name.startsWith('[') && !name.startsWith('('));

    const missing = dirs.filter((d) => !(d in PARTS_SUBROUTES));
    expect(missing, `add these to lib/partsSubroutes.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('titles the drawings page as itself, not as a part', () => {
    expect(PARTS_SUBROUTES.drawings).toBe('Add parts from drawings');
  });
});
