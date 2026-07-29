import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@/__tests__/test-utils';
import { useNoteDwell } from '@/hooks/useNoteDwell';

const rpc = vi.fn().mockResolvedValue({ error: null });
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ rpc }),
  getTypedSupabase: () => ({ rpc }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

/**
 * These guard one promise: the count shown to an author must never exceed
 * reality. In a fifteen-person shop the author can just ask whether someone read
 * it, so an inflated number does not read as a bug — it discredits the loop.
 */

type Cb = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
let observerCb: Cb | undefined;
const observed = new Set<Element>();

class FakeIO {
  constructor(cb: Cb) {
    observerCb = cb;
  }
  observe(el: Element) {
    observed.add(el);
  }
  unobserve(el: Element) {
    observed.delete(el);
  }
  disconnect() {
    observed.clear();
  }
}

function Harness({ ids, enabled = true }: { ids: string[]; enabled?: boolean }) {
  const { observe } = useNoteDwell('co1', 'job1', enabled);
  return (
    <>
      {ids.map((id) => (
        <p key={id} data-note={id} ref={observe(id)}>
          body of {id}
        </p>
      ))}
    </>
  );
}

function intersect(container: HTMLElement, id: string, isIntersecting: boolean) {
  const target = container.querySelector(`[data-note="${id}"]`) as Element;
  act(() => observerCb?.([{ target, isIntersecting }]));
}

/** Dwell (2s) then the batch window (1s). */
function elapse(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  rpc.mockClear();
  observed.clear();
  observerCb = undefined;
  vi.stubGlobal('IntersectionObserver', FakeIO);
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useNoteDwell', () => {
  it('does not log a note that was scrolled past', () => {
    // The brief's own case: rendered but not dwelled on produces no view.
    const { container } = render(<Harness ids={['n1']} />);
    intersect(container, 'n1', true);
    elapse(1500);
    intersect(container, 'n1', false);
    elapse(5000);

    expect(rpc).not.toHaveBeenCalled();
  });

  it('logs a note that stayed visible past the dwell threshold', () => {
    const { container } = render(<Harness ids={['n1']} />);
    intersect(container, 'n1', true);
    elapse(2000 + 1000);

    expect(rpc).toHaveBeenCalledWith(
      'log_note_views',
      expect.objectContaining({ p_note_ids: ['n1'], p_job_id: 'job1' }),
    );
  });

  it('does NOT log while the tab is backgrounded', () => {
    // An IntersectionObserver reports "intersecting" for a phone in a pocket.
    // Without this gate the count climbs while nobody is looking — the exact
    // overstatement that is forbidden.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    const { container } = render(<Harness ids={['n1']} />);
    intersect(container, 'n1', true);
    elapse(5000);

    expect(rpc).not.toHaveBeenCalled();
  });

  it('cancels in-flight dwell when the tab is backgrounded mid-read', () => {
    const { container } = render(<Harness ids={['n1']} />);
    intersect(container, 'n1', true);
    elapse(1000);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    elapse(5000);

    expect(rpc).not.toHaveBeenCalled();
  });

  it('batches a screenful into one round trip', () => {
    // Otherwise a read N+1 is traded for a write N+1.
    const { container } = render(<Harness ids={['n1', 'n2', 'n3']} />);
    intersect(container, 'n1', true);
    intersect(container, 'n2', true);
    intersect(container, 'n3', true);
    elapse(2000 + 1000);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_note_ids.sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('does not re-log the same note when it scrolls back into view', () => {
    const { container } = render(<Harness ids={['n1']} />);
    intersect(container, 'n1', true);
    elapse(2000 + 1000);
    expect(rpc).toHaveBeenCalledTimes(1);

    intersect(container, 'n1', false);
    intersect(container, 'n1', true);
    elapse(2000 + 1000);

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('logs nothing at all when disabled', () => {
    // e.g. a closed sheet — its notes are mounted but not being read.
    const { container } = render(<Harness ids={['n1']} enabled={false} />);
    // No observer is created at all, so nothing can start a dwell timer.
    expect(observerCb).toBeUndefined();
    intersect(container, 'n1', true);
    elapse(5000);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('never surfaces a failed write', async () => {
    // Invisible bookkeeping: it must not toast, block a tap, or break a feed.
    rpc.mockResolvedValueOnce({ error: { message: 'denied' } });
    const { container } = render(<Harness ids={['n1']} />);
    intersect(container, 'n1', true);
    elapse(2000 + 1000);

    // The assertion is simply that nothing threw and the tree still renders.
    expect(container.querySelector('[data-note="n1"]')).toBeInTheDocument();
  });
});
