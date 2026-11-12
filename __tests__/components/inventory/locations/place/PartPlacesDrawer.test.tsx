/**
 * One part, and everywhere it is.
 *
 * This is the surface the search now hands off to. The behaviour worth defending is that it is
 * AUTHORITATIVE — it re-reads rather than reusing the search's rows, which are capped — and that it
 * never presents the put-away pile as a shelf someone could walk to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getBalancesForPart: vi.fn(async () => []),
  // The heats section in the drawer reads these. An untracked part has no lots, which is the
  // shape every case in this file uses.
  getLotsForPart: vi.fn(async () => []),
  setPartLotTracking: vi.fn(async () => 0),
}));
vi.mock('@/utils/lotCertificatesAccess', () => ({
  listLotCertificatesForLots: vi.fn(async () => new Map()),
}));
// What is on order for the part (plan §3.10): nothing, unless a case says otherwise.
vi.mock('@/utils/vendorPoAccess', () => ({
  getOnOrderForParts: vi.fn(async () => new Map()),
}));

import PartPlacesDrawer from '@/components/inventory/locations/place/PartPlacesDrawer';
import { getBalancesForPart } from '@/utils/inventoryLocationsAccess';
import { getOnOrderForParts } from '@/utils/vendorPoAccess';
import type { PartOnOrder } from '@/types/vendorPo';

const PART = { id: 'p-oring', name: 'BUY-ORING-214', unit: 'ea' };

const onOpenPlace = vi.fn();
const onClose = vi.fn();

const setup = (part: typeof PART | null = PART) =>
  render(
    <PartPlacesDrawer
      part={part}
      companyId="co1"
      moveDestinations={[{ id: 'bin6', label: 'Cabinet 3 › Bin 6' }]}
      onClose={onClose}
      onOpenPlace={onOpenPlace}
      onChanged={vi.fn()}
    />,
  );

/** The row is the toggle now; opening a bin lives inside the section it opens. */
const expandRow = async (user: ReturnType<typeof userEvent.setup>, path: string) =>
  user.click(await screen.findByRole('button', { name: new RegExp(`^${path}`) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBalancesForPart).mockResolvedValue([
    {
      location_id: 'shelf-a',
      location_name: 'Shelf A',
      path: ['Cabinet 3', 'Shelf A'],
      quantity: 828,
      kind: null,
    },
    {
      location_id: 'shelf-b',
      location_name: 'Shelf B',
      path: ['Cabinet 3', 'Shelf B'],
      quantity: 552,
      kind: null,
    },
  ]);
});

describe('PartPlacesDrawer', () => {
  it('lists every location the part is in, with full paths', async () => {
    setup();

    expect(await screen.findByRole('heading', { name: 'BUY-ORING-214' })).toBeInTheDocument();
    expect(screen.getByText('Cabinet 3 › Shelf A')).toBeInTheDocument();
    expect(screen.getByText('Cabinet 3 › Shelf B')).toBeInTheDocument();
  });

  /** The one sum on the screen, and it is safe: balances are stored in the part's primary unit. */
  it('totals across locations', async () => {
    setup();
    expect(await screen.findByText(/1,380 ea across 2 locations/i)).toBeInTheDocument();
  });

  /**
   * The row EXPANDS rather than navigating. You arrived holding a part and a place; being sent to
   * a bin makes you re-find the part among everything in it.
   */
  it('expands a location into the four verbs instead of navigating', async () => {
    const user = userEvent.setup();
    setup();

    await expandRow(user, 'Cabinet 3 › Shelf B');

    for (const verb of [/^add$/i, /^remove$/i, /^move$/i, /^adjust$/i]) {
      expect(screen.getByRole('button', { name: verb })).toBeInTheDocument();
    }
    expect(onOpenPlace).not.toHaveBeenCalled();
  });

  /** Inside the section, not a second target on the row — that ambiguity was removed elsewhere. */
  it('still offers the bin, from inside the expanded section', async () => {
    const user = userEvent.setup();
    setup();

    await expandRow(user, 'Cabinet 3 › Shelf B');
    await user.click(screen.getByRole('button', { name: /open bin/i }));
    expect(onOpenPlace).toHaveBeenCalledWith('shelf-b');
  });

  it('opens one location at a time', async () => {
    const user = userEvent.setup();
    setup();

    await expandRow(user, 'Cabinet 3 › Shelf A');
    expect(screen.getByRole('button', { name: /open bin/i })).toBeInTheDocument();

    await expandRow(user, 'Cabinet 3 › Shelf B');
    // Still exactly one section open — two forms at once is a form nobody finished.
    expect(screen.getAllByRole('button', { name: /open bin/i })).toHaveLength(1);
  });

  /**
   * The pile is listed — leaving it out would answer "nowhere" for a part sitting in it — but it is
   * marked, because walking to `Unassigned` is not a thing anyone can do.
   */
  it('marks the pile rather than showing it as a location the part lives in', async () => {
    vi.mocked(getBalancesForPart).mockResolvedValue([
      {
        location_id: 'un',
        location_name: 'Unassigned',
        path: ['Unassigned'],
        quantity: 40,
        kind: 'system',
      },
    ]);
    setup();

    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText(/not stored yet/i)).toBeInTheDocument();
  });

  it('says plainly when a part is in no location at all', async () => {
    vi.mocked(getBalancesForPart).mockResolvedValue([]);
    setup();

    expect(await screen.findByText(/is not recorded in any location/i)).toBeInTheDocument();
    expect(screen.getByText(/not in any location/i)).toBeInTheDocument();
  });

  /** Authoritative: it asks its own question rather than reusing the search's capped rows. */
  it('re-reads the part rather than trusting what found it', async () => {
    setup();
    await screen.findByRole('heading', { name: 'BUY-ORING-214' });
    expect(getBalancesForPart).toHaveBeenCalledWith('p-oring');
  });

  it('renders nothing with no part', () => {
    setup(null);
    expect(screen.queryByRole('heading', { name: 'BUY-ORING-214' })).not.toBeInTheDocument();
    expect(getBalancesForPart).not.toHaveBeenCalled();
  });
});

