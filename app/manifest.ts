import type { MetadataRoute } from 'next';

/**
 * Web app manifest — so Jigged can be added to a shop-floor home screen.
 *
 * ## `display: 'browser'` is the load-bearing line, and it is deliberate
 *
 * `docs/modules/inventory.md` §5.10 records why an installed app must NOT run standalone yet: iOS
 * **does not persist camera permission for a standalone PWA** and Safari re-prompts on route
 * navigation at the same origin ([WebKit #185448]), which would make the in-app location scanner
 * ask again on every screen. A scanner that re-asks permission constantly is worse than tapping a
 * banner.
 *
 * §5.10's stated hedge was "drop `apple-mobile-web-app-capable` so the icon opens in Safari". **That
 * advice is obsolete.** Since iOS 16.4 Safari honours *this* manifest's `display` member for Add to
 * Home Screen, and the meta tag is the legacy mechanism it superseded — so omitting the tag while
 * setting `display: 'standalone'` would install standalone anyway and walk straight into the bug.
 * iOS also treats `standalone`, `fullscreen` and `minimal-ui` alike; **`browser` is the only value
 * that keeps the icon opening in Safari.**
 *
 * So flipping this to `'standalone'` is the concrete deliverable of §5.10's spike, not a tidy-up:
 * the spike's question is *"does camera permission persist across navigations in standalone mode on
 * current iOS?"*, and this line is what it gates. Answer it on the shop's actual handsets first.
 *
 * (Android has no such problem, and would tolerate standalone. This is a route handler, so it
 * *could* branch on user-agent — deliberately not done, because a UA-sniffing manifest is hard to
 * test and easy to get subtly wrong for one line of benefit.)
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Jigged — Manufacturing Operations System',
    short_name: 'Jigged',
    description:
      'Jobs, inventory and shop-floor status for small precision manufacturing shops.',
    // See the note above before changing this.
    display: 'browser',
    // The operator surface is where a home-screen icon earns its place: it's the only part of the
    // app designed for a phone, and it's what a scanned QR label opens.
    start_url: '/',
    scope: '/',
    background_color: '#111439', // theme.palette.background.default
    theme_color: '#111439',
    orientation: 'any', // job details are deliberately usable in landscape on a tablet
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      // Rendered at request time from the same vector as `app/apple-icon.tsx`, so there are no
      // binary assets to keep in sync and nothing upscaled from the 96px logo.
      { src: '/icon-192', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512', sizes: '512x512', type: 'image/png' },
      // `maskable` lets Android crop to its own shape without clipping the mark; it needs the
      // safe-zone padding that `icon-maskable` builds in.
      { src: '/icon-maskable', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
