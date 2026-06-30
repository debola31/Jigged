import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import EditJobPartQuantityModal from '@/components/jobs/EditJobPartQuantityModal';
import type { JobPartWithRelations } from '@/types/job';

// The modal owns only the form; the access layer is stubbed so we assert which
// writer each kind of edit routes to (and the qty-first ordering when both
// change). resolveJobPartUnitPrice is pure and called during render.
vi.mock('@/utils/jobsAccess', () => ({
  getJobPartPricingBasis: vi.fn(),
  resolveJobPartUnitPrice: vi.fn(),
  updateJobPartQuantity: vi.fn(),
  updateJobPartPrice: vi.fn(),
}));

import {
  getJobPartPricingBasis,
  resolveJobPartUnitPrice,
  updateJobPartQuantity,
  updateJobPartPrice,
} from '@/utils/jobsAccess';

const jp = {
  id: 'jp1',
  quantity: 10,
  unit_price: 100,
  total_price: 1000,
  parts: { part_name: 'Bracket' },
} as unknown as JobPartWithRelations;

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const qtyField = () => screen.getByLabelText(/new order quantity/i);
const priceField = () => screen.getByLabelText(/unit price/i);
const saveButton = () => screen.getByRole('button', { name: /^save$/i });

const qtyResult = (overrides = {}) => ({
  jobPart: jp,
  oldQuantity: 10,
  newQuantity: 25,
  oldUnitPrice: 100,
  newUnitPrice: 100,
  oldTotalPrice: 1000,
  newTotalPrice: 2500,
  priceReresolved: false,
  ...overrides,
});

const priceResult = (overrides = {}) => ({
  jobPart: jp,
  oldUnitPrice: 100,
  newUnitPrice: 120,
  oldTotalPrice: 1000,
  newTotalPrice: 1200,
  ...overrides,
});

describe('EditJobPartQuantityModal — price + quantity editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getJobPartPricingBasis).mockResolvedValue(null);
    // Default: no tier curve (no quantity-break choice offered).
    vi.mocked(resolveJobPartUnitPrice).mockReturnValue({
      keepUnitPrice: 100,
      tierUnitPrice: null,
    });
  });

  it('pre-fills the unit price field with the current price', () => {
    render(
      <ThemeProvider theme={jiggedTheme}>
        <EditJobPartQuantityModal
          open
          jobPart={jp}
          qtyShipped={0}
          onClose={vi.fn()}
          onConfirmed={vi.fn()}
        />
      </ThemeProvider>,
    );
    expect((priceField() as HTMLInputElement).value).toBe('100');
  });

  it('a manual price entry hides the quantity-break choice', async () => {
    // Resolver reports a differing tier price → the break choice is offered.
    vi.mocked(resolveJobPartUnitPrice).mockReturnValue({
      keepUnitPrice: 100,
      tierUnitPrice: 90,
    });
    render(wrap(
      <EditJobPartQuantityModal
        open
        jobPart={jp}
        qtyShipped={0}
        onClose={vi.fn()}
        onConfirmed={vi.fn()}
      />,
    ));
    expect(await screen.findByText(/quantity-break price/i)).toBeInTheDocument();

    await userEvent.clear(priceField());
    await userEvent.type(priceField(), '120');

    await waitFor(() =>
      expect(screen.queryByText(/quantity-break price/i)).not.toBeInTheDocument(),
    );
  });

  it('routes a price-only edit to updateJobPartPrice', async () => {
    const onConfirmed = vi.fn();
    vi.mocked(updateJobPartPrice).mockResolvedValue(priceResult());
    render(wrap(
      <EditJobPartQuantityModal
        open
        jobPart={jp}
        qtyShipped={0}
        onClose={vi.fn()}
        onConfirmed={onConfirmed}
      />,
    ));

    await userEvent.clear(priceField());
    await userEvent.type(priceField(), '120');
    await userEvent.click(saveButton());

    await waitFor(() => expect(updateJobPartPrice).toHaveBeenCalledWith('jp1', 120));
    expect(updateJobPartQuantity).not.toHaveBeenCalled();
    expect(onConfirmed).toHaveBeenCalled();
  });

  it('routes a quantity-only edit to updateJobPartQuantity', async () => {
    vi.mocked(updateJobPartQuantity).mockResolvedValue(qtyResult());
    render(wrap(
      <EditJobPartQuantityModal
        open
        jobPart={jp}
        qtyShipped={0}
        onClose={vi.fn()}
        onConfirmed={vi.fn()}
      />,
    ));

    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '25');
    await userEvent.click(saveButton());

    await waitFor(() =>
      expect(updateJobPartQuantity).toHaveBeenCalledWith('jp1', 25, expect.anything()),
    );
    expect(updateJobPartPrice).not.toHaveBeenCalled();
  });

  it('applies a combined qty+price edit via both writers, quantity first', async () => {
    const calls: string[] = [];
    vi.mocked(updateJobPartQuantity).mockImplementation(async () => {
      calls.push('qty');
      return qtyResult();
    });
    vi.mocked(updateJobPartPrice).mockImplementation(async () => {
      calls.push('price');
      return priceResult({ oldTotalPrice: 2500, newTotalPrice: 3000 });
    });
    render(wrap(
      <EditJobPartQuantityModal
        open
        jobPart={jp}
        qtyShipped={0}
        onClose={vi.fn()}
        onConfirmed={vi.fn()}
      />,
    ));

    await userEvent.clear(qtyField());
    await userEvent.type(qtyField(), '25');
    await userEvent.clear(priceField());
    await userEvent.type(priceField(), '120');
    await userEvent.click(saveButton());

    await waitFor(() => expect(calls).toEqual(['qty', 'price']));
  });

  it('keeps Save disabled when nothing changed', async () => {
    render(wrap(
      <EditJobPartQuantityModal
        open
        jobPart={jp}
        qtyShipped={0}
        onClose={vi.fn()}
        onConfirmed={vi.fn()}
      />,
    ));
    expect(saveButton()).toBeDisabled();
  });
});
