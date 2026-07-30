'use client';

/**
 * An in-app scanner for Jigged's own location labels.
 *
 * ## What it scans, and what it deliberately doesn't
 *
 * **Places, not parts.** The only QR codes in the system encode a location
 * (`buildLocationScanUrl` → `/operator/{co}/login?location={uuid}`) or a job traveler. Parts have no
 * barcode at all, so "scan a part" is not a thing that exists and this must not imply otherwise.
 * Vendor barcodes on incoming material are foreign symbologies we don't control — a receiving
 * concern (J6, Phase 3), not this.
 *
 * ## Why it exists at all
 *
 * Today every scan leaves the browser: the phone's camera app surfaces an OS banner, you tap it,
 * you land on the login route, and it redirects. `inventory.md` §5.10 measures the cost — *"ten
 * scans mean ten camera-app round trips"* — and names the flows that can't be served that way:
 * a count session and receiving a pallet, both continuous. In-app, an already-authenticated
 * operator goes straight to the bin with no interstitial.
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
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

/** Where `scripts/copy-scanner-wasm.mjs` puts the decoder, so it loads from our origin not a CDN. */
const WASM_PATH = '/wasm/zxing_reader.wasm';

/** ~5 decode attempts a second: fast enough to feel instant, slow enough not to pin a phone CPU. */
const DECODE_INTERVAL_MS = 200;

/**
 * Parsing moved to `lib/jiggedScan.ts`, which resolves BOTH kinds of Jigged QR — a location
 * label and a job traveler — because they differ only by query string and an operator holding
 * a traveler sheet shouldn't need a different gesture from one holding a bin label.
 *
 * Re-exported here so existing importers and their test suite are untouched.
 */
import { parseJiggedScan } from '@/lib/jiggedScan';

export { locationIdFromScan, parseJiggedScan, type JiggedScan } from '@/lib/jiggedScan';

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
  onScanTraveler?: (scan: {
    jobId: string;
    jobPartId: string;
    /** Present only on older travelers, which target a specific step. */
    operationId?: string;
  }) => boolean | void | Promise<boolean | void>;
  title?: string;
}

export default function LocationScanner({
  open,
  onClose,
  onScan,
  onScanTraveler,
  title = 'Scan a label',
}: LocationScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Guards against a second decode firing while the first is still being handled. */
  const busyRef = useRef(false);

  const [status, setStatus] = useState<'starting' | 'scanning' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // Releasing every track is what turns the camera indicator off. Leaving it on after the dialog
    // closes reads as the app watching you.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      try {
        const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');
        prepareZXingModule({ overrides: { locateFile: () => WASM_PATH } });

        const stream = await navigator.mediaDevices.getUserMedia({
          // `environment` asks for the rear camera, which is the one pointed at a shelf.
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        if (cancelled) return;
        setStatus('scanning');

        // One reused canvas: allocating a frame-sized buffer 5×/second would churn the GC on a
        // phone for no reason.
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        timerRef.current = setInterval(async () => {
          if (busyRef.current || !ctx || video.readyState < 2) return;
          busyRef.current = true;
          try {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const results = await readBarcodes(
              ctx.getImageData(0, 0, canvas.width, canvas.height),
              { formats: ['QRCode'], tryHarder: false, maxNumberOfSymbols: 1 },
            );
            const text = results[0]?.text;
            if (!text) return;

            const scan = parseJiggedScan(text);
            if (!scan) {
              setRejected('That code isn’t a Jigged label.');
              return;
            }

            // A traveler is only accepted where the caller can do something with one. Refusing
            // it out loud beats silently ignoring a code that decoded perfectly well — the
            // operator would just keep pointing the camera at it.
            if (scan.kind === 'traveler') {
              if (!onScanTraveler) {
                setRejected('That’s a job traveler — scan a storage label here.');
                return;
              }
              const ok = await onScanTraveler({
                jobId: scan.jobId,
                jobPartId: scan.jobPartId,
                operationId: scan.operationId,
              });
              if (ok === false) {
                setRejected('That traveler belongs to a different company.');
                return;
              }
              setRejected(null);
              return;
            }

            const accepted = await onScan(scan.locationId);
            if (accepted === false) {
              setRejected('That label belongs to a different company.');
              return;
            }
            setRejected(null);
          } catch (e) {
            // A single bad frame is normal — motion blur, bad light. Don't tear the scanner down.
            console.debug('scan frame failed', e);
          } finally {
            busyRef.current = false;
          }
        }, DECODE_INTERVAL_MS);
      } catch (e) {
        if (cancelled) return;
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
      cancelled = true;
      stop();
    };
  }, [open, onScan, onScanTraveler, stop]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {status === 'error' ? (
          <Alert severity="error">{error}</Alert>
        ) : (
          <>
            <Box
              sx={{
                position: 'relative',
                borderRadius: 1,
                overflow: 'hidden',
                bgcolor: 'common.black',
                aspectRatio: '4 / 3',
              }}
            >
              <Box
                component="video"
                ref={videoRef}
                muted
                playsInline
                sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
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
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              Point the camera at the QR code on a printed label. It scans on its own — keep going
              to work through several.
            </Typography>
            {rejected && (
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                {rejected}
              </Alert>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
