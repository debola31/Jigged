/**
 * The Jigged mark, as one vector. THE SOURCE FOR THE STATIC ICONS, not a live code path.
 *
 * Nothing imports this today, and that is deliberate rather than an oversight. It used to back
 * four `ImageResponse` routes (`app/apple-icon.tsx`, `app/icon-192|512|maskable/route.tsx`) that
 * rendered these icons on request. Those routes are gone: every route under `app/` is a Serverless
 * Function, the Hobby plan caps a deployment at 12, and five icon routes were most of that budget
 * while returning bytes that never change. The icons now sit in `public/` as files.
 *
 * This file survives the deletion because otherwise those PNGs become opaque binaries nobody can
 * reproduce. It is the recipe. **If the mark changes, re-render from here rather than editing
 * pixels** — temporarily reinstate a route that calls `brandIconResponse`, fetch
 * `/icon-192`, `/icon-512`, `/icon-maskable` and `/apple-icon`, save them into `public/` with a
 * `.png` extension, then remove the route again.
 *
 * The original rationale for generating them still holds and is why nothing here is derived from
 * `public/jigged-logo.png`: that file is 96×96, so a 512 built from it would be visibly soft. The
 * committed PNGs were captured from these routes in production, at full size, before removal.
 */
import { ImageResponse } from 'next/og';

/** Brand colours, matching `public/icon.svg` and the design system. */
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
