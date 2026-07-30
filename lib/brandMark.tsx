/**
 * The Jigged mark, as one vector, for every generated icon.
 *
 * `app/apple-icon.tsx` had this inline, and the PWA manifest needs the same thing at 192, 512 and
 * 512-maskable. Duplicating the paths four times is how a brand mark quietly drifts between sizes,
 * so it lives here once and each route only chooses a canvas.
 *
 * Rendered at request time via `next/og`'s `ImageResponse` — which means **no binary icon assets in
 * the repo, and nothing upscaled**: `public/jigged-logo.png` is only 96×96, so a 512 built from it
 * would be visibly soft.
 */
import { ImageResponse } from 'next/og';

/** Brand colours, matching `app/icon.svg` and the design system. */
const INK = '#151520';
const AMBER = '#D4872A';
const STEEL = '#4682B4';
const TEAL = '#2BBCB3';

function Mark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="14" y="10" width="30" height="10" rx="2" fill={AMBER} />
      <rect x="30" y="10" width="10" height="32" rx="0" fill={STEEL} />
      <path d="M40 42 L40 54 L26 54 Q14 54 14 42 L24 42 Q30 42 30 48 L30 54" fill={TEAL} />
    </svg>
  );
}

export interface BrandIconOptions {
  size: number;
  /**
   * Fraction of the canvas the mark occupies.
   *
   * Android crops a `maskable` icon to its own shape — a circle on many launchers — and only the
   * inner ~80% is guaranteed to survive. A maskable icon therefore needs a *smaller* mark on a
   * full-bleed background; a normal icon can fill more of the canvas.
   */
  markRatio?: number;
  /** Rounded corners. Omitted for maskable, where the launcher supplies the shape. */
  rounded?: boolean;
}

/** One generated PNG icon. Each route is a one-liner over this. */
export function brandIconResponse({ size, markRatio = 0.78, rounded = true }: BrandIconOptions) {
  return new ImageResponse(
    (
      <div
        style={{
          width: size,
          height: size,
          background: INK,
          borderRadius: rounded ? size * 0.18 : 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Mark size={Math.round(size * markRatio)} />
      </div>
    ),
    { width: size, height: size },
  );
}
