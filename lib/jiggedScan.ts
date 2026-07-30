/**
 * One parser for every QR code Jigged prints.
 *
 * ## Why one
 *
 * There are exactly two kinds of Jigged QR, and both are deep links through the operator
 * login passthrough, differing only in query string:
 *
 * - **A location label** — `buildLocationScanUrl` in `utils/locationLabelPdf.ts`:
 *   `/operator/{companyId}/login?location={uuid}`
 * - **A job traveler** — `utils/jobTravelerPdf.ts`:
 *   `/operator/{companyId}/login?job={jobId}&part={jobPartId}`
 *
 * The scanner used to read only the first, which meant an operator holding a traveler sheet
 * had to leave the app and use the phone's camera app instead — a different gesture for a
 * near-identical piece of paper. One scanner that resolves either is why this exists.
 *
 * **Parts have no barcode at all.** "Scan a part" is not a thing that exists in this system
 * and nothing here should imply otherwise. Vendor barcodes on incoming material are foreign
 * symbologies we don't control — a receiving concern (J6, Phase 3), not this.
 *
 * ## Why it refuses things
 *
 * Silently treating a foreign code as one of ours would send someone to a location or a job
 * that doesn't exist, which is worse than saying "that isn't a Jigged label". So anything
 * that isn't unambiguously one of the two shapes returns null, and the caller says so.
 *
 * Note this does NOT check that the ids exist, or that they belong to your company — it
 * can't, being pure. Callers validate against loaded data; see `LocationsManager`'s refusal
 * of a decoded-but-foreign label.
 */

/** Canonical v4-ish UUID shape. Anchored: a UUID embedded in a longer string is not a match. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type JiggedScan =
  /** A printed location label, or a bare location UUID typed/wedged in. */
  | { kind: 'location'; locationId: string }
  /**
   * A job traveler sheet. Both job and part are required — one without the other is not a
   * traveler and can't open anything.
   *
   * `operationId` is present only on **older travelers still in circulation on the shop
   * floor**, which encoded `job + part + operation` and jumped straight to that step's action
   * view. Current sheets deliberately omit it so the operator picks the step. Carrying it
   * matters: dropping it would silently downgrade an old sheet to the traveler index, which is
   * a worse outcome than the camera-app path those sheets were printed for.
   */
  | { kind: 'traveler'; jobId: string; jobPartId: string; operationId?: string };

/** A UUID query param, lowercased, or null if absent or malformed. */
function uuidParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  return raw && UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

/**
 * Resolve a scanned string into whichever kind of Jigged code it is, or null.
 *
 * Accepts a full scan URL (what the printed labels encode) or a bare location UUID, so a
 * keyboard-wedge scanner and a hand-typed code both work.
 */
export function parseJiggedScan(text: string): JiggedScan | null {
  const trimmed = text.trim();

  // A bare UUID is only ever a location: a traveler needs two ids, so it can't be expressed
  // this way, and guessing between them would be a coin flip.
  if (UUID_RE.test(trimmed)) {
    return { kind: 'location', locationId: trimmed.toLowerCase() };
  }

  let params: URLSearchParams;
  try {
    params = new URL(trimmed).searchParams;
  } catch {
    // Not a URL and not a bare UUID — a shipping label, a vendor barcode, a URL from another
    // system.
    return null;
  }

  // Location is checked FIRST so that a URL somehow carrying both shapes resolves the same way
  // it always has. Our labels never emit both, so this only matters for malformed input — and
  // "behaves as before" beats "newly refuses" for something nobody can produce deliberately.
  const locationId = uuidParam(params, 'location');
  if (locationId) return { kind: 'location', locationId };

  // Both or neither: a job id without a part id can't open a traveler, so it isn't one.
  const jobId = uuidParam(params, 'job');
  const jobPartId = uuidParam(params, 'part');
  if (jobId && jobPartId) {
    const operationId = uuidParam(params, 'operation');
    // Omit the key entirely rather than setting it undefined, so an equality assertion on a
    // current-sheet scan doesn't have to know about a field only old sheets carry.
    return operationId
      ? { kind: 'traveler', jobId, jobPartId, operationId }
      : { kind: 'traveler', jobId, jobPartId };
  }

  return null;
}

/**
 * Location-only view of `parseJiggedScan`, kept because most callers only care about places
 * and shouldn't have to narrow a union to say so. A traveler scan returns null here, which is
 * exactly what this function did before it was a wrapper.
 */
export function locationIdFromScan(text: string): string | null {
  const scan = parseJiggedScan(text);
  return scan?.kind === 'location' ? scan.locationId : null;
}
