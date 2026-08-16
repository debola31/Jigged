import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../../../test-utils';
import userEvent from '@testing-library/user-event';
import QuickBooksDesktopPanel from '@/components/settings/quickbooks/QuickBooksDesktopPanel';

/**
 * Every button here is a Web Connector round trip to the shop's own PC —
 * ~0.5s warm, 3-10s cold, and far longer if QuickBooks was closed. A button that
 * merely greys out for that long reads as broken, which is exactly how a shop
 * reported it. These tests pin the feedback, not the fetching.
 */

const getStatus = vi.hoisted(() => vi.fn());
const listAccounts = vi.hoisted(() => vi.fn());
const setIncomeAccount = vi.hoisted(() => vi.fn());
const testConnection = vi.hoisted(() => vi.fn());

vi.mock('@/utils/quickbooksDesktop', () => ({
  getQuickBooksDesktopStatus: (...a: unknown[]) => getStatus(...a),
  listQuickBooksDesktopAccounts: (...a: unknown[]) => listAccounts(...a),
  setQuickBooksDesktopIncomeAccount: (...a: unknown[]) => setIncomeAccount(...a),
  testQuickBooksDesktop: (...a: unknown[]) => testConnection(...a),
  disconnectQuickBooksDesktop: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

const STATUS = {
  connected: true,
  linked: true,
  qb_company_name: 'Rock Castle Construction',
  last_successful_request_at: '2026-08-16T00:00:00Z',
  needs_income_account: true,
};

/** A promise we control, so the in-flight state can actually be observed. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  getStatus.mockResolvedValue(STATUS);
  setIncomeAccount.mockResolvedValue(undefined);
});

describe('QuickBooksDesktopPanel — waiting on the shop PC', () => {
  it('says it is reading accounts, and where from, while the round trip is in flight', async () => {
    const d = deferred<{ accounts: { id: string; full_name: string }[] }>();
    listAccounts.mockReturnValue(d.promise);

    render(<QuickBooksDesktopPanel companyId="c1" onDisconnected={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /choose account/i }));

    expect(await screen.findByRole('button', { name: /reading accounts/i })).toBeInTheDocument();
    // Naming the shop computer is the part that stops the pause reading as a fault.
    expect(screen.getByText(/on the shop computer/i)).toBeInTheDocument();

    d.resolve({ accounts: [{ id: '1', full_name: 'Sales' }, { id: '2', full_name: 'Services' }] });
    await waitFor(() => expect(screen.queryByText(/on the shop computer/i)).not.toBeInTheDocument());
  });

  it('says it is asking QuickBooks while Test connection is in flight', async () => {
    const d = deferred<{ ok: boolean; code: string | null; message: string | null }>();
    testConnection.mockReturnValue(d.promise);

    render(<QuickBooksDesktopPanel companyId="c1" onDisconnected={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByRole('button', { name: /asking quickbooks/i })).toBeInTheDocument();

    d.resolve({ ok: true, code: null, message: null });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument(),
    );
  });

  it('only the pressed button reports progress, not every disabled one', async () => {
    const d = deferred<{ accounts: never[] }>();
    listAccounts.mockReturnValue(d.promise);

    render(<QuickBooksDesktopPanel companyId="c1" onDisconnected={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /choose account/i }));

    // Test connection is disabled meanwhile, but must not claim to be working.
    const test = screen.getByRole('button', { name: /test connection/i });
    expect(test).toBeDisabled();
    expect(test).not.toHaveTextContent(/asking quickbooks/i);

    d.resolve({ accounts: [] });
  });
});
