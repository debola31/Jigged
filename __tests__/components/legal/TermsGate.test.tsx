/**
 * The re-acceptance gate.
 *
 * Two properties matter more than the rest and both are about failing in the
 * right direction: a check that did not complete must NOT render as a block,
 * and an operator must never be shown a tally of their own dismissals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import jiggedTheme from '@/lib/theme';

/**
 * Deliberately NOT ../../test-utils. That helper mocks next/navigation with a
 * hard-coded usePathname of '/dashboard/test-company-id', and importing it
 * registers that mock — which would silently defeat every assertion here, since
 * this component's entire job is to behave differently per pathname.
 */
function render(ui: React.ReactElement) {
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <ThemeProvider theme={jiggedTheme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    ),
  });
}

const mockPathname = vi.fn(() => '/dashboard/c1/jobs');
const mockStatus = vi.fn();
const mockSignOut = vi.fn();
const mockCapture = vi.fn();

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('next/navigation');
  return { ...actual, usePathname: () => mockPathname() };
});

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, loading: false, signOut: mockSignOut }),
}));

vi.mock('@/hooks/useTermsStatus', () => ({ useTermsStatus: () => mockStatus() }));

vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => mockCapture(...a) } }));

const mockRecord = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/legal/acceptClient', () => ({
  recordTermsAcceptance: (...a: unknown[]) => mockRecord(...a),
  StaleLegalVersionError: class extends Error {},
}));

import TermsGate from '@/components/legal/TermsGate';

const refresh = vi.fn();
const resolved = (needs: string[]) => ({ state: 'resolved', needs, refresh });

beforeEach(() => {
  vi.clearAllMocks();
  mockPathname.mockReturnValue('/dashboard/c1/jobs');
  mockStatus.mockReturnValue(resolved(['tos']));
  let store: Record<string, string> = {};
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => delete store[k],
      clear: () => {
        store = {};
      },
    },
  });
});

const dialog = () => screen.findByRole('dialog');

describe('TermsGate — when it blocks', () => {
  it('blocks the dashboard until the current version is accepted', async () => {
    render(<TermsGate />);
    expect(await dialog()).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /i agree to the terms/i })).not.toBeChecked();
  });

  /**
   * A blocking modal that flashes is far worse than a banner that does —
   * BillingBanner returns null until resolved for the same reason.
   */
  it('never renders while the status is still resolving', () => {
    mockStatus.mockReturnValue({ state: 'loading', refresh });
    render(<TermsGate />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  /**
   * "Couldn't check" is never "denied". There is nothing the user needs FROM
   * this check, so proceeding is correct and the next navigation retries free.
   */
  it('renders nothing, not a block, when the status query failed', () => {
    mockStatus.mockReturnValue({ state: 'unknown', refresh });
    render(<TermsGate />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders nothing when the user is already current', () => {
    mockStatus.mockReturnValue(resolved([]));
    render(<TermsGate />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never covers the document it is asking the user to read', () => {
    mockPathname.mockReturnValue('/terms');
    render(<TermsGate />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never covers the sign-in path', () => {
    mockPathname.mockReturnValue('/login');
    render(<TermsGate />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('TermsGate — accepting', () => {
  it('records the acceptance and re-asks the status', async () => {
    const user = userEvent.setup();
    render(<TermsGate />);
    await dialog();

    await user.click(screen.getByRole('checkbox', { name: /i agree to the terms/i }));
    await user.click(screen.getByRole('button', { name: /i agree — continue/i }));

    await waitFor(() => expect(mockRecord).toHaveBeenCalled());
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ acceptedVia: 'reacceptance_dashboard' });
    expect(refresh).toHaveBeenCalled();
  });

  it('will not submit until the box is ticked', async () => {
    render(<TermsGate />);
    await dialog();
    expect(screen.getByRole('button', { name: /i agree — continue/i })).toBeDisabled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('TermsGate — the operator surface', () => {
  beforeEach(() => mockPathname.mockReturnValue('/operator/c1'));

  it('offers Remind me later on the shop floor, and Sign out on the dashboard', async () => {
    render(<TermsGate />);
    await dialog();
    expect(screen.getByRole('button', { name: /remind me later/i })).toBeInTheDocument();
    // Never both: a mis-tapped Sign out costs an operator their station.
    expect(screen.queryByRole('button', { name: /^sign out$/i })).not.toBeInTheDocument();
  });

  it('closes when deferred, so a shift is never halted', async () => {
    const user = userEvent.setup();
    render(<TermsGate />);
    await dialog();
    await user.click(screen.getByRole('button', { name: /remind me later/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  /**
   * THE SURVEILLANCE GUARDRAIL. Across every dismissal the operator sees the
   * same screen and the same button. A disappearing affordance is not a
   * read-back of behaviour; a number would be, and operator surfaces may not
   * reflect an operator's own activity back at them.
   */
  it('never shows the operator how many times they have deferred', async () => {
    const { container } = render(<TermsGate />);
    await dialog();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\b[1-5]\s*(of|\/)\s*5\b/);
    expect(text).not.toMatch(/\b\d+\s*(dismissal|reminder|attempt)s?\b/i);
    expect(text).not.toMatch(/\blast (chance|reminder)\b/i);
  });

  it('stops offering the escape once the cap is spent', async () => {
    window.localStorage.setItem(
      'jigged.terms.deferrals.tos.1',
      JSON.stringify({ count: 5, firstPromptedAt: '2026-09-01T00:00:00Z' }),
    );
    render(<TermsGate />);
    await dialog();
    expect(screen.queryByRole('button', { name: /remind me later/i })).not.toBeInTheDocument();
    // Still not trapped — there are always exactly two ways out.
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
