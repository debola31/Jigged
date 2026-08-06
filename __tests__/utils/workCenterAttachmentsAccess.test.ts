import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Chainable Supabase mock (same shape as machineMaintenanceAccess.test.ts) ---
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = ['from', 'select', 'insert', 'delete', 'eq', 'is', 'order', 'single', 'maybeSingle'];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = null;
  builder.error = null;
  builder.count = 0;
  return {
    mockQueryBuilder: builder,
    mockSupabase: { from: vi.fn().mockImplementation(() => builder) },
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

vi.mock('@/utils/storageHelpers', () => ({
  generateStoragePath: vi.fn(),
  uploadFileToStorage: vi.fn(),
  deleteFileFromStorage: vi.fn(),
  getSignedUrl: vi.fn(),
}));

vi.mock('@/utils/operatorAccess', () => ({ getCurrentMember: vi.fn() }));

import {
  listWorkCenterAttachments,
  countWorkCenterAttachments,
} from '@/utils/workCenterAttachmentsAccess';

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryBuilder.data = null;
  mockQueryBuilder.error = null;
  mockQueryBuilder.count = 0;
});

/**
 * A manual carries part numbers, tooling and process notes, so listing the wrong
 * company's is a real disclosure rather than a cosmetic mix-up.
 *
 * RLS on `work_center_attachments` admits every company the caller belongs to,
 * so `work_center_id` alone is NOT tenancy. A stale cross-company station
 * selection reached both of these with a foreign machine id, and the result was
 * another company's manuals counted on the button and opened from the sheet with
 * working signed URLs.
 */
describe('work center attachments are company-scoped', () => {
  it('listWorkCenterAttachments filters on the company as well as the machine', async () => {
    mockQueryBuilder.data = [];

    await listWorkCenterAttachments('wc1', 'c1');

    expect(mockSupabase.from).toHaveBeenCalledWith('work_center_attachments');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('work_center_id', 'wc1');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'c1');
  });

  it('countWorkCenterAttachments filters on the company as well as the machine', async () => {
    // This count renders the "Manuals · N" button that opens the list, so an
    // unscoped count advertises another company's documents before anyone taps.
    mockQueryBuilder.count = 3;

    await expect(countWorkCenterAttachments('wc1', 'c1')).resolves.toBe(3);

    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('work_center_id', 'wc1');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'c1');
  });

  it('countWorkCenterAttachments still degrades to 0 on error rather than throwing', async () => {
    // It only decides whether an affordance renders, and "no manuals" is what a
    // machine with none looks like anyway — a broken screen would be worse.
    mockQueryBuilder.error = { message: 'network down' };

    await expect(countWorkCenterAttachments('wc1', 'c1')).resolves.toBe(0);
  });
});
