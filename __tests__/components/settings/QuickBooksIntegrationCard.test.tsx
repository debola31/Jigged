import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, resetRouterMocks, setSearchParams } from '../../test-utils';
import QuickBooksIntegrationCard from '@/components/settings/QuickBooksIntegrationCard';
import type { QuickBooksStatus } from '@/utils/quickbooksAccess';

const mockGetStatus = vi.fn();
const mockStartConnect = vi.hoisted(() => vi.fn());
// The Purchasing panel's mount read: Jigged's own table, never QuickBooks (plan §3.13).
const mockGetPurchasingSetup = vi.hoisted(() => vi.fn());
const mockListPurchaseItems = vi.hoisted(() => vi.fn());

// Partial: the classifiers and error class the Purchasing panel imports stay real.
vi.mock('@/utils/quickbooksAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/quickbooksAccess')>()),
  getQuickBooksStatus: (...args: unknown[]) => mockGetStatus(...args),
  startQuickBooksConnect: (...args: unknown[]) => mockStartConnect(...args),
  disconnectQuickBooks: vi.fn(),
  getQuickBooksPurchasingSetup: (...args: unknown[]) => mockGetPurchasingSetup(...args),
  listQuickBooksPurchaseItems: (...args: unknown[]) => mockListPurchaseItems(...args),
}));

// The Purchasing panel hides its write actions from non-admins; Settings is admin-only.
vi.mock('@/hooks/useUserRole', () => ({
  useUserRole: () => ({ role: 'admin', isAdmin: true, loading: false }),
}));

const PURCHASING_NOT_SET_UP = {
  connected: true,
  provider: 'qbo',
  items: [],
  one_item_for_all: false,
  ap_account: null,
  preferences: null,
  missing: ['item:part', 'item:outside_service', 'item:other', 'ap_account'],
};

beforeEach(() => {
  mockGetPurchasingSetup.mockResolvedValue(PURCHASING_NOT_SET_UP);
});

// No useCompanyFeatures mock: the card stopped reading feature flags when `quickbooks_desktop`
// was retired (Aug 2026). Leaving an inert one here would keep "working" against a component that
// never calls it.

const mockGetDesktopStatus = vi.fn();
const mockStartDesktopConnect = vi.hoisted(() => vi.fn());
vi.mock('@/utils/quickbooksDesktop', () => ({
  getQuickBooksDesktopStatus: (...args: unknown[]) => mockGetDesktopStatus(...args),
  startQuickBooksDesktopConnect: (...args: unknown[]) => mockStartDesktopConnect(...args),
  testQuickBooksDesktop: vi.fn(),
  disconnectQuickBooksDesktop: vi.fn(),
  listQuickBooksDesktopAccounts: vi.fn(),
  setQuickBooksDesktopIncomeAccount: vi.fn(),
}));

const CONNECTED: QuickBooksStatus = {
  connected: true,
  environment: 'sandbox',
  qb_company_name: 'Sandbox Company_US_1',
  reconnect_required: false,
  connected_at: '2026-07-01T00:00:00Z',
};

