// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

// Sentry is the error tracker; PostHog (below) is product analytics. They are
// deliberately NOT both capturing exceptions — see the `capture_exceptions` note.
//
// Why `enabled` exists: `pnpm dev` and the Playwright suite both run with
// NODE_ENV=development, and every error they produced was landing in the same
// queue as production. 90% of the issue list was our own test runs, which is why
// the alerts became ignorable. Vercel sets NODE_ENV=production for preview *and*
// production builds, so real deployments still report.
const SENTRY_ENABLED = process.env.NODE_ENV === "production";

Sentry.init({
  dsn: "https://1e2c30e3c17e4fd5720927727cd74c85@o4511011478503424.ingest.us.sentry.io/4511011480666112",

  enabled: SENTRY_ENABLED,

  // 10% of transactions, matching the server and edge configs. This was 1 (100%),
  // which is the quickest way to burn the free tier's monthly budget on a spike.
  tracesSampleRate: 0.1,
  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,

  // A mistyped password is not a bug. Sentry's custom inbound message filters are
  // a paid feature, so this is dropped client-side instead — strictly better, since
  // the event never leaves the browser and never counts against quota.
  //
  // `EmptyRanges` is injected by a Safari extension, not by us: the symbol appears in
  // zero files across the source tree, node_modules AND the built production bundle,
  // and the stack is a single frame with no filename caught by window.onerror. Sentry's
  // browser-extensions inbound filter misses it because the frame carries no
  // extension-scheme URL to match on.
  //
  // "Lock was stolen" is @supabase/auth-js's OWN recovery path working as designed:
  // when a token-refresh lock is orphaned (a component unmounts mid-refresh), the next
  // caller times out and re-acquires with `{ steal: true }`, which rejects the orphaned
  // holder. It arrives as an unhandled background rejection with no frames in our code
  // and no user-visible effect — AuthGuard's own handling of the same race is in
  // components/auth/AuthGuard.tsx. Filtering it removes a permanently non-actionable
  // issue (Sentry JAVASCRIPT-NEXTJS-H) rather than leaving it to retrain us to ignore
  // the queue, which is how this project got 55 stale issues in the first place.
  ignoreErrors: ["Invalid login credentials", "EmptyRanges", "Lock was stolen"],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

import posthog from "posthog-js";

// NEXT_PUBLIC_POSTHOG_HOST is deliberately not read: ingestion goes through our
// own origin via the `next.config.ts` rewrites, so `api_host` is the fixed "/ingest"
// path below. The wizard emitted a variable for it that nothing consumed.
//
// THE TOKEN IS THE ENVIRONMENT SWITCH, AND ITS ABSENCE IS THE NORMAL STATE.
// It is set in Vercel Production only — not Preview, not Development, and commented
// out in `.env.local` — so `pnpm dev`, the Playwright suite and preview deployments
// all no-op below. Same reasoning as SENTRY_ENABLED above, but it deliberately does
// NOT reuse `NODE_ENV`: Vercel builds previews with NODE_ENV=production, which is
// right for Sentry (a preview crash is a real crash) and wrong here (a preview
// pageview against seeded data is not a real user). PostHog's free plan caps you at
// one project, so there is no dev project to send this noise to instead.
//
// The wizard's console.error for a missing token is deliberately gone. It fired on
// every local page load, and it told you to configure the one thing we now leave
// unconfigured on purpose — an alert that is wrong by construction trains you to
// ignore the console, which is how the Sentry queue above went bad in the first place.
const posthogToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

if (posthogToken) {
  posthog.init(posthogToken, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-01-30",
    // capture_exceptions is deliberately OFF. Sentry is the error tracker and has
    // the grouping, breadcrumbs and source-map upload that make a solo triage queue
    // workable; PostHog's error tracking has no advanced grouping. Two trackers
    // means double ingest and two places to look during an incident. Turning this
    // on also makes PostHog source-map upload a hard requirement in CI — this is
    // what removes that work item.
    debug: process.env.NODE_ENV === "development",
  });
}
