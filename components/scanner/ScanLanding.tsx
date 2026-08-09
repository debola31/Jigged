'use client';

/**
 * Where a QR scanned with the phone's **camera app** lands.
 *
 * `/T/{code}` and `/L/{code}` both render this. It does one thing: decode the code and hand off to
 * the operator sign-in carrying the destination. It deliberately does NOT read the database, check
 * a session, or know what a traveler is — a scan arrives unauthenticated more often than not, so
 * anything requiring RLS would fail here and have to be redone after login anyway.
 *
 * ## Why the routes are uppercase directories
 *
 * The printed URL is uppercase in full, because that is what keeps the payload inside the QR
 * alphanumeric charset and the code at version 4 (see `lib/jiggedScan.ts`). Next matches path
 * segments case-sensitively, so the directory has to be `T`, not `t`. `next.config.ts` rewrites the
 * lowercase spellings as insurance against a link handler that normalises case.
 *
 * ## Failure is a stop, not a guess
 *
 * A code that does not parse renders a plain refusal and navigates nowhere. Sending someone to a
 * jobs list because we could not read their sheet would look like the app working and leave them
 * wondering why they are in the wrong place.
 */
import { useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Link from 'next/link';

import { loginPassthroughUrl, parseJiggedScan, type JiggedScanKind } from '@/lib/jiggedScan';

export default function ScanLanding({ kind }: { kind: JiggedScanKind }) {
  const params = useParams();
  const router = useRouter();

  const code = typeof params.code === 'string' ? params.code : '';

  /**
   * Derived during render, not set from an effect.
   *
   * `parseJiggedScan` is pure and the code is already in hand, so whether this is one of our labels
   * is knowable on the first render. Routing it through `useState` + `useEffect` would render an
   * empty spinner, then re-render with the refusal — a flash of "loading" for a question that was
   * never asynchronous.
   *
   * Parsed from the path segment rather than `window.location.href`, so a stray query string
   * appended by a link handler cannot change what we decode.
   */
  const scan = useMemo(
    () => parseJiggedScan(`${kind === 'location' ? 'L' : 'T'}${code}`),
    [code, kind],
  );

  useEffect(() => {
    // The effect does only the thing an effect is for: talking to the router.
    if (scan) router.replace(loginPassthroughUrl(scan));
  }, [scan, router]);

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        px: 4,
        textAlign: 'center',
        bgcolor: 'background.default',
      }}
    >
      {!scan ? (
        <>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            That isn&apos;t a Jigged label
          </Typography>
          <Typography variant="body1" color="text.secondary">
            The code scanned, but it isn&apos;t one of ours — or it was damaged enough to read wrong.
            Try again, or open Jigged and use the scan button.
          </Typography>
          {/* Sized for a gloved thumb on a phone, per the operator surface rules. */}
          <Button
            component={Link}
            href="/login"
            variant="contained"
            size="large"
            sx={{ minHeight: 56, minWidth: 200, fontSize: '1.05rem' }}
          >
            Open Jigged
          </Button>
        </>
      ) : (
        <CircularProgress />
      )}
    </Box>
  );
}
