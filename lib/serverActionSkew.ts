import * as Sentry from '@sentry/nextjs';
import { unstable_isUnrecognizedActionError } from 'next/navigation';

/**
 * Deployment skew on the one server action this app has, and why it gets its own path.
 *
 * `submitWaitlist` is called as a *fetch* action — `await`ed from a click handler, so React sends
 * a `Next-Action` header carrying an id minted by the build the browser loaded. Deploy again and
 * that id is gone: the server answers 404 with `x-nextjs-action-not-found` and only `console.warn`s
 * (`next/dist/server/app-render/action-handler.js`, `handleUnrecognizedFetchAction`), so **nothing
 * reaches Sentry from the server**. The browser turns that 404 into `UnrecognizedActionError`
 * ("Server Action "<id>" was not found on the server.", E715) and rejects the promise.
 *
 * Before this existed, both forms collapsed that into "Something went wrong. Email us at
 * hello@jigged.app" and reported it at `level: 'warning'` — medium priority, which never pages. A
 * prospect was blocked by a deploy that happened while they were typing, they saw a dead end, and
 * we never found out. That is the gap this closes.
 *
 * Do NOT confuse this with the scanner error filtered in `sentry.server.config.ts`: that one is
 * Next **E975**, thrown for a generic multipart POST that carries no `Next-Action` header at all,
 * and no browser of ours can send it. See `GENERIC_MULTIPART_POST_E975` in `lib/sentryEventPolicy.ts`.
 *
 * The only cure is a reload — the stale action id is baked into the JS already running, so
 * resubmitting reuses it and fails identically.
 */
export const SKEW_ALERT_MESSAGE =
  'We just shipped an update, so this form is out of date. Refresh and send it again.';

export const GENERIC_ALERT_MESSAGE = 'Something went wrong. Email us at hello@jigged.app';

/**
 * Report a failed waitlist submit and say whether it was deployment skew.
 *
 * Skew reports at `error` level ON PURPOSE: it means a real prospect was blocked and could not
 * submit, which is worth paging for. Everything else stays `warning`, as it was.
 *
 * @param source which surface submitted, matching the `source` column on `waitlist`
 * @returns true when the caller should show the refresh affordance instead of the generic error
 */
export function reportWaitlistSubmitFailure(err: unknown, source: string): boolean {
  const isSkew = unstable_isUnrecognizedActionError(err);

  Sentry.captureException(err, {
    level: isSkew ? 'error' : 'warning',
    tags: { waitlist_failure: isSkew ? 'deployment_skew' : 'unknown' },
    extra: { source },
  });

  return isSkew;
}
