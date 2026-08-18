import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `/legal/privacy.html` was the live URL of the privacy policy before it was
  // versioned to `/legal/privacy/v1.html`. Nothing inside the repo referenced
  // it, and it was never published in outreach email or an external listing --
  // so this is belt and braces rather than a known-broken link. Permanent,
  // because the document did not move temporarily.
  async redirects() {
    return [
      { source: '/legal/privacy.html', destination: '/privacy', permanent: true },
    ];
  },

  async rewrites() {
    return [
      // Printed QR codes encode an all-uppercase URL — that is what keeps the payload in QR
      // alphanumeric mode and the code at version 4 (see lib/jiggedScan.ts). Next matches path
      // segments case-sensitively, so the real routes are `app/T` and `app/L`. These two rewrites
      // are insurance: if any OS link handler or scanner ever normalises a path to lowercase, the
      // sticker on the shelf still resolves instead of 404ing years after it was printed.
      { source: "/t/:code", destination: "/T/:code" },
      { source: "/l/:code", destination: "/L/:code" },
      {
        source: "/api/:path*",
        destination:
          process.env.NODE_ENV === "development"
            ? "http://127.0.0.1:8000/api/:path*"
            : "/api/",
      },
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://us-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "jigged",

  project: "javascript-nextjs",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
