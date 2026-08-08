import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';

import StationSelector from '@/components/operator/StationSelector';

/**
 * The picker names the shop it is picking a station FOR.
 *
 * WHAT THIS GUARDS. The jobs page hides its toolbar while the picker is up and the layout
 * hides the bottom nav, so this card is the entire screen — and it used to identify neither
 * the company nor the person. The operator login page one step earlier DOES show the company
 * name, so it appeared and then vanished at exactly the moment you commit to a working
 * context. A person who works two shops, or who has just stepped into the practice company,
 * had nothing on screen to check against.
 *
 * The literal string "Select Your Station" is asserted on purpose: e2e/helpers/navigation.ts
 * and e2e/machine-maintenance.spec.ts both locate this card by that text, so a rename here is
 * a silent E2E break. This is the cheap unit-level tripwire for it.
 */

const stationContext = {
  stations: [
    { id: 'wc-1', name: 'Haas VF-2' },
    { id: 'wc-2', name: 'Okuma LB3000' },
  ],
  setStation: vi.fn(),
  loading: false,
};

const companyContext = {
  companyId: 'co-1',
  companyName: 'Contour Tool & Machine' as string | null,
  isDemo: false,
  hasDemo: false,
  demoCompanyId: null,
  realCompanyId: 'co-1',
  features: {},
  loading: false,
};

vi.mock('@/components/operator/OperatorStationContext', () => ({
  useStationContext: () => stationContext,
}));

vi.mock('@/components/operator/OperatorCompanyContext', () => ({
  useOperatorCompany: () => companyContext,
}));

beforeEach(() => {
  companyContext.companyName = 'Contour Tool & Machine';
  stationContext.loading = false;
});

describe('StationSelector', () => {
  it('names the company it is picking a station for', () => {
    render(<StationSelector />);

    expect(screen.getByText('Contour Tool & Machine')).toBeInTheDocument();
    expect(screen.getByText('Select Your Station')).toBeInTheDocument();
  });

  it('shows the real company name, not the internal one, inside the practice company', () => {
    // A demo company's own row is named "X - Demo". The context resolves the source
    // company's name for exactly this reason — showing the internal name would leak the
    // implementation and disagree with what the office shows for the same company.
    companyContext.companyName = 'Contour Tool & Machine';

    render(<StationSelector />);

    expect(screen.getByText('Contour Tool & Machine')).toBeInTheDocument();
    expect(screen.queryByText(/- Demo/)).not.toBeInTheDocument();
  });

  it('renders the heading in place rather than reserving a blank line while the name loads', () => {
    // Holding an empty row and dropping the name into it later shifts the heading down one
    // line on first paint. Arriving in place is the better of the two.
    companyContext.companyName = null;

    render(<StationSelector />);

    expect(screen.getByText('Select Your Station')).toBeInTheDocument();
    expect(
      screen.getByText('Choose the station you are working at to continue.'),
    ).toBeInTheDocument();
  });

  it('still lists the stations', () => {
    render(<StationSelector />);

    expect(screen.getByRole('button', { name: 'Haas VF-2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Okuma LB3000' })).toBeInTheDocument();
  });
});
