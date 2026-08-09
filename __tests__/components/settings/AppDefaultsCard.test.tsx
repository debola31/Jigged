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
const updateCompanyDefaults = vi.hoisted(() => vi.fn());
const setCompanyDefaultPaymentTerms = vi.hoisted(() => vi.fn());

vi.mock('@/utils/companyAccess', () => ({
  getCompany,
  getCustomPaymentTerms,
  updateCompanyDefaults,
  setCompanyDefaultPaymentTerms,
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
  updateCompanyDefaults.mockResolvedValue(undefined);
  setCompanyDefaultPaymentTerms.mockImplementation(async (_id: string, v: string) => v.trim() || null);
});

describe('AppDefaultsCard', () => {
  it('shows the numeric defaults and the payment terms in one card', async () => {
    render(<AppDefaultsCard companyId={CO} />);

    // One SettingsSection, so exactly one heading and one Save for the whole group.
    expect(await screen.findByRole('heading', { name: /company default settings/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/default payment terms/i)).toHaveValue('Net 30');
    expect(screen.getAllByRole('button', { name: /^save$/i })).toHaveLength(1);
  });

  it('offers the shop’s own saved terms alongside the presets', async () => {
    render(<AppDefaultsCard companyId={CO} />);
    const input = await screen.findByLabelText(/default payment terms/i);

    await userEvent.clear(input);
    await userEvent.type(input, '2%');

    expect(await screen.findByRole('option', { name: '2% Net 30' })).toBeInTheDocument();
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
    const input = await screen.findByLabelText(/default payment terms/i);

    await userEvent.clear(input);
    await userEvent.type(input, 'Net 45');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(setCompanyDefaultPaymentTerms).toHaveBeenCalled());
    expect(updateCompanyDefaults).toHaveBeenCalledTimes(1);
    expect(setCompanyDefaultPaymentTerms).toHaveBeenCalledWith(CO, 'Net 45');
    expect(updateCompanyDefaults.mock.invocationCallOrder[0]).toBeLessThan(
      setCompanyDefaultPaymentTerms.mock.invocationCallOrder[0],
    );
  });

  it('keeps the numeric patch numeric — the registry did not become a union', async () => {
    render(<AppDefaultsCard companyId={CO} />);
    await screen.findByLabelText(/default payment terms/i);

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
