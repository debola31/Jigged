import { describe, it, expect, vi, beforeEach } from 'vitest';

import { render, waitFor, routerMocks, resetRouterMocks, setSearchParams } from '../../test-utils';
import LoginPage from '@/app/login/page';

/**
 * The /login page once the visitor is signed in, which is also the moment just after the form
 * signs them in: the page must send them where they were headed, not home. A bare
 * replace('/') here overrode the form's own push to `returnTo`, so every returnTo (an AI
 * assistant's consent page, an expired session, an invitation) landed on the dashboard.
 */

const mockUseAuth = vi.fn();
vi.mock('@/components/providers/AuthProvider', () => ({ useAuth: () => mockUseAuth() }));

describe('/login when signed in', () => {
  beforeEach(() => {
    resetRouterMocks();
    setSearchParams();
    mockUseAuth.mockReturnValue({ user: { id: 'user-1' }, loading: false });
  });

  it('goes to returnTo, query string intact', async () => {
    const consent = '/oauth/consent?authorization_id=abc123';
    setSearchParams({ returnTo: consent });
    render(<LoginPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith(consent));
    expect(routerMocks.replace).not.toHaveBeenCalledWith('/');
  });

  it('goes home without a returnTo', async () => {
    render(<LoginPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith('/'));
  });

  it('never follows a returnTo off the allowlist', async () => {
    setSearchParams({ returnTo: 'https://evil.example/dashboard' });
    render(<LoginPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith('/'));
  });
});
