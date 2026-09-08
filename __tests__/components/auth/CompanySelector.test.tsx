import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  waitFor,
  fireEvent,
  routerMocks,
  resetRouterMocks,
} from '../../test-utils';
import userEvent from '@testing-library/user-event';
import CompanySelector from '@/components/auth/CompanySelector';

const useAuthMock = vi.fn();
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => useAuthMock(),
}));

const getUserCompanies = vi.fn();
const setLastCompany = vi.fn();
vi.mock('@/utils/companyAccess', () => ({
  getUserCompanies: (...args: unknown[]) => getUserCompanies(...args),
  setLastCompany: (...args: unknown[]) => setLastCompany(...args),
  // Real one-liner rather than a vi.fn(), so these tests assert the destination the
  // component actually navigates to. The function's own edge cases live in
  // __tests__/utils/homePathForRole.test.ts.
  homePathForRole: (role: string | null | undefined, companyId: string) =>
    role === 'operator' ? `/operator/${companyId}` : `/dashboard/${companyId}`,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

const getSignedUrls = vi.fn(async (paths: string[]) =>
  new Map(paths.map((path) => [path, `https://signed.test/${path}`])),
);

vi.mock('@/utils/storageHelpers', () => ({
  getSignedUrls: (...args: [string[], number?, string?]) => getSignedUrls(...args),
  LOGOS_BUCKET: 'logos',
}));

describe('CompanySelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    useAuthMock.mockReturnValue({ user: { id: 'user-1', email: 'a@b.co' } });
    getUserCompanies.mockResolvedValue([
      { user_id: 'user-1', company_id: 'co-a', role: 'admin', companies: { id: 'co-a', name: 'Acme Corp' } },
      { user_id: 'user-1', company_id: 'co-b', role: 'user', companies: { id: 'co-b', name: 'Beta LLC' } },
    ]);
    setLastCompany.mockResolvedValue(undefined);
  });

  it('renders the company list with names and roles', async () => {
    render(<CompanySelector />);

    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Beta LLC')).toBeInTheDocument();
    expect(screen.getByText('Role: admin')).toBeInTheDocument();
    expect(screen.getByText('Role: user')).toBeInTheDocument();
  });

  it('shows a loading spinner before companies resolve', () => {
    // Don't resolve — leave the promise hanging
    getUserCompanies.mockReturnValueOnce(new Promise(() => {}));
    render(<CompanySelector />);

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /select company/i })).not.toBeInTheDocument();
  });

  it('redirects to /no-access when the user has zero companies', async () => {
    getUserCompanies.mockResolvedValueOnce([]);
    render(<CompanySelector />);

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/no-access');
    });
  });

  it('shows an error message when company fetch fails', async () => {
    getUserCompanies.mockRejectedValueOnce(new Error('Network blew up'));
    render(<CompanySelector />);

    expect(
      await screen.findByText(/failed to load companies/i),
    ).toBeInTheDocument();
  });

  it('calls setLastCompany + navigates to the selected dashboard on click', async () => {
    render(<CompanySelector />);
    const acme = await screen.findByText('Acme Corp');

    const user = userEvent.setup();
    await user.click(acme);

    await waitFor(() => {
      expect(setLastCompany).toHaveBeenCalledWith('user-1', 'co-a');
      expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/co-a');
    });
  });

  // A multi-company operator used to be pushed to /dashboard and then bounced back out
  // by AuthGuard. It worked, but it cost a round trip and a flash on the way in.
  it('sends an operator straight to the shop floor, not through the dashboard', async () => {
    getUserCompanies.mockResolvedValueOnce([
      { user_id: 'user-1', company_id: 'co-a', role: 'operator', companies: { id: 'co-a', name: 'Acme Corp' } },
      { user_id: 'user-1', company_id: 'co-b', role: 'user', companies: { id: 'co-b', name: 'Beta LLC' } },
    ]);
    render(<CompanySelector />);

    const user = userEvent.setup();
    await user.click(await screen.findByText('Acme Corp'));

    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith('/operator/co-a');
    });
  });

  it('shows an error when setLastCompany fails (does not navigate)', async () => {
    setLastCompany.mockRejectedValueOnce(new Error('DB unreachable'));
    render(<CompanySelector />);

    const acme = await screen.findByText('Acme Corp');
    const user = userEvent.setup();
    await user.click(acme);

    expect(await screen.findByText(/failed to select company/i)).toBeInTheDocument();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it('does not fetch companies when user is null', async () => {
    useAuthMock.mockReturnValue({ user: null });
    render(<CompanySelector />);

    // The loading spinner stays visible because the early-return in the
    // effect skips both the fetch and the setLoading(false). That's the
    // intended behavior — the component expects to be rendered only after
    // auth resolves.
    await new Promise((r) => setTimeout(r, 50));
    expect(getUserCompanies).not.toHaveBeenCalled();
  });
});

/**
 * The login picker follows the same rule as the sidebar switcher: a logo that carries the shop's
 * name replaces that name, and anything else keeps the row it has always had. This is the first
 * screen a multi-shop user sees, and every row here used to be the same generic building icon.
 */
describe('CompanySelector logos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    useAuthMock.mockReturnValue({ user: { id: 'user-1', email: 'a@b.co' } });
    setLastCompany.mockResolvedValue(undefined);
  });

  it('shows the wordmark INSTEAD of the name when the logo carries it', async () => {
    getUserCompanies.mockResolvedValue([
      {
        user_id: 'user-1',
        company_id: 'co-a',
        role: 'admin',
        companies: {
          id: 'co-a',
          name: 'Acme Corp',
          logo_url: 'co-a/company/logo_ab12_acme.png',
          settings: { logo_includes_name: true },
        },
      },
    ]);
    render(<CompanySelector />);

    const logo = await screen.findByRole('img', { name: 'Acme Corp' });
    expect(logo).toHaveAttribute('src', 'https://signed.test/co-a/company/logo_ab12_acme.png');
    expect(screen.queryByText('Acme Corp')).toBeNull();
    // The role line survives — it is the one thing the wordmark cannot say.
    expect(screen.getByText('Role: admin')).toBeInTheDocument();
  });

  it('keeps the name for a logo that does not contain it', async () => {
    getUserCompanies.mockResolvedValue([
      {
        user_id: 'user-1',
        company_id: 'co-a',
        role: 'admin',
        companies: {
          id: 'co-a',
          name: 'Acme Corp',
          logo_url: 'co-a/company/logo_ab12_emblem.png',
          settings: { logo_includes_name: false },
        },
      },
    ]);
    render(<CompanySelector />);

    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Acme Corp' })).toBeNull();
    expect(getSignedUrls).not.toHaveBeenCalled();
  });

  it('falls back to the name when the logo fails to load', async () => {
    getUserCompanies.mockResolvedValue([
      {
        user_id: 'user-1',
        company_id: 'co-a',
        role: 'admin',
        companies: {
          id: 'co-a',
          name: 'Acme Corp',
          logo_url: 'co-a/company/logo_ab12_acme.png',
          settings: { logo_includes_name: true },
        },
      },
    ]);
    render(<CompanySelector />);

    fireEvent.error(await screen.findByRole('img', { name: 'Acme Corp' }));

    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
  });
});
