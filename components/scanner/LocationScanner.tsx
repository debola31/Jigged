'use client';

/**
 * An in-app scanner for Jigged's own printed codes.
 *
 * ## What it scans, and what it deliberately doesn't
 *
 * **Places and travelers, not parts.** The only QR codes in the system encode a location or a job
 * traveler (`lib/jiggedScan.ts`). Parts have no barcode at all, so "scan a part" is not a thing that
 * exists and this must not imply otherwise. Vendor barcodes on incoming material are foreign
 * symbologies we don't control — a receiving concern (J6, Phase 3), not this.
 *
 * ## Why it exists at all
 *
 * Otherwise every scan leaves the browser: the phone's camera app surfaces an OS banner, you tap
 * it, you land on the login route, and it redirects. `inventory.md` §5.10 measures the cost — *"ten
 * scans mean ten camera-app round trips"* — and names the flows that can't be served that way: a
 * count session and receiving a pallet, both continuous. In-app, an already-authenticated operator
 * goes straight to the bin with no interstitial.
 *
 * ## The part that is NOT answered yet
 *
 * §5.10's open question is whether iOS persists camera permission across navigations in a
 * **standalone** PWA (WebKit #185448). It doesn't, as far as anyone reports — which is why
 * `app/manifest.ts` ships `display: 'browser'`. In Safari-proper, permission behaves normally.
 * Confirming that on the shop's actual handsets is the spike; nothing here can settle it from a
 * desk, and this file should not be read as evidence that it has been.
 *
 * `zxing-wasm` rather than `BarcodeDetector`: WebKit has never implemented `BarcodeDetector`, so
 * every iOS browser lacks it. Decode speed was never the problem.
 *
 * ## What was wrong with it, and is now fixed
 *
 * Three things, all of which made the scanner worse than the phone's own camera app at the one job
 * it has:
 *
 *   1. **It asked for no camera resolution**, so browsers handed it their default — typically
 *      640×480. A QR at arm's length in a 640×480 frame is a few pixels per module.
 *   2. **It set `tryHarder: false`.** That option defaults to `true` in zxing-wasm; the scanner was
 *      explicitly opting out of accuracy in exchange for speed it did not need at 5 fps.
 *   3. **It decoded the whole frame**, so the megapixels it did have were spread across a scene
 *      instead of concentrated on the code.
 *
 * It now requests 1080p, decodes only the centred square the reticle marks (at sensor resolution,
 * so cropping *raises* pixels-per-module rather than lowering it), and leaves `tryHarder` alone.
 * `tryInvert` is switched off to pay for that: we only ever print black-on-white, so half the work
 * was searching for a thing we do not produce.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import FlashlightOnIcon from '@mui/icons-material/FlashlightOn';
import FlashlightOffIcon from '@mui/icons-material/FlashlightOff';

/** Where `scripts/copy-scanner-wasm.mjs` puts the decoder, so it loads from our origin not a CDN. */
const WASM_PATH = '/wasm/zxing_reader.wasm';

/**
 * Floor between decode attempts, in ms.
 *
 * The loop is self-scheduling — it waits this long *after* a decode resolves, rather than firing on
 * a fixed interval and dropping frames when the previous attempt is still running. That matters now
 * that `tryHarder` is on: a decode costs 50–250 ms depending on the handset, and a fixed 200 ms
 * interval would either idle on a fast phone or thrash on a slow one. This way every device runs as
 * fast as it can and no faster.
 */
const DECODE_FLOOR_MS = 60;

/**
 * Fraction of the frame's short edge that the reticle covers, and therefore that we decode.
 *
 * Generous on purpose: too tight and an operator has to aim, which is precisely the friction the
 * in-app scanner exists to remove. 0.8 still discards ~36% of the pixels — that is the saving —
 * while leaving a target that is hard to miss at arm's length.
 */
const RETICLE_FRACTION = 0.8;

/**
 * `torch` and `focusMode` are real, shipping constraints that `lib.dom`'s `MediaTrackConstraintSet`
 * does not declare — the Image Capture spec they come from has never been folded into the DOM
 * types. Casting through this is the narrowest way to say so: the shape is still checked, only the
 * key names are taken on trust, and both are guarded by a `getCapabilities()` check at the call
 * site anyway.
 */
function advancedConstraint(set: Record<string, unknown>): MediaTrackConstraints {
  return { advanced: [set] } as unknown as MediaTrackConstraints;
}

import { foreignCompanyRejection, parseJiggedScan } from '@/lib/jiggedScan';

