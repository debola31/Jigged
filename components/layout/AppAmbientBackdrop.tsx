'use client';

import Box from '@mui/material/Box';

/**
 * The app workspace canvas.
 *
 * The dashboard went flat when we darkened the global background to fix a contrast bug
 * (white text on the old steel `#4682B4` = 4.11:1). But that bug was specifically text
 * sitting DIRECTLY on the steel — now that cards are opaque, the canvas itself can be a
 * rich, lit steel-indigo again, as long as its lightest point stays under the failure
 * threshold. The base stops stay dark enough that grey secondary labels on the bare
 * canvas keep ~5.9:1; the extra brightness is concentrated in the top-right steel bloom,
 * which tops out ~`#426289` (white ≈ 6.4:1) — and that corner carries white text/icons
 * only, so text clears WCAG AA everywhere it actually lands.
 *
 * Deliberately 2D — a top-lit gradient plus soft brand auroras (steel off the top-right,
 * teal off the bottom-left), no literal 3D scene: concrete objects behind live data read
 * as distracting the same way a video would. Auroras fade to zero-alpha (never
 * `transparent`, which bands a lighter grey mid-fade).
 *
 * Painted opaque and `position: fixed` so it becomes the app's own canvas over the dark
 * global theme base — the marketing pages keep that dark base. `aria-hidden` +
 * `pointer-events: none`: purely decorative, never intercepts input.
 */
export default function AppAmbientBackdrop() {
  return (
    <Box
      aria-hidden
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        background: `
          radial-gradient(78% 58% at 88% -6%, rgba(88, 148, 198, 0.32), rgba(88, 148, 198, 0) 66%),
          radial-gradient(55% 52% at 0% 100%, rgba(43, 188, 179, 0.12), rgba(43, 188, 179, 0) 70%),
          linear-gradient(158deg, #344668 0%, #232d58 46%, #181f45 100%)
        `,
      }}
    />
  );
}
