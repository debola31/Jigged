/**
 * Purchasing settings — PO numbering and the printed terms (plan §3.13, criterion N2).
 *
 * Any office user may change them: a `user` saves exactly as an admin does, because the numbering
 * is how a shop continues its QuickBooks sequence and that is the buyer's job, not only the
 * owner's. The preview is live, the 11-character QuickBooks Desktop limit is refused before any
 * request, and only what changed is sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../test-utils';

const getPurchasingSeries = vi.fn();
const savePurchasingSettings = vi.fn();
vi.mock('@/utils/purchasingSettingsAccess', () => ({
  getPurchasingSeries: (...args: unknown[]) => getPurchasingSeries(...args),
  savePurchasingSettings: (...args: unknown[]) => savePurchasingSettings(...args),
}));

// Role `user`, not admin — the whole point of N2.
vi.mock('@/hooks/useUserRole', () => ({
  useUserRole: () => ({ role: 'user', isAdmin: false, loading: false }),
}));

const capture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...args: unknown[]) => capture(...args) } }));

import PurchasingSettingsDialog from '@/components/purchasing/PurchasingSettingsDialog';

function series(over: { prefix?: string; nextNumber?: number; minDigits?: number; poTerms?: string | null; rfqTerms?: string | null } = {}) {
  const prefix = over.prefix ?? 'PO-';
  const nextNumber = over.nextNumber ?? 1043;
  const minDigits = over.minDigits ?? 4;
  return {
    vendor_purchase_order: {
      kind: 'vendor_purchase_order',
      prefix,
      nextNumber,
      minDigits,
      termsAndConditions: over.poTerms ?? null,
      nextNumberPreview: `${prefix}${String(nextNumber).padStart(minDigits, '0')}`,
      isDefault: false,
    },
    vendor_rfq: {
      kind: 'vendor_rfq',
      prefix: 'RFQ-',
      nextNumber: 7,
      minDigits: 4,
      termsAndConditions: over.rfqTerms ?? null,
      nextNumberPreview: 'RFQ-0007',
      isDefault: false,
    },
  };
}

const onClose = vi.fn();
const onSaved = vi.fn();

function renderDialog() {
  return render(<PurchasingSettingsDialog open companyId="co-1" onClose={onClose} onSaved={onSaved} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  getPurchasingSeries.mockResolvedValue(series());
  savePurchasingSettings.mockImplementation(async (_c: string, kind: string) => series()[kind as 'vendor_rfq']);
});

describe('PurchasingSettingsDialog (N2)', () => {
  it('loads this company’s series and previews the next PO number with its character budget', async () => {
    renderDialog();
    expect(await screen.findByText('Next: PO-1043 · 7 of 11 characters')).toBeInTheDocument();
    expect(getPurchasingSeries).toHaveBeenCalledWith('co-1');
    expect(screen.getByLabelText(/prefix/i)).toHaveValue('PO-');
  });

  it('updates the preview as the prefix and next number change', async () => {
    const user = userEvent.setup();
    renderDialog();
    const prefix = await screen.findByLabelText(/prefix/i);
    await user.clear(prefix);
    await user.type(prefix, 'P-');
    const next = screen.getByLabelText(/next number/i);
    await user.clear(next);
    await user.type(next, '5000');
    expect(screen.getByText('Next: P-5000 · 6 of 11 characters')).toBeInTheDocument();
  });

  it('allows an empty prefix, so a shop can carry on its QuickBooks numbers', async () => {
    const user = userEvent.setup();
    renderDialog();
    const prefix = await screen.findByLabelText(/prefix/i);
    await user.clear(prefix);
    expect(screen.getByText('Next: 1043 · 4 of 11 characters')).toBeInTheDocument();
  });

  it('refuses more than 11 characters before any request, and says why above Save', async () => {
    const user = userEvent.setup();
    renderDialog();
    const prefix = await screen.findByLabelText(/prefix/i);
    await user.clear(prefix);
    await user.type(prefix, 'ACME-P');
    const digits = screen.getByLabelText(/digits/i);
    await user.clear(digits);
    await user.type(digits, '6');

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(screen.getAllByText(/at most 11/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/before you can save/i)).toBeInTheDocument();
    expect(savePurchasingSettings).not.toHaveBeenCalled();
  });

  it('keeps Save off until something actually changed — and off again once it is changed back', async () => {
    const user = userEvent.setup();
    renderDialog();
    const next = await screen.findByLabelText(/next number/i);
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();

    await user.clear(next);
    await user.type(next, '2000');
    expect(save).toBeEnabled();

    await user.clear(next);
    await user.type(next, '1043');
    expect(save).toBeDisabled();
  });

  it('lets a user save the numbering, sending only the PO series and nothing unchanged', async () => {
    const user = userEvent.setup();
    renderDialog();
    const next = await screen.findByLabelText(/next number/i);
    await user.clear(next);
    await user.type(next, '5000');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(savePurchasingSettings).toHaveBeenCalledTimes(1);
    expect(savePurchasingSettings).toHaveBeenCalledWith('co-1', 'vendor_purchase_order', {
      numbering: { prefix: 'PO-', nextNumber: 5000, minDigits: 4 },
    });
    expect(capture).toHaveBeenCalledWith('purchasing settings saved', {
      prefix_changed: false,
      next_number_changed: true,
      digits_changed: false,
      po_terms_changed: false,
      rfq_terms_changed: false,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('saves the RFQ terms on their own series without touching the PO numbering', async () => {
    const user = userEvent.setup();
    renderDialog();
    const rfqTerms = await screen.findByLabelText(/rfq terms and conditions/i);
    await user.type(rfqTerms, 'Quote valid 30 days.');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(savePurchasingSettings).toHaveBeenCalledTimes(1);
    expect(savePurchasingSettings).toHaveBeenCalledWith('co-1', 'vendor_rfq', {
      termsAndConditions: 'Quote valid 30 days.',
    });
  });

  it('shows a refusal from the database and stays open', async () => {
    savePurchasingSettings.mockRejectedValueOnce(new Error('PO-1043 is already used. Start above 1043.'));
    const user = userEvent.setup();
    renderDialog();
    const poTerms = await screen.findByLabelText(/purchase order terms and conditions/i);
    await user.type(poTerms, 'Net 30 unless agreed.');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/already used/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
