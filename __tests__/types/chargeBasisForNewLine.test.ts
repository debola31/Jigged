import { describe, it, expect } from 'vitest';
import { chargeBasisForNewLine } from '@/types/bom';

/**
 * Which basis a newly added BOM line gets (#727).
 *
 * Three inputs, and the order between them is the whole rule: the part's own
 * stance beats the shop default, and a made child ignores both. Getting the
 * order wrong is invisible — a line lands on the wrong side and the only tell is
 * a price a few percent off — so it is pinned here rather than left implicit in
 * a ternary inside the panel.
 */
describe('chargeBasisForNewLine', () => {
  it('follows the shop default when the part has no stance yet', () => {
    expect(chargeBasisForNewLine('bought', null, 'price')).toBe('price');
    expect(chargeBasisForNewLine('bought', null, 'cost')).toBe('cost');
  });

  it("lets the part's existing materials win over the shop default", () => {
    // A part deliberately set to cost does not start mixing in priced materials
    // because the shop-wide default says otherwise — and vice versa.
    expect(chargeBasisForNewLine('bought', 'cost', 'price')).toBe('cost');
    expect(chargeBasisForNewLine('bought', 'price', 'cost')).toBe('price');
  });

  it('never puts a made child at price, whatever is set', () => {
    // Marking up in-house work is a transfer-pricing decision for that part's
    // own Pricing card, not something adding a material does silently.
    expect(chargeBasisForNewLine('made', 'price', 'price')).toBe('cost');
    expect(chargeBasisForNewLine('made', null, 'price')).toBe('cost');
  });

  it('treats a mixed part as having no stance, so the default decides', () => {
    // `null` is both "no purchased materials yet" and "they disagree"; there is
    // nothing coherent to inherit in either case.
    expect(chargeBasisForNewLine('bought', null, 'price')).toBe('price');
  });
});
