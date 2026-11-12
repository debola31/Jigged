/**
 * The PO preview: print, download, email the contact, and "Mark as sent & download"
 * (plan §3.13 "Preview dialog", criterion P8).
 *
 * The order inside "Mark as sent & download" is the point: the send is stamped FIRST, the PO is
 * read again and the PDF re-rendered from that read, and only then is the file saved — so the copy
 * that goes to the vendor can never carry the DRAFT band a never-sent PO prints.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../test-utils';
import { draftPoDetail, poDetail, poHeader } from './vendorPoFixtures';

const getVendorPo = vi.fn();
const markVendorPoSent = vi.fn();
vi.mock('@/utils/vendorPoAccess', () => ({
  getVendorPo: (...args: unknown[]) => getVendorPo(...args),
  markVendorPoSent: (...args: unknown[]) => markVendorPoSent(...args),
}));
const getCompany = vi.fn();
vi.mock('@/utils/companyAccess', () => ({ getCompany: (...args: unknown[]) => getCompany(...args) }));
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({ storage: {} }) }));
vi.mock('@/lib/localDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/localDate')>()),
  todayLocalISODate: () => '2026-11-12',
}));

const save = vi.fn();
const generateVendorPoPdf = vi.fn();
vi.mock('@/utils/vendorPoPdf', () => ({
  generateVendorPoPdf: (...args: unknown[]) => generateVendorPoPdf(...args),
  vendorPoPdfFilename: (poNumber: string, revision: number) =>
    revision > 0 ? `${poNumber}-rev${revision}.pdf` : `${poNumber}.pdf`,
}));

const capture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...args: unknown[]) => capture(...args) } }));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => ({ role: 'user', isAdmin: false, loading: false }) }));

import VendorPoPreviewDialog from '@/components/purchasing/VendorPoPreviewDialog';

const onClose = vi.fn();
const onMarkedSent = vi.fn();

function renderPreview() {
  return render(
    <VendorPoPreviewDialog open companyId="test-company-id" poId="po-1" onClose={onClose} onMarkedSent={onMarkedSent} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getCompany.mockResolvedValue({ id: 'test-company-id', name: 'Contour Tool & Machine' });
  generateVendorPoPdf.mockImplementation(async () => ({
    output: () => new URL('blob:http://localhost/po-preview'),
    save,
  }));
});

describe('VendorPoPreviewDialog', () => {
  it('renders the PO from its own read into the preview frame', async () => {
    getVendorPo.mockResolvedValue(poDetail());
    renderPreview();
    const frame = await screen.findByTitle('Purchase order PO-1042 preview');
    expect(frame).toHaveAttribute('src', 'blob:http://localhost/po-preview');
    expect(getVendorPo).toHaveBeenCalledWith('po-1', { today: '2026-11-12' });
    expect(generateVendorPoPdf).toHaveBeenCalledWith(
      expect.objectContaining({ po: expect.objectContaining({ header: expect.objectContaining({ poNumber: 'PO-1042' }) }) }),
    );
  });

  it('emails the frozen contact, with the PO number and revision in the subject', async () => {
    getVendorPo.mockResolvedValue(poDetail({ header: poHeader({ revision: 2, sentRevision: 2 }) }));
    renderPreview();
    const email = await screen.findByRole('link', { name: /email jane buyer/i });
    const href = email.getAttribute('href') ?? '';
    expect(href.startsWith('mailto:jane@acme.test?')).toBe(true);
    const subject = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('subject') ?? '';
    expect(subject).toContain('PO-1042 Rev 2');
  });

  it('marks a draft sent, re-reads it, re-renders it WITHOUT the draft band, then downloads it', async () => {
    getVendorPo.mockResolvedValueOnce(draftPoDetail()).mockResolvedValueOnce(poDetail());
    markVendorPoSent.mockResolvedValue({ id: 'po-1' });
    const user = userEvent.setup();
    renderPreview();

    await user.click(await screen.findByRole('button', { name: /mark as sent & download/i }));

    await waitFor(() => expect(save).toHaveBeenCalledWith('PO-1042.pdf'));
    expect(markVendorPoSent).toHaveBeenCalledWith('po-1', '2026-11-12');
    // Stamp, then read, then render, then save — in that order.
    expect(markVendorPoSent.mock.invocationCallOrder[0]).toBeLessThan(getVendorPo.mock.invocationCallOrder[1]);
    const lastRender = generateVendorPoPdf.mock.calls[generateVendorPoPdf.mock.calls.length - 1][0] as {
      po: { header: { issuedAt: string | null } };
    };
    expect(lastRender.po.header.issuedAt).not.toBeNull();
    expect(generateVendorPoPdf.mock.invocationCallOrder[generateVendorPoPdf.mock.calls.length - 1]).toBeLessThan(
      save.mock.invocationCallOrder[0],
    );
    expect(onMarkedSent).toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith('vendor po sent', {
      is_resend: false,
      with_download: true,
      has_contact_email: true,
    });
  });

  it('counts sending a new revision as a resend', async () => {
    const revised = poDetail({ header: poHeader({ revision: 1, sentRevision: 0 }) });
    getVendorPo.mockResolvedValueOnce(revised).mockResolvedValueOnce(poDetail({ header: poHeader({ revision: 1, sentRevision: 1 }) }));
    markVendorPoSent.mockResolvedValue({ id: 'po-1' });
    const user = userEvent.setup();
    renderPreview();
    await user.click(await screen.findByRole('button', { name: /mark as sent & download/i }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('PO-1042-rev1.pdf'));
    expect(capture).toHaveBeenCalledWith('vendor po sent', expect.objectContaining({ is_resend: true }));
  });

  it('offers a plain download once the current revision has gone out', async () => {
    getVendorPo.mockResolvedValue(poDetail());
    const user = userEvent.setup();
    renderPreview();
    await screen.findByTitle('Purchase order PO-1042 preview');
    expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^download$/i }));
    expect(save).toHaveBeenCalledWith('PO-1042.pdf');
    expect(markVendorPoSent).not.toHaveBeenCalled();
  });

  it('never offers to send an archived PO', async () => {
    getVendorPo.mockResolvedValue(draftPoDetail({ header: poHeader({ issuedAt: null, sentRevision: null, deletedAt: '2026-11-10T00:00:00Z', isArchived: true }) }));
    renderPreview();
    await screen.findByTitle('Purchase order PO-1042 preview');
    expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
  });

  it('keeps the preview and says so when marking sent is refused', async () => {
    getVendorPo.mockResolvedValue(draftPoDetail());
    markVendorPoSent.mockRejectedValue(new Error('Add at least one line before sending PO-1042.'));
    const user = userEvent.setup();
    renderPreview();
    await user.click(await screen.findByRole('button', { name: /mark as sent & download/i }));
    expect(await screen.findByText(/add at least one line/i)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(onMarkedSent).not.toHaveBeenCalled();
  });
});
