import { describe, it, expect } from 'vitest';
import { chargeBasisForNewLine } from '@/types/bom';

/**
 * Which basis a newly added BOM line gets (#727).
 *
 * Two inputs, and the order between them is the whole rule: the part's own
 * stance beats the shop default. Getting it wrong is invisible — a line lands on
 * the wrong side and the only tell is a price a few percent off — so it is
 * pinned here rather than left implicit in a ternary inside the panel.
 */
describe('chargeBasisForNewLine', () => {
  it('follows the shop default when the part has no stance yet', () => {
    expect(chargeBasisForNewLine(null, 'price')).toBe('price');
    expect(chargeBasisForNewLine(null, 'cost')).toBe('cost');
  });

  it("lets the part's existing materials win over the shop default", () => {
    // A part deliberately set to cost does not start mixing in priced materials
    // because the shop-wide default says otherwise — and vice versa.
    expect(chargeBasisForNewLine('cost', 'price')).toBe('cost');
    expect(chargeBasisForNewLine('price', 'cost')).toBe('price');
  });

  it('treats a mixed part as having no stance, so the default decides', () => {
    // `null` is both "no materials yet" and "they disagree"; there is nothing
    // coherent to inherit in either case.
    expect(chargeBasisForNewLine(null, 'price')).toBe('price');
  });

  it('does not care whether the child is made or bought', () => {
    // The rule takes no source argument at all — that is the point. Both carry
    // costs and pricing tiers, and the rollup has never told them apart. An
    // earlier draft forced made children to cost, inherited from a read-time
    // shop-wide markup this design no longer has.
    expect(chargeBasisForNewLine.length).toBe(2);
  });
});
