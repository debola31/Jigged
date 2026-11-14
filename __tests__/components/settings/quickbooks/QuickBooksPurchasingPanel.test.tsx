import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '../../../test-utils';
import type * as QuickBooksAccess from '@/utils/quickbooksAccess';
import type {
  PurchaseLineKind,
  QuickBooksPurchaseItem,
  QuickBooksPurchaseItemSetting,
  QuickBooksPurchasingSetup,
} from '@/utils/quickbooksAccess';

/**
 * Settings → QuickBooks → Purchasing (plan §3.13, §5.3; criteria QB1 and QB7).
 *
 * The panel mounts on every visit to Settings, so the rule it lives under is QB1: the mount reads
 * Jigged's own setup rows and NOTHING ELSE. Every QuickBooks read here is behind a click, because
 * for QuickBooks Desktop each one is a Web Connector round trip to the shop's PC.
 */

const qb = vi.hoisted(() => ({
  getQuickBooksPurchasingSetup: vi.fn(),
  listQuickBooksPurchaseItems: vi.fn(),
  listQuickBooksPurchaseAccounts: vi.fn(),
  setQuickBooksPurchaseItems: vi.fn(),
  setQuickBooksApAccount: vi.fn(),
  checkQuickBooksPreferences: vi.fn(),
}));
vi.mock('@/utils/quickbooksAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof QuickBooksAccess>()),
  ...qb,
}));

const role = vi.hoisted(() => ({
  current: { role: 'admin' as 'admin' | 'user' | 'operator' | null, isAdmin: true, loading: false },
}));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => role.current }));

const capture = vi.hoisted(() => vi.fn());
vi.mock('posthog-js', () => ({ default: { capture } }));

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } }, error: null }),
    },
  }),
}));

import QuickBooksPurchasingPanel from '@/components/settings/quickbooks/QuickBooksPurchasingPanel';
import { QuickBooksError } from '@/utils/quickbooksAccess';

// ── fixtures ──────────────────────────────────────────────────────────────

const KINDS: PurchaseLineKind[] = ['part', 'outside_service', 'other'];

function setting(kind: PurchaseLineKind, over: Partial<QuickBooksPurchaseItemSetting> = {}): QuickBooksPurchaseItemSetting {
  return {
    line_kind: kind,
    setup_key: `item:${kind}`,
    qb_id: 'i1',
    qb_name: 'Jigged purchases',
    posting_account_id: 'a1',
    posting_account_name: 'Cost of Goods Sold',
    created_in_quickbooks: true,
    ...over,
  };
}

function setup(over: Partial<QuickBooksPurchasingSetup> = {}): QuickBooksPurchasingSetup {
  return {
    connected: true,
    provider: 'qbo',
    items: [],
    one_item_for_all: false,
    ap_account: null,
    preferences: null,
    missing: ['item:part', 'item:outside_service', 'item:other', 'ap_account'],
    ...over,
  };
}

const DONE = setup({
  items: KINDS.map((k) => setting(k)),
  one_item_for_all: true,
  ap_account: { qb_id: 'ap1', qb_name: 'Accounts Payable (A/P)' },
  missing: [],
});

function item(over: Partial<QuickBooksPurchaseItem>): QuickBooksPurchaseItem {
  return {
    id: 'i1',
    name: 'Materials',
    type: 'NonInventory',
    posting_account_id: 'a1',
    posting_account_name: 'Cost of Goods Sold',
    eligible: true,
    ...over,
  };
}

const ACCOUNTS = [
  { id: 'a1', full_name: 'Cost of Goods Sold', type: 'Cost of Goods Sold' },
  { id: 'a2', full_name: 'Subcontractors', type: 'Expense' },
];

