import type { MetadataRoute } from 'next';

/**
 * Web app manifest — so Jigged can be added to a shop-floor home screen.
 *
 * ## `display: 'browser'` is the load-bearing line, and it is deliberate
 *
 * `docs/modules/inventory.md` §5.10 records why an installed app must NOT run standalone yet: iOS
 * **does not persist camera permission for a standalone PWA**, which would make the in-app location
 * scanner ask again on every screen. A scanner that re-asks permission constantly is worse than
 * tapping a banner.
 *
 * §5.10's stated hedge was "drop `apple-mobile-web-app-capable` so the icon opens in Safari". **That
 * advice is obsolete.** Since iOS 16.4 Safari honours *this* manifest's `display` member for Add to
 * Home Screen, and the meta tag is the legacy mechanism it superseded — so omitting the tag while
 * setting `display: 'standalone'` would install standalone anyway and walk straight into the bug.
 * iOS also treats `standalone`, `fullscreen` and `minimal-ui` alike.
 *
 * ### Three corrections to the paragraph above, recorded 2026-08-02
 *
 * 1. **The bug this cites by number is the wrong one.** WebKit #185448 was RESOLVED FIXED in iOS
 *    13.4. The live issue is the separate permission-*persistence* one, still open, with nothing
 *    announced through Safari 27 beta. The concern is real; the citation was stale.
 * 2. **`display: 'browser'` no longer opts out on iOS 26+.** WebKit removed installability
 *    requirements entirely — "Open as Web App" defaults ON and the manifest cannot turn it off. So
 *    `navigator.standalone` is now true for some users and false for others on this same manifest,
 *    differing only by iOS version. **Never route on it.** It also means the camera defence is
 *    already partly lost on new handsets.
 * 3. **This value is not free.** Chrome's installability check requires `standalone`, `fullscreen`
 *    or `minimal-ui`, so `browser` costs Android installability *entirely* — no install prompt, no
 *    WebAPK, only a plain bookmark.
 *
 * There is also a stronger argument for `browser` than the camera one, which §5.10 never made: on
 * iOS a standalone home-screen web app has a **cookie jar separate from Safari**, and since iOS 14
 * the Camera app opens the *default* browser. Our session lives in cookies. Flip to standalone and
 * the icon is one session while every scanned traveler QR is another — the zero-tap traveler path
 * starts demanding a password.
 *
 * So flipping this to `'standalone'` remains the deliverable of §5.10's spike, not a tidy-up — but
 * the spike now has two questions, not one: does camera permission persist, *and* does the QR path
 * survive the session split. Answer both on the shop's actual handsets first.
 *
 * (Android has no such problem. This is a route handler, so it *could* branch on user-agent —
 * deliberately not done, because a UA-sniffing manifest is hard to test and easy to get subtly
 * wrong for one line of benefit.)
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Jigged — Manufacturing Operations System',
    short_name: 'Jigged',
    description:
      'Jobs, inventory and shop-floor status for small precision manufacturing shops.',
    // See the note above before changing this.
    display: 'browser',
    // `/launch` resolves the session server-side and redirects to the member's home before the
    // first paint. It must NOT be `/` — that is the marketing page, and iOS honours start_url over
    // whatever page the user installed from, so `/` meant every icon opened marketing and then
    // resolved the destination on the client. See app/launch/page.tsx.
    start_url: '/launch',
    // `id` defaults to `start_url`, so leaving it implicit means any future change to start_url
    // silently orphans every existing install (the icon becomes a dead app, and a reinstall is a
    // *different* app). Pinning it to '/' keeps the identity stable — including across the
    // start_url change above, which is why it is '/' and not '/launch'. Never change this value.
    id: '/',
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
