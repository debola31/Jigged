/**
 * The Purchasing hub: one sidebar row, four tabs on `?view=` (plan §3.1 Routes, §3.13).
 *
 * The tabs are views of one section, so they live in the URL — a reload, a shared link and Back
 * all land on the same tab — and an unknown value falls back to Orders rather than rendering an
 * empty page. Each tab's own filters are its own: switching tabs starts the next one clean.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, routerMocks, resetRouterMocks, setSearchParams } from '../../../test-utils';

vi.mock('@/components/purchasing/VendorPoList', () => ({
  default: ({ companyId }: { companyId: string }) => <div data-testid="orders-tab">orders {companyId}</div>,
}));
vi.mock('@/components/purchasing/VendorPoReceiptsList', () => ({
  default: ({ companyId }: { companyId: string }) => <div data-testid="receipts-tab">receipts {companyId}</div>,
}));
vi.mock('@/components/purchasing/BuyList', () => ({
  BuyList: ({ companyId }: { companyId: string }) => <div data-testid="to-buy-tab">to buy {companyId}</div>,
}));
vi.mock('@/components/purchasing/RfqList', () => ({
  RfqList: ({ companyId }: { companyId: string }) => <div data-testid="rfqs-tab">rfqs {companyId}</div>,
}));
vi.mock('@/components/purchasing/PurchasingSettingsDialog', () => ({
  default: ({ open, companyId }: { open: boolean; companyId: string }) =>
    open ? <div role="dialog" aria-label="Purchasing settings">settings {companyId}</div> : null,
}));

import PurchasingHubPage from '@/app/dashboard/[companyId]/purchasing/page';

describe('Purchasing hub', () => {
  beforeEach(() => {
    resetRouterMocks();
    setSearchParams();
  });

  it('opens on Orders, the default view', () => {
    render(<PurchasingHubPage />);
    expect(screen.getByRole('tab', { name: /orders/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('orders-tab')).toHaveTextContent('orders test-company-id');
  });

  it.each([
    ['receipts', /receipts/i, 'receipts-tab'],
    ['to-buy', /to buy/i, 'to-buy-tab'],
    ['rfqs', /rfqs/i, 'rfqs-tab'],
  ])('?view=%s selects its tab and renders it for this company', (view, tabName, testId) => {
    setSearchParams({ view });
    render(<PurchasingHubPage />);
    expect(screen.getByRole('tab', { name: tabName })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId(testId)).toHaveTextContent('test-company-id');
    expect(screen.queryByTestId('orders-tab')).not.toBeInTheDocument();
  });

  it('falls back to Orders for a view it does not know', () => {
    setSearchParams({ view: 'shortages' });
    render(<PurchasingHubPage />);
    expect(screen.getByRole('tab', { name: /orders/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('orders-tab')).toBeInTheDocument();
  });

  it('switches tabs with router.replace, dropping the last tab’s filters', async () => {
    setSearchParams({ view: 'orders', status: 'draft', vendor: 'v1' });
    const user = userEvent.setup();
    render(<PurchasingHubPage />);

    await user.click(screen.getByRole('tab', { name: /to buy/i }));

    expect(routerMocks.replace).toHaveBeenCalledWith('?view=to-buy', { scroll: false });
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it('opens the purchasing settings from a labelled button, for any office user', async () => {
    const user = userEvent.setup();
    render(<PurchasingHubPage />);

    expect(screen.queryByRole('dialog', { name: /purchasing settings/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /purchasing settings/i }));
    expect(screen.getByRole('dialog', { name: /purchasing settings/i })).toHaveTextContent('test-company-id');
  });
});
