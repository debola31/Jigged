/**
 * "To buy" (plan §3.10, criterion B3) — the buy list a person reads and orders from.
 *
 * Ported from 87df208's shop-wide shortages page (`InventoryShortagesPage.test.tsx`, 8 tests). The
 * reason that page existed survives: two jobs each needing 10 against 15 on hand both read "not
 * short" on their own job cards, and only a shop-wide roll-up shows the conflict. What changed:
 *   - its date window is gone (the "this week" default usually reported nothing), so the two
 *     window tests become "every open job counts" and "Buy from re-groups without a re-read";
 *   - the hot-job test is gone with `jobs.is_hot`; urgency is now the sort (soonest need first).
 *
 * The rule itself is pinned in lib (`__tests__/fixtures/buyListCases.json`). These tests drive the
 * REAL `buildBuyListFromSnapshot` over a fixture snapshot and mock only the read and the writes, so
 * grouping, "Buy from" and the price defaults are the shipped ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within, waitFor, routerMocks, setSearchParams } from '../../test-utils';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('@/utils/buyListAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/buyListAccess')>()),
  loadBuyListSnapshot: vi.fn(),
}));
vi.mock('@/utils/vendorPoAccess', () => ({
  createVendorPo: vi.fn(),
  updateVendorPo: vi.fn(),
}));
// The "Another vendor…" picker bulk-loads every vendor; a plain select stands in for it.
vi.mock('@/components/vendors/VendorAutocomplete', () => ({
  default: ({ label, onChange }: { label: string; onChange: (v: { id: string; name: string } | null) => void }) => (
    <label>
      {label}
      <select
        aria-label={label}
        defaultValue=""
        onChange={(e) => onChange(e.target.value ? { id: e.target.value, name: e.target.selectedOptions[0].text } : null)}
      >
        <option value="">—</option>
        <option value="gamma">Gamma Metals</option>
      </select>
    </label>
  ),
}));

import posthog from 'posthog-js';
import { BuyList } from '@/components/purchasing/BuyList';
import { loadBuyListSnapshot } from '@/utils/buyListAccess';
import { createVendorPo, updateVendorPo } from '@/utils/vendorPoAccess';
import type {
  BuyListBoughtPartDemand,
  BuyListMaterialDemand,
  BuyListPart,
  BuyListVendorOption,
} from '@/lib/purchasing/buyList';
import type { BuyListSnapshot, BuyListPriceInputs } from '@/types/buyList';
import { todayLocalISODate } from '@/lib/localDate';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const VENDOR_NAMES: Record<string, string> = {
  acme: 'Acme Steel',
  beta: 'Beta Supply',
  gamma: 'Gamma Metals',
};

const vendor = (vendorId: string, over: Partial<BuyListVendorOption> = {}): BuyListVendorOption => ({
  partVendorId: `pv-${vendorId}`,
  vendorId,
  vendorName: VENDOR_NAMES[vendorId] ?? vendorId,
  status: 'approved',
  vendorArchived: false,
  purchaseUnit: 'each',
  purchaseFactor: 1,
  minimumOrderQuantity: null,
  ...over,
});

const part = (over: Partial<BuyListPart> & { partId: string }): BuyListPart => ({
  partName: over.partId.toUpperCase(),
  source: 'bought',
  stockUnit: 'each',
  onHand: 0,
  onOrder: 0,
  onDraft: 0,
  reorderPoint: null,
  isArchived: false,
  preferredVendorId: null,
  vendors: [],
  ...over,
});

const material = (
  partId: string,
  jobId: string,
  required: number | null,
  over: Partial<BuyListMaterialDemand> = {},
): BuyListMaterialDemand => ({
  kind: 'material',
  partId,
  jobId,
  jobNumber: jobId.toUpperCase(),
  jobPartId: `${jobId}-jp`,
  madePartName: 'Widget',
  dueDate: '2026-08-01',
  requiredInStockUnit: required,
  issued: 0,
  ...over,
});

const bought = (partId: string, jobId: string, stillToShip: number): BuyListBoughtPartDemand => ({
  kind: 'bought_part',
  partId,
  jobId,
  jobNumber: jobId.toUpperCase(),
  jobPartId: `${jobId}-bought`,
  dueDate: '2026-08-05',
  stillToShip,
});

/** An Acme price sheet in `each`: 1+ at $10, 10+ at $8. */
const acmeSheet: BuyListPriceInputs = {
  sheetsByVendor: {
    acme: {
      vendorName: 'Acme Steel',
      status: 'approved',
      purchaseUnit: 'each',
      stockFactor: 1,
      validUntil: null,
      breaks: [
        { minQuantity: 1, unitPrice: 10 },
        { minQuantity: 10, unitPrice: 8 },
      ],
    },
  },
  lastPurchases: [],
  costTiers: [],
};

