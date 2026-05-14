/**
 * User-facing error message for failed imports.
 *
 * The backend uses `Conflicts detected. Set skip_conflicts=true ...` as its
 * 400 detail when execute_import re-validates and finds new conflicts. That
 * string mentions an internal API flag and should never reach end users; this
 * helper translates it into a friendlier message. All other detail strings
 * pass through unchanged.
 */
export function importErrorMessage(detail: unknown, fallback: string): string {
  const raw =
    typeof detail === 'string'
      ? detail
      : Array.isArray(detail)
        ? detail
            .map((d) =>
              d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d),
            )
            .join('; ')
        : detail
          ? JSON.stringify(detail)
          : fallback;

  if (raw.includes('skip_conflicts')) {
    return 'Additional conflicts were detected during import. Please go back and re-validate.';
  }
  return raw;
}
