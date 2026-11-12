/**
 * The RFQ form (criterion Q1): lines are a part or ad-hoc text, each with up to four quantities in
 * one unit; vendors are suggested from the parts' approved vendors first; prefill takes ids only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within, waitFor, fireEvent } from '../../test-utils';

const m = vi.hoisted(() => ({
  createVendorRfq: vi.fn(),
  saveVendorRfq: vi.fn(),
  listPartVendors: vi.fn(),
  getPartsForSelectByIds: vi.fn(),
  searchPartsForSelect: vi.fn(),
  getAllVendors: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { capture: m.capture } }));
vi.mock('@/utils/vendorRfqAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorRfqAccess')>()),
  createVendorRfq: (...a: unknown[]) => m.createVendorRfq(...a),
  saveVendorRfq: (...a: unknown[]) => m.saveVendorRfq(...a),
}));
vi.mock('@/utils/partVendorsAccess', () => ({ listPartVendors: (...a: unknown[]) => m.listPartVendors(...a) }));
vi.mock('@/utils/partsAccess', () => ({
  getPartsForSelectByIds: (...a: unknown[]) => m.getPartsForSelectByIds(...a),
  searchPartsForSelect: (...a: unknown[]) => m.searchPartsForSelect(...a),
}));
vi.mock('@/utils/vendorsAccess', () => ({ getAllVendors: (...a: unknown[]) => m.getAllVendors(...a) }));

import RfqForm from '@/components/purchasing/RfqForm';
import type { PartVendorList } from '@/types/partVendor';
import { rfqDetail } from './rfqFixtures';

const BAR = {
  id: 'part-bar',
  part_name: 'BAR-6061',
  description: '6061-T6 round bar',
  has_routing: false,
  source: 'bought' as const,
  primary_unit: 'inches',
  quantity: 0,
};

function avl(): PartVendorList {
  return {
    part: {
      id: 'part-bar',
      partName: 'BAR-6061',
      source: 'bought',
      stockUnit: 'inches',
      preferredVendorId: 'v-acme',
      conversions: [{ from_unit: 'bar', to_primary_factor: 144 }],
    },
    preferredVendorMissing: false,
    rows: [
      {
        id: 'pv-1', partId: 'part-bar', vendorId: 'v-acme', vendorName: 'Acme Steel', status: 'approved',
        statusNote: null, vendorPartNumber: 'ACME-61', purchaseUnit: 'bar', purchaseFactor: 144,
        factorLabel: '1 bar = 144 in', leadTimeDays: 5, minimumOrderQuantity: null, quotedOn: null,
        validUntil: null, isExpired: false, notes: null, isPreferred: true, breaks: [], lastPurchase: null,
        createdAt: 'c', updatedAt: 'u',
      },
      {
        id: 'pv-2', partId: 'part-bar', vendorId: 'v-zeta', vendorName: 'Zeta Supply', status: 'disapproved',
        statusNote: null, vendorPartNumber: null, purchaseUnit: 'inches', purchaseFactor: 1, factorLabel: null,
        leadTimeDays: null, minimumOrderQuantity: null, quotedOn: null, validUntil: null, isExpired: false,
        notes: null, isPreferred: false, breaks: [], lastPurchase: null, createdAt: 'c', updatedAt: 'u',
      },
    ],
  };
}

const VENDORS = [
  { id: 'v-beta', company_id: 'c', name: 'Beta Metals', created_at: '', updated_at: '' },
  { id: 'v-zeta', company_id: 'c', name: 'Zeta Supply', created_at: '', updated_at: '' },
  { id: 'v-acme', company_id: 'c', name: 'Acme Steel', created_at: '', updated_at: '' },
];

const onSaved = vi.fn();
const onCancel = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  m.getAllVendors.mockResolvedValue(VENDORS);
  m.getPartsForSelectByIds.mockResolvedValue([BAR]);
  m.searchPartsForSelect.mockResolvedValue([BAR]);
  m.listPartVendors.mockResolvedValue(avl());
  m.createVendorRfq.mockResolvedValue({ id: 'rfq-new', rfqNumber: 'RFQ-0008' });
  m.saveVendorRfq.mockResolvedValue({ id: 'rfq-1', rfqNumber: 'RFQ-0007', status: 'quoted', lineIds: [], invitationIds: [], updatedAt: 'x' });
});

describe('RfqForm — a new RFQ (Q1)', () => {
  const user = userEvent.setup();

  it('prefills lines from part ids and vendors from vendor ids, and buys in the sheet unit', async () => {
    render(
      <RfqForm companyId="c" initialPartIds={['part-bar']} initialVendorIds={['v-beta']} onSaved={onSaved} onCancel={onCancel} />,
    );
    expect(await screen.findByDisplayValue('BAR-6061')).toBeInTheDocument();
    expect(m.getPartsForSelectByIds).toHaveBeenCalledWith(['part-bar']);
    // The preferred vendor's sheet is in bars, so the RFQ asks in bars.
    expect(await screen.findByRole('combobox', { name: 'Unit' })).toHaveTextContent('bar');
    expect(await screen.findByRole('button', { name: /Beta Metals/ })).toBeInTheDocument();
  });

  it("suggests the parts' approved vendors first, and never a Do not use one", async () => {
    render(<RfqForm companyId="c" initialPartIds={['part-bar']} onSaved={onSaved} onCancel={onCancel} />);
    const suggested = await screen.findByRole('group', { name: /Suggested vendors/ });
    expect(within(suggested).getByRole('button', { name: /Add Acme Steel/ })).toBeInTheDocument();
    expect(within(suggested).getByText(/approved for 1 of 1 part line/)).toBeInTheDocument();
    expect(within(suggested).queryByText(/Zeta Supply/)).toBeNull();

    // In the picker too: the approved vendor heads the list.
    await user.click(screen.getByRole('combobox', { name: /Vendors to ask/ }));
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveTextContent('Acme Steel');
  });

  it('takes at most four quantities on a line', async () => {
    render(<RfqForm companyId="c" initialPartIds={['part-bar']} onSaved={onSaved} onCancel={onCancel} />);
    await screen.findByDisplayValue('BAR-6061');
    const add = screen.getByRole('button', { name: /Add a quantity/ });
    await user.click(add);
    await user.click(add);
    await user.click(add);
    expect(screen.getAllByLabelText(/^Quantity \d$/)).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /Add a quantity/ })).toBeNull();
  });

  it('says what is missing beside a disabled Create, and sends nothing', async () => {
    render(<RfqForm companyId="c" initialPartIds={['part-bar']} onSaved={onSaved} onCancel={onCancel} />);
    await screen.findByDisplayValue('BAR-6061');
    expect(screen.getByRole('button', { name: 'Create RFQ' })).toBeDisabled();
    expect(screen.getByText(/Line 1 needs a quantity./)).toBeInTheDocument();
    expect(screen.getByText(/Choose at least one vendor to ask./)).toBeInTheDocument();
    expect(m.createVendorRfq).not.toHaveBeenCalled();
  });

  it('creates the RFQ with a part line and an ad-hoc line, and counts its shape', async () => {
    render(
      <RfqForm companyId="c" initialPartIds={['part-bar']} fromBuyList onSaved={onSaved} onCancel={onCancel} />,
    );
    await screen.findByDisplayValue('BAR-6061');
    await user.type(screen.getByLabelText('Quantity 1'), '10');
    await user.click(screen.getByRole('button', { name: /Add a quantity/ }));
    await user.type(screen.getByLabelText('Quantity 2'), '25');

    await user.click(screen.getByRole('button', { name: /Other item/ }));
    const line2 = screen.getByRole('group', { name: /Line 2/ });
    await user.type(within(line2).getByLabelText(/What you need/), 'Brushes');
    await user.type(within(line2).getByLabelText('Quantity 1'), '50');

    await user.click(await screen.findByRole('button', { name: /Add Acme Steel/ }));
    fireEvent.change(screen.getByLabelText('Respond by'), { target: { value: '2026-11-20' } });
    await user.click(screen.getByRole('button', { name: 'Create RFQ' }));

    await waitFor(() => expect(m.createVendorRfq).toHaveBeenCalled());
    const [companyId, input] = m.createVendorRfq.mock.calls[0];
    expect(companyId).toBe('c');
    expect(input.vendorIds).toEqual(['v-acme']);
    expect(input.header).toMatchObject({ respondByOn: '2026-11-20' });
    expect(input.lines).toEqual([
      { partId: 'part-bar', unit: 'bar', quantities: [10, 25], certRequired: false, notes: null },
      { description: 'Brushes', unit: 'each', quantities: [50], certRequired: false, notes: null },
    ]);
    expect(onSaved).toHaveBeenCalledWith('rfq-new');
    expect(m.capture).toHaveBeenCalledWith('vendor rfq created', {
      line_count: 2,
      adhoc_line_count: 1,
      quantity_count: 3,
      vendor_count: 1,
      from_buy_list: true,
    });
  }, 30_000); // A whole create journey: many user-event steps over a large form (vitest.config.ts: per-test, not global).

  it('a refusal from the database stays on screen and nothing is counted', async () => {
    m.createVendorRfq.mockRejectedValue(new Error('Acme Steel is archived, so it can’t be asked to quote.'));
    render(
      <RfqForm companyId="c" initialPartIds={['part-bar']} initialVendorIds={['v-acme']} onSaved={onSaved} onCancel={onCancel} />,
    );
    await screen.findByDisplayValue('BAR-6061');
    await user.type(screen.getByLabelText('Quantity 1'), '10');
    await user.click(screen.getByRole('button', { name: 'Create RFQ' }));
    expect(await screen.findByText(/is archived, so it can’t be asked to quote/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(m.capture).not.toHaveBeenCalled();
  });
});

describe('RfqForm — editing an RFQ', () => {
  const user = userEvent.setup();

  it('sends only what changed, with the updated_at it read', async () => {
    m.listPartVendors.mockResolvedValue(avl());
    render(<RfqForm companyId="c" rfq={rfqDetail()} onSaved={onSaved} onCancel={onCancel} />);
    const title = await screen.findByLabelText(/Title/);
    await user.clear(title);
    await user.type(title, 'Bar stock, revised');
    const line2 = screen.getByRole('group', { name: /Line 2/ });
    await user.click(within(line2).getByRole('button', { name: /Add a quantity/ }));
    await user.type(within(line2).getByLabelText('Quantity 2'), '100');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(m.saveVendorRfq).toHaveBeenCalled());
    expect(m.saveVendorRfq).toHaveBeenCalledWith('rfq-1', {
      changes: { title: 'Bar stock, revised' },
      lines: [{ id: 'line-brush', quantities: [50, 100] }],
      removedLineIds: [],
      addVendorIds: [],
      removedInvitationIds: [],
      expectedUpdatedAt: '2026-11-08T15:00:00.123456+00:00',
    });
    expect(onSaved).toHaveBeenCalledWith('rfq-1');
  }, 30_000); // Same: a full edit journey.

  it('locks the part and unit on a line that has quotes, and says why', async () => {
    render(<RfqForm companyId="c" rfq={rfqDetail()} onSaved={onSaved} onCancel={onCancel} />);
    const line1 = await screen.findByRole('group', { name: /Line 1/ });
    expect(within(line1).getByText(/Has quotes, so its part and unit can't change/)).toBeInTheDocument();
    expect(within(line1).queryByRole('button', { name: /Remove line/ })).toBeNull();
  });
});
