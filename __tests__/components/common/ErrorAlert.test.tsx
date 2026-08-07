import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import ErrorAlert from '@/components/common/ErrorAlert';

/**
 * The two collaborators ErrorAlert reads. Both are mocked at module level and driven per test
 * through these mutable stubs, because the component's whole job is choosing copy from their
 * combination.
 */
let subscriptionStub: Record<string, unknown> | null = null;
let roleStub = { role: 'admin' as string | null, isAdmin: true, loading: false };

vi.mock('@/components/providers/SubscriptionProvider', () => ({
  useOptionalSubscription: () => subscriptionStub,
}));

vi.mock('@/hooks/useUserRole', () => ({
  useUserRole: () => roleStub,
}));

// The button redirects to Stripe; its internals are covered by its own surface, and rendering it
// for real would pull in billingApi.
vi.mock('@/components/billing/SubscribeButton', () => ({
  default: () => <button type="button">Subscribe</button>,
}));

/** Copy is derived from `billing.subscription_status`, so the stubs carry a real row. */
const billingRow = (subscription_status: string | null) => ({
  billing_exempt: false,
  subscription_status,
  current_period_end: null,
  cancel_at: null,
  ended_at: null,
});

/** A shop that can write: the healthy case. */
const CAN_WRITE = {
  isLoading: false,
  canWrite: true,
  mustSubscribe: false,
  isReadOnly: false,
  billing: billingRow('active'),
};
/** Never subscribed — no company_billing row at all. */
const MUST_SUBSCRIBE = {
  isLoading: false,
  canWrite: false,
  mustSubscribe: true,
  isReadOnly: false,
  billing: null,
};
/** Subscribed once, canceled, past the grace window. */
const READ_ONLY = {
  isLoading: false,
  canWrite: false,
  mustSubscribe: false,
  isReadOnly: true,
  billing: billingRow('canceled'),
};
/** Paused — also read-only, but emphatically NOT ended. */
const PAUSED = {
  isLoading: false,
  canWrite: false,
  mustSubscribe: false,
  isReadOnly: true,
  billing: billingRow('paused'),
};

const BLOCKED_INSERT = {
  code: '42501',
  message: 'new row violates row-level security policy "billing_gate_insert" for table "parts"',
};
/** What a billing-blocked UPDATE actually looks like today: RLS filters it to zero rows. */
const NO_ROWS = {
  code: 'PGRST116',
  message: 'JSON object requested, multiple (or no) rows returned',
};
const FK_VIOLATION = {
  code: '23503',
  message:
    'delete on table "customer_addresses" violates foreign key constraint "quotes_x_fkey" on table "quotes"',
};

beforeEach(() => {
  subscriptionStub = { ...CAN_WRITE };
  roleStub = { role: 'admin', isAdmin: true, loading: false };
});

