import { describe, it, expect } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';

import BinHistory from '@/components/operator/BinHistory';
import type { LocationHistoryEntry } from '@/types/inventoryLocations';

const entry = (over: Partial<LocationHistoryEntry> = {}): LocationHistoryEntry => ({
  id: 't1',
  createdAt: '2026-08-03T14:20:00Z',
  type: 'addition',
  itemName: 'RAW-AL6061-BLANK',
  quantity: 12,
  unit: 'ea',
  notes: null,
  actorName: 'Ada Lovelace',
  photoUrl: null,
  hasDiscrepancy: false,
  transferGroupId: null,
  ...over,
});

describe('BinHistory — "what happened here, and who did it"', () => {
  it('shows what moved, which way, and who moved it', () => {
    render(<BinHistory entries={[entry()]} loading={false} />);

    expect(screen.getByText('+12 ea')).toBeInTheDocument();
    expect(screen.getByText('RAW-AL6061-BLANK')).toBeInTheDocument();
    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
  });

  /**
   * Direction is carried by the SIGN as well as the colour. Colour alone fails on a bright shop
   * floor and for anyone colour-blind, and these are the same operators the design system already
   * accommodates elsewhere.
   */
  it('signs a removal, and gives an adjustment no direction at all', () => {
    render(
      <BinHistory
        entries={[
          entry({ id: 'a', type: 'depletion', quantity: 4 }),
          entry({ id: 'b', type: 'adjustment', quantity: 30 }),
        ]}
        loading={false}
      />,
    );
    expect(screen.getByText('−4 ea')).toBeInTheDocument();
    // An adjustment is neither in nor out — it sets a number, so a +/− would misdescribe it.
    expect(screen.getByText('set to 30 ea')).toBeInTheDocument();
  });

  it('shows the photo whoever moved it left behind', () => {
    render(<BinHistory entries={[entry({ photoUrl: 'https://signed/p.jpg' })]} loading={false} />);
    const img = screen.getByRole('img', { name: /photo taken when RAW-AL6061-BLANK was moved/i });
    expect(img).toHaveAttribute('src', 'https://signed/p.jpg');
  });

  /**
   * `operator_id` is only populated going forward, and `created_by` holds an auth user id the
   * browser cannot read. An older row therefore has no author — and must render WITHOUT one rather
   * than inventing "Unknown", which would read as a real person nobody can find.
   */
  it('leaves an unattributed movement unattributed, never "Unknown"', () => {
    render(<BinHistory entries={[entry({ actorName: null })]} loading={false} />);

    expect(screen.getByText('+12 ea')).toBeInTheDocument();
    expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/·\s*$/)).not.toBeInTheDocument();
  });

  it('flags a recorded shortfall, which is the one thing here that needs chasing', () => {
    render(<BinHistory entries={[entry({ hasDiscrepancy: true })]} loading={false} />);
    expect(screen.getByText(/shortfall recorded/i)).toBeInTheDocument();
  });

  it('says nothing has happened rather than showing a blank panel', () => {
    render(<BinHistory entries={[]} loading={false} />);
    expect(screen.getByText(/nothing recorded here yet/i)).toBeInTheDocument();
  });

  it('surfaces a failure instead of looking empty', () => {
    render(<BinHistory entries={null} loading={false} error="denied" />);
    expect(screen.getByText('denied')).toBeInTheDocument();
    expect(screen.queryByText(/nothing recorded here yet/i)).not.toBeInTheDocument();
  });

  it('is a list, so the count is announced and each row is addressable', () => {
    render(<BinHistory entries={[entry(), entry({ id: 't2' })]} loading={false} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