export type { JiggedScan } from '@/lib/jiggedScan';
export { parseJiggedScan } from '@/lib/jiggedScan';

/** Why a decoded code was refused. Enum, not free text — it goes to analytics as a property. */
type RejectionReason =
  | 'not_jigged'
  | 'foreign_company'
  | 'traveler_unsupported'
  | 'caller_rejected';

export interface LocationScannerProps {
  open: boolean;
  onClose: () => void;
  /**
   * A location id was read. Return `false` to reject it and keep scanning — used to refuse a code
   * from another company, which decodes perfectly well but isn't one of yours.
   */
  onScan: (locationId: string) => boolean | void | Promise<boolean | void>;
  /**
   * A job traveler was read. Optional: surfaces where travelers are meaningful (the operator
   * tab-bar scanner) and omitted where they aren't, in which case a traveler scan is refused
   * with a legible message rather than silently ignored.
   */
  onScanTraveler?: (scan: { jobPartId: string }) => boolean | void | Promise<boolean | void>;
  /**
   * The company this scanner belongs to. When set, a label whose payload names a *different*
   * company is refused here and the handlers are never called.
   *
   * This is enforced in the component rather than left to each caller because the failure is
   * silent otherwise: a foreign traveler QR decodes perfectly, and a caller that just pushes the
   * route navigates the operator into another shop's job, relying on the destination page's RLS
   * to fail. That produces an error screen instead of "that isn't yours", and only after a
   * navigation.
   */
  expectedCompanyId?: string;
  title?: string;
  /**
   * Which surface opened the scanner. Analytics only — it is the property that lets the tab-bar
   * scanner and the count-session scanner be compared without becoming two event names.
   */
  surface: 'operator_tabbar' | 'inventory_count';
}

/**
 * The dialog shell.
 *
 * `ScannerView` is mounted **only while `open`**, which is what lets every piece of camera state
 * below start fresh on each opening. It used to live in this component and be reset by hand at the
 * top of the camera effect — `setTorchAvailable(false)` and friends — and that reset was
 * load-bearing: without it, a phone whose second stream had no torch would keep showing a torch
 * button from the first. Mounting solves it structurally instead, and nothing has to remember.
 */
export default function LocationScanner({
  open,
  onClose,
  title = 'Scan a label',
  ...rest
}: LocationScannerProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>{open && <ScannerView {...rest} />}</DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}

type ScannerViewProps = Omit<LocationScannerProps, 'open' | 'onClose' | 'title'>;

