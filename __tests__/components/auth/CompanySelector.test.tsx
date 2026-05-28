import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, routerMocks, resetRouterMocks } from '../../test-utils';
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
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
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