const snapshot = (over: Partial<BuyListSnapshot> = {}): BuyListSnapshot => ({
  parts: [],
  demand: [],
  draftsByVendor: {},
  priceInputsByPart: {},
  truncatedSources: [],
  ...over,
});

/** STEEL is short for one job and bought from Acme (preferred); BOLT from Beta (its only Approved). */
const twoVendorSnapshot = () =>
  snapshot({
    parts: [
      part({ partId: 'steel', preferredVendorId: 'acme', vendors: [vendor('acme'), vendor('beta', { status: 'conditional' })] }),
      part({ partId: 'bolt', vendors: [vendor('beta')] }),
      part({ partId: 'nut' }),
    ],
    demand: [material('steel', 'j1', 5), material('bolt', 'j1', 4), material('nut', 'j2', 3)],
    priceInputsByPart: { steel: acmeSheet },
  });

const renderList = () => render(<BuyList companyId="co1" />);

/** The vendor's card: a labelled region, so rows are found inside the group they belong to. */
const group = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  vi.clearAllMocks();
  setSearchParams();
  asMock(loadBuyListSnapshot).mockResolvedValue(snapshot());
  asMock(createVendorPo).mockResolvedValue({ id: 'po-new', poNumber: 'PO-1043' });
  asMock(updateVendorPo).mockResolvedValue({
    id: 'po-draft',
    poNumber: 'PO-1040',
    status: 'draft',
    lineIds: ['l1'],
    linkedOutsideShipmentIds: [],
    unlinkedOutsideShipmentIds: [],
    revision: 0,
    sentRevision: null,
    revisionBumped: false,
    contentVersion: 1,
    contentChanged: true,
    updatedAt: '2026-11-09T00:00:00.000001+00:00',
  });
});

