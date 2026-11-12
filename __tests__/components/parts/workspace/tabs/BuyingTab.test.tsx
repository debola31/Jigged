/**
 * The part's Buying tab (criteria V1, V2, L4): the approved vendor list with its price sheets, the
 * preferred star, inline Save/Cancel editing, archive that asks first and re-adding that revives,
 * and what is on order.
 *
 * The access layer is mocked: these tests hold the screen to WHAT IT SENDS (the RPC-shaped
 * arguments of `savePartVendor` / `archivePartVendor`) and what it says in words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within, waitFor } from '../../../../test-utils';

const m = vi.hoisted(() => ({
  listPartVendors: vi.fn(),
  savePartVendor: vi.fn(),
  archivePartVendor: vi.fn(),
  getOnOrderForParts: vi.fn(),
  listVendorPoLinesForPart: vi.fn(),
  updatePartPreferredVendor: vi.fn(),
  getAllVendors: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { capture: m.capture } }));
vi.mock('@/utils/partVendorsAccess', () => ({
  listPartVendors: (...a: unknown[]) => m.listPartVendors(...a),
  savePartVendor: (...a: unknown[]) => m.savePartVendor(...a),
  archivePartVendor: (...a: unknown[]) => m.archivePartVendor(...a),
}));
vi.mock('@/utils/vendorPoAccess', () => ({
  getOnOrderForParts: (...a: unknown[]) => m.getOnOrderForParts(...a),
  listVendorPoLinesForPart: (...a: unknown[]) => m.listVendorPoLinesForPart(...a),
}));
vi.mock('@/utils/partsAccess', () => ({
  updatePartPreferredVendor: (...a: unknown[]) => m.updatePartPreferredVendor(...a),
}));
vi.mock('@/utils/vendorsAccess', () => ({ getAllVendors: (...a: unknown[]) => m.getAllVendors(...a) }));
// The sourcing dialog has its own suite; here it only has to open for the right sheet.
vi.mock('@/components/parts/UseAsPartCostDialog', () => ({
  default: ({ partVendorId, open }: { partVendorId: string | null; open: boolean }) =>
    open ? <div>use-cost:{partVendorId}</div> : null,
}));

import BuyingTab from '@/components/parts/workspace/tabs/BuyingTab';
import type { Part } from '@/types/part';
import type { PartVendorList, PartVendorRow } from '@/types/partVendor';
import type { PartOnOrder, VendorPoPartLine } from '@/types/vendorPo';

const part: Part = {
  id: 'part-bar',
  company_id: 'c1',
  part_name: 'BAR-6061',
  description: '6061-T6 round bar',
  source: 'bought',
  primary_unit: 'inches',
  quantity: 0,
  reorder_point: null,
  preferred_vendor_id: 'v-acme',
  costing_batch_quantity: null,
  lot_tracked: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function row(over: Partial<PartVendorRow> & Pick<PartVendorRow, 'id' | 'vendorId' | 'vendorName'>): PartVendorRow {
  return {
    partId: 'part-bar',
    status: 'approved',
    statusNote: null,
    vendorPartNumber: null,
    purchaseUnit: 'inches',
    purchaseFactor: 1,
    factorLabel: null,
    leadTimeDays: null,
    minimumOrderQuantity: null,
    quotedOn: null,
    validUntil: null,
    isExpired: false,
    notes: null,
    isPreferred: false,
    breaks: [],
    lastPurchase: null,
    createdAt: 'c',
    updatedAt: 'u',
    ...over,
  };
}

const ACME = row({
  id: 'pv-1',
  vendorId: 'v-acme',
  vendorName: 'Acme Steel',
  vendorPartNumber: 'ACME-61',
  purchaseUnit: 'bar',
  purchaseFactor: 144,
  factorLabel: '1 bar = 144 in',
  leadTimeDays: 5,
  minimumOrderQuantity: 2,
  quotedOn: '2026-09-01',
  validUntil: '2026-12-31',
  isPreferred: true,
  breaks: [
    { id: 'b1', minQuantity: 1, unitPrice: 60, source: 'manual', vendorRfqResponseId: null },
    { id: 'b2', minQuantity: 10, unitPrice: 50, source: 'rfq', vendorRfqResponseId: 'r1' },
  ],
  lastPurchase: {
    vendorPurchaseOrderId: 'po-40',
    poNumber: 'PO-0040',
    orderedOn: '2026-10-01',
    lineId: 'l-40',
    quantity: 3,
    unit: 'bar',
    unitPrice: 55,
    unitPricePerStockUnit: 0.381944,
    stockUnit: 'inches',
    stockFactor: 144,
  },
});
const BETA = row({
  id: 'pv-2',
  vendorId: 'v-beta',
  vendorName: 'Beta Metals',
  status: 'conditional',
  statusNote: 'late twice',
  validUntil: '2026-10-31',
  isExpired: true,
});
const ZETA = row({ id: 'pv-3', vendorId: 'v-zeta', vendorName: 'Zeta Supply', status: 'disapproved' });

function list(over: Partial<PartVendorList> = {}): PartVendorList {
  return {
    part: {
      id: 'part-bar',
      partName: 'BAR-6061',
      source: 'bought',
      stockUnit: 'inches',
      preferredVendorId: 'v-acme',
      conversions: [{ from_unit: 'bar', to_primary_factor: 144 }],
    },
    rows: [ACME, BETA, ZETA],
    preferredVendorMissing: false,
    ...over,
  };
}

const onPartChanged = vi.fn();
const onDirtyChange = vi.fn();

function renderTab() {
  return render(
    <BuyingTab part={part} companyId="c1" partId="part-bar" refreshKey={0} onPartChanged={onPartChanged} onDirtyChange={onDirtyChange} />,
  );
}

const vendorRow = (name: string) => screen.getByRole('listitem', { name });

beforeEach(() => {
  vi.clearAllMocks();
  m.listPartVendors.mockResolvedValue(list());
  m.getOnOrderForParts.mockResolvedValue(new Map());
  m.listVendorPoLinesForPart.mockResolvedValue({ rows: [], total: 0, truncated: false });
  m.savePartVendor.mockResolvedValue({ partVendorId: 'pv-1', created: false, revived: false, preferred: true });
  m.archivePartVendor.mockResolvedValue({ partVendorId: 'pv-2', archived: true, clearedPreferred: false });
  m.updatePartPreferredVendor.mockResolvedValue(undefined);
  m.getAllVendors.mockResolvedValue([
    { id: 'v-acme', company_id: 'c1', name: 'Acme Steel', created_at: '', updated_at: '' },
    { id: 'v-gamma', company_id: 'c1', name: 'Gamma Tube', created_at: '', updated_at: '' },
  ]);
});

describe('BuyingTab — the approved vendor list (V1, V2, L4)', () => {
  it('lists each vendor with its status in words, its sheet and its Last PO price', async () => {
    renderTab();
    const acme = await screen.findByRole('listitem', { name: 'Acme Steel' });
    expect(within(acme).getByText('Approved')).toBeInTheDocument();
    expect(within(acme).getByText(/Their part # ACME-61/)).toBeInTheDocument();
    expect(within(acme).getByText(/Bought in bar \(1 bar = 144 in\)/)).toBeInTheDocument();
    expect(within(acme).getByText(/Lead time 5 days/)).toBeInTheDocument();
    expect(within(acme).getByText(/Minimum order 2 bar/)).toBeInTheDocument();
    expect(within(acme).getByText(/1\+ bar \$60\.00/)).toBeInTheDocument();
    expect(within(acme).getByText(/10\+ bar \$50\.00/)).toBeInTheDocument();
    expect(within(acme).getByText(/Last PO price \$55\.00 \/ bar/)).toBeInTheDocument();
    expect(within(acme).getByRole('link', { name: 'PO-0040' })).toHaveAttribute(
      'href',
      '/dashboard/c1/purchasing/orders/po-40',
    );
    expect(m.listPartVendors).toHaveBeenCalledWith('part-bar', { today: expect.any(String) });
  });

  it('marks Conditional and Do not use in words, and an expired sheet with an Expired chip', async () => {
    renderTab();
    const beta = await screen.findByRole('listitem', { name: 'Beta Metals' });
    expect(within(beta).getByText('Conditional')).toBeInTheDocument();
    expect(within(beta).getByText(/late twice/)).toBeInTheDocument();
    expect(within(beta).getByText('Expired')).toBeInTheDocument();
    expect(within(vendorRow('Zeta Supply')).getByText('Do not use')).toBeInTheDocument();
    expect(within(vendorRow('Acme Steel')).queryByText('Expired')).toBeNull();
  });

  it('the star IS the preferred vendor: starring another goes through save_part_vendor', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Make Beta Metals the preferred vendor' }));
    await waitFor(() =>
      expect(m.savePartVendor).toHaveBeenCalledWith({ partId: 'part-bar', vendorId: 'v-beta', makePreferred: true }),
    );
    expect(onPartChanged).toHaveBeenCalled();
    // The star is not a list edit, so it is not counted as one.
    expect(m.capture).not.toHaveBeenCalled();
  });

  it('pressing the filled star clears the preference', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: /Acme Steel is the preferred vendor/ }));
    await waitFor(() => expect(m.updatePartPreferredVendor).toHaveBeenCalledWith('part-bar', null));
    expect(onPartChanged).toHaveBeenCalled();
  });

  it('a refused star says why, in the database’s words', async () => {
    const user = userEvent.setup();
    m.savePartVendor.mockRejectedValue(new Error("Zeta Supply is marked Do not use for BAR-6061, so it can't be the preferred vendor."));
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Make Zeta Supply the preferred vendor' }));
    expect(await screen.findByText(/marked Do not use for BAR-6061/)).toBeInTheDocument();
    expect(onPartChanged).not.toHaveBeenCalled();
  });

  it('links a new PO for this vendor and part — but not for a Do not use vendor', async () => {
    renderTab();
    const acme = await screen.findByRole('listitem', { name: 'Acme Steel' });
    expect(within(acme).getByRole('link', { name: 'New PO' })).toHaveAttribute(
      'href',
      '/dashboard/c1/purchasing/orders/new?vendor=v-acme&part=part-bar',
    );
    expect(within(vendorRow('Zeta Supply')).queryByRole('link', { name: 'New PO' })).toBeNull();
  });

  it('says plainly when the preferred vendor is archived, rather than hiding it', async () => {
    m.listPartVendors.mockResolvedValue(list({ rows: [BETA], preferredVendorMissing: true }));
    renderTab();
    expect(await screen.findByText(/preferred vendor is archived/)).toBeInTheDocument();
  });

  it('an empty list invites adding a vendor', async () => {
    m.listPartVendors.mockResolvedValue(list({ rows: [] }));
    renderTab();
    expect(await screen.findByText(/No vendors on this part's list yet/)).toBeInTheDocument();
  });

  it('a failed load offers Try Again, never "no vendors"', async () => {
    m.listPartVendors.mockRejectedValue(new Error("Failed to load the part's vendors."));
    renderTab();
    expect(await screen.findByText(/Couldn't load this part's vendors/)).toBeInTheDocument();
    expect(screen.queryByText(/No vendors on this part's list yet/)).toBeNull();
  });
});

describe('BuyingTab — inline editing (V2)', () => {
  const user = userEvent.setup();

  it('edits a row in place: Save sends only what changed, then counts the save', async () => {
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Edit Acme Steel' }));
    const editor = screen.getByRole('group', { name: /Acme Steel/ });
    const lead = within(editor).getByLabelText('Lead time (days)');
    expect(lead).toHaveValue('5');
    await user.clear(lead);
    await user.type(lead, '7');
    await user.click(within(editor).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(m.savePartVendor).toHaveBeenCalledWith({
        partId: 'part-bar',
        vendorId: 'v-acme',
        changes: { leadTimeDays: 7 },
      }),
    );
    expect(m.capture).toHaveBeenCalledWith('part vendor saved', {
      is_new: false,
      status: 'approved',
      break_count: 2,
      has_vendor_part_number: true,
      has_lead_time: true,
      has_valid_until: true,
    });
    // Back to the row, refreshed.
    expect(await screen.findByRole('listitem', { name: 'Acme Steel' })).toBeInTheDocument();
    expect(m.listPartVendors.mock.calls.length).toBeGreaterThan(1);
  });

  it('a changed price replaces the whole sheet with what is on screen', async () => {
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Edit Acme Steel' }));
    const editor = screen.getByRole('group', { name: /Acme Steel/ });
    const firstPrice = within(editor).getAllByLabelText(/^Price per bar/)[0];
    await user.clear(firstPrice);
    await user.type(firstPrice, '58');
    await user.click(within(editor).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(m.savePartVendor).toHaveBeenCalled());
    expect(m.savePartVendor.mock.calls[0][0]).toEqual({
      partId: 'part-bar',
      vendorId: 'v-acme',
      changes: {},
      priceBreaks: [
        { minQuantity: 1, unitPrice: 58 },
        { minQuantity: 10, unitPrice: 50 },
      ],
    });
  });

  it('Cancel puts the row back and writes nothing', async () => {
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Edit Acme Steel' }));
    await user.click(within(screen.getByRole('group', { name: /Acme Steel/ })).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('listitem', { name: 'Acme Steel' })).toBeInTheDocument();
    expect(m.savePartVendor).not.toHaveBeenCalled();
  });

  it('reports an editor holding changes to the exit guard, and clears it on Cancel', async () => {
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Edit Acme Steel' }));
    const editor = screen.getByRole('group', { name: /Acme Steel/ });
    await user.type(within(editor).getByLabelText('Their part #'), '-X');
    expect(onDirtyChange).toHaveBeenLastCalledWith('buying', true);
    await user.click(within(editor).getByRole('button', { name: 'Cancel' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith('buying', false);
  });

  it('says what is wrong with a sheet in words, beside a disabled Save', async () => {
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Edit Acme Steel' }));
    const editor = screen.getByRole('group', { name: /Acme Steel/ });
    const lead = within(editor).getByLabelText('Lead time (days)');
    await user.clear(lead);
    await user.type(lead, '800');
    const firstPrice = within(editor).getAllByLabelText(/^Price per bar/)[0];
    await user.clear(firstPrice);
    await user.type(firstPrice, '0');
    expect(within(editor).getByText(/Lead time is a whole number of days, up to 730/)).toBeInTheDocument();
    expect(within(editor).getByText(/Each price break needs a quantity and a price above zero/)).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('adds a vendor with its first price break', async () => {
    m.savePartVendor.mockResolvedValue({ partVendorId: 'pv-9', created: true, revived: false, preferred: false });
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Add vendor' }));
    const editor = screen.getByRole('group', { name: /New vendor/ });
    await user.click(within(editor).getByRole('combobox', { name: /Vendor/ }));
    await user.click(await screen.findByRole('option', { name: 'Gamma Tube' }));
    await user.type(within(editor).getByLabelText(/^From \(in\)/), '1');
    await user.type(within(editor).getByLabelText(/^Price per in/), '0.45');
    await user.click(within(editor).getByRole('button', { name: 'Add vendor' }));

    await waitFor(() =>
      expect(m.savePartVendor).toHaveBeenCalledWith({
        partId: 'part-bar',
        vendorId: 'v-gamma',
        changes: { status: 'approved', purchaseUnit: 'inches' },
        priceBreaks: [{ minQuantity: 1, unitPrice: 0.45 }],
      }),
    );
    expect(m.capture).toHaveBeenCalledWith('part vendor saved', {
      is_new: true,
      status: 'approved',
      break_count: 1,
      has_vendor_part_number: false,
      has_lead_time: false,
      has_valid_until: false,
    });
  });

  it('adding a vendor that was on the list before brings its row back, and says so', async () => {
    m.savePartVendor.mockResolvedValue({ partVendorId: 'pv-old', created: false, revived: true, preferred: false });
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Add vendor' }));
    const editor = screen.getByRole('group', { name: /New vendor/ });
    await user.click(within(editor).getByRole('combobox', { name: /Vendor/ }));
    await user.click(await screen.findByRole('option', { name: 'Gamma Tube' }));
    await user.click(within(editor).getByRole('button', { name: 'Add vendor' }));
    expect(await screen.findByText(/Gamma Tube was on this list before/)).toBeInTheDocument();
    // Left blank, so the earlier sheet is kept rather than wiped.
    expect(m.savePartVendor.mock.calls[0][0]).not.toHaveProperty('priceBreaks');
    // ...AND ITS UNIT. The form opens on the stock unit; sending that unasked re-read a kept
    // "$60 per bar" sheet as $60 per inch (found end to end: purchasing-vendors-sourcing.spec.ts).
    expect(m.savePartVendor.mock.calls[0][0].changes).toEqual({ status: 'approved' });
  });

  it('a unit the person picks, or prices typed in the unit on screen, are sent with that unit', async () => {
    m.savePartVendor.mockResolvedValue({ partVendorId: 'pv-9', created: true, revived: false, preferred: false });
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Add vendor' }));
    const editor = screen.getByRole('group', { name: /New vendor/ });
    await user.click(within(editor).getByRole('combobox', { name: /Vendor/ }));
    await user.click(await screen.findByRole('option', { name: 'Gamma Tube' }));
    await user.click(within(editor).getByRole('combobox', { name: 'Bought in' }));
    await user.click(await screen.findByRole('option', { name: 'bar' }));
    await user.click(within(editor).getByRole('button', { name: 'Add vendor' }));
    await waitFor(() => expect(m.savePartVendor).toHaveBeenCalled());
    expect(m.savePartVendor.mock.calls[0][0].changes).toEqual({ status: 'approved', purchaseUnit: 'bar' });
  });

  it('will not add a vendor that is already on the list', async () => {
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Add vendor' }));
    const editor = screen.getByRole('group', { name: /New vendor/ });
    await user.click(within(editor).getByRole('combobox', { name: /Vendor/ }));
    await user.click(await screen.findByRole('option', { name: 'Acme Steel' }));
    expect(within(editor).getByText(/Acme Steel is already on this list/)).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: 'Add vendor' })).toBeDisabled();
  });
});

describe('BuyingTab — archive asks first (V1)', () => {
  const user = userEvent.setup();

  it('takes a vendor off only after the dialog, and counts it', async () => {
    renderTab();
    await user.click(await screen.findByRole('button', { name: "Remove Beta Metals from this part's vendors" }));
    expect(m.archivePartVendor).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Remove Beta Metals from BAR-6061's vendors\?/)).toBeInTheDocument();
    expect(within(dialog).getByText(/adding Beta Metals again brings it back/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(m.archivePartVendor).toHaveBeenCalledWith('pv-2'));
    expect(m.capture).toHaveBeenCalledWith('part vendor archived');
    expect(onPartChanged).not.toHaveBeenCalled();
  });

  it('removing the preferred vendor says the preference goes too, and refreshes the part', async () => {
    m.archivePartVendor.mockResolvedValue({ partVendorId: 'pv-1', archived: true, clearedPreferred: true });
    renderTab();
    await user.click(await screen.findByRole('button', { name: "Remove Acme Steel from this part's vendors" }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/no preferred vendor/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onPartChanged).toHaveBeenCalled());
  });
});

describe('BuyingTab — Use as part cost', () => {
  it("opens the preview for that vendor's sheet", async () => {
    const user = userEvent.setup();
    renderTab();
    const acme = await screen.findByRole('listitem', { name: 'Acme Steel' });
    await user.click(within(acme).getByRole('button', { name: 'Use as part cost' }));
    expect(await screen.findByText('use-cost:pv-1')).toBeInTheDocument();
  });
});

describe('BuyingTab — purchase orders for this part', () => {
  const onOrder: PartOnOrder = {
    partId: 'part-bar',
    stockUnit: 'inches',
    onOrder: 288,
    onDraft: 144,
    nextExpectedOn: '2026-12-09',
    openLineCount: 1,
    draftLineCount: 1,
    unitMismatchLineCount: 0,
    refs: [
      { vendorPurchaseOrderId: 'po-42', poNumber: 'PO-0042', vendorId: 'v-acme', lineId: 'l1', lineNumber: 1, stockQuantity: 288, expectedOn: '2026-12-09', isDraft: false, status: 'open' },
      { vendorPurchaseOrderId: 'po-43', poNumber: 'PO-0043', vendorId: 'v-beta', lineId: 'l2', lineNumber: 1, stockQuantity: 144, expectedOn: null, isDraft: true, status: 'draft' },
    ],
  };

  it('shows on order and on draft in the stock unit, with each PO', async () => {
    m.getOnOrderForParts.mockResolvedValue(new Map([['part-bar', onOrder]]));
    renderTab();
    const card = await screen.findByRole('region', { name: 'Purchase orders' });
    expect(await within(card).findByText(/On order: 288 in/)).toBeInTheDocument();
    expect(within(card).getByText(/On draft: 144 in/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'PO-0042' })).toHaveAttribute('href', '/dashboard/c1/purchasing/orders/po-42');
    expect(within(card).getByText(/Draft — not sent yet/)).toBeInTheDocument();
    expect(m.getOnOrderForParts).toHaveBeenCalledWith('c1', ['part-bar']);
  });

  it('links a New PO for the preferred vendor and this part', async () => {
    renderTab();
    const card = await screen.findByRole('region', { name: 'Purchase orders' });
    expect(within(card).getByRole('link', { name: 'New PO' })).toHaveAttribute(
      'href',
      '/dashboard/c1/purchasing/orders/new?vendor=v-acme&part=part-bar',
    );
    expect(await within(card).findByText(/Nothing on order for this part/)).toBeInTheDocument();
  });

  it('a failed on-order load offers Try again, never "nothing on order"', async () => {
    m.getOnOrderForParts.mockRejectedValue(new Error('Failed to load what is on order.'));
    renderTab();
    const card = await screen.findByRole('region', { name: 'Purchase orders' });
    expect(await within(card).findByText(/Couldn't load what's on order/)).toBeInTheDocument();
    expect(within(card).queryByText(/Nothing on order/)).toBeNull();
    expect(within(card).getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  const pastLine = (over: Partial<VendorPoPartLine> = {}): VendorPoPartLine => ({
    lineId: 'l-40',
    vendorPurchaseOrderId: 'po-40',
    poNumber: 'PO-0040',
    poStatus: 'received',
    vendorId: 'v-acme',
    vendorName: 'Acme Steel',
    orderedOn: '2026-10-01',
    lineNumber: 1,
    quantity: 3,
    unit: 'bar',
    receivedQuantity: 3,
    openQuantity: 0,
    status: 'received',
    expectedOn: null,
    isLate: false,
    jobNumber: null,
    createdAt: '2026-10-01T14:00:00Z',
    ...over,
  });

  /** What has come, beside what is coming: the received lines and the ones closed short. */
  it('lists the received and closed lines under what is still on order', async () => {
    m.getOnOrderForParts.mockResolvedValue(new Map([['part-bar', onOrder]]));
    m.listVendorPoLinesForPart.mockResolvedValue({
      rows: [
        pastLine(),
        pastLine({ lineId: 'l-39', vendorPurchaseOrderId: 'po-39', poNumber: 'PO-0039', poStatus: 'closed', status: 'closed', receivedQuantity: 1, orderedOn: '2026-09-01' }),
        pastLine({ lineId: 'l-38', vendorPurchaseOrderId: 'po-38', poNumber: 'PO-0038', receivedQuantity: 4 }),
      ],
      total: 3,
      truncated: false,
    });
    renderTab();
    const card = await screen.findByRole('region', { name: 'Purchase orders' });
    // Still coming, from the on-order read.
    expect(await within(card).findByRole('link', { name: 'PO-0042' })).toBeInTheDocument();

    const past = await within(card).findByRole('region', { name: 'Received and closed' });
    expect(within(past).getByRole('link', { name: 'PO-0040' })).toHaveAttribute('href', '/dashboard/c1/purchasing/orders/po-40');
    expect(past).toHaveTextContent('PO-0040 · Acme Steel · 3 of 3 bar · Received · 10/1/26');
    expect(past).toHaveTextContent('PO-0039 · Acme Steel · 1 of 3 bar · Closed short · 9/1/26');
    expect(past).toHaveTextContent('PO-0038 · Acme Steel · 4 of 3 bar · Received +1');
    // What is still owed is the on-order list's, complete: the history asks only for the rest.
    expect(m.listVendorPoLinesForPart).toHaveBeenCalledWith('part-bar', {
      today: expect.any(String),
      limit: 10,
      statuses: ['received', 'closed'],
    });
  });

  it('shows the history even when nothing is on order, and says when older lines are not shown', async () => {
    m.listVendorPoLinesForPart.mockResolvedValue({ rows: [pastLine()], total: 12, truncated: true });
    renderTab();
    const card = await screen.findByRole('region', { name: 'Purchase orders' });
    expect(await within(card).findByText(/Nothing on order for this part/)).toBeInTheDocument();
    expect(await within(card).findByRole('link', { name: 'PO-0040' })).toBeInTheDocument();
    expect(within(card).getByText(/only the most recent orders are shown/i)).toBeInTheDocument();
  });

  it('a failed history load offers its own Try again, and leaves what is on order standing', async () => {
    m.getOnOrderForParts.mockResolvedValue(new Map([['part-bar', onOrder]]));
    m.listVendorPoLinesForPart.mockRejectedValueOnce(new Error("Failed to load the part's purchase orders."));
    const user = userEvent.setup();
    renderTab();
    const card = await screen.findByRole('region', { name: 'Purchase orders' });
    expect(await within(card).findByText(/Couldn't load the orders already received/)).toBeInTheDocument();
    expect(within(card).getByText(/On order: 288 in/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(m.listVendorPoLinesForPart).toHaveBeenCalledTimes(2));
  });
});
