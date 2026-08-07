import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import SubscriptionRequiredNotice from '@/components/billing/SubscriptionRequiredNotice';

let subscriptionStub: Record<string, unknown> | null = null;
let roleStub = { role: 'admin' as string | null, isAdmin: true, loading: false };

vi.mock('@/components/providers/SubscriptionProvider', () => ({
  useOptionalSubscription: () => subscriptionStub,
}));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => roleStub }));
vi.mock('@/components/billing/SubscribeButton', () => ({
  default: () => <button type="button">Subscribe</button>,
}));

const BASE = { isLoading: false, isDemo: false, canWrite: false, mustSubscribe: true };

beforeEach(() => {
  subscriptionStub = { ...BASE };
  roleStub = { role: 'admin', isAdmin: true, loading: false };
});

describe('SubscriptionRequiredNotice', () => {
  it('tells an admin who has never subscribed what to do, with a way to do it', () => {
    render(<SubscriptionRequiredNotice entityPlural="parts" />);
    expect(screen.getByText(/start your subscription to add parts/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /subscribe/i })).toBeInTheDocument();
  });

  it('says "resubscribe" for a shop that lapsed rather than never started', () => {
    subscriptionStub = { ...BASE, mustSubscribe: false };
    render(<SubscriptionRequiredNotice entityPlural="quotes" />);
    expect(screen.getByText(/read-only.*resubscribe to add quotes again/i)).toBeInTheDocument();
  });

  it('points a non-admin at their admin and offers no button', () => {
    roleStub = { role: 'user', isAdmin: false, loading: false };
    render(<SubscriptionRequiredNotice entityPlural="customers" />);
    expect(screen.getByText(/an admin at your shop can restart it/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
  });

  it('renders nothing while entitlement is still loading', () => {
    // The guard that matters. isLoading starts true with billing null, which resolves to
    // must_subscribe — so canWrite is false for a healthy shop until the first fetch lands.
    // Without this the notice would flash on every create page load, for everyone.
    subscriptionStub = { ...BASE, isLoading: true };
    const { container } = render(<SubscriptionRequiredNotice entityPlural="parts" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a shop that can write', () => {
    subscriptionStub = { ...BASE, canWrite: true, mustSubscribe: false };
    const { container } = render(<SubscriptionRequiredNotice entityPlural="parts" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a demo company', () => {
    subscriptionStub = { ...BASE, isDemo: true };
    const { container } = render(<SubscriptionRequiredNotice entityPlural="parts" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing outside a SubscriptionProvider', () => {
    subscriptionStub = null;
    const { container } = render(<SubscriptionRequiredNotice entityPlural="parts" />);
    expect(container).toBeEmptyDOMElement();
  });
});
