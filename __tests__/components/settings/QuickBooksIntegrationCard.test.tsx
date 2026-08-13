import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, resetRouterMocks } from '../../test-utils';
import QuickBooksIntegrationCard from '@/components/settings/QuickBooksIntegrationCard';
import type { QuickBooksStatus, QuickBooksPoField } from '@/utils/quickbooksAccess';

const mockGetStatus = vi.fn();
const mockRefreshPoField = vi.fn();

vi.mock('@/utils/quickbooksAccess', () => ({
  getQuickBooksStatus: (...args: unknown[]) => mockGetStatus(...args),
  startQuickBooksConnect: vi.fn(),
  disconnectQuickBooks: vi.fn(),
  refreshQuickBooksPoField: (...args: unknown[]) => mockRefreshPoField(...args),
}));

const mockFeatures = vi.fn();
vi.mock('@/hooks/useCompanyFeatures', () => ({
  useCompanyFeatures: () => ({ features: mockFeatures(), loading: false }),
}));

const mockGetDesktopStatus = vi.fn();
vi.mock('@/utils/quickbooksDesktop', () => ({
  getQuickBooksDesktopStatus: (...args: unknown[]) => mockGetDesktopStatus(...args),
  startQuickBooksDesktopConnect: vi.fn(),
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
    // QuickBooks Desktop is opt-in, so the option only renders for a tenant with
    // the flag on. Default it on here; the test below covers the off case.
    mockFeatures.mockReturnValue({ quickbooks_desktop: true });
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

  it('hides QuickBooks Desktop for a tenant without the flag', async () => {
    // The backend refuses /connect for a flag-off tenant, so showing the button
    // would offer an action that can only fail. Conductor bills per connected
    // company file, which is why the flag exists at all.
    mockFeatures.mockReturnValue({});
    mockGetStatus.mockResolvedValue({ connected: false } as QuickBooksStatus);
    render(<QuickBooksIntegrationCard companyId="c1" />);

    expect(
      await screen.findByRole('button', { name: /Connect QuickBooks Online/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Connect QuickBooks Desktop/i }),
    ).not.toBeInTheDocument();
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
