import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';

import OperatorCompanyLabel from '@/components/operator/OperatorCompanyLabel';

/**
 * The operator surface's ONLY statement of which shop you are in.
 *
 * WHAT THIS GUARDS. The AppBar's centre slot renders the station chip and nothing else, so before
 * a station was picked it was empty — and the station picker hides the bottom nav too, leaving the
 * one screen where you commit to a working context identifying nothing. The operator login page
 * one screen earlier does show the company name, so it appeared and then vanished.
 *
 * This carries it alone. The picker card deliberately does NOT repeat it (see StationSelector),
 * which is what makes a test here load-bearing rather than one of two safety nets: if this
 * regresses, company identity disappears from the operator surface entirely.
 */

const stationContext = { stationId: null as string | null };
const companyContext = { companyName: 'Contour Tool & Machine' as string | null };

vi.mock('@/components/operator/OperatorStationContext', () => ({
  useStationContext: () => stationContext,
}));

vi.mock('@/components/operator/OperatorCompanyContext', () => ({
  useOperatorCompany: () => companyContext,
}));

beforeEach(() => {
  stationContext.stationId = null;
  companyContext.companyName = 'Contour Tool & Machine';
});

describe('OperatorCompanyLabel', () => {
  it('names the shop while no station is chosen', () => {
    render(<OperatorCompanyLabel />);

    expect(screen.getByText('Contour Tool & Machine')).toBeInTheDocument();
  });

  it('yields the slot once a station is chosen', () => {
    // The station chip takes this space. Two things in the centre slot is what the header's
    // own note rules out, and the station is the more useful of the two once it exists.
    stationContext.stationId = 'wc-1';

    const { container } = render(<OperatorCompanyLabel />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing rather than reserving a blank space while the name resolves', () => {
    companyContext.companyName = null;

    const { container } = render(<OperatorCompanyLabel />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is not a tap target', () => {
    /**
     * The operator AppBar carries a documented prohibition on adding tap targets: two small
     * targets side by side is the worst case in Fitts's law, and touch platforms resolve a tap
     * to the NEAREST control, so missing one fires the other. The obvious tidy-up here — make
     * the company name tappable to switch company — is exactly what must not happen. The
     * switcher lives in the "Me" tab.
     */
    render(<OperatorCompanyLabel />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Contour Tool & Machine').closest('button')).toBeNull();
  });
});
