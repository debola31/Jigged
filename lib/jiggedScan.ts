/**
 * The scan scheme: one module that both WRITES and READS every QR code Jigged prints.
 *
 * ## The shape, and why it looks like this
 *
 * ```
 * Traveler   HTTPS://WWW.JIGGED.APP/T/{company32}{jobPart32}
 * Location   HTTPS://WWW.JIGGED.APP/L/{company32}{location32}
 * ```
 *
 * 77 characters, which puts a traveler at QR **version 4** (33×33) at error correction M and a
 * location label at **version 6** (41×41) at H. The codes this replaced were version 8 and version
 * **10** — a Contour operator spent 30+ seconds failing to scan a traveler off *fresh* paper, and
 * `jobTravelerPdf`'s `QR_SIZE` comment had already diagnosed it: payload length drives module
 * density, so shorten the URL rather than enlarge the code.
 *
 * Three things buy those versions, and all three are load-bearing:
 *
 * 1. **Every character is inside the QR alphanumeric charset** (`0-9 A-Z $%*+-./:` and space).
 *    Alphanumeric mode packs two characters into 11 bits where byte mode spends 8 bits on each, so
 *    the whole payload costs ~45% less. This is why the URL is UPPERCASE — schemes and hosts are
 *    case-insensitive, and base32's alphabet is uppercase already. `qrcode` picks the mode per
 *    segment, so lowercase does not fall off a cliff; it just quietly costs a version, which on a
 *    location label is 9% of module size. `__tests__/utils/qrVersionCeiling.test.ts` fails CI if
 *    either creeps back.
 * 2. **UUIDs are base32, not hex.** 16 bytes → 26 characters instead of 36, twice over.
 * 3. **A traveler carries `job_part_id` only, not `job_id` too.** Three UUIDs would be 103
 *    characters and version 5. `getJobPartTraveler(jobPartId, companyId)` never needed the job id,
 *    so the traveler route dropped its `/jobs/{jobId}` segment rather than the payload growing.
 *
 * ## Why the company id is still in there
 *
 * The obvious shortening — `/t/{jobPartId}` — hits version 4 by dropping the company, which would
 * delete the offline cross-tenant check with it. Base32 buys the same version *and keeps it*, so a
 * foreign shop's label is still refused before any navigation, with no network round trip. Every
 * code now carries a company, which is why `JiggedScan` has a `companyId` field and
 * `foreignCompanyRejection` no longer has an "absence is not a mismatch" case to reason about.
 *
 * ## Why one module
 *
 * The URL builder used to live in `utils/locationLabelPdf.ts` while the parser lived here, and the
 * destination mapping existed TWICE — once in `scanDestination` and once, by hand, in the operator
 * login page's `postLoginPath`. A comment admitted the two had to agree and that nothing checked
 * it. Now the landing route computes the destination once, and the login page only validates and
 * replays it (`safeNextPath`). Write, read and route are one file that its own tests cover.
 *
 * ## What it refuses
 *
 * Anything that isn't unambiguously one of the two shapes returns null, and the caller says so.
 * Silently treating a foreign code as one of ours would send someone to a location or a job that
 * doesn't exist, which is worse than "that isn't a Jigged label".
 *
 * Note this does NOT check that the ids **exist** — it can't, being pure. Callers validate against
 * loaded data; see `LocationsManager`'s refusal of a decoded-but-foreign label.
 *
 * **Parts have no barcode at all.** "Scan a part" is not a thing that exists in this system and
 * nothing here should imply otherwise. Vendor barcodes on incoming material are foreign symbologies
 * we don't control — a receiving concern (J6, Phase 3), not this.
 */

import { isUuid } from './validators';

/**
 * RFC 4648 base32. Uppercase A–Z and 2–7, every one of which is in the QR alphanumeric charset.
 *
 * Not Crockford, whose alphabet includes `0` and `1`: nobody reads these aloud or types them, so
 * transcription-friendliness buys nothing, and RFC 4648 is what every other implementation means
 * by "base32".
 */
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32_INDEX: Record<string, number> = Object.fromEntries(
  [...B32_ALPHABET].map((c, i) => [c, i]),
);

/** A UUID is 128 bits, which is 25.6 base32 characters — so 26, with 2 bits of zero padding. */
export const UUID_B32_LENGTH = 26;

/**
 * A UUID's 16 bytes as 26 uppercase base32 characters, unpadded.
 *
 * Unpadded because the length is fixed and known: standard base32 would append six `=`, and `=` is
 * not in the QR alphanumeric charset, so padding would cost six characters AND the mode that makes
 * the whole scheme work.
 */
