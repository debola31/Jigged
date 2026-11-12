/**
 * "Use as part cost" (criteria V3, V4): a preview the DATABASE computed, the consequences in plain
 * words — a count that could not be taken reads "couldn't count", never 0 — nothing written until
 * the person confirms, and the apply sent the preview exactly as the database returned it, so it
 * refuses ("changed since you previewed") rather than writing numbers nobody saw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within, waitFor } from '../../test-utils';

const m = vi.hoisted(() => ({
  preview: vi.fn(),
  apply: vi.fn(),
  countQuotes: vi.fn(),
  countParents: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { capture: m.capture } }));
vi.mock('@/utils/partVendorsAccess', async (importOriginal) => ({
  // toSourcingPreview stays real: the rows on screen are the pure helpers' words.
  ...(await importOriginal<typeof import('@/utils/partVendorsAccess')>()),
  previewPartCostFromVendor: (...a: unknown[]) => m.preview(...a),
  applyPartCostFromVendor: (...a: unknown[]) => m.apply(...a),
  countOpenQuotesWithPart: (...a: unknown[]) => m.countQuotes(...a),
  countBomParents: (...a: unknown[]) => m.countParents(...a),
}));

import UseAsPartCostDialog from '@/components/parts/UseAsPartCostDialog';
import type { PartCostPreview } from '@/types/partVendor';

const TODAY = '2026-11-09';

/** What the database said, kept byte for byte for the apply. */
const EXPECTED = { tiers: [{ tier_id: 't-1' }], the: 'reply' };

function preview(over: Partial<PartCostPreview> = {}): PartCostPreview {
  return {
    partVendorId: 'pv-1',
    partId: 'part-bar',
    partName: 'BAR-6061',
    vendorId: 'v-acme',
    vendorName: 'Acme Steel',
    purchaseUnit: 'bar',
    stockUnit: 'inches',
    stockFactor: 144,
    quotedOn: '2026-09-01',
    validUntil: '2026-12-31',
    tiers: [
      { tierId: 't-1', quantity: 72, markupPercent: 25, currentCost: 0.4, proposedCost: 0.416667, currentPrice: 0.5, proposedPrice: 0.52, vendorMinQuantity: 1, vendorUnitPrice: 60, belowVendorMinimum: true },
      { tierId: 't-2', quantity: 1440, markupPercent: 25, currentCost: 0.4, proposedCost: 0.347222, currentPrice: 0.5, proposedPrice: 0.43, vendorMinQuantity: 10, vendorUnitPrice: 50, belowVendorMinimum: false },
    ],
    inserts: [],
    openQuoteCount: 2,
    bomParentPartCount: 1,
    warnings: ['below_vendor_minimum'],
    expected: EXPECTED,
    ...over,
  };
}

const onClose = vi.fn();
const onApplied = vi.fn();

function renderDialog() {
  return render(
    <UseAsPartCostDialog
      open
      partVendorId="pv-1"
      partId="part-bar"
      partName="BAR-6061"
      vendorName="Acme Steel"
      today={TODAY}
      onClose={onClose}
      onApplied={onApplied}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.preview.mockResolvedValue(preview());
  m.countQuotes.mockResolvedValue(3);
  m.countParents.mockResolvedValue(1);
  m.apply.mockResolvedValue({ partId: 'part-bar', partVendorId: 'pv-1', updatedTierIds: ['t-1', 't-2'], insertedTierIds: [] });
});

