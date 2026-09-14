// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { applySupabaseEventPolicy, GENERIC_MULTIPART_POST_E975 } from "@/lib/sentryEventPolicy";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Don't report from `pnpm dev` or the local E2E run — see instrumentation-client.ts
  // for why. Vercel builds (preview and production) set NODE_ENV=production.
  enabled: process.env.NODE_ENV === "production",

  // Performance monitoring: sample 10% of transactions to stay within free tier limits
  tracesSampleRate: 0.1,

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,

  // Next E975 — scanner traffic, not a user. A generic multipart POST at a page that owns a
  // server action makes Next throw and 500; this app's only action is called as a fetch action
  // and cannot produce one. The reason, the sibling error this must NOT catch, and why the
  // browser and edge configs are left alone: docs/telemetry.md § "`ignoreErrors` — what's
  // filtered and why". Pinned by __tests__/lib/serverActionSkewFilter.test.ts.
  //
  // Server only, on purpose. `sentry.edge.config.ts` stays without an `ignoreErrors`: Next's edge
  // branch throws the identical error, but no app route here runs on the edge runtime
  // (`app/opengraph-image.tsx` is a GET metadata route, and there is no middleware.ts), so the
  // same entry there would be a filter that cannot fire — which reads as protection and is not.
  ignoreErrors: [GENERIC_MULTIPART_POST_E975],

  // Same Supabase-capture policy as the browser — see lib/sentryEventPolicy.ts.
  //
  // The rpc branch is effectively inert here: only the browser client stamps the rpc span
  // attribute (in its own `fetch`), and server-side rpc calls have no access-layer helper to
  // report them instead — `utils/*Access.ts` is browser code. So a route handler's failed rpc
  // is captured by the net, which is the correct outcome rather than a gap.
  beforeSend: applySupabaseEventPolicy,
});
