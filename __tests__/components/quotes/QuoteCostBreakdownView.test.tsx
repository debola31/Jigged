import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import QuoteCostBreakdownView from '@/components/quotes/QuoteCostBreakdownView';
import type {
  QuoteLineItem,
  QuoteMaterialSnapshot,
  QuoteOperationSnapshot,
} from '@/types/quote';

/**
 * The breakdown is the answer to the question a pilot buyer asked verbatim —
 * "where does the final number come from?" — so what it must prove is not
 * layout but PROVENANCE (#727):
 *
 *   1. It says WHICH rung set a charged rate: the material's own pricing tier,
 *      or the shop-wide default, named with its number.
 *   2. It renders that from the SNAPSHOT and never recomputes. A quote priced
 *      against a 25% default keeps saying 25% after the setting becomes 30% —
 *      the component is given no way to read the current setting, and these
 *      tests are what keeps it that way.
 *   3. Effective margin is measured against TRUE cost, so stacked markup is
 *      seen rather than discovered.
 *
 * A shared default resolved at read time with nothing on screen to say where
 * the number came from is what got the markup_rates module deleted in July
 * 2026. This file is the guard against rebuilding it.
 */

function material(overrides: Partial<QuoteMaterialSnapshot> = {}): QuoteMaterialSnapshot {
  return {
    id: 'mat-1',
    quote_id: 'q-1',
    company_id: 'co-1',
    part_id: 'part-1',
    sequence: 0,
    material_part_id: null,
    item_name: 'BAR STOCK',
    quantity: 1,
    unit: 'ea',
    cost_per_unit: 10,
    line_cost: 10,
    units_consumed: 1,
    charge_basis: 'cost',
    true_cost_per_unit: 10,
    true_line_cost: 10,
    charge_rate_source: null,
    charge_markup_percent: null,
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

function lineItem(overrides: Partial<QuoteLineItem> = {}): QuoteLineItem {
  return {
    id: 'li-1',
    quote_id: 'q-1',
    company_id: 'co-1',
    part_id: 'part-1',
    source_tier_id: 'tier-1',
    sequence: 10,
    quantity: 1,
    unit_price: 87.5,
    total_price: 87.5,
    markup_percent: 40,
    base_cost_per_unit: 62.5,
    true_cost_per_unit: 60,
    is_quote_override: false,
    pricing_basis_snapshot: null,
    basis_unknown: false,
    lead_time_text: null,
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

const NO_OPS: QuoteOperationSnapshot[] = [];

describe('QuoteCostBreakdownView — where the number came from', () => {
  it('names the shop default AND its percentage on a default-priced material', () => {
    render(
      <QuoteCostBreakdownView
        partName="ASSEMBLY"
        operations={NO_OPS}
        materials={[
          material({
            charge_basis: 'price',
            cost_per_unit: 12.5,
            line_cost: 12.5,
            true_cost_per_unit: 10,
            true_line_cost: 10,
            charge_rate_source: 'company_default',
            charge_markup_percent: 25,
          }),
        ]}
        lineItems={[]}
      />,
    );

    expect(screen.getByText('Price (shop default 25%)')).toBeInTheDocument();
    // The cost underneath the charged rate, on the row that produced the uplift.
    expect(screen.getByText('cost $10.00')).toBeInTheDocument();
  });

  it('distinguishes a material’s own tier from the shop default', () => {
    render(
      <QuoteCostBreakdownView
        partName="ASSEMBLY"
        operations={NO_OPS}
        materials={[
          material({
            id: 'mat-tier',
            item_name: 'BAR',
            charge_basis: 'price',
            cost_per_unit: 11,
            line_cost: 11,
            true_cost_per_unit: 10,
            true_line_cost: 10,
            charge_rate_source: 'tier',
            charge_markup_percent: 10,
          }),
          material({
            id: 'mat-default',
            item_name: 'BUSHING',
            charge_basis: 'price',
            cost_per_unit: 5,
            line_cost: 5,
            true_cost_per_unit: 4,
            true_line_cost: 4,
            charge_rate_source: 'company_default',
            charge_markup_percent: 25,
          }),
          material({ id: 'mat-cost', item_name: 'PIN' }),
        ]}
        lineItems={[]}
      />,
    );

    expect(screen.getByText('Price (own tier)')).toBeInTheDocument();
    expect(screen.getByText('Price (shop default 25%)')).toBeInTheDocument();
    expect(screen.getByText('Our cost')).toBeInTheDocument();

    // Charged 26 against a true 24 — the uplift is called out, not left to be
    // worked out by subtraction.
    expect(screen.getByText('of which material markup')).toBeInTheDocument();
    expect(screen.getByText('$2.00')).toBeInTheDocument();
  });

  it('keeps saying the rate it was priced at, whatever the setting says now', () => {
    // The component is handed only the snapshot. There is no company prop, no
    // fetch, nothing to re-resolve against — so a later change to the shop
    // default cannot rewrite what this quote says about itself.
    render(
      <QuoteCostBreakdownView
        partName="ASSEMBLY"
        operations={NO_OPS}
        materials={[
          material({
            charge_basis: 'price',
            cost_per_unit: 12.5,
            line_cost: 12.5,
            true_cost_per_unit: 10,
            true_line_cost: 10,
            charge_rate_source: 'company_default',
            charge_markup_percent: 25,
          }),
        ]}
        lineItems={[]}
      />,
    );

    expect(screen.getByText('Price (shop default 25%)')).toBeInTheDocument();
    expect(screen.queryByText(/30%/)).not.toBeInTheDocument();
  });

  it('shows effective margin against TRUE cost, so stacking is visible', () => {
    // Markup on the tier is 40%, but materials came in at price, so the real
    // margin over what the part costs us is wider: (87.50 - 60) / 87.50.
    render(
      <QuoteCostBreakdownView
        partName="ASSEMBLY"
        operations={NO_OPS}
        materials={[
          material({
            charge_basis: 'price',
            cost_per_unit: 42.5,
            line_cost: 42.5,
            true_cost_per_unit: 40,
            true_line_cost: 40,
            charge_rate_source: 'company_default',
            charge_markup_percent: 25,
          }),
        ]}
        lineItems={[lineItem()]}
      />,
    );

    const tierTable = screen.getByText('Quantity tiers on this quote').closest('div')!;
    expect(within(tierTable).getByText('31.4%')).toBeInTheDocument();
    // ...and it is NOT the tier's own markup, which is the number that would
    // mislead here.
    expect(within(tierTable).getByText('40%')).toBeInTheDocument();
  });

  it('renders an unknown margin as blank, never as zero', () => {
    render(
      <QuoteCostBreakdownView
        partName="ASSEMBLY"
        operations={NO_OPS}
        materials={[material()]}
        lineItems={[lineItem({ true_cost_per_unit: null })]}
      />,
    );

    const tierTable = screen.getByText('Quantity tiers on this quote').closest('div')!;
    expect(within(tierTable).getByText('—')).toBeInTheDocument();
  });
});
