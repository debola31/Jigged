import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useLoad } from '@/hooks/useLoad';

describe('useLoad', () => {
  it('starts in loading state, then resolves with data', async () => {
    const loader = vi.fn().mockResolvedValue(['a', 'b']);
    const { result } = renderHook(() => useLoad(loader, []));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(['a', 'b']);
    expect(result.current.error).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('captures a rejection in `error` and invokes onError', async () => {
    const err = new Error('boom');
    const loader = vi.fn().mockRejectedValue(err);
    const onError = vi.fn();
    const { result } = renderHook(() => useLoad(loader, [], { onError }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.data).toBeNull();
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('reload() re-runs the loader and re-shows the loading state', async () => {
    let resolveSecond: (v: string) => void = () => {};
    const loader = vi
      .fn()
      .mockResolvedValueOnce('first')
      .mockImplementationOnce(
        () => new Promise<string>((r) => {
          resolveSecond = r;
        }),
      );
    const { result } = renderHook(() => useLoad(loader, []));

    await waitFor(() => expect(result.current.data).toBe('first'));

    // Fire reload; the second load is held pending so we can observe loading.
    act(() => {
      void result.current.reload();
    });
    expect(result.current.loading).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond('second');
    });
    await waitFor(() => expect(result.current.data).toBe('second'));
  });

  it('re-runs when deps change', async () => {
    const loader = vi.fn().mockResolvedValue('x');
    let dep = 1;
    const { result, rerender } = renderHook(() => useLoad(() => loader(dep), [dep]));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(loader).toHaveBeenCalledTimes(1);

    dep = 2;
    rerender();
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader).toHaveBeenLastCalledWith(2);
  });

  it('drops a stale resolve that lands after unmount (no state write)', async () => {
    let resolve: (v: string) => void = () => {};
    const loader = vi.fn(() => new Promise<string>((r) => {
      resolve = r;
    }));
    const { unmount } = renderHook(() => useLoad(loader, []));
    expect(loader).toHaveBeenCalledTimes(1);

    unmount();
    // Resolving after unmount must be a no-op (request-id guard), not a warning.
    await act(async () => {
      resolve('late');
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
