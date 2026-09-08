import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../../test-utils';
import userEvent from '@testing-library/user-event';

/**
 * The merged defaults card: the numeric registry and the shop's default payment terms in one box.
 *
 * They were two cards, and the split was defended in a docstring that was right about the
 * *registry* — `KNOWN_DEFAULTS` is numeric end to end — and wrong about the *card*. A user does not
 * know what a registry is; they know quote validity and payment terms are both "what a new quote
 * starts with". So the card merged and the registry stayed numeric, and the test that matters most
 * here is the one about how the two halves are written.
 */

const getCompany = vi.hoisted(() => vi.fn());
const getCustomPaymentTerms = vi.hoisted(() => vi.fn());
const addCustomPaymentTerm = vi.hoisted(() => vi.fn());
const removeCustomPaymentTerm = vi.hoisted(() => vi.fn());
const updateCompanyDefaults = vi.hoisted(() => vi.fn());
const setCompanyDefaultPaymentTerms = vi.hoisted(() => vi.fn());
const setCompanyPricingDefaults = vi.hoisted(() => vi.fn());
const listQuickBooksTerms = vi.hoisted(() => vi.fn());

// The terms field is the shared PaymentTermsPicker, so this card now depends on
// the picker's own reads: the saved list and QuickBooks' terms.
vi.mock('@/utils/quickbooksAccess', () => ({ listQuickBooksTerms }));

vi.mock('@/utils/companyAccess', () => ({
  getCompany,
  getCustomPaymentTerms,
  addCustomPaymentTerm,
  removeCustomPaymentTerm,
  updateCompanyDefaults,
  setCompanyDefaultPaymentTerms,
  setCompanyPricingDefaults,
  // Not mocked away: it is a pure read over the company row, and stubbing it
  // would hide a mismatch between what the card renders and what the column is.
  readCompanyPricingDefaults: (c: { default_markup_made_percent?: number; default_markup_bought_percent?: number } | null) => ({
    made: c?.default_markup_made_percent ?? 0,
    bought: c?.default_markup_bought_percent ?? 0,
  }),
}));

import AppDefaultsCard from '@/components/settings/AppDefaultsCard';

const CO = '71000000-0000-0000-0000-000000000002';

beforeEach(() => {
  vi.clearAllMocks();
  getCompany.mockResolvedValue({
    id: CO,
    name: 'Acme',
    settings: { defaults: {}, default_payment_terms: 'Net 30' },
  });
  getCustomPaymentTerms.mockResolvedValue(['2% Net 30']);
  addCustomPaymentTerm.mockResolvedValue(['2% Net 30']);
  removeCustomPaymentTerm.mockResolvedValue([]);
  listQuickBooksTerms.mockResolvedValue({ connected: false, terms: [] });
  updateCompanyDefaults.mockResolvedValue(undefined);
  setCompanyDefaultPaymentTerms.mockImplementation(async (_id: string, v: string) => v.trim() || null);
});

describe('AppDefaultsCard', () => {
  it('shows the numeric defaults and the payment terms in one card', async () => {
    render(<AppDefaultsCard companyId={CO} />);

    // One SettingsSection, so exactly one heading and one Save for the whole group.
    expect(await screen.findByRole('heading', { name: /company default settings/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^payment terms$/i)).toHaveValue('Net 30');
    expect(screen.getAllByRole('button', { name: /^save$/i })).toHaveLength(1);
  });

  it('offers the shop’s own saved terms alongside the presets', async () => {
    render(<AppDefaultsCard companyId={CO} />);
    const input = await screen.findByLabelText(/^payment terms$/i);

    await userEvent.clear(input);
    await userEvent.type(input, '2%');

    expect(await screen.findByRole('option', { name: '2% Net 30' })).toBeInTheDocument();
  });

  /**
   * **Why this card stopped rendering its own combobox.**
   *
   * The settings screen is where a shop curates its house terms — and it was the one screen with
   * neither "Add New" nor the remove control, because it had hand-rolled a plain freeSolo box
   * beside the shared picker. A term typed into it set the default without ever joining
   * `custom_payment_terms`, so it then showed up on quotes as an unrecognised value.
   */
  it('offers "Add New" here, and saves the term to the shop’s list', async () => {
    addCustomPaymentTerm.mockResolvedValue(['2% Net 30 EOM', '2% Net 30']);
    render(<AppDefaultsCard companyId={CO} />);

    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/^payment terms$/i));
    await user.click(await screen.findByRole('option', { name: /add new/i }));
    await user.type(await screen.findByLabelText('New payment term'), '2% Net 30 EOM');
    await user.click(screen.getByRole('button', { name: 'Add', exact: true }));

    expect(addCustomPaymentTerm).toHaveBeenCalledWith(CO, '2% Net 30 EOM');
    // …and it is the value the card will save as the shop default.
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(setCompanyDefaultPaymentTerms).toHaveBeenCalledWith(CO, '2% Net 30 EOM'),
    );
  });

  it('can remove one of the shop’s saved terms from here', async () => {
    render(<AppDefaultsCard companyId={CO} />);

    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/^payment terms$/i));
    await user.click(await screen.findByRole('button', { name: 'Remove 2% Net 30' }));

    expect(removeCustomPaymentTerm).toHaveBeenCalledWith(CO, '2% Net 30');
  });

  /**
   * **The reason this file exists.**
   *
   * `updateCompanyDefaults` and `setCompanyDefaultPaymentTerms` both read the whole
   * `companies.settings` object, merge one key into it, and write it back. Firing them
   * concurrently means the second read happens before the first write lands, and one silently
   * clobbers the other — the shop saves both fields, sees "Settings saved", and one of them
   * quietly reverts. Merging the cards is what made this possible, so the save has to be
   * sequential and the sequence has to be pinned.
   */
  it('writes both halves in sequence, never concurrently', async () => {
    render(<AppDefaultsCard companyId={CO} />);
    const user = userEvent.setup();
    // Pick-only: the term is chosen from the menu, not typed into the field.
    await user.click(await screen.findByLabelText(/^payment terms$/i));
    await user.click(await screen.findByRole('option', { name: 'Net 15', exact: true }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(setCompanyDefaultPaymentTerms).toHaveBeenCalled());
    expect(updateCompanyDefaults).toHaveBeenCalledTimes(1);
    expect(setCompanyDefaultPaymentTerms).toHaveBeenCalledWith(CO, 'Net 15');
    expect(updateCompanyDefaults.mock.invocationCallOrder[0]).toBeLessThan(
      setCompanyDefaultPaymentTerms.mock.invocationCallOrder[0],
    );
  });

  it('keeps the numeric patch numeric — the registry did not become a union', async () => {
    render(<AppDefaultsCard companyId={CO} />);
    await screen.findByLabelText(/^payment terms$/i);

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(updateCompanyDefaults).toHaveBeenCalled());
    const patch = updateCompanyDefaults.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.values(patch).every((v) => typeof v === 'number')).toBe(true);
    expect(Object.keys(patch)).not.toContain('default_payment_terms');
  });

  it('refuses to save an out-of-range number, and does not write the terms either', async () => {
    render(<AppDefaultsCard companyId={CO} />);
    const numeric = (await screen.findAllByRole('spinbutton'))[0];

    await userEvent.clear(numeric);
    await userEvent.type(numeric, '0');

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(updateCompanyDefaults).not.toHaveBeenCalled();
    expect(setCompanyDefaultPaymentTerms).not.toHaveBeenCalled();
  });
});