/** A promise we control, so the in-flight state can actually be observed. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const NO_QUICKBOOKS_CALLS = [
  qb.listQuickBooksPurchaseItems,
  qb.listQuickBooksPurchaseAccounts,
  qb.setQuickBooksPurchaseItems,
  qb.setQuickBooksApAccount,
  qb.checkQuickBooksPreferences,
];

beforeEach(() => {
  vi.resetAllMocks();
  role.current = { role: 'admin', isAdmin: true, loading: false };
  qb.getQuickBooksPurchasingSetup.mockResolvedValue(setup());
  qb.setQuickBooksPurchaseItems.mockImplementation(async () => ({
    saved: true,
    items: KINDS.map((k) => setting(k, { qb_id: 'i2', qb_name: 'Subcontract' })),
    one_item_for_all: true,
  }));
  qb.setQuickBooksApAccount.mockImplementation(async (_c: string, id: string) => ({
    saved: true,
    ap_account: { qb_id: id, qb_name: id === 'ap2' ? 'A/P — Vendors' : 'Accounts Payable (A/P)' },
  }));
});

// ── QB1: the mount reads Jigged's own rows, and only those ──────────────

describe('QuickBooksPurchasingPanel — nothing reaches QuickBooks on mount', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the purchasing setup and calls nothing that reaches QuickBooks', async () => {
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    expect(await screen.findByText('QuickBooks item for purchases')).toBeInTheDocument();
    expect(qb.getQuickBooksPurchasingSetup).toHaveBeenCalledTimes(1);
    expect(qb.getQuickBooksPurchasingSetup).toHaveBeenCalledWith('c1');
    for (const fn of NO_QUICKBOOKS_CALLS) expect(fn).not.toHaveBeenCalled();
  });

  it('on the wire: GET /purchasing/setup is the only request until a button is pressed', async () => {
    const actual = await vi.importActual<typeof QuickBooksAccess>('@/utils/quickbooksAccess');
    qb.getQuickBooksPurchasingSetup.mockImplementation(actual.getQuickBooksPurchasingSetup);
    qb.listQuickBooksPurchaseItems.mockImplementation(actual.listQuickBooksPurchaseItems);
    const fetchSpy = vi.fn(async (url: string) => {
      const body = String(url).includes('/purchasing/items')
        ? { items: [item({})], accounts: ACCOUNTS }
        : setup();
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const quickBooksCalls = () =>
      fetchSpy.mock.calls.map((call: unknown[]) => String(call[0])).filter((u) => u.includes('/api/quickbooks'));

    render(<QuickBooksPurchasingPanel companyId="c1" />);
    await screen.findByText('QuickBooks item for purchases');
    await new Promise((r) => setTimeout(r, 50));

    expect(quickBooksCalls()).toHaveLength(1);
    expect(quickBooksCalls()[0]).toContain('/api/quickbooks/c1/purchasing/setup');

    await userEvent.click(screen.getByRole('button', { name: 'Choose item' }));
    await waitFor(() => expect(quickBooksCalls()).toHaveLength(2));
    expect(quickBooksCalls()[1]).toContain('/api/quickbooks/c1/purchasing/items');
  });

  it('tells its parent whether purchasing still needs setting up', async () => {
    const onSetupChange = vi.fn();
    const first = render(<QuickBooksPurchasingPanel companyId="c1" onSetupChange={onSetupChange} />);
    await waitFor(() => expect(onSetupChange).toHaveBeenLastCalledWith(true));
    first.unmount();

    qb.getQuickBooksPurchasingSetup.mockResolvedValue(DONE);
    render(<QuickBooksPurchasingPanel companyId="c1" onSetupChange={onSetupChange} />);
    await waitFor(() => expect(onSetupChange).toHaveBeenLastCalledWith(false));
  });
});

// ── QB7: one general item by default; a split if the shop wants one ─────

describe('QuickBooksPurchasingPanel — the purchases item', () => {
  const user = userEvent.setup();

  it('offers ONE item for all purchases by default, and the split only on request', async () => {
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    const row = await screen.findByRole('group', { name: 'QuickBooks item for purchases' });
    expect(within(row).getByText(/required/i)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Outside services' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use different items for parts, outside services and other' }));
    for (const name of ['Parts and material', 'Outside services', 'Other purchases']) {
      expect(screen.getByRole('group', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('group', { name: 'QuickBooks item for purchases' })).not.toBeInTheDocument();
  });

  it('shows a chosen item and its account, as one item for everything', async () => {
    qb.getQuickBooksPurchasingSetup.mockResolvedValue(DONE);
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    const row = await screen.findByRole('group', { name: 'QuickBooks item for purchases' });
    expect(within(row).getByText(/“Jigged purchases”, posting to Cost of Goods Sold/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Change item' })).toBeInTheDocument();
  });

  it('opens a stored split as a split', async () => {
    qb.getQuickBooksPurchasingSetup.mockResolvedValue(
      setup({
        items: [setting('part'), setting('outside_service', { qb_id: 'i9', qb_name: 'Plating' })],
        one_item_for_all: false,
        missing: ['item:other', 'ap_account'],
      }),
    );
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    expect(await screen.findByRole('group', { name: 'Outside services' })).toHaveTextContent('Plating');
    expect(screen.getByRole('group', { name: 'Other purchases' })).toHaveTextContent(/not chosen yet/i);
  });

  it('Choose item reads items and accounts on the click, and Use existing saves one item for all three kinds', async () => {
    qb.listQuickBooksPurchaseItems.mockResolvedValue({
      items: [
        item({ id: 'i1', name: 'Materials' }),
        item({ id: 'i2', name: 'Subcontract', posting_account_id: 'a2', posting_account_name: 'Subcontractors' }),
        item({ id: 'i3', name: 'Freight in', eligible: false, posting_account_name: 'Sales' }),
      ],
      accounts: ACCOUNTS,
    });
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    const row = await screen.findByRole('group', { name: 'QuickBooks item for purchases' });
    await user.click(within(row).getByRole('button', { name: 'Choose item' }));
    await waitFor(() => expect(qb.listQuickBooksPurchaseItems).toHaveBeenCalledWith('c1'));

    expect(within(row).getByLabelText('Use an item already in QuickBooks')).toBeChecked();
    // Two to choose from, so nothing is chosen for them.
    const save = within(row).getByRole('button', { name: 'Use this item' });
    expect(save).toBeDisabled();

    await user.click(within(row).getByRole('combobox', { name: /^Item/ }));
    // An item posting to income is shown, so its absence isn't a mystery, but it can't be picked.
    expect(screen.getByRole('option', { name: /Freight in/ })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('option', { name: /Subcontract/ }));
    await user.click(save);

    await waitFor(() =>
      expect(qb.setQuickBooksPurchaseItems).toHaveBeenCalledWith('c1', {
        allKinds: { action: 'use_existing', qb_item_id: 'i2' },
      }),
    );
    expect(capture).toHaveBeenCalledWith('quickbooks purchase item chosen', {
      provider: 'qbo',
      setup_key: 'all_kinds',
      action: 'use_existing',
    });
    expect(await screen.findByText(/Saved\. Vendor POs post under “Subcontract”/)).toBeInTheDocument();
    // The saved state is re-read from Jigged's own table — still no QuickBooks call to show it.
    await waitFor(() => expect(qb.getQuickBooksPurchasingSetup).toHaveBeenCalledTimes(2));
  });

  it('picks the only eligible item for them', async () => {
    qb.listQuickBooksPurchaseItems.mockResolvedValue({
      items: [item({ id: 'i1', name: 'Materials' }), item({ id: 'i3', name: 'Freight in', eligible: false })],
      accounts: ACCOUNTS,
    });
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    const row = await screen.findByRole('group', { name: 'QuickBooks item for purchases' });
    await user.click(within(row).getByRole('button', { name: 'Choose item' }));

    expect(await within(row).findByRole('combobox', { name: /^Item/ })).toHaveTextContent('Materials');
    await user.click(within(row).getByRole('button', { name: 'Use this item' }));
    await waitFor(() =>
      expect(qb.setQuickBooksPurchaseItems).toHaveBeenCalledWith('c1', {
        allKinds: { action: 'use_existing', qb_item_id: 'i1' },
      }),
    );
  });

  it('with no usable item, offers to create one posting to the only account — picked for them', async () => {
    qb.listQuickBooksPurchaseItems.mockResolvedValue({
      items: [item({ id: 'i3', name: 'Freight in', eligible: false })],
      accounts: [ACCOUNTS[0]],
    });
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    const row = await screen.findByRole('group', { name: 'QuickBooks item for purchases' });
    await user.click(within(row).getByRole('button', { name: 'Choose item' }));

    expect(await within(row).findByLabelText('Create a new item posting to…')).toBeChecked();
    expect(within(row).getByRole('combobox', { name: /^Account it posts to/ })).toHaveTextContent('Cost of Goods Sold');
    await user.click(within(row).getByRole('button', { name: 'Create item' }));

    await waitFor(() =>
      expect(qb.setQuickBooksPurchaseItems).toHaveBeenCalledWith('c1', {
        allKinds: { action: 'create', qb_account_id: 'a1' },
      }),
    );
    expect(capture).toHaveBeenCalledWith('quickbooks purchase item chosen', {
      provider: 'qbo',
      setup_key: 'all_kinds',
      action: 'create',
    });
  });

  it('a split saves only the kind it was chosen for', async () => {
    qb.listQuickBooksPurchaseItems.mockResolvedValue({
      items: [item({ id: 'i2', name: 'Subcontract' })],
      accounts: ACCOUNTS,
    });
    qb.setQuickBooksPurchaseItems.mockResolvedValue({
      saved: true,
      items: [setting('outside_service', { qb_id: 'i2', qb_name: 'Subcontract' })],
      one_item_for_all: false,
    });
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    await user.click(await screen.findByRole('button', { name: 'Use different items for parts, outside services and other' }));
    const row = screen.getByRole('group', { name: 'Outside services' });
    await user.click(within(row).getByRole('button', { name: 'Choose item' }));
    await user.click(await within(row).findByRole('button', { name: 'Use this item' }));

    await waitFor(() =>
      expect(qb.setQuickBooksPurchaseItems).toHaveBeenCalledWith('c1', {
        byKind: { outside_service: { action: 'use_existing', qb_item_id: 'i2' } },
      }),
    );
    expect(capture).toHaveBeenCalledWith('quickbooks purchase item chosen', {
      provider: 'qbo',
      setup_key: 'item:outside_service',
      action: 'use_existing',
    });
  });

  it("shows QuickBooks' refusal of an item in its own words", async () => {
    qb.listQuickBooksPurchaseItems.mockResolvedValue({ items: [item({})], accounts: ACCOUNTS });
    qb.setQuickBooksPurchaseItems.mockRejectedValue(
      new QuickBooksError(
        "That's the item Jigged's invoices post to, so purchases can't use it. Choose another item, or create one.",
        400,
      ),
    );
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    await user.click(await screen.findByRole('button', { name: 'Choose item' }));
    await user.click(await screen.findByRole('button', { name: 'Use this item' }));
    expect(await screen.findByText(/That's the item Jigged's invoices post to/)).toBeInTheDocument();
    expect(capture).not.toHaveBeenCalled();
    // The picker stays open so another item can be chosen.
    expect(screen.getByRole('button', { name: 'Use this item' })).toBeEnabled();
  });
});

// ── the accounts-payable account (QuickBooks Online only) ────────────────

describe('QuickBooksPurchasingPanel — the accounts-payable account', () => {
  const user = userEvent.setup();

  it('is not offered for QuickBooks Desktop, whose POs carry none', async () => {
    qb.getQuickBooksPurchasingSetup.mockResolvedValue(setup({ provider: 'qbd', missing: ['item:part', 'item:outside_service', 'item:other'] }));
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    await screen.findByText('QuickBooks item for purchases');
    expect(screen.queryByText('Accounts-payable account')).not.toBeInTheDocument();
    expect(screen.getByText(/up to 11 characters/)).toBeInTheDocument();
  });

  it('uses the only one without asking', async () => {
    qb.listQuickBooksPurchaseAccounts.mockResolvedValue({
      accounts: ACCOUNTS,
      ap_accounts: [{ id: 'ap1', full_name: 'Accounts Payable (A/P)', type: 'Accounts Payable' }],
    });
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    const row = await screen.findByRole('group', { name: 'Accounts-payable account' });
    await user.click(within(row).getByRole('button', { name: 'Choose account' }));

    await waitFor(() => expect(qb.setQuickBooksApAccount).toHaveBeenCalledWith('c1', 'ap1'));
    expect(await screen.findByText(/the only accounts-payable account/i)).toBeInTheDocument();
  });

  it('asks which one when there are several', async () => {
    qb.listQuickBooksPurchaseAccounts.mockResolvedValue({
      accounts: ACCOUNTS,
      ap_accounts: [
        { id: 'ap1', full_name: 'Accounts Payable (A/P)', type: 'Accounts Payable' },
        { id: 'ap2', full_name: 'A/P — Vendors', type: 'Accounts Payable' },
      ],
    });
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    const row = await screen.findByRole('group', { name: 'Accounts-payable account' });
    await user.click(within(row).getByRole('button', { name: 'Choose account' }));
    await user.click(await within(row).findByRole('combobox', { name: /^Accounts-payable account/ }));
    await user.click(screen.getByRole('option', { name: 'A/P — Vendors' }));
    expect(qb.setQuickBooksApAccount).not.toHaveBeenCalled();
    await user.click(within(row).getByRole('button', { name: 'Use this account' }));

    await waitFor(() => expect(qb.setQuickBooksApAccount).toHaveBeenCalledWith('c1', 'ap2'));
  });
});

// ── Check QuickBooks ──────────────────────────────────────────────────────

describe('QuickBooksPurchasingPanel — Check QuickBooks', () => {
  const user = userEvent.setup();

  it('shows what QuickBooks said needs changing', async () => {
    qb.getQuickBooksPurchasingSetup.mockResolvedValue(DONE);
    qb.checkQuickBooksPreferences.mockResolvedValue({
      provider: 'qbo',
      purchase_orders_enabled: false,
      custom_txn_numbers: false,
      checked_at: '2026-11-09T12:00:00Z',
      warnings: [
        'Purchase orders are turned off in QuickBooks Online (they need the Plus or Advanced plan). Turn them on in QuickBooks under Settings → Account and settings → Expenses, then try again.',
        "Custom transaction numbers are off in QuickBooks Online, so QuickBooks gives each PO its own number instead of Jigged's.",
      ],
    });
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    await user.click(await screen.findByRole('button', { name: 'Check QuickBooks' }));
    expect(await screen.findByText(/Purchase orders are turned off in QuickBooks Online/)).toBeInTheDocument();
    expect(screen.getByText(/Custom transaction numbers are off/)).toBeInTheDocument();
    expect(qb.checkQuickBooksPreferences).toHaveBeenCalledWith('c1');
  });

  it('says so when all is well', async () => {
    qb.checkQuickBooksPreferences.mockResolvedValue({
      provider: 'qbo',
      purchase_orders_enabled: true,
      custom_txn_numbers: true,
      checked_at: '2026-11-09T12:00:00Z',
      warnings: [],
    });
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    await user.click(await screen.findByRole('button', { name: 'Check QuickBooks' }));
    expect(await screen.findByText(/Purchase orders are turned on/)).toBeInTheDocument();
    expect(screen.getByText(/QuickBooks keeps Jigged's PO numbers/)).toBeInTheDocument();
  });

  it('QuickBooks Desktop being off is a warning with a retry', async () => {
    qb.getQuickBooksPurchasingSetup.mockResolvedValue(setup({ provider: 'qbd', missing: [] }));
    qb.checkQuickBooksPreferences.mockRejectedValue(
      new QuickBooksError("QuickBooks Desktop didn't answer.", 409, 'qbd_offline', { code: 'qbd_offline' }),
    );
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    await user.click(await screen.findByRole('button', { name: 'Check QuickBooks' }));
    expect(await screen.findByText("QuickBooks isn't answering right now")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(qb.checkQuickBooksPreferences).toHaveBeenCalledTimes(2));
  });
});

// ── waiting, and who may press what ──────────────────────────────────────

describe('QuickBooksPurchasingPanel — waiting and permissions', () => {
  const user = userEvent.setup();

  it('only the pressed button says it is waiting, and Desktop names the shop computer', async () => {
    qb.getQuickBooksPurchasingSetup.mockResolvedValue(setup({ provider: 'qbd', missing: ['item:part', 'item:outside_service', 'item:other'] }));
    const d = deferred<{ items: QuickBooksPurchaseItem[]; accounts: typeof ACCOUNTS }>();
    qb.listQuickBooksPurchaseItems.mockReturnValue(d.promise);
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    await user.click(await screen.findByRole('button', { name: 'Choose item' }));

    expect(await screen.findByRole('button', { name: /reading items/i })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/shop computer/i);
    const check = screen.getByRole('button', { name: 'Check QuickBooks' });
    expect(check).toBeDisabled();
    expect(check).not.toHaveAttribute('aria-busy');

    d.resolve({ items: [], accounts: ACCOUNTS });
    await waitFor(() => expect(screen.queryByText(/shop computer/i)).not.toBeInTheDocument());
  });

  it('shows a non-admin the setup, but nothing to change it with', async () => {
    role.current = { role: 'user', isAdmin: false, loading: false };
    qb.getQuickBooksPurchasingSetup.mockResolvedValue(DONE);
    render(<QuickBooksPurchasingPanel companyId="c1" />);

    expect(await screen.findByText(/“Jigged purchases”, posting to Cost of Goods Sold/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change item|choose item|check quickbooks|change account|choose account/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use different items/i })).not.toBeInTheDocument();
    expect(screen.getByText(/An admin can change/i)).toBeInTheDocument();
  });

  it('renders nothing when QuickBooks is not connected', async () => {
    qb.getQuickBooksPurchasingSetup.mockResolvedValue(
      setup({ connected: false, provider: null, missing: [] }),
    );
    const { container } = render(<QuickBooksPurchasingPanel companyId="c1" />);
    await waitFor(() => expect(qb.getQuickBooksPurchasingSetup).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
