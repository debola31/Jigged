import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within, routerMocks, resetRouterMocks } from '../../test-utils';
import AccountMenu from '@/components/layout/AccountMenu';

/**
 * These tests go through the real `useCurrentMember`, stubbing only the data layer beneath it.
 * That is deliberate: the bug this component exists to fix was a WIRING bug — the header read
 * `user_metadata.first_name` while the name actually lived on `user_company_access` — so a test
 * that mocked the hook would assert the component renders whatever it is handed and prove nothing
 * about where the name comes from. Every `useAuth` stub below therefore has an EMPTY
 * `user_metadata`, and the name still has to appear.
 */

const mockSignOut = vi.fn();
const mockGetCurrentMember = vi.fn();

vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: (companyId: string) => mockGetCurrentMember(companyId),
}));

let authUser: { id: string; email?: string; user_metadata: Record<string, unknown> } | null = null;
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: authUser, signOut: mockSignOut }),
}));

/** Opens the menu and returns the trigger, so callers can assert focus returns to it. */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole('button', { name: /account/i });
  await user.click(trigger);
  await screen.findByRole('menu');
  return trigger;
}

describe('AccountMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    authUser = { id: 'u1', email: 'hello@jigged.app', user_metadata: {} };
    mockGetCurrentMember.mockResolvedValue({
      id: 'm1',
      name: 'Test User',
      user_id: 'u1',
      role: 'admin',
      reactions_seen_at: null,
    });
  });

  // The reported bug, pinned. `Welcome, {firstName}` read `user_metadata.first_name`, a key only
  // two sign-up paths ever write — so an account created any other way showed NOTHING, while the
  // Team page one route away showed the same person's name correctly off `user_company_access`.
  it('names the signed-in person from their company membership, not from auth metadata', async () => {
    render(<AccountMenu />);

    expect(await screen.findByText('Test User')).toBeInTheDocument();
    expect(mockGetCurrentMember).toHaveBeenCalledWith('test-company-id');
  });

  // The whole reason the component exists: two accounts can share a first name, so the office
  // surface has to be able to answer WHICH account, not just roughly who.
  it('states the signed-in email, so the account is identifiable and not just the person', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    await openMenu(user);

    expect(screen.getByText('hello@jigged.app')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  // `user_company_access.name` is nullable. Leading with the email is honest; synthesising a name
  // from its local part would invent identity, which is the opposite of what this is for.
  it('leads with the email rather than a blank line when the member has no name', async () => {
    mockGetCurrentMember.mockResolvedValue({
      id: 'm1',
      name: null,
      user_id: 'u1',
      role: 'user',
      reactions_seen_at: null,
    });
    const user = userEvent.setup();
    render(<AccountMenu />);
    await openMenu(user);

    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('hello@jigged.app')).toBeInTheDocument();
    // Exactly one line carries the email — it was promoted, not duplicated into both slots.
    expect(within(menu).getAllByText('hello@jigged.app')).toHaveLength(1);
  });

  // A lookup that fails must not take the way out with it — the same promise useOperatorIdentity
  // makes for the operator's Log out button.
  it('still reaches sign out when the identity lookup fails', async () => {
    mockGetCurrentMember.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<AccountMenu />);
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: /sign out/i }));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  });

  // docs/interaction-standards.md §1: the destructive option sits at the END, away from the benign
  // ones, so it is predictably located rather than crowded next to something routine.
  it('puts sign out last, after the benign actions', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    await openMenu(user);

    const items = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(items[items.length - 1]).toMatch(/sign out/i);
    expect(items).toContain('Change password');
  });

  it('signs out and returns to the marketing home', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: /sign out/i }));

    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    // No scope argument — AuthProvider's `local` default is what keeps the same person signed in
    // on the shop-floor phone in their pocket. Passing a scope here would silently revoke it.
    expect(mockSignOut).toHaveBeenCalledWith();
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith('/'));
  });

  it('offers a way to change password, which nothing else in the office chrome does', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    await openMenu(user);

    expect(screen.getByRole('menuitem', { name: /change password/i })).toHaveAttribute(
      'href',
      '/change-password',
    );
  });

  // Under `md` the avatar is all that survives, and this repo has twice rejected a bare glyph in
  // this header (Header.tsx "Shop floor", operator layout: "our audience skews 50-60, where icon
  // recognition is measurably worse"). The name must be on screen on desktop, and the control must
  // be named at BOTH widths.
  it('shows the name on screen on a desktop, and stays named when it collapses on a phone', async () => {
    const { unmount } = render(<AccountMenu />);
    expect(await screen.findByRole('button', { name: 'Account: Test User' })).toBeInTheDocument();
    expect(screen.getByText('Test User')).toBeInTheDocument();
    unmount();

    render(<AccountMenu isMobile />);
    expect(await screen.findByRole('button', { name: 'Account: Test User' })).toBeInTheDocument();
    expect(screen.queryByText('Test User')).not.toBeInTheDocument();
  });

  // WAI-ARIA menu button pattern. `aria-expanded` is the only thing that tells a screen-reader user
  // the trigger opens something and whether it is open.
  it('announces itself as a menu button and tracks its own open state', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    const trigger = await screen.findByRole('button', { name: /account/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes on Escape and hands focus back to the trigger', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    const trigger = await openMenu(user);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  /**
   * The identity block is a statement, not an action. Without MUI's `muiSkipListHighlight`,
   * `MenuList` picks the first non-disabled child as `activeItemIndex` and clones `autoFocus` and
   * `tabIndex={0}` onto it — which would make the name/email block focusable, steal the menu's
   * opening focus, and put a no-op at the first stop of every keyboard user's arrow-down. This
   * fails if that static is ever dropped.
   */
  it('opens with focus on a real action, not on the identity block', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    await openMenu(user);

    expect(screen.getByRole('menuitem', { name: /change password/i })).toHaveFocus();
  });
});
