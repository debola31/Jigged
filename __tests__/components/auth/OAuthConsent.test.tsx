import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor, routerMocks, resetRouterMocks, setSearchParams } from '../../test-utils';
import OAuthConsent from '@/components/auth/OAuthConsent';

/**
 * Connecting an AI assistant to Jigged: what the person sees, and what each choice sends back.
 */

const mockUseAuth = vi.fn();
vi.mock('@/components/providers/AuthProvider', () => ({ useAuth: () => mockUseAuth() }));

const mockGetDetails = vi.fn();
const mockApprove = vi.fn();
const mockDeny = vi.fn();
const mockSignOut = vi.fn();
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    auth: {
      oauth: {
        getAuthorizationDetails: (...a: unknown[]) => mockGetDetails(...a),
        approveAuthorization: (...a: unknown[]) => mockApprove(...a),
        denyAuthorization: (...a: unknown[]) => mockDeny(...a),
      },
      signOut: (...a: unknown[]) => mockSignOut(...a),
    },
  }),
}));

const mockGetUserCompanies = vi.fn();
vi.mock('@/utils/companyAccess', () => ({
  getUserCompanies: (...a: unknown[]) => mockGetUserCompanies(...a),
}));

const mockCapture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => mockCapture(...a) } }));

const DETAILS = {
  authorization_id: 'auth-1',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  client: { id: 'client-9', name: 'Claude', uri: 'https://claude.ai', logo_uri: '' },
  user: { id: 'user-1', email: 'owner@shop.test' },
  scope: 'openid email profile',
};

const assign = vi.fn();

describe('OAuthConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    setSearchParams({ authorization_id: 'auth-1' });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...new URL('http://localhost:3000/oauth/consent?authorization_id=auth-1'), assign },
    });
    mockUseAuth.mockReturnValue({ user: { id: 'user-1' }, loading: false });
    mockGetDetails.mockResolvedValue({ data: DETAILS, error: null });
    mockGetUserCompanies.mockResolvedValue([
      { company_id: 'co-1', role: 'admin', companies: { id: 'co-1', name: 'Acme Machining' } },
      { company_id: 'co-2', role: 'operator', companies: { id: 'co-2', name: 'Gamma Works' } },
    ]);
    mockApprove.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/cb?code=xyz' }, error: null });
    mockDeny.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/cb?error=access_denied' }, error: null });
  });

  it('sends a signed-out visitor to sign in and straight back to this request', async () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });
    render(<OAuthConsent />);
    await waitFor(() =>
      expect(routerMocks.replace).toHaveBeenCalledWith(
        `/login?returnTo=${encodeURIComponent('/oauth/consent?authorization_id=auth-1')}`,
      ),
    );
    expect(mockGetDetails).not.toHaveBeenCalled();
  });

  it('names the assistant, where it returns to, and only the office companies it reaches', async () => {
    render(<OAuthConsent />);
    expect(await screen.findByRole('heading', { name: 'Connect Claude to Jigged' })).toBeInTheDocument();
    expect(screen.getByText('claude.ai')).toBeInTheDocument();
    expect(screen.getByText(/Acme Machining/)).toBeInTheDocument();
    // An operator company is not one the assistant can work in, so it is not offered as one.
    expect(screen.queryByText(/Gamma Works/)).not.toBeInTheDocument();
    expect(screen.getByText(/Signed in as owner@shop\.test/)).toBeInTheDocument();
  });

  it('Allow approves, records the connection and returns to the assistant', async () => {
    render(<OAuthConsent />);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?code=xyz'));
    expect(mockApprove).toHaveBeenCalledWith('auth-1', { skipBrowserRedirect: true });
    expect(mockCapture).toHaveBeenCalledWith('ai assistant connected', { client_kind: 'claude' });
  });

  it('Cancel denies and returns to the assistant without recording a connection', async () => {
    render(<OAuthConsent />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?error=access_denied'));
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('keeps the person on the page with a sentence when approval fails', async () => {
    mockApprove.mockResolvedValue({ data: null, error: new Error('authorization expired') });
    render(<OAuthConsent />);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(await screen.findByText(/couldn’t finish connecting/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('offers an operator-only login no Allow, only the way back', async () => {
    mockGetUserCompanies.mockResolvedValue([
      { company_id: 'co-2', role: 'operator', companies: { id: 'co-2', name: 'Gamma Works' } },
    ]);
    render(<OAuthConsent />);
    expect(await screen.findByRole('heading', { name: /can’t connect an AI assistant/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to Claude' }));
    await waitFor(() => expect(mockDeny).toHaveBeenCalledWith('auth-1', { skipBrowserRedirect: true }));
  });

  it('refuses a look-alike assistant: no Allow, the real return address, and Cancel', async () => {
    // Registration is open, so the name is whatever a phisher typed. The redirect host is where the
    // code would go, and it is not one Jigged recognises, so approval is never offered.
    mockGetDetails.mockResolvedValue({
      data: { ...DETAILS, client: { ...DETAILS.client, name: 'Claude' }, redirect_uri: 'https://claude.ai.evil.example/cb' },
      error: null,
    });
    render(<OAuthConsent />);
    expect(await screen.findByRole('heading', { name: 'Jigged doesn’t recognise this assistant' })).toBeInTheDocument();
    expect(screen.getByText('claude.ai.evil.example')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(mockDeny).toHaveBeenCalled());
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('goes straight back when this assistant was already approved', async () => {
    mockGetDetails.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/cb?code=again' }, error: null });
    render(<OAuthConsent />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?code=again'));
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('says the link expired when Supabase no longer knows the request', async () => {
    mockGetDetails.mockResolvedValue({ data: null, error: new Error('not found') });
    render(<OAuthConsent />);
    expect(await screen.findByRole('heading', { name: 'This connection link has expired' })).toBeInTheDocument();
  });

  it('says the link expired when it carries no authorization_id', async () => {
    setSearchParams();
    render(<OAuthConsent />);
    expect(await screen.findByRole('heading', { name: 'This connection link has expired' })).toBeInTheDocument();
    expect(mockGetDetails).not.toHaveBeenCalled();
  });
});
