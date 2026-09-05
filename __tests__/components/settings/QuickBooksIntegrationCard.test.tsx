import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, resetRouterMocks, setSearchParams } from '../../test-utils';
import QuickBooksIntegrationCard from '@/components/settings/QuickBooksIntegrationCard';
import type { QuickBooksStatus, QuickBooksPoField } from '@/utils/quickbooksAccess';

const mockGetStatus = vi.fn();
const mockRefreshPoField = vi.fn();
const mockStartConnect = vi.hoisted(() => vi.fn());

vi.mock('@/utils/quickbooksAccess', () => ({
  getQuickBooksStatus: (...args: unknown[]) => mockGetStatus(...args),
  startQuickBooksConnect: (...args: unknown[]) => mockStartConnect(...args),
  disconnectQuickBooks: vi.fn(),
  refreshQuickBooksPoField: (...args: unknown[]) => mockRefreshPoField(...args),
}));

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

const NOT_FOUND: QuickBooksPoField = {
  configured: false,
  field_id: null,
  field_name: null,
  candidates: [],
  slots_used: 0,
};

describe('QuickBooksIntegrationCard — customer PO field', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    mockGetStatus.mockResolvedValue(CONNECTED);
    mockGetDesktopStatus.mockResolvedValue({ connected: false, linked: false });
    mockRefreshPoField.mockResolvedValue(NOT_FOUND);
  });

  // The guard that matters most. Reading the PO field is a live round trip to
  // Intuit; if it ever moves to mount, every visit to Settings calls their API.
  it('does not touch QuickBooks settings until the admin asks', async () => {
    render(<QuickBooksIntegrationCard companyId="c1" />);
    await screen.findByText(/Customer PO number/i);
    expect(mockRefreshPoField).not.toHaveBeenCalled();
  });

  it('explains how to add the field when QuickBooks has none', async () => {
    render(<QuickBooksIntegrationCard companyId="c1" />);
    await user.click(await screen.findByRole('button', { name: /Check QuickBooks settings/i }));

    await waitFor(() => expect(mockRefreshPoField).toHaveBeenCalledWith('c1'));
    // Names the exact menu path — the shop has to do this by hand because the
    // API cannot create the field (REST no-ops, GraphQL needs a partner tier).
    expect(await screen.findByText(/Account and settings/i)).toBeInTheDocument();
  });

  it('confirms the field by name once QuickBooks has one', async () => {
    mockRefreshPoField.mockResolvedValue({
      configured: true,
      field_id: '1',
      field_name: 'PO Number',
      candidates: [{ id: '1', name: 'PO Number' }],
      slots_used: 1,
    } satisfies QuickBooksPoField);

    render(<QuickBooksIntegrationCard companyId="c1" />);
    await user.click(await screen.findByRole('button', { name: /Check QuickBooks settings/i }));

    expect(await screen.findByText('PO Number')).toBeInTheDocument();
    expect(screen.queryByText(/Account and settings/i)).not.toBeInTheDocument();
  });

  // QuickBooks caps custom fields at three. If they're all spoken for, saying
  // "add a field" is advice the shop cannot follow.
  it('says so when all three custom-field slots are taken', async () => {
    mockRefreshPoField.mockResolvedValue({
      configured: false,
      field_id: null,
      field_name: null,
      candidates: [
        { id: '1', name: 'Sales Rep' },
        { id: '2', name: 'Crew #' },
        { id: '3', name: 'Job Site' },
      ],
      slots_used: 3,
    } satisfies QuickBooksPoField);

    render(<QuickBooksIntegrationCard companyId="c1" />);
    await user.click(await screen.findByRole('button', { name: /Check QuickBooks settings/i }));

    expect(await screen.findByText(/custom-field slots are in use/i)).toBeInTheDocument();
    expect(screen.getByText(/Sales Rep, Crew #, Job Site/)).toBeInTheDocument();
  });

  it('surfaces a failed lookup instead of implying the field is missing', async () => {
    mockRefreshPoField.mockRejectedValue(new Error('QuickBooks is not responding.'));

    render(<QuickBooksIntegrationCard companyId="c1" />);
    await user.click(await screen.findByRole('button', { name: /Check QuickBooks settings/i }));

    expect(await screen.findByText('QuickBooks is not responding.')).toBeInTheDocument();
  });

  it('hides the whole section when QuickBooks is not connected', async () => {
    mockGetStatus.mockResolvedValue({ connected: false } as QuickBooksStatus);
    render(<QuickBooksIntegrationCard companyId="c1" />);

    await screen.findByRole('button', { name: /Connect QuickBooks Online/i });
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
    mockRefreshPoField.mockResolvedValue(NOT_FOUND);
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
