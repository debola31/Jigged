/**
 * New purchase order: the form plus the subscription notice, prefilled from the URL by IDS ONLY
 * (the quotes/new rule) — a stale or tampered id simply fails to resolve, and nothing is seeded from
 * text in the URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, setSearchParams } from '../../../test-utils';

const formProps: { current: Record<string, unknown> | null } = { current: null };
vi.mock('@/components/purchasing/VendorPoForm', () => ({
  default: (p: Record<string, unknown>) => {
    formProps.current = p;
    return <div data-testid="po-form" />;
  },
}));
vi.mock('@/components/billing/SubscriptionRequiredNotice', () => ({
  default: ({ entityPlural }: { entityPlural: string }) => <div data-testid="subscription-notice">{entityPlural}</div>,
}));

import NewVendorPoPage from '@/app/dashboard/[companyId]/purchasing/orders/new/page';
import { newVendorPoPath } from '@/lib/purchasingRoutes';

const V = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  formProps.current = null;
  setSearchParams();
});

describe('New purchase order page', () => {
  it('shows the subscription notice for purchase orders above a create form', () => {
    render(<NewVendorPoPage />);
    expect(screen.getByTestId('subscription-notice')).toHaveTextContent('purchase orders');
    expect(formProps.current).toMatchObject({ mode: 'create', companyId: 'test-company-id' });
  });

  it('passes the ids it was handed, and only ids', () => {
    setSearchParams({ vendor: V, part: P, jobOperation: OP, job: 'J-1042 (not an id)' });
    render(<NewVendorPoPage />);
    expect(formProps.current?.prefill).toEqual({
      vendorId: V,
      partId: P,
      jobId: null,
      jobPartId: null,
      jobOperationId: OP,
      workCenterId: null,
    });
  });

  /** A link and the page that opens it read one key map, so neither can rename a key alone. */
  it('opens prefilled from the link an operation card builds', () => {
    const href = newVendorPoPath('test-company-id', { vendorId: V, jobOperationId: OP });
    setSearchParams(href.split('?')[1]);
    render(<NewVendorPoPage />);
    expect(formProps.current?.prefill).toMatchObject({ vendorId: V, jobOperationId: OP, partId: null });
  });
});
