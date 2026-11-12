/**
 * The purchase order form (plan §3.13 "PO form", criteria P3, P4, L2, L4, QB1).
 *
 * The form holds only what the vendor sees. What is pinned: the vendor's defaults fill only what the
 * person has not touched; Save is blocked only by the items the notice lists; the price default and
 * its caption come from lib/purchasing/priceDefault through the access layer; Do-not-use blocks a
 * line; a sent PO predicts "Save as Rev N+1"; a received line keeps its part and unit; removing a
 * line asks nothing; `beforeunload` is armed only while something is unsaved; and nothing calls
 * QuickBooks before a click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within, routerMocks, resetRouterMocks } from '../../test-utils';
import { otherLine, outsideLine, poDetail, poHeader, poLine } from './vendorPoFixtures';
import type { OpenOutsideOperation, VendorPoPriceDefaultInputs } from '@/types/vendorPo';

const createVendorPo = vi.fn();
const updateVendorPo = vi.fn();
const getPriceDefaultInputs = vi.fn();
const listOpenOutsideOpsForVendor = vi.fn();
vi.mock('@/utils/vendorPoAccess', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/utils/vendorPoAccess')>();
  return {
    // The pure resolver is the real one: the captions under test are its words.
    resolveLinePriceDefault: real.resolveLinePriceDefault,
    createVendorPo: (...a: unknown[]) => createVendorPo(...a),
    updateVendorPo: (...a: unknown[]) => updateVendorPo(...a),
    getPriceDefaultInputs: (...a: unknown[]) => getPriceDefaultInputs(...a),
    listOpenOutsideOpsForVendor: (...a: unknown[]) => listOpenOutsideOpsForVendor(...a),
  };
});
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));

const VENDORS = [
  { id: 'v1', company_id: 'test-company-id', name: 'Acme Steel', default_payment_terms: 'Net 30', created_at: '', updated_at: '' },
  { id: 'v2', company_id: 'test-company-id', name: 'Bolt Supply', default_payment_terms: 'Net 60', created_at: '', updated_at: '' },
];
vi.mock('@/components/vendors/VendorAutocomplete', () => ({
  default: ({ label, valueId, onChange, disabled }: { label: string; valueId?: string | null; onChange: (v: unknown) => void; disabled?: boolean }) => (
    <select aria-label={label} value={valueId ?? ''} disabled={disabled} onChange={(e) => onChange(VENDORS.find((v) => v.id === e.target.value) ?? null)}>
      <option value="">(none)</option>
      {VENDORS.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('@/utils/vendorsAccess', () => ({
  getVendor: vi.fn(async (id: string) => VENDORS.find((v) => v.id === id) ?? null),
}));
const getContactsForVendor = vi.fn();
vi.mock('@/utils/vendorContactsAccess', () => ({ getContactsForVendor: (...a: unknown[]) => getContactsForVendor(...a) }));
const getAddressesForVendor = vi.fn();
vi.mock('@/utils/vendorAddressesAccess', () => ({ getAddressesForVendor: (...a: unknown[]) => getAddressesForVendor(...a) }));
vi.mock('@/utils/customerAccess', () => ({ getAllCustomers: vi.fn(async () => []) }));
vi.mock('@/utils/customerAddressesAccess', () => ({ getAddressesForCustomer: vi.fn(async () => []) }));
vi.mock('@/utils/workCentersAccess', () => ({
  getWorkCentersFlat: vi.fn(async () => [{ id: 'wc1', company_id: 'test-company-id', name: 'Haas VF-2' }]),
}));

const PARTS = [
  { id: 'p1', part_name: '6061-BAR-1', description: '6061-T6 round bar, 1 in', has_routing: false, source: 'bought', primary_unit: 'inches', quantity: 0 },
];
vi.mock('@/components/parts/PartAutocomplete', () => ({
  default: ({ label, value, onChange, disabled }: { label: string; value: { id: string } | null; onChange: (p: unknown) => void; disabled?: boolean }) => (
    <select aria-label={label} value={value?.id ?? ''} disabled={disabled} onChange={(e) => onChange(PARTS.find((p) => p.id === e.target.value) ?? null)}>
      <option value="">(none)</option>
      {PARTS.map((p) => (
        <option key={p.id} value={p.id}>
          {p.part_name}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('@/utils/partsAccess', () => ({ getPartsForSelectByIds: vi.fn(async (ids: string[]) => PARTS.filter((p) => ids.includes(p.id))) }));
const JOBS = [{ id: 'j1', job_number: 'J-1042' }];
vi.mock('@/components/inventory/JobTagPicker', () => ({
  loadTaggableJobs: vi.fn(async () => JOBS),
  default: ({ label, value, onChange }: { label?: string; value: { id: string } | null; onChange: (j: unknown) => void }) => (
    <select aria-label={label ?? 'Job'} value={value?.id ?? ''} onChange={(e) => onChange(JOBS.find((j) => j.id === e.target.value) ?? null)}>
      <option value="">(none)</option>
      {JOBS.map((j) => (
        <option key={j.id} value={j.id}>
          {j.job_number}
        </option>
      ))}
    </select>
  ),
}));

// PaymentTermsPicker is REAL: the lazy QuickBooks load is part of what is under test (QB1).
const listQuickBooksTerms = vi.fn(async () => ({ terms: [] }));
vi.mock('@/utils/quickbooksAccess', () => ({ listQuickBooksTerms: (...a: unknown[]) => listQuickBooksTerms(...a) }));
vi.mock('@/utils/companyAccess', () => ({
  getCustomPaymentTerms: vi.fn(async () => []),
  addCustomPaymentTerm: vi.fn(),
  removeCustomPaymentTerm: vi.fn(),
}));

vi.mock('@/lib/localDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/localDate')>()),
  todayLocalISODate: () => '2026-11-12',
}));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => ({ role: 'user', isAdmin: false, loading: false }) }));
const capture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => capture(...a) } }));

import VendorPoForm from '@/components/purchasing/VendorPoForm';

function inputs(over: Partial<VendorPoPriceDefaultInputs> = {}): VendorPoPriceDefaultInputs {
  return {
    partId: 'p1',
    partName: '6061-BAR-1',
    partSource: 'bought',
    stockUnit: 'inches',
    conversions: [{ from_unit: 'bar', to_primary_factor: 144 }],
    vendorId: 'v1',
    vendorName: 'Acme Steel',
    partVendor: {
      id: 'pv1',
      status: 'approved',
      statusNote: null,
      vendorPartNumber: 'AC-6061-1',
      purchaseUnit: 'bar',
      leadTimeDays: 5,
      minimumOrderQuantity: null,
      validUntil: null,
    },
    sheet: { vendorName: 'Acme Steel', status: 'approved', purchaseUnit: 'bar', stockFactor: 144, validUntil: null, breaks: [{ minQuantity: 1, unitPrice: 120 }] },
    lastPurchases: [],
    lastOrderedUnit: null,
    costTiers: [],
    ...over,
  };
}

function op(over: Partial<OpenOutsideOperation> = {}): OpenOutsideOperation {
  return {
    jobOperationId: 'op30',
    jobId: 'j1',
    jobNumber: 'J-1042',
    jobDueDate: '2026-12-01',
    jobPartId: 'jp2',
    partId: 'p2',
    partName: '1234-A',
    stockUnit: 'each',
    sequence: 30,
    operationName: 'Anodize',
    operationStatus: 'pending',
    vendorServiceId: 'vs1',
    serviceName: 'Anodize',
    vendorServicePrice: 1.25,
    frozenOperationPrice: 1.1,
    priceDefault: { unitPrice: 1.25, priceSource: 'vendor_service', caption: "Acme Steel's price for Anodize · Job costed at $1.10", warnings: [] },
    orderedQuantity: 100,
    sentQuantity: 50,
    goodQuantity: 0,
    atVendorQuantity: 50,
    leftToSendQuantity: 50,
    openLine: null,
    defaultDescription: 'Anodize — 1234-A — Job J-1042, Op 30',
    ...over,
  };
}

const saveButton = () => screen.getByRole('button', { name: /^save/i });
const formLine = (n: number) => screen.getByTestId(`po-form-line-${n}`);

beforeEach(() => {
  vi.clearAllMocks();
  resetRouterMocks();
  getContactsForVendor.mockImplementation(async (vendorId: string) =>
    vendorId === 'v1'
      ? [
          { id: 'c-primary', vendor_id: 'v1', name: 'Pat Primary', role: 'other', role_label: 'Owner', email: 'pat@acme.test', phone: null, is_primary: true, created_at: '1' },
          { id: 'c-sales', vendor_id: 'v1', name: 'Sam Sales', role: 'sales', role_label: null, email: 'sam@acme.test', phone: null, is_primary: false, created_at: '2' },
        ]
      : [{ id: 'c-bolt', vendor_id: 'v2', name: 'Bo Bolt', role: 'sales', role_label: null, email: null, phone: null, is_primary: true, created_at: '1' }],
  );
  getAddressesForVendor.mockImplementation(async (vendorId: string) =>
    vendorId === 'v1'
      ? [
          { id: 'a-other', vendor_id: 'v1', address_line1: '9 Side St', address_line2: null, city: 'Gary', state: 'IN', postal_code: '46402', country: 'USA', attention_to: null, is_default: false },
          { id: 'a-default', vendor_id: 'v1', address_line1: '100 Mill Rd', address_line2: null, city: 'Gary', state: 'IN', postal_code: '46402', country: 'USA', attention_to: null, is_default: true },
        ]
      : [],
  );
  getPriceDefaultInputs.mockResolvedValue(inputs());
  listOpenOutsideOpsForVendor.mockResolvedValue([op()]);
  createVendorPo.mockResolvedValue({ id: 'po-new', poNumber: 'PO-1043' });
  updateVendorPo.mockResolvedValue({ id: 'po-1', revisionBumped: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function pickVendor(user: ReturnType<typeof userEvent.setup>, id = 'v1') {
  await user.selectOptions(screen.getByLabelText('Vendor'), id);
}

async function addPartLine(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^part$/i }));
  const n = screen.getAllByTestId(/^po-form-line-/).length;
  await user.selectOptions(within(formLine(n)).getByLabelText('Part'), 'p1');
  return n;
}

describe('VendorPoForm — a new PO', () => {
  it('cannot be saved empty, and the notice says exactly why', () => {
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    expect(saveButton()).toBeDisabled();
    // The notice bullets each item, so match the sentence inside it.
    expect(screen.getByText(/choose the vendor\./i)).toBeInTheDocument();
    expect(screen.getByText(/add at least one line\./i)).toBeInTheDocument();
  });

  it('fills the vendor’s sales contact, default address and standing terms', async () => {
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    await pickVendor(user);
    await waitFor(() => expect(screen.getByRole('combobox', { name: /contact/i })).toHaveTextContent('Sam Sales'));
    expect(screen.getByRole('combobox', { name: /order from/i })).toHaveTextContent('100 Mill Rd');
    expect(screen.getByLabelText(/payment terms/i)).toHaveValue('Net 30');
  });

  it('keeps terms the person chose when the vendor changes — defaults fill only untouched fields', async () => {
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    await pickVendor(user);
    await waitFor(() => expect(screen.getByLabelText(/payment terms/i)).toHaveValue('Net 30'));

    await user.click(screen.getByLabelText(/payment terms/i));
    await user.click(await screen.findByRole('option', { name: 'Net 15' }));
    await pickVendor(user, 'v2');

    await waitFor(() => expect(screen.getByRole('combobox', { name: /contact/i })).toHaveTextContent('Bo Bolt'));
    expect(screen.getByLabelText(/payment terms/i)).toHaveValue('Net 15');
  });

  it('asks nothing of QuickBooks until the terms picker is opened', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    await pickVendor(user);
    await addPartLine(user);
    await waitFor(() => expect(getPriceDefaultInputs).toHaveBeenCalled());
    expect(listQuickBooksTerms).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/quickbooks'))).toHaveLength(0);
  });

  it('defaults a part line from this vendor’s sheet: its unit, its price, its part number, and names the source', async () => {
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    await pickVendor(user);
    const n = await addPartLine(user);
    const line = formLine(n);
    await waitFor(() => expect(within(line).getByLabelText('Unit price')).toHaveValue('120'));
    expect(getPriceDefaultInputs).toHaveBeenCalledWith('test-company-id', 'v1', 'p1');
    expect(within(line).getByText(/acme steel price sheet · 1\+ bar/i)).toBeInTheDocument();
    expect(within(line).getByText('1 bar = 144 in')).toBeInTheDocument();
    expect(within(line).getByLabelText(/vendor part/i)).toHaveValue('AC-6061-1');
  });

  it('creates the draft with the defaults it showed, then opens it', async () => {
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    await pickVendor(user);
    const n = await addPartLine(user);
    await waitFor(() => expect(within(formLine(n)).getByLabelText('Unit price')).toHaveValue('120'));
    await user.clear(within(formLine(n)).getByLabelText('Quantity'));
    await user.type(within(formLine(n)).getByLabelText('Quantity'), '3');
    await user.click(saveButton());

    await waitFor(() => expect(createVendorPo).toHaveBeenCalledTimes(1));
    const input = createVendorPo.mock.calls[0][0];
    expect(input).toMatchObject({ vendorId: 'v1', orderedOn: '2026-11-12', today: '2026-11-12' });
    expect(input.header).toMatchObject({ vendorContactId: 'c-sales', vendorAddressId: 'a-default', paymentTerms: 'Net 30', shipTo: { kind: 'shop' } });
    expect(input.lines).toEqual([
      expect.objectContaining({
        lineKind: 'part',
        partId: 'p1',
        quantity: 3,
        unit: 'bar',
        unitPrice: 120,
        priceSource: 'price_sheet',
        vendorPartNumber: 'AC-6061-1',
      }),
    ]);
    expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/test-company-id/purchasing/orders/po-new');
    expect(capture).toHaveBeenCalledWith('vendor po created', expect.objectContaining({ surface: 'form', part_line_count: 1, price_sheet_line_count: 1 }));
  });

  it('records a typed price as typed', async () => {
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    await pickVendor(user);
    const n = await addPartLine(user);
    const price = within(formLine(n)).getByLabelText('Unit price');
    await waitFor(() => expect(price).toHaveValue('120'));
    await user.clear(price);
    await user.type(price, '110.5');
    expect(within(formLine(n)).getByText('Typed')).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(createVendorPo).toHaveBeenCalled());
    expect(createVendorPo.mock.calls[0][0].lines[0]).toMatchObject({ unitPrice: 110.5, priceSource: 'manual' });
  });

  it('defaults an outside line from the step: what is left to send, the service price, the description', async () => {
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    await pickVendor(user);
    await user.click(screen.getByRole('button', { name: /^outside service$/i }));
    const line = formLine(1);
    await user.click(within(line).getByRole('combobox', { name: /outside step/i }));
    await user.click(await screen.findByRole('option', { name: /J-1042 · 1234-A · Anodize · 50 left to send/i }));

    expect(within(line).getByLabelText('Quantity')).toHaveValue('50');
    expect(within(line).getByLabelText('Unit price')).toHaveValue('1.25');
    expect(within(line).getByText(/job costed at \$1\.10/i)).toBeInTheDocument();
    expect(within(line).getByLabelText('Need by')).toHaveValue('');
    await user.click(saveButton());
    await waitFor(() => expect(createVendorPo).toHaveBeenCalled());
    expect(createVendorPo.mock.calls[0][0].lines[0]).toMatchObject({
      lineKind: 'outside_service',
      jobOperationId: 'op30',
      quantity: 50,
      unitPrice: 1.25,
      priceSource: 'vendor_service',
      description: 'Anodize — 1234-A — Job J-1042, Op 30',
    });
  });

  it('prompts to use an Outside service line when an Other line names a job with outside work at this vendor', async () => {
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    await pickVendor(user);
    await user.click(screen.getByRole('button', { name: /^other$/i }));
    const line = formLine(1);
    // Required, so its label carries the asterisk.
    await user.type(within(line).getByLabelText(/^description/i), 'Anodize J-1042');
    await user.selectOptions(within(line).getByLabelText(/for job/i), 'j1');
    expect(await within(line).findByText(/use an outside service line so it follows the vendor slips/i)).toBeInTheDocument();
  });
});

describe('VendorPoForm — prefilled from another screen', () => {
  it('takes a prefilled vendor’s contact, address and standing terms, as a pick would', async () => {
    render(<VendorPoForm mode="create" companyId="test-company-id" prefill={{ vendorId: 'v1' }} />);
    await waitFor(() => expect(screen.getByLabelText(/payment terms/i)).toHaveValue('Net 30'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: /contact/i })).toHaveTextContent('Sam Sales'));
    expect(screen.getByRole('combobox', { name: /order from/i })).toHaveTextContent('100 Mill Rd');
  });

  it('fills an outside line from the step it was opened for (an operation card’s Create PO)', async () => {
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" prefill={{ vendorId: 'v1', jobOperationId: 'op30' }} />);
    const line = formLine(1);
    await waitFor(() => expect(within(line).getByLabelText('Quantity')).toHaveValue('50'));
    await user.click(saveButton());
    await waitFor(() => expect(createVendorPo).toHaveBeenCalled());
    expect(createVendorPo.mock.calls[0][0]).toMatchObject({ vendorId: 'v1', lines: [expect.objectContaining({ jobOperationId: 'op30' })] });
    expect(capture).toHaveBeenCalledWith('vendor po created', expect.objectContaining({ surface: 'operation', outside_line_count: 1 }));
  });
});

describe('VendorPoForm — approved vendors (L4)', () => {
  it('says quietly when the vendor is not on the part’s list, with a way to add it', async () => {
    getPriceDefaultInputs.mockResolvedValue(inputs({ partVendor: null, sheet: null }));
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    await pickVendor(user);
    const n = await addPartLine(user);
    expect(await within(formLine(n)).findByText(/isn.t on this part.s approved vendor list/i)).toBeInTheDocument();
    expect(within(formLine(n)).getByRole('link', { name: /add to list/i })).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('blocks a Do-not-use vendor, in the line and in the notice', async () => {
    getPriceDefaultInputs.mockResolvedValue(
      inputs({ partVendor: { ...inputs().partVendor!, status: 'disapproved' }, sheet: null }),
    );
    const user = userEvent.setup();
    render(<VendorPoForm mode="create" companyId="test-company-id" />);
    await pickVendor(user);
    const n = await addPartLine(user);
    expect(await within(formLine(n)).findByText(/marked do not use for this part/i)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/line 1: acme steel is marked do not use/i)).toBeInTheDocument();
  });
});

describe('VendorPoForm — editing', () => {
  const sentPo = () => poDetail({ lines: [poLine(), otherLine()] });

  it('predicts "Save as Rev 1" on a sent PO once the vendor’s copy would change — and not before', async () => {
    const user = userEvent.setup();
    render(<VendorPoForm mode="edit" companyId="test-company-id" po={sentPo()} onCancel={vi.fn()} onSaved={vi.fn()} />);
    expect(saveButton()).toHaveTextContent(/^save$/i);
    const qty = within(formLine(1)).getByLabelText('Quantity');
    await user.clear(qty);
    await user.type(qty, '4');
    expect(saveButton()).toHaveTextContent('Save as Rev 1');
    expect(screen.getByText(/saving makes it rev 1 — send it again/i)).toBeInTheDocument();
  });

  it('sends only what changed, with the staleness token exactly as read', async () => {
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<VendorPoForm mode="edit" companyId="test-company-id" po={sentPo()} onCancel={vi.fn()} onSaved={onSaved} />);
    const qty = within(formLine(1)).getByLabelText('Quantity');
    await user.clear(qty);
    await user.type(qty, '4');
    await user.click(saveButton());
    await waitFor(() => expect(updateVendorPo).toHaveBeenCalledTimes(1));
    expect(updateVendorPo).toHaveBeenCalledWith('po-1', {
      today: '2026-11-12',
      changes: {},
      lines: [{ id: 'l1', quantity: 4 }],
      removedLineIds: [],
      expectedUpdatedAt: '2026-11-02T15:00:00.123456+00:00',
    });
    expect(onSaved).toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith('vendor po updated', {
      revision_bumped: false,
      added_line_count: 0,
      removed_line_count: 0,
      changed_line_count: 1,
      header_changed: false,
    });
  });

  it('removes a line with no confirm — the removal waits for Save', async () => {
    const user = userEvent.setup();
    render(<VendorPoForm mode="edit" companyId="test-company-id" po={sentPo()} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('po-form-line-2')).not.toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(updateVendorPo).toHaveBeenCalled());
    expect(updateVendorPo.mock.calls[0][1]).toMatchObject({ removedLineIds: ['l2'], lines: [] });
  });

  it('locks a received line’s part and unit, says why, and offers no Remove', async () => {
    const po = poDetail({ lines: [poLine({ hasLiveReceipts: true, removable: false, receivedQuantity: 1, receivedStockQuantity: 144 })] });
    render(<VendorPoForm mode="edit" companyId="test-company-id" po={po} onCancel={vi.fn()} onSaved={vi.fn()} />);
    const line = formLine(1);
    expect(within(line).getByLabelText('Part')).toBeDisabled();
    expect(within(line).getByText(/received already — its part and unit can.t change/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove line 1' })).not.toBeInTheDocument();
  });

  it('refuses a quantity below what was received, in the notice', async () => {
    const po = poDetail({ lines: [poLine({ hasLiveReceipts: true, removable: false, receivedQuantity: 2, receivedStockQuantity: 288 })] });
    const user = userEvent.setup();
    render(<VendorPoForm mode="edit" companyId="test-company-id" po={po} onCancel={vi.fn()} onSaved={vi.fn()} />);
    const qty = within(formLine(1)).getByLabelText('Quantity');
    await user.clear(qty);
    await user.type(qty, '1');
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/line 1: can.t be less than the 2 bar already received/i)).toBeInTheDocument();
  });

  it('keeps the vendor fixed once the PO is sent', () => {
    render(<VendorPoForm mode="edit" companyId="test-company-id" po={sentPo()} onCancel={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Vendor')).toBeDisabled();
    expect(screen.getByText(/vendor can.t change once a po is sent/i)).toBeInTheDocument();
  });

  it('keeps an outside line’s step fixed, and its quantity editable', () => {
    const po = poDetail({ lines: [outsideLine()] });
    render(<VendorPoForm mode="edit" companyId="test-company-id" po={po} onCancel={vi.fn()} onSaved={vi.fn()} />);
    const line = formLine(1);
    expect(within(line).getByText(/anodize — 1234-a — job j-1042, op 30/i)).toBeInTheDocument();
    expect(within(line).queryByRole('combobox', { name: /outside step/i })).not.toBeInTheDocument();
    expect(within(line).getByLabelText('Quantity')).toBeEnabled();
  });
});

describe('VendorPoForm — leaving with unsaved changes', () => {
  it('arms beforeunload only while something is unsaved', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const user = userEvent.setup();
    render(<VendorPoForm mode="edit" companyId="test-company-id" po={poDetail({ header: poHeader({ shipVia: null }) })} onCancel={vi.fn()} onSaved={vi.fn()} />);
    expect(add.mock.calls.filter((c) => c[0] === 'beforeunload')).toHaveLength(0);
    await user.type(screen.getByLabelText('Ship via'), 'FedEx');
    expect(add.mock.calls.filter((c) => c[0] === 'beforeunload').length).toBeGreaterThan(0);
  });
});
