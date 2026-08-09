/**
 * The in-app scanner's camera plumbing.
 *
 * The parser used to be tested here too. It moved to `__tests__/lib/jiggedScan.test.ts` when the
 * component stopped re-exporting it — one module owns writing, reading and routing a scan now, and
 * its tests belong with it.
 *
 * jsdom has no `getUserMedia` and no WASM, so the decode loop itself cannot run here — the browser
 * is the only place that gets tested. What these cover is everything around it that fails in the
 * real world for boring reasons: permission, camera release, and the request we make of the camera
 * in the first place, which is what a Contour operator's failed scan turned out to hinge on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '../../test-utils';

import LocationScanner from '@/components/scanner/LocationScanner';

const capture = vi.hoisted(() => vi.fn());
vi.mock('posthog-js', () => ({ default: { capture } }));

describe('LocationScanner — camera', () => {
  const track = (capabilities?: Record<string, unknown>) => ({
    stop: vi.fn(),
    getCapabilities: capabilities ? () => capabilities : undefined,
    applyConstraints: vi.fn(async () => {}),
  });

  const streamOf = (tracks: ReturnType<typeof track>[]) =>
    ({
      getTracks: () => tracks,
      getVideoTracks: () => tracks,
    }) as unknown as MediaStream;

  beforeEach(() => {
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn() },
    });
    // The component dynamically imports the decoder; jsdom can't load the wasm.
    vi.doMock('zxing-wasm/reader', () => ({
      prepareZXingModule: vi.fn(),
      readBarcodes: vi.fn(async () => []),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // `doUnmock` alone only affects FUTURE imports — it does not evict a module already in the
    // registry, and the component imports `zxing-wasm/reader` dynamically while these tests run.
    // The real protection is that the round trip lives in its own file (vitest isolates the
    // registry per file); this reset is belt-and-braces for anything added to this one later.
    vi.doUnmock('zxing-wasm/reader');
    vi.resetModules();
  });

  /**
   * Permission is the single commonest failure, and it can't be fixed by retrying — so the message
   * has to say where to go instead of "something went wrong".
   */
  it('explains a blocked camera and where to fix it', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
      new DOMException('Permission denied', 'NotAllowedError'),
    );

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} surface="operator_tabbar" />);

    expect(
      await screen.findByText(/camera access was blocked.*browser settings/i),
    ).toBeInTheDocument();
  });

  it('surfaces any other camera failure rather than sitting on a spinner', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
      new Error('Requested device not found'),
    );

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} surface="operator_tabbar" />);
    expect(await screen.findByText(/requested device not found/i)).toBeInTheDocument();
  });

  /** A camera left running after the dialog closes reads as the app watching you. */
  it('releases every track when it unmounts', async () => {
    const tracks = [track(), track()];
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamOf(tracks));

    const { unmount } = render(
      <LocationScanner open onClose={vi.fn()} onScan={vi.fn()} surface="operator_tabbar" />,
    );
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());

    unmount();
    await waitFor(() => {
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    });
  });

  /**
   * The camera must survive the parent re-rendering.
   *
   * Callers pass inline arrow functions — the operator layout does — so every parent render hands
   * this component new `onScan`/`onScanTraveler` identities. While those were effect dependencies,
   * any such render tore the effect down and back up: `stop()` released every track, then
   * `getUserMedia` ran again. On a phone that is a visible black flash and a lost half-second of
   * aiming, in the middle of a scan.
   */
  it('does not restart the camera when the parent re-renders', async () => {
    const tracks = [track()];
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamOf(tracks));

    const { rerender } = render(
      <LocationScanner
        open
        onClose={() => {}}
        onScan={() => {}}
        onScanTraveler={() => {}}
        surface="operator_tabbar"
      />,
    );
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));

    // Three more renders, each with brand-new function identities.
    for (let i = 0; i < 3; i++) {
      rerender(
        <LocationScanner
          open
          onClose={() => {}}
          onScan={() => {}}
          onScanTraveler={() => {}}
          surface="operator_tabbar"
        />,
      );
    }

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(tracks[0].stop).not.toHaveBeenCalled();
  });

  /**
   * **The regression that started all of this.**
   *
   * The scanner asked for no resolution at all, so browsers handed it their default — typically
   * 640×480, which is a handful of pixels per QR module at arm's length. `ideal` rather than
   * `exact` on purpose: a handset that cannot do 1080p must fall back, not throw
   * OverconstrainedError and leave the operator with no scanner at all.
   */
  it('asks for the rear camera at a resolution a QR can actually be read from', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamOf([]));

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} surface="operator_tabbar" />);

    await waitFor(() =>
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        }),
      ),
    );
  });

  it('does not touch the camera while closed', () => {
    render(
      <LocationScanner open={false} onClose={vi.fn()} onScan={vi.fn()} surface="operator_tabbar" />,
    );
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('tells the operator to use the reticle, and that it keeps scanning', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamOf([]));

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} surface="operator_tabbar" />);
    expect(
      await screen.findByText(/hold the qr code inside the square.*keep going/i),
    ).toBeInTheDocument();
  });

  /**
   * Torch and focus must degrade **silently**.
   *
   * WebKit implements neither, so on every iPhone in the shop these capabilities are absent. A
   * torch button that does nothing is worse than no button: an operator in a dark aisle taps it and
   * concludes the app is broken.
   */
  it('hides the torch button on a device that has no torch', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamOf([track({})]));

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} surface="operator_tabbar" />);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());

    expect(screen.queryByRole('button', { name: /light/i })).not.toBeInTheDocument();
  });

  it('offers the torch, and applies it, where the device advertises one', async () => {
    const t = track({ torch: true });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamOf([t]));

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} surface="operator_tabbar" />);

    const button = await screen.findByRole('button', { name: /turn the light on/i });
    button.click();

    await waitFor(() =>
      expect(t.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] }),
    );
  });

  it('asks for continuous autofocus where the device advertises it', async () => {
    const t = track({ focusMode: ['manual', 'continuous'] });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamOf([t]));

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} surface="operator_tabbar" />);

    await waitFor(() =>
      expect(t.applyConstraints).toHaveBeenCalledWith({
        advanced: [{ focusMode: 'continuous' }],
      }),
    );
  });

  it('does not ask for autofocus a device never claimed to support', async () => {
    const t = track({ focusMode: ['manual'] });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamOf([t]));

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} surface="operator_tabbar" />);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());

    expect(t.applyConstraints).not.toHaveBeenCalled();
  });

  it('reports the scanner opening, tagged with the surface that opened it', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(streamOf([]));

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} surface="inventory_count" />);

    await waitFor(() =>
      expect(capture).toHaveBeenCalledWith('scanner opened', { surface: 'inventory_count' }),
    );
  });
});

/**
 * The round trip — "what we print, we can read" — lives in `scannerRoundTrip.test.ts`, NOT here.
 *
 * It must not share a file with the camera suite above: that suite `vi.doMock`s
 * `zxing-wasm/reader` with a `readBarcodes` returning `[]`, the component imports that module
 * dynamically mid-render, and `vi.doUnmock` cannot evict an already-imported module. The round
 * trip then decoded with the mock and failed on `expected [] to have a length of 1` — on CI only,
 * where contended workers let the mocked import land first. Vitest isolates the registry per
 * FILE, so separation removes the race rather than narrowing it.
 */
