import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryLoad } from '@/app/(marketing)/showcase/_components/retryLoad';

afterEach(() => vi.useRealTimers());

describe('temporary showcase asset failures', () => {
  it.each([
    ['rate limit', Object.assign(new Error('HTTP error'), { response: { status: 429 } })],
    ['server error', new Error('fetch for "bench.glb" responded with 503: ')],
    ['network', new TypeError('Load failed')],
    ['image error', new Event('error')],
  ])('backs off and recovers without exposing the first failure: %s', async (_, error) => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('asset');
    const result = retryLoad(load);
    await vi.advanceTimersByTimeAsync(999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('asset');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stops after three attempts and preserves the final error for reporting', async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error('rate limited'), { response: { status: 429 } });
    const load = vi.fn().mockRejectedValue(error);
    const result = expect(retryLoad(load)).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(load).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['missing object', new Error('fetch for "missing.glb" responded with 400: ')],
    ['not found', Object.assign(new Error('not found'), { response: { status: 404 } })],
    ['decode', new Error('invalid GLTF')],
    ['cancelled', new DOMException('Aborted', 'AbortError')],
  ])('does not retry a permanent failure or cancellation: %s', async (_, error) => {
    const load = vi.fn().mockRejectedValue(error);
    await expect(retryLoad(load)).rejects.toBe(error);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