describe('BuyList — ported from the 87df208 shortages page', () => {
  /**
   * The case a job card cannot show. Both jobs individually fit inside 15 on hand; together they
   * don't. One row, one on-hand figure, both jobs listed.
   */
  it('shows a part once with every job that wants it', async () => {
    asMock(loadBuyListSnapshot).mockResolvedValue(
      snapshot({
        parts: [part({ partId: 'steel', onHand: 15 })],
        demand: [material('steel', 'j1', 10), material('steel', 'j2', 10, { dueDate: '2026-08-03' })],
      }),
    );
    renderList();

    expect(await screen.findByText('STEEL')).toBeInTheDocument();
    expect(screen.getByText('Short 5 each')).toBeInTheDocument();
    expect(screen.getByText(/20 needed · 15 on hand/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'J1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'J2' })).toBeInTheDocument();
  });

  /** Was "says which jobs it counted and what date the window resolved to": there is no window now. */
  it('counts every open job whatever its due date — overdue and undated included, no window to pick', async () => {
    asMock(loadBuyListSnapshot).mockResolvedValue(
      snapshot({
        parts: [part({ partId: 'steel' }), part({ partId: 'bolt' })],
        demand: [
          material('steel', 'j-late', 4, { dueDate: '2020-01-01' }),
          material('bolt', 'j-undated', 2, { dueDate: null }),
        ],
      }),
    );
    renderList();

    expect(await screen.findByText('STEEL')).toBeInTheDocument();
    expect(screen.getByText('BOLT')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /this week/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /next 30 days/i })).not.toBeInTheDocument();
  });

  /**
   * Was "re-queries when the window changes". The one control left that changes what is shown is
   * "Buy from", and it must NOT re-read: the list is rebuilt from the snapshot already loaded.
   */
  it('re-groups a row under the vendor picked in "Buy from", without reading again', async () => {
    const user = userEvent.setup();
    asMock(loadBuyListSnapshot).mockResolvedValue(twoVendorSnapshot());
    renderList();

    await screen.findByText('STEEL');
    expect(within(group('Acme Steel')).getByText('STEEL')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /buy steel from/i }));
    await user.click(await screen.findByRole('option', { name: /beta supply/i }));

    await waitFor(() => expect(within(group('Beta Supply')).getByText('STEEL')).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Acme Steel' })).not.toBeInTheDocument();
    expect(loadBuyListSnapshot).toHaveBeenCalledTimes(1);
  });

  it('says plainly when there is nothing to buy', async () => {
    renderList();
    expect(await screen.findByText(/nothing to buy/i)).toBeInTheDocument();
    expect(
      screen.getByText(/covered by stock or orders, and nothing is at its reorder point/i),
    ).toBeInTheDocument();
  });

  /**
   * An unmeasurable material must never sit silently in the "you're fine" bucket — it is a
   * different answer from "you have enough", and the list has to say which one it means.
   */
  it('lists materials it cannot compare separately, never as fine', async () => {
    asMock(loadBuyListSnapshot).mockResolvedValue(
      snapshot({
        parts: [part({ partId: 'bar', stockUnit: 'inches', onHand: 500 })],
        demand: [material('bar', 'j1', null), material('bar', 'j2', null), material('bar', 'j3', null)],
      }),
    );
    renderList();

    expect(await screen.findByText(/nothing to buy/i)).toBeInTheDocument();
    const section = screen.getByRole('region', { name: /can't compare units \(1\)/i });
    expect(within(section).getByText('BAR')).toBeInTheDocument();
    expect(within(section).getByText(/3 jobs affected/)).toBeInTheDocument();
  });

  /** Was "marks a hot job": `is_hot` is gone, and urgency is the order — soonest need first. */
  it('puts the soonest need first', async () => {
    asMock(loadBuyListSnapshot).mockResolvedValue(
      snapshot({
        parts: [part({ partId: 'later' }), part({ partId: 'sooner' })],
        demand: [
          material('later', 'j1', 2, { dueDate: '2026-09-01' }),
          material('sooner', 'j2', 2, { dueDate: '2026-08-01' }),
        ],
      }),
    );
    renderList();

    const later = await screen.findByText('LATER');
    const sooner = screen.getByText('SOONER');
    // DOCUMENT_POSITION_FOLLOWING: `later` comes after `sooner`.
    expect(sooner.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('states the top-level-only limitation, and that only POs in Jigged count', async () => {
    renderList();
    expect(await screen.findByText(/top-level materials only/i)).toBeInTheDocument();
    expect(screen.getByText(/only POs in Jigged count as on order/i)).toBeInTheDocument();
  });

  it('surfaces a failed load rather than rendering an empty all-clear', async () => {
    asMock(loadBuyListSnapshot).mockRejectedValue(new Error('boom'));
    renderList();
    expect(await screen.findByText(/couldn't load the buy list/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/nothing to buy/i)).not.toBeInTheDocument();
  });
});

describe('BuyList — grouping and ordering', () => {
  it('groups by preferred vendor, then the only Approved vendor, with "No vendor chosen" last', async () => {
    asMock(loadBuyListSnapshot).mockResolvedValue(twoVendorSnapshot());
    renderList();

    await screen.findByText('STEEL');
    expect(within(group('Acme Steel')).getByText('STEEL')).toBeInTheDocument();
    expect(within(group('Beta Supply')).getByText('BOLT')).toBeInTheDocument();
    expect(within(group('No vendor chosen')).getByText('NUT')).toBeInTheDocument();

    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(names.slice(0, 3)).toEqual(['Acme Steel', 'Beta Supply', 'No vendor chosen']);
  });

  it('counts a bought part still to ship as demand, linked to its job', async () => {
    asMock(loadBuyListSnapshot).mockResolvedValue(
      snapshot({
        parts: [part({ partId: 'pump', preferredVendorId: 'acme', vendors: [vendor('acme')] })],
        demand: [bought('pump', 'j7', 2)],
      }),
    );
    const user = userEvent.setup();
    renderList();

    await screen.findByText('PUMP');
    await user.click(within(group('Acme Steel')).getByRole('button', { name: /create draft po for acme steel/i }));
    await waitFor(() => expect(createVendorPo).toHaveBeenCalledTimes(1));
    const [{ lines }] = asMock(createVendorPo).mock.calls[0];
    expect(lines[0]).toEqual(
      expect.objectContaining({ partId: 'pump', quantity: 2, jobId: 'j7', jobPartId: 'j7-bought' }),
    );
  });
});

describe('BuyList — ordering from a group', () => {
  it('creates ONE draft PO for the vendor with the ticked rows, then says so with a link', async () => {
    const user = userEvent.setup();
    asMock(loadBuyListSnapshot).mockResolvedValue(twoVendorSnapshot());
    renderList();

    await screen.findByText('STEEL');
    await user.click(within(group('Acme Steel')).getByRole('button', { name: /create draft po for acme steel/i }));

    await waitFor(() => expect(createVendorPo).toHaveBeenCalledTimes(1));
    const today = todayLocalISODate();
    expect(createVendorPo).toHaveBeenCalledWith(
      expect.objectContaining({
        vendorId: 'acme',
        orderedOn: today,
        today,
        lines: [
          expect.objectContaining({
            lineKind: 'part',
            partId: 'steel',
            quantity: 5,
            unit: 'each',
            unitPrice: 10,
            priceSource: 'price_sheet',
            jobId: 'j1',
          }),
        ],
      }),
    );
    expect(updateVendorPo).not.toHaveBeenCalled();
    expect(posthog.capture).toHaveBeenCalledWith('vendor po created', expect.objectContaining({ surface: 'buy_list' }));

    const notice = await screen.findByText(/draft PO-1043 created for Acme Steel/i);
    expect(notice).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open PO-1043/i })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/orders/po-new',
    );
    // The list re-reads, so the rows now on the draft drop off.
    await waitFor(() => expect(loadBuyListSnapshot).toHaveBeenCalledTimes(2));
  });

  it('adds to the vendor’s existing draft instead of starting a second one', async () => {
    const user = userEvent.setup();
    asMock(loadBuyListSnapshot).mockResolvedValue({
      ...twoVendorSnapshot(),
      draftsByVendor: { acme: { vendorPurchaseOrderId: 'po-draft', poNumber: 'PO-1040' } },
    });
    renderList();

    await screen.findByText('STEEL');
    expect(within(group('Acme Steel')).queryByRole('button', { name: /create draft/i })).not.toBeInTheDocument();
    await user.click(within(group('Acme Steel')).getByRole('button', { name: /add to draft PO-1040/i }));

    await waitFor(() => expect(updateVendorPo).toHaveBeenCalledTimes(1));
    expect(updateVendorPo).toHaveBeenCalledWith(
      'po-draft',
      expect.objectContaining({
        today: todayLocalISODate(),
        lines: [expect.objectContaining({ lineKind: 'part', partId: 'steel', quantity: 5 })],
      }),
    );
    expect(createVendorPo).not.toHaveBeenCalled();
    expect(await screen.findByText(/added 1 line to draft PO-1040/i)).toBeInTheDocument();
    // Counted as an update FROM THE BUY LIST, so it is never mistaken for a form edit.
    expect(posthog.capture).toHaveBeenCalledWith('vendor po updated', {
      surface: 'buy_list',
      revision_bumped: false,
      added_line_count: 1,
      removed_line_count: 0,
      changed_line_count: 0,
      header_changed: false,
    });
  });

  it('leaves out a row that was unticked', async () => {
    const user = userEvent.setup();
    asMock(loadBuyListSnapshot).mockResolvedValue(
      snapshot({
        parts: [
          part({ partId: 'steel', preferredVendorId: 'acme', vendors: [vendor('acme')] }),
          part({ partId: 'rod', preferredVendorId: 'acme', vendors: [vendor('acme')] }),
        ],
        demand: [material('steel', 'j1', 5), material('rod', 'j1', 3)],
      }),
    );
    renderList();

    await screen.findByText('ROD');
    await user.click(screen.getByRole('checkbox', { name: /include rod/i }));
    await user.click(screen.getByRole('button', { name: /create draft po for acme steel/i }));

    await waitFor(() => expect(createVendorPo).toHaveBeenCalledTimes(1));
    const [{ lines }] = asMock(createVendorPo).mock.calls[0];
    expect(lines.map((l: { partId: string }) => l.partId)).toEqual(['steel']);
  });

  /** A typed quantity crosses a price break, so the price is re-defaulted for it — not kept from 5. */
  it('prices an edited quantity at its own break, and sends what was typed', async () => {
    const user = userEvent.setup();
    asMock(loadBuyListSnapshot).mockResolvedValue(twoVendorSnapshot());
    renderList();

    await screen.findByText('STEEL');
    const qty = screen.getByRole('textbox', { name: /quantity of steel to buy/i });
    await user.clear(qty);
    await user.type(qty, '12');

    const steelRow = qty.closest('tr')!;
    expect(within(steelRow).getByText('$8.00')).toBeInTheDocument();
    expect(within(steelRow).getByText('$96.00')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create draft po for acme steel/i }));
    await waitFor(() => expect(createVendorPo).toHaveBeenCalledTimes(1));
    const [{ lines }] = asMock(createVendorPo).mock.calls[0];
    expect(lines[0]).toEqual(expect.objectContaining({ quantity: 12, unitPrice: 8, priceSource: 'price_sheet' }));
  });

  /** Invariant 1: a refresh re-derives the list; it never re-seeds a quantity somebody typed. */
  it('keeps an edited quantity through the refresh after another group’s write', async () => {
    const user = userEvent.setup();
    asMock(loadBuyListSnapshot).mockResolvedValue(twoVendorSnapshot());
    renderList();

    await screen.findByText('BOLT');
    const boltQty = screen.getByRole('textbox', { name: /quantity of bolt to buy/i });
    await user.clear(boltQty);
    await user.type(boltQty, '7');

    await user.click(screen.getByRole('button', { name: /create draft po for acme steel/i }));
    await waitFor(() => expect(loadBuyListSnapshot).toHaveBeenCalledTimes(2));
    await screen.findByText(/draft PO-1043 created/i);

    expect(screen.getByRole('textbox', { name: /quantity of bolt to buy/i })).toHaveValue('7');
  });

  it('will not order a ticked row with no quantity, and says which one', async () => {
    const user = userEvent.setup();
    asMock(loadBuyListSnapshot).mockResolvedValue(twoVendorSnapshot());
    renderList();

    await screen.findByText('STEEL');
    await user.clear(screen.getByRole('textbox', { name: /quantity of steel to buy/i }));

    const acme = group('Acme Steel');
    expect(within(acme).getByRole('button', { name: /create draft po for acme steel/i })).toBeDisabled();
    expect(within(acme).getByText(/how many STEEL to buy/i)).toBeInTheDocument();
  });

  it('shows a refused write in the group and keeps the list as it was', async () => {
    const user = userEvent.setup();
    asMock(loadBuyListSnapshot).mockResolvedValue(twoVendorSnapshot());
    asMock(createVendorPo).mockRejectedValue(new Error('Acme Steel is marked Do not use for STEEL.'));
    renderList();

    await screen.findByText('STEEL');
    await user.click(screen.getByRole('button', { name: /create draft po for acme steel/i }));

    expect(await within(group('Acme Steel')).findByText(/marked Do not use/i)).toBeInTheDocument();
    expect(posthog.capture).not.toHaveBeenCalledWith('vendor po created', expect.anything());
    expect(loadBuyListSnapshot).toHaveBeenCalledTimes(1);
  });

  it('starts an RFQ for the "No vendor chosen" group with its ticked parts', async () => {
    asMock(loadBuyListSnapshot).mockResolvedValue(
      snapshot({
        parts: [part({ partId: 'nut' }), part({ partId: 'washer' })],
        demand: [material('nut', 'j1', 3), material('washer', 'j1', 9)],
      }),
    );
    renderList();

    await screen.findByText('NUT');
    const noVendor = group('No vendor chosen');
    expect(within(noVendor).queryByRole('button', { name: /create draft/i })).not.toBeInTheDocument();
    const href = within(noVendor).getByRole('link', { name: /ask for prices \(rfq\)/i }).getAttribute('href')!;
    const url = new URL(href, 'https://jigged.test');
    expect(url.pathname).toBe('/dashboard/co1/purchasing/rfqs/new');
    expect(url.searchParams.getAll('part').sort()).toEqual(['nut', 'washer']);
    // What tells the RFQ form — and its `vendor rfq created` event — that the buy list started it.
    expect(url.searchParams.get('from')).toBe('to-buy');
  });

  it('moves a row to a vendor that is not on the part’s list through "Another vendor…"', async () => {
    const user = userEvent.setup();
    asMock(loadBuyListSnapshot).mockResolvedValue(
      snapshot({ parts: [part({ partId: 'nut' })], demand: [material('nut', 'j1', 3)] }),
    );
    renderList();

    await screen.findByText('NUT');
    await user.click(screen.getByRole('combobox', { name: /buy nut from/i }));
    await user.click(await screen.findByRole('option', { name: /another vendor/i }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Vendor' }), 'gamma');
    await user.click(within(dialog).getByRole('button', { name: /^buy from gamma metals$/i }));

    await waitFor(() => expect(within(group('Gamma Metals')).getByText('NUT')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /create draft po for gamma metals/i }));
    await waitFor(() => expect(createVendorPo).toHaveBeenCalledTimes(1));
    expect(asMock(createVendorPo).mock.calls[0][0]).toEqual(expect.objectContaining({ vendorId: 'gamma' }));
  });
});

describe('BuyList — what it says about itself', () => {
  it('says a capped read means the list may be incomplete', async () => {
    asMock(loadBuyListSnapshot).mockResolvedValue({ ...twoVendorSnapshot(), truncatedSources: ['job_parts'] });
    renderList();
    expect(await screen.findByText(/this list may be incomplete/i)).toBeInTheDocument();
    expect(screen.getByText(/open job parts/i)).toBeInTheDocument();
  });

  it('reports the shape of what it showed, once per visit — not again after its own refresh', async () => {
    const user = userEvent.setup();
    asMock(loadBuyListSnapshot).mockResolvedValue(twoVendorSnapshot());
    renderList();

    await screen.findByText('STEEL');
    await waitFor(() =>
      expect(posthog.capture).toHaveBeenCalledWith('buy list loaded', {
        row_count: 3,
        job_row_count: 3,
        reorder_row_count: 0,
        no_vendor_row_count: 1,
        incomparable_count: 0,
        truncated: false,
      }),
    );

    await user.click(screen.getByRole('button', { name: /create draft po for acme steel/i }));
    await waitFor(() => expect(loadBuyListSnapshot).toHaveBeenCalledTimes(2));
    const loads = asMock(posthog.capture).mock.calls.filter(([event]) => event === 'buy list loaded');
    expect(loads).toHaveLength(1);
  });

  it('narrows to one job from ?job=, with a chip that clears it', async () => {
    const user = userEvent.setup();
    setSearchParams('view=to-buy&job=j2');
    asMock(loadBuyListSnapshot).mockResolvedValue(twoVendorSnapshot());
    renderList();

    expect(await screen.findByText('NUT')).toBeInTheDocument();
    expect(screen.queryByText('STEEL')).not.toBeInTheDocument();
    expect(screen.getByText(/quantities cover every open job/i)).toBeInTheDocument();

    const chip = screen.getByRole('button', { name: /for J2/i });
    await user.click(within(chip).getByTestId('CancelIcon'));
    expect(routerMocks.replace).toHaveBeenCalledWith('/dashboard/test-company-id?view=to-buy');
  });

  it('never writes on its own', async () => {
    asMock(loadBuyListSnapshot).mockResolvedValue(twoVendorSnapshot());
    renderList();
    await screen.findByText('STEEL');
    expect(createVendorPo).not.toHaveBeenCalled();
    expect(updateVendorPo).not.toHaveBeenCalled();
  });
});
