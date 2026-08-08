import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, routerMocks } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import OperatorDemoBar from '@/components/operator/OperatorDemoBar';

/**
 * The demo bar says you are in the demo, and is the way out.
 *
 * WHAT THIS GUARDS. Before it existed the operator surface had no demo awareness at all: an
 * admin who entered demo mode in the office and tapped "Shop floor" landed on a shop-floor
 * screen showing fabricated jobs with nothing saying so, and the header's "Office" button
 * pushes `/dashboard/{companyId}` from the raw route param — carrying them back into the demo
 * dashboard rather than out. The two failures this must never allow are an operator believing
 * demo work was recorded, and an operator unable to get back to the real shop.
 */

const companyContext = {
  companyId: 'demo-1',
  companyName: 'Contour Tool & Machine' as string | null,
  isDemo: true,
  hasDemo: true,
  demoCompanyId: null as string | null,
  realCompanyId: 'co-1' as string | null,
  features: {},
  loading: false,
};

// `next/navigation` is already mocked by test-utils, and `routerMocks.push` is the handle it
// exposes. Declaring a second mock for it here would shadow that one and silently assert
// against a router nothing calls.
vi.mock('@/components/operator/OperatorCompanyContext', () => ({
  useOperatorCompany: () => companyContext,
}));

beforeEach(() => {
  routerMocks.push.mockClear();
  companyContext.isDemo = true;
  companyContext.realCompanyId = 'co-1';
});

describe('OperatorDemoBar', () => {
  it('renders nothing in a real company', () => {
    // The cost of a false positive here is a warning strip over a real shop's job list,
    // telling an operator their actual work does not count.
    companyContext.isDemo = false;

    const { container } = render(<OperatorDemoBar />);

    expect(container).toBeEmptyDOMElement();
  });

  it('says you are in demo mode, in the same words as the office', () => {
    // The office banner opens "You're in demo mode. Changes here won't affect your real
    // company." This is that first clause; the second does not fit beside a 48px button at
    // 375px. Same words, so an admin saying "you're in demo mode" matches the screen.
    render(<OperatorDemoBar />);

    expect(screen.getByText(/You're in demo mode/)).toBeInTheDocument();
  });

  it('takes its colours from the theme Alert rather than hand-picked ones', () => {
    /**
     * REGRESSION, and the reason this is an Alert at all. The first version hand-rolled an
     * amber Box and set `color: 'common.black'` on the row for the message to inherit. It
     * does not inherit: the theme gives `body2` an explicit colour (#C8CCD4, lib/theme.ts),
     * and a variant's own colour beats a parent's inherited one. Measured in a real browser:
     * light grey on amber, about 1.9:1 against WCAG AA's 4.5:1 floor — on the one element
     * whose entire job is to tell an operator their work is not being recorded. It survived a
     * screenshot review, because #C8CCD4 on amber still reads as "darkish text on a warning
     * strip" at a glance.
     *
     * `severity="info"` hands contrast back to MUI's theme-aware Alert palette, which is what
     * the office banner already relies on. Asserting the ROLE rather than a colour: the point
     * is that no colour is being chosen here, so a colour assertion would re-add the coupling
     * this removed.
     */
    const { container } = render(<OperatorDemoBar />);

    const alert = container.querySelector('.MuiAlert-root');
    expect(alert).not.toBeNull();
    expect(alert!.className).toContain('MuiAlert-standardInfo');
  });

  it('leaves to the real company, not the demo', async () => {
    const user = userEvent.setup();
    render(<OperatorDemoBar />);

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(routerMocks.push).toHaveBeenCalledWith('/operator/co-1/jobs');
  });

  it('stays up but inert when the source company has not resolved', () => {
    // A failed reverse lookup is a dropped request, not evidence that this is a real
    // company. The bar must keep telling the truth — `isDemo` comes off the company's own
    // row and is unaffected — while refusing to navigate somewhere wrong.
    companyContext.realCompanyId = null;

    render(<OperatorDemoBar />);

    expect(screen.getByText(/You're in demo mode/)).toBeInTheDocument();
    // Asserted as disabled rather than clicked: userEvent refuses a `pointer-events: none`
    // element, so "click it and expect nothing" cannot express this.
    expect(screen.getByRole('button', { name: 'Leave' })).toBeDisabled();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });
});
