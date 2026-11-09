import * as Sentry from '@sentry/nextjs';
import { isNetworkFailureError, toError } from '@/lib/supabaseErrors';

/**
 * Reports media that failed to load, and says whether it did. Not when the browser never reached the bucket
 * (offline, a dropped connection, the tab closed mid-download: Safari's `TypeError: Load failed`, Chrome's
 * `Failed to fetch`), which is no fault of the page: the same rule `shouldReportSupabaseError` applies, for the
 * thrown errors that never pass through it (docs/telemetry.md). The visitor is still told where it shows (the
 * shop's "couldn't be loaded"), and a realistic model that fails leaves its light one in place (Sentry
 * JAVASCRIPT-NEXTJS-3R). An answer from Storage, a 400 for a file not there, reports: that's a fault (3Q).
 */
export function reportLoadFailure(error: unknown, message: string): boolean {
  if (isNetworkFailureError(error)) return false;
  Sentry.captureException(toError(error, message));
  return true;
}
