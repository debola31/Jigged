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
 * Note this does NOT check that the ids **exist** — it can't, being pure. Callers validate
 * against loaded data; see `LocationsManager`'s refusal of a decoded-but-foreign label.
 *
 * It *can* tell you whose label it is, though: the company is in the URL path our own
 * generators write. See `companyIdFromScan`.
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
 * Where a scanned Jigged code should take an operator.
 *
 * Pure, and deliberately extracted: this mapping also exists in `postLoginPath`
 * (`app/operator/[companyId]/login/page.tsx`), which is the path a code scanned with the phone's
 * *camera app* travels. The two must agree — they resolve the same piece of paper — and when the
 * in-app version was inline in the layout, nothing could compare them and nothing tested the one
 * behaviour that matters most.
 *
 * **The `operationId` branch is the load-bearing one.** Current traveller sheets encode only
 * `job + part`; older sheets still on the shop floor also encode `operation` and jump straight to
 * that step. Dropping it here would silently downgrade an old sheet to the traveller index —
 * making in-app scanning *worse* than the camera-app path those sheets were printed for.
 *
 * `postLoginPath` has not been switched over to this, on purpose: it accepts non-UUID ids and
 * routes a lone `?job=` to the jobs list, whereas `parseJiggedScan` refuses both. Unifying them
 * would change that behaviour, which is a separate decision from extracting the mapping.
 */
export function scanDestination(companyId: string, scan: JiggedScan): string {
  const base = `/operator/${companyId}`;
  if (scan.kind === 'location') return `${base}/inventory/locations/${scan.locationId}`;
  return scan.operationId
    ? `${base}/jobs/${scan.jobId}/parts/${scan.jobPartId}/operations/${scan.operationId}`
    : `${base}/jobs/${scan.jobId}/parts/${scan.jobPartId}`;
}

/**
 * Which company's label this is, from the `/operator/{companyId}/login` path our generators
 * write — or null for a bare UUID, a non-URL, or a URL that isn't shaped like one of ours.
 *
 * Deliberately a separate function rather than a field on `JiggedScan`: "what kind of code is
 * this" and "whose is it" are different questions, only some callers ask the second, and
 * widening the union's shape would have churned every strict equality assertion in its suite
 * for no gain.
 *
 * **Null means "can't tell", never "yours".** A caller must treat null as unverified rather
 * than as a pass — a bare typed UUID legitimately has no company in it.
 */
export function companyIdFromScan(text: string): string | null {
  let path: string;
  try {
    path = new URL(text.trim()).pathname;
  } catch {
    return null;
  }
  // `/operator/{companyId}/login` — the shape both `buildLocationScanUrl` and the traveler PDF
  // emit. Anything else is not one of our labels.
  const m = /^\/operator\/([^/]+)\/login\/?$/.exec(path);
  const candidate = m?.[1];
  return candidate && UUID_RE.test(candidate) ? candidate.toLowerCase() : null;
}

/**
 * The message to show when a decoded code belongs to a different company — or null to accept it.
 *
 * Pure and separate from the component because this is a tenant boundary, and the component's
 * decode loop cannot run in jsdom (no `getUserMedia`, no WASM), so logic left inside it is
 * untestable outside a browser. The choice of *which* message is part of the logic: an operator
 * holding a traveller and an operator holding a shelf label need to be told different things.
 *
 * **Absence is not a mismatch.** A payload with no company in it (a bare typed UUID) returns null
 * — unverified, to be caught by the caller's own data validation — rather than being refused. The
 * only rejection here is a positive disagreement between two known ids.
 */
export function foreignCompanyRejection(
  text: string,
  scan: JiggedScan,
  expectedCompanyId?: string,
): string | null {
  if (!expectedCompanyId) return null;
  const scanCompanyId = companyIdFromScan(text);
  if (!scanCompanyId) return null;
  if (scanCompanyId === expectedCompanyId.toLowerCase()) return null;
  return scan.kind === 'traveler'
    ? 'That traveler belongs to a different company.'
    : 'That label belongs to a different company.';
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
