/**
 * The per-vendor RFQ preview: Print, Download, Email (mailto) and "Mark as sent & download"
 * (criterion Q1). The PDF is the one generateRfqPdf builds for THAT invitation, fed that vendor's
 * part numbers from its approved-vendor rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../test-utils';

const m = vi.hoisted(() => ({
  generate: vi.fn(),
  save: vi.fn(),
  getCompany: vi.fn(),
  listVendorParts: vi.fn(),
  setInvitation: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { capture: m.capture } }));
vi.mock('@/utils/rfqPdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/rfqPdf')>()),
  generateRfqPdf: (...a: unknown[]) => m.generate(...a),
}));
vi.mock('@/utils/companyAccess', () => ({ getCompany: (...a: unknown[]) => m.getCompany(...a) }));
vi.mock('@/utils/partVendorsAccess', () => ({ listVendorParts: (...a: unknown[]) => m.listVendorParts(...a) }));
vi.mock('@/utils/vendorRfqAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorRfqAccess')>()),
  setVendorRfqInvitationState: (...a: unknown[]) => m.setInvitation(...a),
}));

import RfqPreviewDialog from '@/components/purchasing/RfqPreviewDialog';
import { rfqDetail } from './rfqFixtures';

const onClose = vi.fn();
const onMarkedSent = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  m.generate.mockResolvedValue({ output: () => 'blob:rfq-preview', save: m.save });
  m.getCompany.mockResolvedValue({ id: 'test-company-id', name: 'Contour Tool & Machine' });
  m.listVendorParts.mockResolvedValue([
    { partVendorId: 'pv-1', partId: 'part-bar', partName: 'BAR-6061', description: null, partSource: 'bought', status: 'approved', vendorPartNumber: 'BETA-61', purchaseUnit: 'bar', leadTimeDays: null, minimumOrderQuantity: null, quotedOn: null, validUntil: null, isExpired: false, isPreferred: false },
  ]);
  m.setInvitation.mockResolvedValue({ invitationId: 'inv-beta', vendorRfqId: 'rfq-1', action: 'mark_sent', status: 'sent' });
});

function renderDialog(invitationId = 'inv-beta', readOnly = false) {
  return render(
    <RfqPreviewDialog
      open
      rfq={rfqDetail()}
      invitationId={invitationId}
      onClose={onClose}
      onMarkedSent={onMarkedSent}
      readOnly={readOnly}
    />,
  );
}

describe('RfqPreviewDialog', () => {
  const user = userEvent.setup();

  it("renders THIS vendor's copy, with its own part numbers", async () => {
    renderDialog();
    expect(await screen.findByTitle(/RFQ-0007 for Beta Metals/)).toHaveAttribute('src', 'blob:rfq-preview');
    expect(m.listVendorParts).toHaveBeenCalledWith('v-beta', expect.objectContaining({ today: expect.any(String) }));
    const ctx = m.generate.mock.calls[0][0];
    expect(ctx.invitationId).toBe('inv-beta');
    expect(ctx.vendorPartNumbers).toEqual([{ partId: 'part-bar', vendorId: 'v-beta', vendorPartNumber: 'BETA-61' }]);
  });

  it('a vendor not yet sent leads with "Mark as sent & download"', async () => {
    renderDialog();
    await screen.findByTitle(/RFQ-0007 for Beta Metals/);
    await user.click(screen.getByRole('button', { name: /Mark as sent & download/ }));
    await waitFor(() => expect(m.setInvitation).toHaveBeenCalledWith('inv-beta', 'mark_sent'));
    expect(m.save).toHaveBeenCalledWith('RFQ-0007-Beta-Metals.pdf');
    expect(onMarkedSent).toHaveBeenCalled();
    expect(m.capture).toHaveBeenCalledWith('vendor rfq sent', { is_resend: false });
  });

  it('an already-sent vendor can be marked sent again, as a resend', async () => {
    renderDialog('inv-acme');
    await screen.findByTitle(/RFQ-0007 for Acme Steel/);
    await user.click(screen.getByRole('button', { name: 'Mark sent again' }));
    await waitFor(() => expect(m.capture).toHaveBeenCalledWith('vendor rfq sent', { is_resend: true }));
    expect(m.save).not.toHaveBeenCalled();
  });

  it('emails the contact, with the RFQ number in the subject', async () => {
    renderDialog('inv-acme');
    const link = await screen.findByRole('link', { name: /Email Jane Buyer/ });
    const href = decodeURIComponent(link.getAttribute('href') ?? '');
    expect(href.startsWith('mailto:jane@acme.test?subject=RFQ-0007')).toBe(true);
  });

  it('Download saves the file under its name and marks nothing', async () => {
    renderDialog();
    await screen.findByTitle(/RFQ-0007 for Beta Metals/);
    await user.click(screen.getByRole('button', { name: /^Download$/ }));
    expect(m.save).toHaveBeenCalledWith('RFQ-0007-Beta-Metals.pdf');
    expect(m.setInvitation).not.toHaveBeenCalled();
  });

  it('read-only (closed or archived) can print and download, but not mark sent', async () => {
    renderDialog('inv-beta', true);
    await screen.findByTitle(/RFQ-0007 for Beta Metals/);
    expect(screen.queryByRole('button', { name: /Mark as sent/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Download$/ })).toBeInTheDocument();
  });

  it("a failed render says so rather than showing an empty frame", async () => {
    m.getCompany.mockResolvedValue(null);
    renderDialog();
    expect(await screen.findByText(/Couldn't load your shop's details/)).toBeInTheDocument();
    expect(m.generate).not.toHaveBeenCalled();
  });
});