export function uuidToBase32(uuid: string): string {
  // `isUuid` is the shared validator from `lib/validators` rather than a regex of our own. This
  // file had a private copy until they collided in review; one definition of "is this a UUID" is
  // worth more than a local one, and the fix that introduced it landed for exactly this reason.
  if (!isUuid(uuid)) throw new Error(`Not a UUID: ${uuid}`);
  const hex = uuid.replace(/-/g, '');

  let bits = '';
  for (let i = 0; i < 32; i += 2) bits += parseInt(hex.slice(i, i + 2), 16).toString(2).padStart(8, '0');
  // 128 bits -> 130, so the final 5-bit group is whole. The 2 extra bits are zero, and `base32ToUuid`
  // insists on that — see below.
  bits = bits.padEnd(130, '0');

  let out = '';
  for (let i = 0; i < 130; i += 5) out += B32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

/**
 * The inverse, or null if `code` is not 26 valid base32 characters.
 *
 * **Rejects a non-zero pad**, which is the part worth keeping. Without that check, 4 distinct codes
 * decode to each UUID (the last character carries 3 real bits and 2 free ones), so the encoding
 * stops being injective and a scan could be "valid" in four spellings — one of which some future
 * comparison would treat as different from the one we printed.
 */
export function base32ToUuid(code: string): string | null {
  if (code.length !== UUID_B32_LENGTH) return null;

  let bits = '';
  for (const ch of code) {
    const v = B32_INDEX[ch];
    if (v === undefined) return null;
    bits += v.toString(2).padStart(5, '0');
  }

  if (bits.slice(128) !== '00') return null;

  let hex = '';
  for (let i = 0; i < 128; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** The path segment that says which kind of thing a code points at. */
const KIND_SEGMENT = { traveler: 'T', location: 'L' } as const;

export type JiggedScanKind = keyof typeof KIND_SEGMENT;

export type JiggedScan =
  /** A printed location label — a shelf, bin or cabinet. */
  | { kind: 'location'; companyId: string; locationId: string }
  /**
   * A job traveler sheet.
   *
   * `jobPartId` alone, deliberately: the job id is derivable and carrying it would have cost a QR
   * version. The traveler route takes only this.
   */
  | { kind: 'traveler'; companyId: string; jobPartId: string };

/**
 * Where printed codes point.
 *
 * `window.location.origin` is the fallback rather than the rule, because a label printed from a
 * preview deployment would otherwise encode that preview's hostname **forever** — the sticker
 * outlives the deployment by years. Production sets `NEXT_PUBLIC_SCAN_ORIGIN`; Preview deliberately
 * leaves it unset so preview labels stay self-consistent for testing.
 *
 * `NEXT_PUBLIC_*` is inlined at build time, so changing it in Vercel requires a redeploy to take.
 */
export function scanOrigin(): string {
  const pinned = process.env.NEXT_PUBLIC_SCAN_ORIGIN?.trim();
  if (pinned) return pinned.replace(/\/+$/, '');
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/**
 * The string a printed QR encodes. **Uppercased in full** — see the header; this is what buys
 * version 4 / version 6, and lowercasing any part of it silently costs a version.
 */
export function buildScanUrl(scan: JiggedScan, origin: string = scanOrigin()): string {
  const entityId = scan.kind === 'location' ? scan.locationId : scan.jobPartId;
  const code = uuidToBase32(scan.companyId) + uuidToBase32(entityId);
  // Trailing slashes are stripped here as well as in `scanOrigin`, because callers pass an origin
  // directly too — and `//T/` would be a different path, silently, on the one string we cannot fix
  // after it is printed.
  return `${origin.replace(/\/+$/, '')}/${KIND_SEGMENT[scan.kind]}/${code}`.toUpperCase();
}

/** Split a `{company32}{entity32}` code into two UUIDs, or null if either half is malformed. */
function decodeCode(code: string): { companyId: string; entityId: string } | null {
  if (code.length !== UUID_B32_LENGTH * 2) return null;
  const companyId = base32ToUuid(code.slice(0, UUID_B32_LENGTH));
  const entityId = base32ToUuid(code.slice(UUID_B32_LENGTH));
  return companyId && entityId ? { companyId, entityId } : null;
}

function toScan(kindSegment: string, code: string): JiggedScan | null {
  const parts = decodeCode(code);
  if (!parts) return null;
  if (kindSegment === KIND_SEGMENT.location) {
    return { kind: 'location', companyId: parts.companyId, locationId: parts.entityId };
  }
  if (kindSegment === KIND_SEGMENT.traveler) {
    return { kind: 'traveler', companyId: parts.companyId, jobPartId: parts.entityId };
  }
  return null;
}

/**
 * Resolve a scanned string into whichever kind of Jigged code it is, or null.
 *
 * Accepts either container:
 *   - the full URL a printed label encodes, which is what a camera decodes;
 *   - the bare `T…`/`L…` code, which is what a keyboard-wedge scanner or a retyped label carries.
 *
 * The bare form REPLACED "a bare UUID is always a location", which was accepted before this
 * scheme. Nothing printed ever produced a bare UUID and no surface accepts a typed one, whereas a
 * bare code still carries its company — so the tenant check survives a wedge scan, which it could
 * not before.
 *
 * Pure, and case-insensitive on input even though we always emit uppercase: some scanners and
 * link handlers normalise case, and refusing our own label because a phone lowercased the path
 * would be an absurd way to fail.
 */
export function parseJiggedScan(text: string): JiggedScan | null {
  const trimmed = text.trim().toUpperCase();

  // Bare code: one kind letter, then two base32 UUIDs.
  const bare = /^([TL])([A-Z2-7]{52})$/.exec(trimmed);
  if (bare) return toScan(bare[1], bare[2]);

  let path: string;
  try {
    path = new URL(trimmed).pathname;
  } catch {
    // Not a URL and not a bare code — a shipping label, a vendor barcode, a URL from another system.
    return null;
  }

  const m = /^\/([TL])\/([A-Z2-7]{52})\/?$/.exec(path);
  return m ? toScan(m[1], m[2]) : null;
}

/**
 * Where a scanned Jigged code should take an operator. Pure, synchronous, and the ONLY copy of this
 * mapping — the login passthrough replays what this produced rather than deriving it again.
 *
 * The traveler destination has no `/jobs/{jobId}` segment: the page resolves the job from the part
 * (`getJobPartTraveler` always did), and carrying the job id would have cost a QR version.
 */
export function scanDestination(scan: JiggedScan): string {
  const base = `/operator/${scan.companyId}`;
  return scan.kind === 'location'
    ? `${base}/inventory/locations/${scan.locationId}`
    : `${base}/parts/${scan.jobPartId}`;
}

/**
 * Which kind of code produced a destination path, or null if it isn't one of ours.
 *
 * Only telemetry needs this: the login passthrough is handed a path, not a scan, and reporting
 * *what* was scanned is half of what makes the time-to-scan number readable. It lives here, next to
 * `scanDestination`, so the two cannot disagree about which path shape means what — the previous
 * scheme's bug was exactly a second copy of a mapping living somewhere else.
 */
export function scanKindFromDestination(path: string): JiggedScanKind | null {
  if (/^\/operator\/[^/]+\/inventory\/locations\//.test(path)) return 'location';
  if (/^\/operator\/[^/]+\/parts\//.test(path)) return 'traveler';
  return null;
}

/**
 * Where a code scanned with the phone's *camera app* goes first: the operator sign-in, carrying the
 * destination it should replay once there.
 *
 * The destination travels as a `next` path rather than as the ids that produced it, so the login
 * page never has to know what a traveler is. It is re-validated on arrival by `safeNextPath` — a
 * query parameter is attacker-controlled even when we were the ones who wrote it.
 */
export function loginPassthroughUrl(scan: JiggedScan): string {
  return `/operator/${scan.companyId}/login?next=${encodeURIComponent(scanDestination(scan))}`;
}

/**
 * `next` if it is a path this company's operator surface can actually own, else null.
 *
 * An allowlist by construction, not a denylist of bad shapes: it must start with this company's own
 * operator prefix and contain nothing but path characters after it. That rejects the whole family
 * at once — `https://evil.example`, the protocol-relative `//evil.example`, `\\evil.example`, a
 * traversal out via `..`, and another tenant's `/operator/{otherCompany}/…` — without anyone having
 * to have thought of each.
 */
export function safeNextPath(
  next: string | null | undefined,
  companyId: string,
): string | null {
  if (!next) return null;
  if (!isUuid(companyId)) return null;
  const prefix = `/operator/${companyId.toLowerCase()}/`;
  const candidate = next.trim();
  if (!candidate.toLowerCase().startsWith(prefix)) return null;
  // Only plain path characters past the prefix: no `?`, no `#`, no `%` escapes to smuggle any of
  // the above back in, and no `.` so a traversal segment cannot form.
  return /^[A-Za-z0-9/_-]*$/.test(candidate.slice(prefix.length)) ? candidate : null;
}

/**
 * The message to show when a decoded code belongs to a different company — or null to accept it.
 *
 * Pure and separate from the scanner component because this is a tenant boundary, and the decode
 * loop cannot run in jsdom (no `getUserMedia`, no WASM), so logic left inside it is untestable
 * outside a browser. The choice of *which* message is part of the logic: an operator holding a
 * traveller and an operator holding a shelf label need to be told different things.
 *
 * Every code carries a company now, so unlike the previous scheme there is no "can't tell" case —
 * if a scan parsed at all, it named a company, and either it matches or it does not.
 */
export function foreignCompanyRejection(
  scan: JiggedScan,
  expectedCompanyId?: string,
): string | null {
  if (!expectedCompanyId) return null;
  if (scan.companyId === expectedCompanyId.toLowerCase()) return null;
  return scan.kind === 'traveler'
    ? 'That traveler belongs to a different company.'
    : 'That label belongs to a different company.';
}
