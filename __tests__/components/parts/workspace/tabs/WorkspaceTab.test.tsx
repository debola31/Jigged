import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import WorkspaceTab from '@/components/parts/workspace/tabs/WorkspaceTab';
import type { Part } from '@/types/part';
import type { PartSetupStatus } from '@/components/parts/workspace/partSetupStatus';

// The workspace panels each hit Supabase on mount; this test only cares about
// the completeness banner, so stub them out to inert markers.
vi.mock('@/components/parts/PartPricing', () => ({ default: () => <div data-testid="pricing" /> }));
vi.mock('@/components/parts/PartRoutingPanel', () => ({ default: () => <div data-testid="routing" /> }));
vi.mock('@/components/parts/PartBomPanel', () => ({ default: () => <div data-testid="bom" /> }));
vi.mock('@/components/parts/PartProcurementPricingPanel', () => ({
  default: () => <div data-testid="procurement" />,
}));
vi.mock('@/components/parts/workspace/PartIdentitySection', () => ({
  default: () => <div data-testid="identity" />,
}));

const madePart = {
  id: 'parent1',
  company_id: 'co1',
  part_name: 'PARENT',
  source: 'made',
  primary_unit: 'ea',
  bom_lines_count: 1,
  preferred_vendor_id: null,
} as unknown as Part;

const notReadyStatus: PartSetupStatus = {
  state: 'needs_cost',
  color: 'warning',
  label: 'Needs cost',
  nextStep: 'This part isn’t priceable yet — a sub-part markup still needs setting up.',
  targetTab: 'workspace',
};

const readyStatus: PartSetupStatus = {
  state: 'ready',
  color: 'success',
  label: 'Ready to quote',
  nextStep: null,
  targetTab: 'workspace',
};

const renderTab = (
  setupStatus: PartSetupStatus | null,
  pricingGaps: React.ComponentProps<typeof WorkspaceTab>['pricingGaps'],
) =>
  render(
    <ThemeProvider theme={jiggedTheme}>
      <WorkspaceTab
        part={madePart}
        companyId="co1"
        partId="parent1"
        refreshKey={0}
        currentChain={[]}
        refreshAfterMutation={() => {}}
        setupStatus={setupStatus}
        pricingGaps={pricingGaps}
      />
    </ThemeProvider>,
  );

describe('WorkspaceTab completeness banner', () => {
  it('names a sub-part with no vendor cost and links to it', () => {
    // Cost gaps CAN be on a child (a bought material with no vendor price) and
    // link to it. (Markup gaps, by contrast, are only ever the root now.)
    renderTab(notReadyStatus, {
      missing_markups: [],
      missing_op_rates: [],
      missing_leaves: [{ part_id: 'sub1', part_name: 'SUB-COVER', depth: 1, qty_required: 1 }],
    });

    expect(screen.getByText(/isn’t ready to quote yet/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'SUB-COVER' });
    expect(link).toHaveAttribute('href', '/dashboard/co1/parts/sub1');
    expect(screen.getByText(/has no vendor cost/i)).toBeInTheDocument();
  });

  it('phrases a missing markup on the part itself as "This part …" with no link', () => {
    // Markup gaps only ever apply to the root (the part being quoted) — a
    // material's markup is never used inside a parent.
    renderTab(notReadyStatus, {
      missing_markups: [{ part_id: 'parent1', part_name: 'PARENT', depth: 0, source: 'made' }],
      missing_op_rates: [],
      missing_leaves: [],
    });

    expect(screen.getByText(/has no markup applied/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'PARENT' })).not.toBeInTheDocument();
  });

  it('phrases a gap on the part itself as "This part …" with no link', () => {
    renderTab(notReadyStatus, {
      missing_markups: [],
      missing_op_rates: [{ part_id: 'parent1', part_name: 'PARENT', depth: 0 }],
      missing_leaves: [],
    });

    expect(screen.getByText(/This part has an operation with no rate or no time/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'PARENT' })).not.toBeInTheDocument();
  });

  it('shows no banner when the part is ready', () => {
    renderTab(readyStatus, { missing_markups: [], missing_op_rates: [], missing_leaves: [] });

    expect(screen.queryByText(/isn’t ready to quote yet/i)).not.toBeInTheDocument();
  });
});
