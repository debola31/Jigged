/**
 * The gate's status read, and the staleness bug that made it prompt someone who
 * had just agreed.
 *
 * REPORTED BEHAVIOUR: a newly invited user ticks the box on /accept-invite,
 * lands on the dashboard, and is asked AGAIN — then never again after a reload.
 *
 * CAUSE: `TermsGate` must call this hook unconditionally (hooks cannot sit
 * behind an early return), so it queried on /accept-invite too, BEFORE the
 * acceptance existed. `router.replace` is a client-side navigation, so the
 * layout never remounts and that pre-acceptance answer survived onto the
 * dashboard, where the route is no longer exempt.
 *
 * FIX: do not query while the gate could not act on the answer anyway, and
 * re-query when it becomes able to. That removes the staleness at its source
 * rather than papering over it with a refresh call from the accept page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockUser = { id: 'u-1' };
const mockFetch = vi.fn();

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

vi.mock('@/utils/termsAccess', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/utils/termsAccess');
  return { ...actual, fetchAcceptedVersions: (...a: unknown[]) => mockFetch(...a) };
});

import { useTermsStatus } from '@/hooks/useTermsStatus';

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue([]);
});

describe('useTermsStatus — when it is allowed to ask', () => {
  it('does not query while disabled', async () => {
    renderHook(() => useTermsStatus(false));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('queries once enabled', async () => {
    renderHook(() => useTermsStatus(true));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });

  /**
   * THE REGRESSION. Disabled on /accept-invite, enabled on the dashboard: the
   * answer must be fetched AFTER the transition, not carried across it. Before
   * the fix this queried once, on the exempt route, and reused that stale
   * result on the dashboard — prompting a user who had just agreed.
   */
  it('re-queries when it becomes enabled, instead of reusing a stale answer', async () => {
    const { rerender } = renderHook(({ on }) => useTermsStatus(on), {
      initialProps: { on: false },
    });
    expect(mockFetch).not.toHaveBeenCalled();

    rerender({ on: true });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });

  it('reports what the fresh answer says', async () => {
    mockFetch.mockResolvedValue([]);
    const { result } = renderHook(() => useTermsStatus(true));
    await waitFor(() => expect(result.current.state).toBe('resolved'));
    if (result.current.state === 'resolved') {
      expect(result.current.needs).toEqual(['tos', 'privacy']);
    }
  });

  it('reports unknown, not compliant, when the query fails', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useTermsStatus(true));
    await waitFor(() => expect(result.current.state).toBe('unknown'));
  });
});
