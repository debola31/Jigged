import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import SubscribeButton from '@/components/billing/SubscribeButton';

let subscriptionStub: Record<string, unknown> | null = null;
let roleStub = { role: 'admin' as string | null, isAdmin: true, loading: false };

vi.mock('@/components/providers/SubscriptionProvider', () => ({
  useOptionalSubscription: () => subscriptionStub,
}));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => roleStub }));
vi.mock('@/lib/billingApi', () => ({
  startCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
}));

beforeEach(() => {
  subscriptionStub = { mustSubscribe: true, hasCustomer: false, refresh: vi.fn() };
  roleStub = { role: 'admin', isAdmin: true, loading: false };
});

describe('SubscribeButton', () => {
  it('offers Subscribe to an admin who has no Stripe customer yet', () => {
    render(<SubscribeButton />);
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeInTheDocument();
  });

  it('offers Manage billing once Stripe knows the shop', () => {
    subscriptionStub = { mustSubscribe: false, hasCustomer: true, refresh: vi.fn() };
    render(<SubscribeButton />);
    expect(screen.getByRole('button', { name: 'Manage billing' })).toBeInTheDocument();
  });

  it('renders nothing for a non-admin', () => {
    // The role gate lives here rather than in each caller, so BillingBanner and ErrorAlert
    // cannot drift. Pressing it as a `user` hit `_verify_company_admin` and 403'd — a
    // confirm-then-error dead end (interaction-standards.md §4).
    roleStub = { role: 'user', isAdmin: false, loading: false };
    const { container } = render(<SubscribeButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the role is still unknown', () => {
    roleStub = { role: null, isAdmin: false, loading: true };
    const { container } = render(<SubscribeButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing outside a SubscriptionProvider', () => {
    // The operator app mounts none, and an operator cannot subscribe.
    subscriptionStub = null;
    const { container } = render(<SubscribeButton />);
    expect(container).toBeEmptyDOMElement();
  });
});
