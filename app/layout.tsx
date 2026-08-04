import type { Metadata, Viewport } from "next";
import { DM_Sans, Space_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { ThemeProvider, AuthProvider } from "@/components/providers";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
});

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
});

/**
 * Viewport, declared rather than inherited.
 *
 * Next injects a default `width=device-width, initial-scale=1`, so the app was never shipping
 * unscaled — what was missing was *control*. Two things matter for the shop floor:
 *
 *  - `viewportFit: 'cover'` lets the layout reach under the iOS home indicator and notch, which is
 *    the precondition for the `env(safe-area-inset-*)` padding the operator bottom nav uses.
 *  - `themeColor` tints the browser chrome to match the app instead of leaving a pale bar above a
 *    dark UI.
 *
 * Deliberately NOT setting `maximumScale` or `userScalable: false`: pinch-zoom is an accessibility
 * affordance, and this audience is 50–60-year-old shop owners reading under fluorescent light.
 *
 * It has to live in THIS file. `app/operator/[companyId]/layout.tsx` is `'use client'`, so it
 * structurally cannot export viewport metadata.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#111439', // theme.palette.background.default
};

export const metadata: Metadata = {
  metadataBase: new URL('https://jigged.app'),
  title: {
    template: '%s | Jigged',
    default: 'Jigged — Manufacturing Operations System',
  },
  description:
    'A flexible data platform for small precision manufacturing shops. Real-time visibility, flexible inventory, and operators who actually log their work.',
  icons: {
    icon: '/icon.svg',
    // `.png` again, and this time it is the correct form — the inverse of what this comment used
    // to warn about. These were `ImageResponse` routes under `app/`, so the generated href had no
    // extension and `/apple-icon.png` 404'd. They are now real files in `public/`, so the
    // extension is required and the bare path is what 404s. Both facts were true; only one is now.
    apple: '/apple-icon.png',
  },
  /**
   * The home-screen caption, and nothing else.
   *
   * iOS reads `apple-mobile-web-app-title` for the Add to Home Screen label and prefers it over
   * both the manifest's `short_name` and `<title>`. With no such tag the sheet pre-fills from
   * `<title>`, which on the marketing home page resolves through the `%s | Jigged` template to
   * "Jigged — Your whole shop, in one place | Jigged" — a fine `<title>`, and a useless caption
   * under a 60px icon. `short_name: 'Jigged'` in `app/manifest.ts` covers Android; this covers iOS.
   *
   * **`capable: false` is load-bearing, not a spelled-out default.** Next resolves a missing
   * `capable` to `true` (`resolveAppleWebApp`), which emits `mobile-web-app-capable` and asks the
   * launcher to install standalone — precisely what `app/manifest.ts` declines to do via
   * `display: 'browser'` until the iOS camera-permission spike clears. Read the note there before
   * flipping either. `title` is emitted independently of `capable`, so this costs nothing.
   *
   * (Next also emits `apple-mobile-web-app-status-bar-style` unconditionally once this key exists.
   * It only applies in standalone, and `default` is what we'd pick anyway.)
   */
  appleWebApp: {
    title: 'Jigged',
    capable: false,
  },
  openGraph: {
    title: 'Jigged — Manufacturing Operations System',
    description:
      'The operations system built for small manufacturing shops. Track jobs, manage inventory, and empower your operators.',
    url: 'https://jigged.app',
    siteName: 'Jigged',
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Jigged — Manufacturing Operations System',
    description:
      'The operations system built for small manufacturing shops. Track jobs, manage inventory, and empower your operators.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${spaceMono.variable}`}>
      <body>
        <ThemeProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
