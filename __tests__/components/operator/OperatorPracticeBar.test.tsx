import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, routerMocks } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import OperatorPracticeBar from '@/components/operator/OperatorPracticeBar';

/**
 * The practice bar says the data is not real, and is the way out.
 *
 * WHAT THIS GUARDS. Before it existed the operator surface had no demo awareness at all: an
 * admin who entered demo mode in the office and tapped "Shop floor" landed on a shop-floor
 * screen showing fabricated jobs with nothing saying so, and the header's "Office" button
 * pushes `/dashboard/{companyId}` from the raw route param — carrying them back into the demo
 * dashboard rather than out. The two failures this must never allow are an operator believing
 * practice work was recorded, and an operator unable to get back to the real shop.
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

describe('OperatorPracticeBar', () => {
  it('renders nothing in a real company', () => {
    // The cost of a false positive here is a warning strip over a real shop's job list,
    // telling an operator their actual work does not count.
    companyContext.isDemo = false;

    const { container } = render(<OperatorPracticeBar />);

    expect(container).toBeEmptyDOMElement();
  });

  it('says the data is not real', () => {
    render(<OperatorPracticeBar />);

    expect(screen.getByText(/Practice mode/)).toBeInTheDocument();
    expect(screen.getByText(/nothing here is real/)).toBeInTheDocument();
  });

  it('sets the message colour on the Typography, where it actually wins', () => {
    /**
     * REGRESSION. The bar's amber (`warning.main`, #f59e0b) needs dark text, so `color:
     * 'common.black'` was set on the row and left to inherit. It does not: the theme gives
     * `body2` an explicit colour (#C8CCD4, lib/theme.ts), and a variant's own colour beats a
     * parent's inherited one. Measured in a real browser at the time: light grey on amber,
     * about 1.9:1 against WCAG AA's 4.5:1 floor — on the one element whose entire job is to
     * tell an operator their work is not being recorded.
     *
     * It survived a screenshot review, because #C8CCD4 on amber still reads as "darkish text
     * on a warning strip" at a glance. Asserted on the element's own style rather than a
     * computed contrast ratio, which jsdom cannot give honestly.
     */
    render(<OperatorPracticeBar />);

    const message = screen.getByText(/Practice mode/);
    expect(message).toHaveStyle({ color: 'rgb(0, 0, 0)' });
  });

  it('leaves to the real company, not the demo', async () => {
    const user = userEvent.setup();
    render(<OperatorPracticeBar />);

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(routerMocks.push).toHaveBeenCalledWith('/operator/co-1/jobs');
  });

  it('stays up but inert when the source company has not resolved', () => {
    // A failed reverse lookup is a dropped request, not evidence that this is a real
    // company. The bar must keep telling the truth — `isDemo` comes off the company's own
    // row and is unaffected — while refusing to navigate somewhere wrong.
    companyContext.realCompanyId = null;

    render(<OperatorPracticeBar />);

    expect(screen.getByText(/Practice mode/)).toBeInTheDocument();
    // Asserted as disabled rather than clicked: userEvent refuses a `pointer-events: none`
    // element, so "click it and expect nothing" cannot express this.
    expect(screen.getByRole('button', { name: 'Leave' })).toBeDisabled();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });
});