function ScannerView({
  onScan,
  onScanTraveler,
  expectedCompanyId,
  surface,
}: ScannerViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stoppedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<'starting' | 'scanning' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  /** When this scanning session began, and how many codes it has taken. Analytics only. */
  const openedAtRef = useRef(0);
  const scanCountRef = useRef(0);
  const torchUsedRef = useRef(false);

  /**
   * The scan callbacks, held in refs so they are NOT effect dependencies.
   *
   * They used to be in the deps list below, and callers pass inline arrow functions — the
   * operator layout does — which get a fresh identity on every parent render. That made *any*
   * re-render of the parent while this dialog was open tear the effect down and back up:
   * `stop()` releases every camera track, then `getUserMedia` starts over. On a phone that is a
   * visible black flash and a lost half-second of aiming, mid-scan.
   *
   * Fixed here rather than with `useCallback` at each call site, because then the component is
   * correct for every caller instead of correct only while each one remembers.
   */
  const onScanRef = useRef(onScan);
  const onScanTravelerRef = useRef(onScanTraveler);
  const expectedCompanyIdRef = useRef(expectedCompanyId);
  const surfaceRef = useRef(surface);
  useEffect(() => {
    onScanRef.current = onScan;
    onScanTravelerRef.current = onScanTraveler;
    expectedCompanyIdRef.current = expectedCompanyId;
    surfaceRef.current = surface;
  });

  const reject = useCallback((reason: RejectionReason, message: string) => {
    setRejected(message);
    posthog.capture('label scan rejected', { surface: surfaceRef.current, reason });
  }, []);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Releasing every track is what turns the camera indicator off. Leaving it on after the dialog
    // closes reads as the app watching you.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /**
   * Torch, where the device has one.
   *
   * Chrome on Android exposes it through `MediaStreamTrack.applyConstraints`; WebKit does not
   * implement the capability at all, so on iPhone the button never appears. Degrading silently is
   * the requirement — a torch button that does nothing on half the shop's phones is worse than no
   * button, because an operator in a dark aisle will tap it and conclude the app is broken.
   */
  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints(advancedConstraint({ torch: next }));
      setTorchOn(next);
      if (next) torchUsedRef.current = true;
    } catch {
      // The capability was advertised and the constraint still failed. Nothing to tell the operator
      // that they can act on, so drop the affordance rather than leave a dead button.
      setTorchAvailable(false);
    }
  }, [torchOn]);

  useEffect(() => {
    // Runs once per opening, because this component only exists while the dialog is open.
    openedAtRef.current = Date.now();
    posthog.capture('scanner opened', { surface: surfaceRef.current });

    (async () => {
      try {
        const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');
        prepareZXingModule({ overrides: { locateFile: () => WASM_PATH } });

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            // `environment` asks for the rear camera, which is the one pointed at a shelf.
            facingMode: 'environment',
            // `ideal`, not `exact`: a handset that cannot do 1080p should hand back its best
            // effort, not throw a OverconstrainedError and leave the operator with no scanner.
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (stoppedRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const track = stream.getVideoTracks()[0];
        const capabilities = track?.getCapabilities?.() as
          | (MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] })
          | undefined;

        if (capabilities?.torch) setTorchAvailable(true);

        // Continuous autofocus where the device admits to having it. A fixed-focus frame of a QR at
        // 20cm is the other half of why codes failed to read, and unlike resolution it cannot be
        // compensated for downstream.
        if (capabilities?.focusMode?.includes('continuous')) {
          await track
            .applyConstraints(advancedConstraint({ focusMode: 'continuous' }))
            .catch(() => {
              /* Advertised but refused. Nothing to do, and nothing worth telling anyone. */
            });
        }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        if (stoppedRef.current) return;
        setStatus('scanning');

        // One reused canvas: allocating a frame-sized buffer several times a second would churn the
        // GC on a phone for no reason.
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        /**
         * A code was read and the caller took it.
         *
         * `ms_to_decode` is measured from the dialog opening, and `scan_index` counts within the
         * session — so `scan_index = 1` is "how long does a scan take", which is the number worth
         * watching at Contour, and the rest describe the continuous-scan cadence a count session
         * actually runs at. Neither the id nor the name of the thing scanned is sent.
         */
        const accept = (kind: 'location' | 'traveler') => {
          setRejected(null);
          scanCountRef.current += 1;
          posthog.capture('label scanned', {
            surface: surfaceRef.current,
            kind,
            ms_to_decode: Date.now() - openedAtRef.current,
            scan_index: scanCountRef.current,
            torch_used: torchUsedRef.current,
          });
        };

        const scheduleNext = () => {
          if (stoppedRef.current) return;
          timerRef.current = setTimeout(tick, DECODE_FLOOR_MS);
        };

        const tick = async () => {
          if (stoppedRef.current || !ctx || video.readyState < 2) {
            scheduleNext();
            return;
          }
          try {
            // Crop to the centred square the reticle marks, at the sensor's own resolution. This is
            // the opposite of downscaling: the same number of pixels now covers a smaller piece of
            // the world, so a code inside the reticle is described by MORE pixels per module than
            // when the whole frame was decoded, and each decode is cheaper as well.
            const side = Math.floor(Math.min(video.videoWidth, video.videoHeight) * RETICLE_FRACTION);
            if (side <= 0) {
              scheduleNext();
              return;
            }
            const sx = Math.floor((video.videoWidth - side) / 2);
            const sy = Math.floor((video.videoHeight - side) / 2);
            canvas.width = side;
            canvas.height = side;
            ctx.drawImage(video, sx, sy, side, side, 0, 0, side, side);

            const results = await readBarcodes(ctx.getImageData(0, 0, side, side), {
              formats: ['QRCode'],
              // Left at its `true` default. The previous `false` was the single biggest decode
              // regression in this file.
              tryInvert: false,
              maxNumberOfSymbols: 1,
            });
            if (stoppedRef.current) return;

            const text = results[0]?.text;
            if (!text) return;

            const scan = parseJiggedScan(text);
            if (!scan) {
              reject('not_jigged', 'That code isn’t a Jigged label.');
              return;
            }

            // Whose label is it? Checked before either handler runs, so a foreign code never
            // becomes a navigation. The decision lives in `foreignCompanyRejection` because this
            // loop cannot run under jsdom, and a tenant boundary should not be untestable.
            const foreign = foreignCompanyRejection(scan, expectedCompanyIdRef.current);
            if (foreign) {
              reject('foreign_company', foreign);
              return;
            }

            // A traveler is only accepted where the caller can do something with one. Refusing
            // it out loud beats silently ignoring a code that decoded perfectly well — the
            // operator would just keep pointing the camera at it.
            if (scan.kind === 'traveler') {
              if (!onScanTravelerRef.current) {
                reject('traveler_unsupported', 'That’s a job traveler — scan a storage label here.');
                return;
              }
              const ok = await onScanTravelerRef.current({ jobPartId: scan.jobPartId });
              if (ok === false) {
                reject('caller_rejected', 'That traveler can’t be used here.');
                return;
              }
              accept('traveler');
              return;
            }

            const accepted = await onScanRef.current(scan.locationId);
            if (accepted === false) {
              /**
               * "Can't be used here", NOT "belongs to a different company" — which is what this
               * used to say and was wrong most of the time.
               *
               * A handler returning `false` means *the caller* can't accept this code, and the
               * count page's put-away picker returns it for three different reasons: the label
               * isn't a valid destination, it's the bin you're already standing at, or it's the
               * `Unassigned` bucket. Two of those are your own labels scanned by the right person,
               * so telling them it belongs to another company was a plain falsehood.
               *
               * The genuine wrong-company case is caught earlier by `foreignCompanyRejection`,
               * which owns that wording — so this path no longer needs to guess at a cause.
               */
              reject('caller_rejected', 'That label can’t be used here.');
              return;
            }
            accept('location');
          } catch (e) {
            // A single bad frame is normal — motion blur, bad light. Don't tear the scanner down.
            console.debug('scan frame failed', e);
          } finally {
            scheduleNext();
          }
        };

        tick();
      } catch (e) {
        if (stoppedRef.current) return;
        setStatus('error');
        // The failure is nearly always permission, and the fix is in browser settings — not
        // something a retry button can do, so say where to go.
        const denied =
          e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        setError(
          denied
            ? 'Camera access was blocked. Allow the camera for this site in your browser settings, then try again.'
            : e instanceof Error
              ? e.message
              : 'Could not start the camera.',
        );
      }
    })();

    return () => {
      stop();
    };
  }, [stop, reject]);

  if (status === 'error') return <Alert severity="error">{error}</Alert>;

  return (
    <>
            <Box
              sx={{
                position: 'relative',
                borderRadius: 1,
                overflow: 'hidden',
                bgcolor: 'common.black',
                aspectRatio: '1 / 1',
              }}
            >
              <Box
                component="video"
                ref={videoRef}
                muted
                playsInline
                sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              {/*
                The reticle is not decoration: it marks the region actually decoded, so an operator
                who frames the code inside it gets the full sensor resolution on the modules. An
                outline rather than a dimmed surround, because dimming the rest of the frame makes
                a dark aisle harder to aim in.
              */}
              {status === 'scanning' && (
                <Box
                  aria-hidden
                  sx={{
                    position: 'absolute',
                    top: `${((1 - RETICLE_FRACTION) / 2) * 100}%`,
                    left: `${((1 - RETICLE_FRACTION) / 2) * 100}%`,
                    width: `${RETICLE_FRACTION * 100}%`,
                    height: `${RETICLE_FRACTION * 100}%`,
                    border: '2px solid rgba(255,255,255,0.7)',
                    borderRadius: 1,
                    pointerEvents: 'none',
                  }}
                />
              )}
              {status === 'starting' && (
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <CircularProgress size={28} />
                </Box>
              )}
              {torchAvailable && (
                <Tooltip title={torchOn ? 'Turn the light off' : 'Turn the light on'}>
                  <IconButton
                    onClick={toggleTorch}
                    aria-label={torchOn ? 'Turn the light off' : 'Turn the light on'}
                    sx={{
                      position: 'absolute',
                      right: 8,
                      bottom: 8,
                      // Sized for a gloved thumb, and legible against whatever the camera sees.
                      minWidth: 56,
                      minHeight: 56,
                      bgcolor: 'rgba(0,0,0,0.55)',
                      color: 'common.white',
                      '&:hover': { bgcolor: 'rgba(0,0,0,0.7)' },
                    }}
                  >
                    {torchOn ? <FlashlightOnIcon /> : <FlashlightOffIcon />}
                  </IconButton>
                </Tooltip>
              )}
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              Hold the QR code inside the square. It scans on its own — keep going to work through
              several.
            </Typography>
      {rejected && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          {rejected}
        </Alert>
      )}
    </>
  );
}
