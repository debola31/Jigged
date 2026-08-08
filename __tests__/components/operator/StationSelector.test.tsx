import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';

import StationSelector from '@/components/operator/StationSelector';

/**
 * The picker names the task, and lets the header name the shop.
 *
 * WHAT THIS GUARDS. This screen used to identify nothing — the jobs page hides its toolbar while
 * the picker is up and the layout hides the bottom nav, so the card was the whole screen. The fix
 * went into the AppBar's centre slot (`OperatorCompanyLabel`), which is empty until a station is
 * picked and which is also present on the other screens reachable without one ("Me", Inventory).
 *
 * An interim version put the company name HERE as well, and on this screen it rendered the same
 * words twice within about 100px. The absence assertion below is the guard against that coming
 * back — it is the kind of thing that looks like an improvement in a diff.
 *
 * The literal string "Select Your Station" is asserted on purpose: e2e/helpers/navigation.ts and
 * e2e/machine-maintenance.spec.ts both locate this card by that text, so a rename here is a silent
 * E2E break. This is the cheap unit-level tripwire for it.
 */

const stationContext = {
  stations: [
    { id: 'wc-1', name: 'Haas VF-2' },
    { id: 'wc-2', name: 'Okuma LB3000' },
  ],
  setStation: vi.fn(),
  loading: false,
};

vi.mock('@/components/operator/OperatorStationContext', () => ({
  useStationContext: () => stationContext,
}));

beforeEach(() => {
  stationContext.loading = false;
  stationContext.setStation.mockReset();
});

describe('StationSelector', () => {
  it('asks for a station', () => {
    render(<StationSelector />);

    expect(screen.getByText('Select Your Station')).toBeInTheDocument();
    expect(
      screen.getByText('Choose the station you are working at to continue.'),
    ).toBeInTheDocument();
  });

  it('does not repeat the company name the header already shows', () => {
    // Not a styling preference: on this screen the header sits about 100px above the card, so
    // the two lines were adjacent and identical. The company name has one home.
    render(<StationSelector />);

    expect(screen.queryByText('Contour Tool & Machine')).not.toBeInTheDocument();
  });

  it('does not reach for the company context at all', () => {
    // Stronger than the absence check above, and the reason this file mocks only the station
    // context: if StationSelector called `useOperatorCompany`, this render would throw
    // ("must be used within an OperatorCompanyProvider"). Re-adding the company line here
    // therefore fails loudly rather than quietly duplicating the header.
    expect(() => render(<StationSelector />)).not.toThrow();
  });

  it('lists the stations', () => {
    render(<StationSelector />);

    expect(screen.getByRole('button', { name: 'Haas VF-2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Okuma LB3000' })).toBeInTheDocument();
  });
});