describe('UseAsPartCostDialog — the preview (V3)', () => {
  it('shows each tier: quantity, cost now → new, markup unchanged, price now → new', async () => {
    renderDialog();
    const row = await screen.findByRole('row', { name: /72 in/ });
    expect(within(row).getByText('$0.40')).toBeInTheDocument();
    expect(within(row).getByText('$0.41667')).toBeInTheDocument();
    expect(within(row).getByText('25% · unchanged')).toBeInTheDocument();
    expect(within(row).getByText('$0.50')).toBeInTheDocument();
    expect(within(row).getByText('$0.52')).toBeInTheDocument();
    expect(within(row).getByText("Below Acme Steel's 1 bar minimum")).toBeInTheDocument();
    expect(m.preview).toHaveBeenCalledWith('pv-1', TODAY);
  });

  it('says what applying it changes elsewhere, in plain words', async () => {
    renderDialog();
    expect(await screen.findByText(/3 open quotes with this part will show Pricing changed/)).toBeInTheDocument();
    expect(screen.getByText('1 part using it as material re-costs.')).toBeInTheDocument();
    expect(screen.getByText('Existing jobs keep their frozen cost.')).toBeInTheDocument();
    expect(m.countQuotes).toHaveBeenCalledWith('part-bar', TODAY);
    expect(m.countParents).toHaveBeenCalledWith('part-bar');
  });

  it('a count that fails reads "couldn\'t count" — never 0', async () => {
    m.countQuotes.mockRejectedValue(new Error('Failed to count the open quotes with this part.'));
    renderDialog();
    expect(await screen.findByText(/couldn't count the open quotes with this part/)).toBeInTheDocument();
    expect(screen.queryByText(/no open quotes include this part/)).toBeNull();
    expect(screen.queryByText(/0 open quotes/)).toBeNull();
    // The rest of the dialog still works: the count is a consequence, not the preview.
    expect(screen.getByRole('button', { name: 'Use as part cost' })).toBeEnabled();
  });

  it('a part with no pricing yet gets the breaks at 0% markup, and is told to set markups', async () => {
    m.preview.mockResolvedValue(
      preview({
        tiers: [],
        inserts: [
          { quantity: 144, proposedCost: 0.416667, markupPercent: 0, vendorMinQuantity: 1, vendorUnitPrice: 60 },
          { quantity: 1440, proposedCost: 0.347222, markupPercent: 0, vendorMinQuantity: 10, vendorUnitPrice: 50 },
        ],
        warnings: ['starter_tiers_inserted'],
      }),
    );
    renderDialog();
    expect(await screen.findByText(/no price breaks yet/)).toBeInTheDocument();
    expect(screen.getAllByText('0% · new')).toHaveLength(2);
  });

  it('a refused preview gives its sentence and no way to apply', async () => {
    m.preview.mockRejectedValue(new Error("Acme Steel's price sheet for BAR-6061 expired on 2026-10-31."));
    renderDialog();
    expect(await screen.findByText(/price sheet for BAR-6061 expired/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use as part cost' })).toBeNull();
  });
});

describe('UseAsPartCostDialog — apply only on confirm (V3)', () => {
  const user = userEvent.setup();

  it('writes nothing until confirmed, then sends the preview exactly as the database returned it', async () => {
    renderDialog();
    await screen.findByRole('row', { name: /72 in/ });
    expect(m.apply).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Use as part cost' }));
    await waitFor(() => expect(m.apply).toHaveBeenCalledTimes(1));
    const [id, today, expected] = m.apply.mock.calls[0];
    expect(id).toBe('pv-1');
    expect(today).toBe(TODAY);
    // The same object — markups and quantities come back untouched, because nothing re-built it.
    expect(expected).toBe(EXPECTED);
    expect(onApplied).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(m.capture).toHaveBeenCalledWith('part cost sourced', {
      tiers_updated: 2,
      tiers_added: 0,
      unit_converted: true,
      below_minimum: true,
    });
  });

  it('"changed since you previewed" shows its sentence and can preview again', async () => {
    m.apply.mockRejectedValue(new Error("This part's pricing or the price sheet changed since you previewed. Preview it again."));
    renderDialog();
    await screen.findByRole('row', { name: /72 in/ });
    await user.click(screen.getByRole('button', { name: 'Use as part cost' }));
    expect(await screen.findByText(/changed since you previewed/)).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
    expect(m.capture).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(m.preview).toHaveBeenCalledTimes(2));
  });

  it('Cancel closes and writes nothing', async () => {
    renderDialog();
    await screen.findByRole('row', { name: /72 in/ });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });
});
