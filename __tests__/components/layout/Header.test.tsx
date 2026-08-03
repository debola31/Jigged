import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../test-utils';
import Header from '@/components/layout/Header';

const mockSignOut = vi.fn();
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u1', user_metadata: { first_name: 'Shane' } },
    signOut: mockSignOut,
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

  it('still renders the page title and sign out', () => {
    render(<Header />);

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  // The bell that used to sit in this slot was removed in August 2026 — at-risk jobs
  // were measured wrong and low stock is the parts shortage lens. Pinned so it doesn't
  // come back by habit.
  it('has no alerts bell', () => {
    render(<Header />);

    expect(screen.queryByRole('button', { name: /alert/i })).not.toBeInTheDocument();
  });
});
