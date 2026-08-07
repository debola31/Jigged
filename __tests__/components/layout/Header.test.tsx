import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../test-utils';
import Header from '@/components/layout/Header';

const mockSignOut = vi.fn();
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'shane@lltool.test', user_metadata: {} },
    signOut: mockSignOut,
  }),
}));

// The header composes the account menu; what the menu itself does with this data — and the fact
// that the name comes off `user_company_access` rather than auth metadata — is pinned in
// AccountMenu.test.tsx. Note the auth stub above deliberately carries no `user_metadata.first_name`:
// the header must not depend on it again.
vi.mock('@/hooks/useCurrentMember', () => ({
  useCurrentMember: () => ({
    name: 'Shane Miller',
    email: 'shane@lltool.test',
    role: 'admin',
    loading: false,
  }),
}));

const mockUseDemoMode = vi.fn();
vi.mock('@/components/providers/DemoModeProvider', () => ({
  useDemoMode: () => mockUseDemoMode(),
}));

vi.mock('@/components/layout/PageTitleProvider', () => ({
  usePageTitle: () => ({ title: null }),
}));

describe('Header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDemoMode.mockReturnValue({ isDemoMode: false });
  });

  // This control is the reason the whole entry-point change exists: on a phone the
  // sidebar is behind a hamburger, so the header is the only always-visible office
  // chrome — and a phone is where an owner-operator reaches for the shop floor.
  it('offers a labelled way to the shop floor', () => {
    render(<Header />);

    const shopFloor = screen.getByRole('link', { name: /shop floor/i });
    expect(shopFloor).toHaveAttribute('href', '/operator/test-company-id');
  });

  it('keeps the shop-floor door visible on a phone, where the sidebar is hidden', () => {
    render(<Header isMobile />);

    // Labelled at both sizes on purpose. Sign Out collapses to an icon on mobile; this
    // one must not, because an unlabelled icon assumes the viewer already knows the app
    // has two surfaces, which is exactly what they don't know.
    expect(screen.getByRole('link', { name: /shop floor/i })).toBeInTheDocument();
  });

  it('still renders the page title', () => {
    render(<Header />);

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  // The office surface used to have no way to confirm which account you were in as — the shop
  // floor did, and the header's `Welcome, {firstName}` read a key most accounts never had. Identity
  // is now on screen at rest, without a click.
  it('says who is signed in without making anyone open anything', () => {
    render(<Header />);

    expect(screen.getByText('Shane Miller')).toBeInTheDocument();
  });

  // Sign out did not disappear, it moved: it lives with the identity it belongs to instead of
  // sitting bare beside Shop floor, where at phone widths one mis-tap ended the session.
  it('reaches sign out through the account menu', async () => {
    const user = userEvent.setup();
    render(<Header />);

    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /account/i }));
    expect(await screen.findByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });

  // The bell that used to sit in this slot was removed in August 2026 — at-risk jobs
  // were measured wrong and low stock is the parts shortage lens. Pinned so it doesn't
  // come back by habit.
  it('has no alerts bell', () => {
    render(<Header />);

    expect(screen.queryByRole('button', { name: /alert/i })).not.toBeInTheDocument();
  });
});