describe('QuickBooksIntegrationCard — status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    mockGetStatus.mockResolvedValue(CONNECTED);
    mockGetDesktopStatus.mockResolvedValue({ connected: false, linked: false });
  });

  // The Customer PO number section was removed from Settings on 2026-11-09.
  it('shows the connected company and offers to disconnect', async () => {
    render(<QuickBooksIntegrationCard companyId="c1" />);

    expect(await screen.findByText('Sandbox Company_US_1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^disconnect$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Customer PO number/i)).not.toBeInTheDocument();
  });

  /**
   * Both providers, for every tenant, with no feature state set up anywhere in this file.
   *
   * Desktop used to sit behind the `quickbooks_desktop` flag, which was backend-enforced because
   * Conductor bills $49/month per connected company file. The flag was retired Aug 2026 and the
   * backend gate with it, so this now also covers the case the deleted "hides Desktop without the
   * flag" test used to own: there is no tenant for whom the button is absent.
   */
  it('offers both providers when nothing is connected', async () => {
    mockGetStatus.mockResolvedValue({ connected: false } as QuickBooksStatus);
    render(<QuickBooksIntegrationCard companyId="c1" />);

    expect(
      await screen.findByRole('button', { name: /Connect QuickBooks Online/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Connect QuickBooks Desktop/i }),
    ).toBeInTheDocument();
  });

  it('shows the Purchasing panel once QuickBooks Online is connected, reading only Jigged’s setup', async () => {
    render(<QuickBooksIntegrationCard companyId="c1" />);

    expect(await screen.findByRole('heading', { name: 'Purchasing' })).toBeInTheDocument();
    expect(await screen.findByText('QuickBooks item for purchases')).toBeInTheDocument();
    expect(mockGetPurchasingSetup).toHaveBeenCalledWith('c1');
    // Nothing that reaches QuickBooks runs on the way in.
    expect(mockListPurchaseItems).not.toHaveBeenCalled();
  });

  it('has no Purchasing panel until something is connected', async () => {
    mockGetStatus.mockResolvedValue({ connected: false } as QuickBooksStatus);
    render(<QuickBooksIntegrationCard companyId="c1" />);

    await screen.findByRole('button', { name: /Connect QuickBooks Online/i });
    expect(screen.queryByRole('heading', { name: 'Purchasing' })).not.toBeInTheDocument();
    expect(mockGetPurchasingSetup).not.toHaveBeenCalled();
  });

  it('QuickBooks Desktop: says "Purchasing setup needed" beside its own setup, with the panel inside', async () => {
    mockGetStatus.mockResolvedValue({ connected: false } as QuickBooksStatus);
    mockGetDesktopStatus.mockResolvedValue({
      connected: true,
      linked: true,
      qb_company_name: 'Rock Castle Construction',
      last_successful_request_at: null,
      needs_income_account: false,
    });
    mockGetPurchasingSetup.mockResolvedValue({
      ...PURCHASING_NOT_SET_UP,
      provider: 'qbd',
      missing: ['item:part', 'item:outside_service', 'item:other'],
    });
    render(<QuickBooksIntegrationCard companyId="c1" />);

    expect(await screen.findByText('Purchasing setup needed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Purchasing' })).toBeInTheDocument();
    // The panel sits above Disconnect, not after it.
    const disconnect = screen.getByRole('button', { name: /disconnect quickbooks desktop/i });
    const chooseItem = screen.getByRole('button', { name: 'Choose item' });
    expect(chooseItem.compareDocumentPosition(disconnect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not offer to connect when the status check itself failed', async () => {
    // A failed check is not a definitive "not connected". With two providers,
    // getting this wrong shows "pick a provider" to a shop that already has one.
    mockGetStatus.mockRejectedValue(new Error('network down'));
    render(<QuickBooksIntegrationCard companyId="c1" />);

    await screen.findByText(/network down/i);
    expect(
      screen.queryByRole('button', { name: /Connect QuickBooks Online/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Connect QuickBooks Desktop/i }),
    ).not.toBeInTheDocument();
    // And it must not assert a status it never learned.
    expect(screen.queryByText(/Not connected/i)).not.toBeInTheDocument();
  });
});

/**
 * Both connects are multi-second — QuickBooks Online round-trips our API for an
 * Intuit authorize URL before navigating away, and Desktop makes two Conductor
 * calls. A button that only greys out for that long reads as a dropped click,
 * which is what a shop reported about the panel's buttons.
 */
describe('QuickBooksIntegrationCard — connecting', () => {
  const user = userEvent.setup();

  /** A promise we control, so the in-flight state can actually be observed. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    // Not connected to either, so the provider choice renders.
    mockGetStatus.mockResolvedValue({
      connected: false,
      environment: 'sandbox',
      qb_company_name: null,
      reconnect_required: false,
      connected_at: null,
    });
    mockGetDesktopStatus.mockResolvedValue({ connected: false, linked: false });
  });

  it('says it is creating the setup link while Desktop connect is in flight', async () => {
    const d = deferred<{ auth_flow_url: string; expires_at: string }>();
    mockStartDesktopConnect.mockReturnValue(d.promise);

    render(<QuickBooksIntegrationCard companyId="c1" />);
    await user.click(await screen.findByRole('button', { name: /connect quickbooks desktop/i }));

    expect(await screen.findByRole('button', { name: /creating setup link/i })).toBeInTheDocument();
    // The other card is disabled meanwhile, but must not claim to be working.
    const online = screen.getByRole('button', { name: /connect quickbooks online/i });
    expect(online).toBeDisabled();
    expect(online).not.toHaveTextContent(/opening quickbooks/i);

    d.resolve({ auth_flow_url: 'https://connect.conductor.is/qbd/x', expires_at: null as never });
  });

  it('says it is opening QuickBooks while the Online connect is in flight', async () => {
    const d = deferred<string>();
    mockStartConnect.mockReturnValue(d.promise);

    render(<QuickBooksIntegrationCard companyId="c1" />);
    await user.click(await screen.findByRole('button', { name: /connect quickbooks online/i }));

    expect(await screen.findByRole('button', { name: /opening quickbooks/i })).toBeInTheDocument();
    d.resolve('https://appcenter.intuit.com/connect/oauth2?x=1');
  });

  it('restores the button when starting the connection fails', async () => {
    mockStartDesktopConnect.mockRejectedValue(new Error('Conductor is unavailable'));

    render(<QuickBooksIntegrationCard companyId="c1" />);
    await user.click(await screen.findByRole('button', { name: /connect quickbooks desktop/i }));

    // A spinner left running after a failure is how a retry becomes impossible.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /connect quickbooks desktop/i })).toBeEnabled(),
    );
    expect(await screen.findByText(/Conductor is unavailable/i)).toBeInTheDocument();
  });
});


describe('QuickBooksIntegrationCard — reconnecting to the wrong QuickBooks company', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    mockGetStatus.mockResolvedValue(CONNECTED);
    mockGetDesktopStatus.mockResolvedValue({ connected: false, linked: false });
  });

  afterEach(() => setSearchParams());

  // The failure this guards is silent by nature: the sign-in succeeds, so the
  // only thing standing between an admin and a repointed connection is this
  // message. It has to name the company they are already filed in, because
  // "a different company" does not tell anyone which account to sign in as.
  it('names the connected company and says nothing was changed', async () => {
    setSearchParams({ qb: 'realm_mismatch' });
    render(<QuickBooksIntegrationCard companyId="test-company-id" />);

    const alert = await screen.findByText(/different QuickBooks company/i);
    expect(alert).toHaveTextContent('Sandbox Company_US_1');
    expect(alert).toHaveTextContent(/nothing was changed/i);
    expect(alert).toHaveTextContent(/disconnect first/i);
  });

  // The name arrives from a separate async status load, so a naive
  // implementation reads it as undefined and renders "than undefined".
  it('still reads sensibly before the company name has loaded', async () => {
    mockGetStatus.mockReturnValue(new Promise(() => {}));
    setSearchParams({ qb: 'realm_mismatch' });
    render(<QuickBooksIntegrationCard companyId="test-company-id" />);

    const alert = await screen.findByText(/different QuickBooks company/i);
    expect(alert).not.toHaveTextContent(/undefined|null/);
    expect(alert).toHaveTextContent(/your existing company/i);
  });

  it('shows nothing when the callback reported success', async () => {
    setSearchParams({ qb: 'connected' });
    render(<QuickBooksIntegrationCard companyId="test-company-id" />);

    await screen.findByText(/QuickBooks connected/i);
    expect(screen.queryByText(/different QuickBooks company/i)).toBeNull();
  });
});
