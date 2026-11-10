/**
 * "Use as part cost" — rendering the preview (plan §3.8, criterion V3).
 *
 * The database does the maths (`preview_part_cost_from_vendor`) and the only writer is
 * `apply_part_cost_from_vendor`. These helpers only turn the preview into words, so the dialog
 * can never show a number the database did not compute — and a count that failed reads
 * "couldn't count", never 0.
 */
import { describe, it, expect } from 'vitest';
import { sourcingConsequences, sourcingPreviewRows, type SourcingPreview } from '@/lib/purchasing/sourcing';

const preview = (over: Partial<SourcingPreview> = {}): SourcingPreview => ({
  vendorName: 'Acme',
  stockUnit: 'inches',
  purchaseUnit: 'bar',
  vendorMinimumQuantity: 10,
  tiers: [
    {
      tierId: 't1', quantity: 1, currentCost: 0.3, proposedCost: 0.25, markupPercent: 35,
      currentPrice: 0.405, proposedPrice: 0.3375, belowVendorMinimum: true,
    },
    {
      tierId: 't2', quantity: 1440, currentCost: 0.25, proposedCost: 0.25, markupPercent: 35,
      currentPrice: 0.3375, proposedPrice: 0.3375, belowVendorMinimum: false,
    },
  ],
  inserts: [],
  ...over,
});

describe('sourcingPreviewRows (V3)', () => {
  it('shows each existing tier as quantity · cost now → new · markup unchanged · price now → new', () => {
    expect(sourcingPreviewRows(preview())).toEqual([
      {
        key: 't1', isNew: false, quantityLabel: '1 in',
        costBefore: '$0.30', costAfter: '$0.25', costChanged: true,
        markupLabel: '35% · unchanged',
        priceBefore: '$0.405', priceAfter: '$0.3375', priceChanged: true,
        note: 'Below Acme\'s 10 bar minimum',
      },
      {
        key: 't2', isNew: false, quantityLabel: '1,440 in',
        costBefore: '$0.25', costAfter: '$0.25', costChanged: false,
        markupLabel: '35% · unchanged',
        priceBefore: '$0.3375', priceAfter: '$0.3375', priceChanged: false,
        note: null,
      },
    ]);
  });

  it('shows the tiers a part with none will get, at the 0% starter markup', () => {
    const rows = sourcingPreviewRows(
      preview({
        tiers: [],
        inserts: [
          { tierId: null, quantity: 144, currentCost: null, proposedCost: 0.25, markupPercent: 0, currentPrice: null, proposedPrice: 0.25 },
        ],
      }),
    );
    expect(rows).toEqual([
      {
        key: 'new-0', isNew: true, quantityLabel: '144 in',
        costBefore: '—', costAfter: '$0.25', costChanged: true,
        markupLabel: '0% · new',
        priceBefore: '—', priceAfter: '$0.25', priceChanged: true,
        note: null,
      },
    ]);
  });

  it('says when a tier has no markup rather than inventing one', () => {
    const [row] = sourcingPreviewRows(
      preview({
        tiers: [{ tierId: 't1', quantity: 1, currentCost: 0.3, proposedCost: 0.25, markupPercent: null, currentPrice: null, proposedPrice: null }],
      }),
    );
    expect(row).toMatchObject({ markupLabel: 'No markup set', priceBefore: '—', priceAfter: '—', priceChanged: false });
  });

  it('treats a sub-cent drift as no change, the way quotes do', () => {
    const [row] = sourcingPreviewRows(
      preview({
        tiers: [{ tierId: 't1', quantity: 1, currentCost: 1.001, proposedCost: 1.004, markupPercent: 0, currentPrice: 1.001, proposedPrice: 1.004 }],
      }),
    );
    expect(row).toMatchObject({ costChanged: false, priceChanged: false });
  });
});

describe('sourcingConsequences — in plain words (V3, V4)', () => {
  it('counts the open quotes and the parts that re-cost', () => {
    expect(sourcingConsequences({ openQuoteCount: 3, bomParentCount: 2 })).toEqual([
      'Quotes keep their prices; 3 open quotes with this part will show Pricing changed.',
      '2 parts using it as material re-cost.',
      'Existing jobs keep their frozen cost.',
    ]);
  });

  it('speaks in the singular for one', () => {
    expect(sourcingConsequences({ openQuoteCount: 1, bomParentCount: 1 })).toEqual([
      'Quotes keep their prices; 1 open quote with this part will show Pricing changed.',
      '1 part using it as material re-costs.',
      'Existing jobs keep their frozen cost.',
    ]);
  });

  it('says none when the count is a real zero', () => {
    expect(sourcingConsequences({ openQuoteCount: 0, bomParentCount: 0 })).toEqual([
      'Quotes keep their prices; no open quotes include this part.',
      'No parts use it as material.',
      'Existing jobs keep their frozen cost.',
    ]);
  });

  it('says "couldn\'t count" when a count failed — never 0', () => {
    expect(sourcingConsequences({ openQuoteCount: null, bomParentCount: null })).toEqual([
      'Quotes keep their prices; couldn\'t count the open quotes with this part.',
      'Couldn\'t count the parts using it as material.',
      'Existing jobs keep their frozen cost.',
    ]);
  });
});
