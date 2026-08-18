import { describe, it, expect } from 'vitest';
import { resolveName } from '@/utils/drawingImportCreate';
import type { DrawingRow, IdentityOutcome } from '@/types/drawingImport';

/**
 * Which name a row is actually created under.
 *
 * This is the last thing standing between two customers who both call a part
 * "1003308" and a merge: reusing a name in this repo revives or updates, so
 * writing the taken name would put customer B's drawing onto customer A's part
 * with A's quotes and jobs still pointing at it.
 *
 * The grid seeds the suggested name into the field so the column reads true. That
 * makes the check here a BACKSTOP — it has to hold when the user types.
 */
const rowWith = (identity: IdentityOutcome, typed?: string): DrawingRow =>
  ({
    stem: 'PKG-1',
    identity,
    fields: {},
    edits: typed === undefined ? {} : { part_name: typed },
  }) as unknown as DrawingRow;

const nameTaken: IdentityOutcome = {
  kind: 'name_taken',
  partId: 'other-customers-part',
  partName: '1003308',
  suggestedName: '1003308-2',
};

describe('resolveName', () => {
  it('renames a row whose name belongs to another customer', () => {
    expect(resolveName(rowWith(nameTaken))).toBe('1003308-2');
  });

  it('refuses the taken name even when the user types it back in', () => {
    expect(resolveName(rowWith(nameTaken, '1003308'))).toBe('1003308-2');
    // Case and padding are not a way around it.
    expect(resolveName(rowWith(nameTaken, '  1003308  '))).toBe('1003308-2');
  });

  it('takes any OTHER name the user chooses', () => {
    // The suggestion is a default, not a sentence. A shop that wants its own
    // convention gets it.
    expect(resolveName(rowWith(nameTaken, '1003308-ACME'))).toBe('1003308-ACME');
  });

  it('falls back to the suggestion rather than the filename when nothing was typed', () => {
    // `valueOf` would answer "PKG-1" here — the stem. A part named after the file
    // it arrived in is not a decision anyone made.
    expect(resolveName(rowWith(nameTaken))).toBe('1003308-2');
  });

  it('leaves an ordinary row alone', () => {
    expect(resolveName(rowWith({ kind: 'new' }, '1006914'))).toBe('1006914');
  });
});
