/**
 * The in-app location scanner.
 *
 * The parser is the part worth pinning hardest. A shop floor is full of barcodes that are not ours —
 * shipping labels, vendor part codes, another system's QR — and every one of them decodes perfectly
 * well. Treating a foreign code as a location id would route someone to a bin that doesn't exist and
 * blame them for it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '../../test-utils';

import LocationScanner, {
  locationIdFromScan,
} from '@/components/scanner/LocationScanner';

const UUID = '71000000-0000-0000-0000-000000000002';

describe('locationIdFromScan', () => {
  it('reads the id out of a printed label URL', () => {
    expect(
      locationIdFromScan(`https://jigged.app/operator/co1/login?location=${UUID}`),
    ).toBe(UUID);
  });

  it('accepts a bare uuid, so a keyboard-wedge scanner or typing also works', () => {
    expect(locationIdFromScan(UUID)).toBe(UUID);
  });

  it('tolerates surrounding whitespace and upper case', () => {
    expect(locationIdFromScan(`  ${UUID.toUpperCase()}  `)).toBe(UUID);
  });

  it('reads a localhost URL, so a dev-printed label works too', () => {
    expect(locationIdFromScan(`http://localhost:3000/operator/co1/login?location=${UUID}`)).toBe(UUID);
  });

  // Everything below is the "not ours" set — each must be rejected, not guessed at.
  it.each([
    ['a plain shipping barcode', '1Z999AA10123456784'],
    ['a vendor part code', 'MCM-91290A115'],
    ['a URL with no location param', 'https://jigged.app/operator/co1/login'],
    ['a URL whose location is not a uuid', 'https://jigged.app/x?location=CAB3-A'],
    ['another system’s QR', 'https://some-erp.example/bin/17'],
    ['a job traveler QR', 'https://jigged.app/operator/co1/login?job=j1&part=p1'],
    ['empty text', '   '],
  ])('rejects %s', (_label, text) => {
    expect(locationIdFromScan(text)).toBeNull();
  });
});

/**
 * Camera plumbing.
 *
 * jsdom has no `getUserMedia` and no WASM, so the decode loop itself can't run here — the browser is
 * the only place that gets tested. What these cover is the part that fails in the real world for
 * boring reasons: permission being denied, and the camera being released on close.
 */
describe('LocationScanner — camera', () => {
  const track = () => ({ stop: vi.fn() });

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
    // The real protection is that the round trip now lives in its own file (vitest isolates the
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

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} />);

    expect(
      await screen.findByText(/camera access was blocked.*browser settings/i),
    ).toBeInTheDocument();
  });

  it('surfaces any other camera failure rather than sitting on a spinner', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
      new Error('Requested device not found'),
    );

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} />);
    expect(await screen.findByText(/requested device not found/i)).toBeInTheDocument();
  });

  /** A camera left running after the dialog closes reads as the app watching you. */
  it('releases every track when it unmounts', async () => {
    const tracks = [track(), track()];
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => tracks,
    } as unknown as MediaStream);

    const { unmount } = render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} />);
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
   *
   * Re-rendering with fresh inline handlers is exactly what the layout does, so this asserts the
   * camera is acquired once and the tracks are never stopped.
   */
  it('does not restart the camera when the parent re-renders', async () => {
    const tracks = [track()];
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => tracks,
    } as unknown as MediaStream);

    const { rerender } = render(
      <LocationScanner open onClose={() => {}} onScan={() => {}} onScanTraveler={() => {}} />,
    );
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));

    // Three more renders, each with brand-new function identities.
    for (let i = 0; i < 3; i++) {
      rerender(
        <LocationScanner open onClose={() => {}} onScan={() => {}} onScanTraveler={() => {}} />,
      );
    }

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(tracks[0].stop).not.toHaveBeenCalled();
  });

  it('asks for the rear camera, which is the one pointed at a shelf', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => [],
    } as unknown as MediaStream);

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} />);

    await waitFor(() =>
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({ video: { facingMode: 'environment' } }),
      ),
    );
  });

  it('does not touch the camera while closed', () => {
    render(<LocationScanner open={false} onClose={vi.fn()} onScan={vi.fn()} />);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('says what to do, and that it keeps scanning', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => [],
    } as unknown as MediaStream);

    render(<LocationScanner open onClose={vi.fn()} onScan={vi.fn()} />);
    expect(
      await screen.findByText(/point the camera at the qr code.*keep going/i),
    ).toBeInTheDocument();
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
