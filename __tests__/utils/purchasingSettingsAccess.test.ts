/**
 * Purchasing numbering and printed terms — access layer (criterion N2).
 *
 * Any office user saves through `save_purchasing_document_settings` (no table write); the dialog's
 * own rules refuse a prefix the database would refuse and a PO number over 11 characters before a
 * round trip; RFQs keep the RFQ- series.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { stub } from './purchasingTestStub';

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));

vi.mock('@/lib/supabase', async () => {
  const { stub: s } = await import('./purchasingTestStub');
  return { getSupabase: () => s.client, createClient: () => s.client, supabase: s.client };
});
vi.mock('@sentry/nextjs', () => ({ captureException: mockCapture }));

import { getPurchasingSeries, savePurchasingSettings } from '@/utils/purchasingSettingsAccess';

beforeEach(() => {
  vi.clearAllMocks();
  stub.reset();
});

describe('getPurchasingSeries', () => {
  it('reads both series, and a kind with no row yet shows the defaults its first document creates', async () => {
    stub.queue('purchasing_document_series', {
      data: [{ document_kind: 'vendor_purchase_order', prefix: '', next_number: 1043, min_digits: 1, terms_and_conditions: 'Net 30 unless agreed' }],
    });
    const series = await getPurchasingSeries('co-1');
    expect(stub.callsOf('purchasing_document_series', 'eq')).toEqual([['company_id', 'co-1']]);
    expect(series.vendor_purchase_order).toEqual({
      kind: 'vendor_purchase_order',
      prefix: '',
      nextNumber: 1043,
      minDigits: 1,
      termsAndConditions: 'Net 30 unless agreed',
      nextNumberPreview: '1043',
      isDefault: false,
    });
    expect(series.vendor_rfq).toMatchObject({ prefix: 'RFQ-', nextNumber: 1, minDigits: 4, nextNumberPreview: 'RFQ-0001', isDefault: true });
  });

  it('throws on a failed read', async () => {
    stub.queue('purchasing_document_series', { error: { code: '08006', message: 'connection failure' } });
    await expect(getPurchasingSeries('co-1')).rejects.toThrow('Failed to load the purchasing settings.');
  });
});

describe('savePurchasingSettings', () => {
  const reply = {
    document_kind: 'vendor_purchase_order',
    prefix: 'P-',
    next_number: 5000,
    min_digits: 4,
    terms_and_conditions: 'Ship complete.',
    next_number_preview: 'P-5000',
  };

  it('goes through save_purchasing_document_settings, never a table write', async () => {
    stub.rpc.mockResolvedValue({ data: reply, error: null });
    const saved = await savePurchasingSettings('co-1', 'vendor_purchase_order', {
      numbering: { prefix: 'P-', nextNumber: 5000, minDigits: 4 },
      termsAndConditions: 'Ship complete.',
    });
    expect(stub.rpc).toHaveBeenCalledWith('save_purchasing_document_settings', {
      p_company_id: 'co-1',
      p_kind: 'vendor_purchase_order',
      p_changes: { prefix: 'P-', next_number: 5000, min_digits: 4, terms_and_conditions: 'Ship complete.' },
    });
    expect(saved).toMatchObject({ prefix: 'P-', nextNumber: 5000, nextNumberPreview: 'P-5000', termsAndConditions: 'Ship complete.' });
    expect(stub.tables).toEqual([]);
  });

  it('refuses more than 11 characters before the call (QuickBooks Desktop)', async () => {
    await expect(
      savePurchasingSettings('co-1', 'vendor_purchase_order', { numbering: { prefix: 'ACME-P', nextNumber: 1, minDigits: 6 } }),
    ).rejects.toThrow(/11/);
    await expect(
      savePurchasingSettings('co-1', 'vendor_purchase_order', { numbering: { prefix: 'PO-', nextNumber: 123456789, minDigits: 4 } }),
    ).rejects.toThrow(/11/);
    await expect(
      savePurchasingSettings('co-1', 'vendor_purchase_order', { numbering: { prefix: 'PO 1', nextNumber: 1, minDigits: 4 } }),
    ).rejects.toThrow(/letters, numbers and hyphens/);
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it('only the terms change for RFQs: numbering is refused before the call', async () => {
    await expect(
      savePurchasingSettings('co-1', 'vendor_rfq', { numbering: { prefix: 'Q-', nextNumber: 1, minDigits: 4 } }),
    ).rejects.toThrow(/RFQ- series/);
    stub.rpc.mockResolvedValue({ data: { ...reply, document_kind: 'vendor_rfq', prefix: 'RFQ-', next_number: 1, next_number_preview: 'RFQ-0001', terms_and_conditions: null }, error: null });
    await savePurchasingSettings('co-1', 'vendor_rfq', { termsAndConditions: null });
    expect(stub.rpc.mock.calls[0][1]).toEqual({ p_company_id: 'co-1', p_kind: 'vendor_rfq', p_changes: { terms_and_conditions: null } });
  });

  it('"already issued" comes back as the sentence, unreported (P0001)', async () => {
    stub.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Number 1042 has already been issued under "", so the next number must be at least 1043.' },
    });
    await expect(
      savePurchasingSettings('co-1', 'vendor_purchase_order', { numbering: { prefix: '', nextNumber: 1000, minDigits: 1 } }),
    ).rejects.toThrow(/at least 1043/);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('an operator is refused by the database, and that is reported', async () => {
    stub.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: "This is an office task: operators can't change purchasing records." } });
    await expect(savePurchasingSettings('co-1', 'vendor_purchase_order', { termsAndConditions: 'x' })).rejects.toThrow();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});
