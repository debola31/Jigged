import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { reportLoadFailure } from '@/app/(marketing)/showcase/_components/reportLoad';
import { lightModel } from '@/app/(marketing)/showcase/_components/lightModel';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

// The loader stands in for three's: a URL with "missing" in it is answered as Storage answers a file not there.
const { loadAsync } = vi.hoisted(() => ({
  loadAsync: vi.fn((url: string) =>
    url.includes('missing') ? Promise.reject(new Error(`fetch for "${url}" responded with 400: `)) : Promise.resolve({ scene: { url } }),
  ),
}));
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {
      return this;
    }
    loadAsync = loadAsync;
  },
}));
vi.mock('three/addons/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));

const BUCKET = 'https://mayuquvexmqjvwkfasxg.supabase.co/storage/v1/object/public/showcase';

describe('a showcase file that failed to load', () => {
  beforeEach(() => vi.mocked(Sentry.captureException).mockClear());

  it.each([
    ['Safari', new TypeError('Load failed')],
    // As Sentry's fetch instrumentation leaves the message (JAVASCRIPT-NEXTJS-3R).
    ['Safari, as Sentry saw it', new TypeError('Load failed (mayuquvexmqjvwkfasxg.supabase.co)')],
    ['Chrome', new TypeError('Failed to fetch')],
    ['Firefox', new TypeError('NetworkError when attempting to fetch resource.')],
  ])('is not reported when the browser never reached the bucket (%s)', (_, error) => {
    expect(reportLoadFailure(error, 'Showcase: a shop model failed to load')).toBe(false);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('is reported when Storage answered that it is not there (JAVASCRIPT-NEXTJS-3Q)', () => {
    const error = new Error(`fetch for "${BUCKET}/models/keeper.glb" responded with 400: `);
    expect(reportLoadFailure(error, 'Showcase: a shop model failed to load')).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('is reported under its message when what failed is not an Error', () => {
    expect(reportLoadFailure(new Event('error'), "Showcase: the shop room's textures failed to load")).toBe(true);
    const sent = vi.mocked(Sentry.captureException).mock.calls[0][0] as Error;
    expect(sent).toBeInstanceOf(Error);
    expect(sent.message).toBe("Showcase: the shop room's textures failed to load");
  });
});

describe('a light model', () => {
  it('shares a rate-limited load through its retry and recovers for every caller', async () => {
    vi.useFakeTimers();
    try {
      const url = `${BUCKET}/models/rate-limited.glb`;
      loadAsync.mockClear();
      loadAsync.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { response: { status: 429 } }));
      const first = lightModel(url);
      expect(lightModel(url)).toBe(first);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(first).resolves.toEqual({ scene: { url } });
      expect(loadAsync).toHaveBeenCalledTimes(2);
      expect(lightModel(url)).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles as { error } and never rejects, so nothing in a canvas throws for a missing file', async () => {
    const loaded = await lightModel(`${BUCKET}/models/missing.glb`);
    expect('error' in loaded && (loaded.error as Error).message).toMatch(/responded with 400/);
  });

  it('settles as { scene } when it loads', async () => {
    const loaded = await lightModel(`${BUCKET}/models/vf2.glb`);
    expect('scene' in loaded && loaded.scene).toEqual({ url: `${BUCKET}/models/vf2.glb` });
  });

  it('is loaded once per URL for the page, a failure included, for the shop and the cards to share', async () => {
    loadAsync.mockClear();
    const url = `${BUCKET}/models/missing-once.glb`;
    const first = lightModel(url);
    expect(lightModel(url)).toBe(first);
    await first;
    expect(lightModel(url)).toBe(first);
    expect(loadAsync).toHaveBeenCalledTimes(1);
  });
});