/**
 * The per-part count's door. The part page's Storage tab carried `Count all N locations` until it
 * was removed on 2026-09-09; this rail inherited everything else that tab held, and not this.
 */
describe('PartPlacesDrawer — counting a split part everywhere', () => {
  it('links a part in two locations to one sheet with a row per location', async () => {
    setup();

    const link = await screen.findByRole('link', { name: /count all 2 locations/i });
    expect(link).toHaveAttribute('href', '/dashboard/co1/inventory/count?part=p-oring');
  });

  /** In one place, that row's Adjust already IS counting it everywhere. */
  it('offers nothing extra for a part in one location, however many heats it holds there', async () => {
    vi.mocked(getBalancesForPart).mockResolvedValue([
      {
        location_id: 'shelf-a',
        location_name: 'Shelf A',
        path: ['Cabinet 3', 'Shelf A'],
        quantity: 40,
        kind: null,
        lot_id: 'lot-1',
        lot_code: 'H-4471',
        heat_number: 'H-4471',
      },
      {
        location_id: 'shelf-a',
        location_name: 'Shelf A',
        path: ['Cabinet 3', 'Shelf A'],
        quantity: 12,
        kind: null,
        lot_id: 'lot-2',
        lot_code: 'H-8823',
        heat_number: 'H-8823',
      },
    ]);
    setup();

    // Distinct PLACES, not balance rows: two heats on one shelf is one location.
    expect(await screen.findByText(/52 ea across 1 location/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /count all/i })).not.toBeInTheDocument();
  });
});

describe('PartPlacesDrawer — also on order (plan §3.10, criterion B4)', () => {
  const onOrder = (over: Partial<PartOnOrder> = {}): PartOnOrder => ({
    partId: 'p-oring',
    stockUnit: 'ea',
    onOrder: 288,
    onDraft: 0,
    nextExpectedOn: '2026-03-09',
    openLineCount: 1,
    draftLineCount: 0,
    unitMismatchLineCount: 0,
    refs: [
      {
        vendorPurchaseOrderId: 'po-1042',
        poNumber: 'PO-1042',
        vendorId: 'v1',
        lineId: 'line-1',
        lineNumber: 1,
        stockQuantity: 288,
        expectedOn: '2026-03-09',
        isDraft: false,
        status: 'open',
      },
    ],
    ...over,
  });

  it('says what is on order, with the PO and when it is due, as a link to it', async () => {
    vi.mocked(getOnOrderForParts).mockResolvedValue(new Map([['p-oring', onOrder()]]));
    setup();

    const line = await screen.findByText(/also on order: 288 ea/i);
    expect(line).toHaveTextContent('Also on order: 288 ea · PO-1042 due 3/9/26');
    expect(screen.getByRole('link', { name: 'PO-1042' })).toHaveAttribute(
      'href',
      '/dashboard/co1/purchasing/orders/po-1042',
    );
    expect(getOnOrderForParts).toHaveBeenCalledWith('co1', ['p-oring']);
  });

  it('keeps drafts out of "on order" — the vendor has not seen them — and shows them apart', async () => {
    vi.mocked(getOnOrderForParts).mockResolvedValue(
      new Map([
        [
          'p-oring',
          onOrder({
            onOrder: 0,
            onDraft: 144,
            refs: [{ ...onOrder().refs[0], poNumber: 'PO-1050', vendorPurchaseOrderId: 'po-1050', isDraft: true, status: 'draft', stockQuantity: 144 }],
          }),
        ],
      ]),
    );
    setup();
    expect(await screen.findByText('+144 ea on a draft PO, not sent yet')).toBeInTheDocument();
    expect(screen.queryByText(/also on order/i)).not.toBeInTheDocument();
  });

  it('says nothing when nothing is on order', async () => {
    setup();
    await screen.findByRole('heading', { name: 'BUY-ORING-214' });
    await screen.findByText('Cabinet 3 › Shelf A');
    expect(screen.queryByText(/on order/i)).not.toBeInTheDocument();
  });

  /** A failed read must not look like "nothing on order" — that is the line's whole point. */
  it('says it could not check, rather than nothing, when the read fails', async () => {
    vi.mocked(getOnOrderForParts).mockRejectedValue(new Error('Failed to load what is on order.'));
    setup();
    expect(await screen.findByText(/couldn't check what's on order/i)).toBeInTheDocument();
  });
});