describe('ErrorAlert', () => {
  it('renders nothing without an error', () => {
    const { container } = render(<ErrorAlert error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a plain string as given', () => {
    render(<ErrorAlert error="Part name is required" />);
    expect(screen.getByText('Part name is required')).toBeInTheDocument();
  });

  it('translates an ordinary failure and offers no Subscribe button', () => {
    render(<ErrorAlert error={FK_VIOLATION} entity="address" />);
    expect(screen.getByText(/still referenced by/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
  });

  it('passes through a hand-written Error message rather than genericising it', () => {
    // The access layer throws plenty of these — "This operation cannot be received.",
    // "A quote must include at least one part." They carry no SQLSTATE, so code-matching finds
    // nothing and would fall back to "Something went wrong"; the message IS the useful part.
    render(
      <ErrorAlert
        error={new Error('This operation cannot be received.')}
        entity="operation"
        fallback="Something went wrong. Please try again."
      />,
    );
    expect(screen.getByText('This operation cannot be received.')).toBeInTheDocument();
  });

  it('does NOT pass through a raw Supabase message', () => {
    // The other half of that rule: anything carrying a SQLSTATE is DB text, and
    // "raw DB strings must never reach a user".
    render(
      <ErrorAlert
        error={{ code: '23503', message: 'violates foreign key constraint "x_fkey"' }}
        entity="address"
      />,
    );
    expect(screen.queryByText(/x_fkey/)).not.toBeInTheDocument();
  });

  describe('context-first classification', () => {
    it('reads a zero-row failure as billing when the shop cannot write', () => {
      // The reason context is checked before error shape. A billing-blocked UPDATE is filtered
      // by RLS to zero rows, so it arrives as PGRST116 with nothing billing-shaped about it.
      subscriptionStub = { ...READ_ONLY };
      render(<ErrorAlert error={NO_ROWS} entity="part" />);
      expect(screen.getByText(/subscription has ended/i)).toBeInTheDocument();
    });

    it('reads a nameless storage denial as billing when the shop cannot write', () => {
      // Storage policies are permissive, so their denial carries no policy name and error-shape
      // classification cannot see it.
      subscriptionStub = { ...READ_ONLY };
      render(
        <ErrorAlert
          error={{ status: 403, message: 'new row violates row-level security policy' }}
          entity="attachment"
        />,
      );
      expect(screen.getByText(/subscription has ended/i)).toBeInTheDocument();
    });

    it('does NOT read a zero-row failure as billing while entitlement is still loading', () => {
      // The false-negative-flash guard. isLoading starts true with billing null, which resolves
      // to must_subscribe — so canWrite is false for a healthy shop during its first fetch.
      // Without the isLoading check every error on every page would briefly read as billing.
      subscriptionStub = { ...MUST_SUBSCRIBE, isLoading: true };
      render(<ErrorAlert error={NO_ROWS} entity="part" fallback="Failed to save part." />);
      expect(screen.queryByText(/subscription/i)).not.toBeInTheDocument();
      expect(screen.getByText('Failed to save part.')).toBeInTheDocument();
    });

    it('falls back to error shape when the shop looks writable but the DB disagreed', () => {
      // The lapsed-mid-session race: the cached context still says canWrite.
      subscriptionStub = { ...CAN_WRITE };
      render(<ErrorAlert error={BLOCKED_INSERT} entity="part" />);
      expect(screen.getByText(/subscription/i)).toBeInTheDocument();
    });
  });

  describe('who is offered a way to fix it', () => {
    it('offers Subscribe to an admin who has never subscribed', () => {
      subscriptionStub = { ...MUST_SUBSCRIBE };
      render(<ErrorAlert error={BLOCKED_INSERT} entity="part" />);
      expect(screen.getByText(/subscription hasn't started yet/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /subscribe/i })).toBeInTheDocument();
    });

    it('offers Subscribe to an admin whose subscription lapsed', () => {
      subscriptionStub = { ...READ_ONLY };
      render(<ErrorAlert error={BLOCKED_INSERT} entity="part" />);
      expect(screen.getByText(/read-only/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /subscribe/i })).toBeInTheDocument();
    });

    it('tells a non-admin to ask an admin, with no button', () => {
      // Settings is behind AdminGuard and the Stripe routes 403 a non-admin, so a button here
      // would be a two-step dead end.
      subscriptionStub = { ...READ_ONLY };
      roleStub = { role: 'user', isAdmin: false, loading: false };
      render(<ErrorAlert error={BLOCKED_INSERT} entity="part" />);
      expect(screen.getByText(/an admin at your shop can restart it/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
    });

    it('does not tell a shop that never subscribed that anything ended', () => {
      subscriptionStub = { ...MUST_SUBSCRIBE };
      render(<ErrorAlert error={BLOCKED_INSERT} entity="part" />);
      expect(screen.queryByText(/ended|resubscribe/i)).not.toBeInTheDocument();
    });

    it('says paused, not ended, for a paused subscription', () => {
      // Entitlement collapses paused into read_only alongside canceled/unpaid; the copy must not.
      subscriptionStub = { ...PAUSED };
      render(<ErrorAlert error={BLOCKED_INSERT} entity="part" />);
      expect(screen.getByText(/subscription is paused/i)).toBeInTheDocument();
      expect(screen.queryByText(/ended/i)).not.toBeInTheDocument();
    });

    it('offers no button while the role is still loading', () => {
      subscriptionStub = { ...READ_ONLY };
      roleStub = { role: null, isAdmin: false, loading: true };
      render(<ErrorAlert error={BLOCKED_INSERT} entity="part" />);
      expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
    });

    it('points an operator at the office, never at Settings', () => {
      // No SubscriptionProvider in the operator shell, and an operator cannot reach Settings.
      subscriptionStub = null;
      roleStub = { role: 'operator', isAdmin: false, loading: false };
      render(<ErrorAlert error={BLOCKED_INSERT} entity="operation" />);
      expect(screen.getByText(/let the office know/i)).toBeInTheDocument();
      expect(screen.queryByText(/settings/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
    });
  });
});
