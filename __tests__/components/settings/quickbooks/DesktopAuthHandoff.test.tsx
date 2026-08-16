import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '../../../test-utils';
import userEvent from '@testing-library/user-event';
import DesktopAuthHandoff from '@/components/settings/quickbooks/DesktopAuthHandoff';

/**
 * The regression this file exists for reached production: with no link in hand,
 * "I'm on that computer" called window.open('') and opened about:blank, which
 * reads as "Conductor is broken" rather than "setup was never finished".
 *
 * The URL lives only in the /connect response — nothing persists it — so an
 * empty string is the NORMAL state after any reload of Settings while setup is
 * half-done, not an edge case.
 */

const URL = 'https://connect.conductor.is/qbd/auth_sess_client_secret_abc123';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openSpy = vi.fn(() => ({ opener: null }) as unknown as Window);
  vi.stubGlobal('open', openSpy);
});
afterEach(() => vi.unstubAllGlobals());

function setup(props: Partial<React.ComponentProps<typeof DesktopAuthHandoff>> = {}) {
  const onNewLink = vi.fn();
  render(
    <DesktopAuthHandoff
      authFlowUrl={URL}
      expiresAt={FUTURE}
      onCheckNow={vi.fn()}
      onNewLink={onNewLink}
      {...props}
    />,
  );
  return { onNewLink };
}

describe('DesktopAuthHandoff', () => {
  it('opens the setup page when there is a link', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: /I'm on that computer/i }));
    expect(openSpy).toHaveBeenCalledWith(URL, '_blank');
  });

  it('offers a fresh link instead of a dead button when there is no url', async () => {
    const { onNewLink } = setup({ authFlowUrl: '' });

    // The broken affordance must not be reachable at all.
    expect(screen.queryByRole('button', { name: /I'm on that computer/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Setup was started but not finished/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /get a new link/i }));
    expect(onNewLink).toHaveBeenCalled();
    // Nothing was opened — no about:blank tab.
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('never calls window.open with an empty url', async () => {
    setup({ authFlowUrl: '' });
    // Even if a future refactor renders the button again, the guard holds.
    for (const b of screen.queryAllByRole('button')) await userEvent.click(b);
    for (const call of openSpy.mock.calls) expect(call[0]).toBeTruthy();
  });

  it('still reports an expired link separately from a missing one', () => {
    setup({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(screen.getByText(/that setup link has expired/i)).toBeInTheDocument();
  });
});
