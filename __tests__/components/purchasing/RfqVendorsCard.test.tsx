/**
 * Per invited vendor: preview, email, Mark sent, Declined / undo, Record quote (criterion Q1).
 * The PDF goes by mailto, like quotes; "Mark sent" stamps the send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within, waitFor } from '../../test-utils';

const { mockSetInvitation, mockCapture } = vi.hoisted(() => ({ mockSetInvitation: vi.fn(), mockCapture: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { capture: mockCapture } }));
vi.mock('@/utils/vendorRfqAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorRfqAccess')>()),
  setVendorRfqInvitationState: (...a: unknown[]) => mockSetInvitation(...a),
}));

import RfqVendorsCard from '@/components/purchasing/RfqVendorsCard';
import { rfqDetail, INVITATIONS } from './rfqFixtures';

const onPreview = vi.fn();
const onRecordQuote = vi.fn();
const onChanged = vi.fn();

function renderCard(rfq = rfqDetail(), readOnly = false) {
  return render(
    <RfqVendorsCard
      companyId="c1"
      rfq={rfq}
      readOnly={readOnly}
      onPreview={onPreview}
      onRecordQuote={onRecordQuote}
      onChanged={onChanged}
    />,
  );
}

const vendorRow = (name: string) => screen.getByRole('listitem', { name });

beforeEach(() => {
  vi.clearAllMocks();
  mockSetInvitation.mockResolvedValue({ invitationId: 'x', vendorRfqId: 'rfq-1', action: 'mark_sent', status: 'sent' });
});

describe('RfqVendorsCard', () => {
  const user = userEvent.setup();

  it("shows each vendor's frozen contact with a mailto that names the RFQ", () => {
    renderCard();
    const acme = vendorRow('Acme Steel');
    expect(within(acme).getByText(/Jane Buyer · jane@acme.test · 555-0101/)).toBeInTheDocument();
    const email = within(acme).getByRole('link', { name: /Email Jane Buyer/ });
    const href = email.getAttribute('href') ?? '';
    expect(href.startsWith('mailto:jane@acme.test?')).toBe(true);
    expect(decodeURIComponent(href)).toContain('RFQ-0007');
    expect(within(acme).getByText(/Sent/)).toBeInTheDocument();
  });

  it('a vendor with no email on file says so instead of offering a dead link', () => {
    renderCard();
    const beta = vendorRow('Beta Metals');
    expect(within(beta).queryByRole('link', { name: /Email/ })).toBeNull();
    expect(within(beta).getByText(/No email on file/)).toBeInTheDocument();
    expect(within(beta).getByText(/Not sent yet/)).toBeInTheDocument();
  });

  it('Mark sent stamps the send, counts it, and refreshes the page', async () => {
    renderCard();
    await user.click(within(vendorRow('Beta Metals')).getByRole('button', { name: 'Mark sent' }));
    await waitFor(() => expect(mockSetInvitation).toHaveBeenCalledWith('inv-beta', 'mark_sent'));
    expect(onChanged).toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith('vendor rfq sent', { is_resend: false });
  });

  it('marking an already-sent vendor sent again is a resend', async () => {
    renderCard();
    await user.click(within(vendorRow('Acme Steel')).getByRole('button', { name: 'Mark sent again' }));
    await waitFor(() => expect(mockCapture).toHaveBeenCalledWith('vendor rfq sent', { is_resend: true }));
  });

  it('records a decline, and can undo it', async () => {
    const { unmount } = renderCard();
    await user.click(within(vendorRow('Beta Metals')).getByRole('button', { name: 'Declined' }));
    await waitFor(() => expect(mockSetInvitation).toHaveBeenCalledWith('inv-beta', 'decline'));
    expect(mockCapture).not.toHaveBeenCalled();
    unmount();

    renderCard(
      rfqDetail({
        invitations: INVITATIONS.map((i) => (i.id === 'inv-beta' ? { ...i, declinedAt: '2026-11-09T12:00:00Z' } : i)),
      }),
    );
    const beta = vendorRow('Beta Metals');
    expect(within(beta).getByText(/Declined/)).toBeInTheDocument();
    expect(within(beta).queryByRole('button', { name: /Record quote|Edit quote/ })).toBeNull();
    await user.click(within(beta).getByRole('button', { name: 'Undo decline' }));
    await waitFor(() => expect(mockSetInvitation).toHaveBeenCalledWith('inv-beta', 'undo_decline'));
  });

  it('opens the preview and the quote grid for the vendor pressed', async () => {
    renderCard();
    await user.click(within(vendorRow('Beta Metals')).getByRole('button', { name: 'Preview' }));
    expect(onPreview).toHaveBeenCalledWith('inv-beta');
    await user.click(within(vendorRow('Acme Steel')).getByRole('button', { name: 'Edit quote' }));
    expect(onRecordQuote).toHaveBeenCalledWith('inv-acme');
  });

  it('a refusal shows its sentence', async () => {
    mockSetInvitation.mockRejectedValue(new Error('RFQ-0007 is closed. Reopen it first.'));
    renderCard();
    await user.click(within(vendorRow('Beta Metals')).getByRole('button', { name: 'Mark sent' }));
    expect(await screen.findByText('RFQ-0007 is closed. Reopen it first.')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('read-only keeps the preview and the email, and drops every write', () => {
    renderCard(rfqDetail(), true);
    const acme = vendorRow('Acme Steel');
    expect(within(acme).getByRole('button', { name: 'Preview' })).toBeInTheDocument();
    expect(within(acme).getByRole('link', { name: /Email Jane Buyer/ })).toBeInTheDocument();
    expect(within(acme).queryByRole('button', { name: /Mark sent/ })).toBeNull();
    expect(within(acme).queryByRole('button', { name: /Declined/ })).toBeNull();
    expect(within(acme).queryByRole('button', { name: /quote/ })).toBeNull();
  });
});
