import { describe, it, expect } from 'vitest';
import {
  base32ToUuid,
  buildScanUrl,
  foreignCompanyRejection,
  loginPassthroughUrl,
  parseJiggedScan,
  safeNextPath,
  scanDestination,
  uuidToBase32,
  UUID_B32_LENGTH,
  type JiggedScan,
} from '@/lib/jiggedScan';

/**
 * The scan scheme, end to end but without a camera: encode → decode → route.
 *
 * The physical half of the chain — that a QR encoded this way actually decodes off a printed page —
 * lives in `__tests__/components/scanner/scannerRoundTrip.test.ts`, which runs the real `.wasm`.
 * The version ceiling that keeps it scannable lives in `__tests__/utils/qrVersionCeiling.test.ts`.
 * This file owns the string handling those two rely on.
 */

const CO = '11111111-2222-3333-4444-555555555555';
const OTHER_CO = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LOC = '99999999-8888-7777-6666-555555555555';
const PART = '8a3f9c1d-4b2e-4f6a-9c8d-0e1f2a3b4c5d';

const ORIGIN = 'https://www.jigged.app';
const location: JiggedScan = { kind: 'location', companyId: CO, locationId: LOC };
const traveler: JiggedScan = { kind: 'traveler', companyId: CO, jobPartId: PART };

describe('base32 UUID codec', () => {
  it('round-trips every UUID through exactly 26 characters', () => {
    for (const uuid of [CO, OTHER_CO, LOC, PART, '00000000-0000-0000-0000-000000000000']) {
      const code = uuidToBase32(uuid);
      expect(code).toHaveLength(UUID_B32_LENGTH);
      expect(base32ToUuid(code)).toBe(uuid);
    }
  });

  it('emits only RFC 4648 base32, which is inside the QR alphanumeric charset', () => {
    expect(uuidToBase32(PART)).toMatch(/^[A-Z2-7]{26}$/);
  });

  it('rejects a code whose padding bits are not zero, so the encoding stays injective', () => {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const code = uuidToBase32(PART);
    // The final character carries 3 real bits and 2 pad bits, so four characters share the same
    // 128-bit prefix and would decode to the same UUID. Only the one with a zero pad is legal;
    // accepting the other three would give every code four spellings.
    const legalIndex = ALPHABET.indexOf(code[UUID_B32_LENGTH - 1]);
    expect(legalIndex % 4).toBe(0);

    for (let pad = 1; pad <= 3; pad++) {
      const impostor = code.slice(0, -1) + ALPHABET[legalIndex + pad];
      expect(base32ToUuid(impostor), `pad ${pad} must be refused`).toBeNull();
    }
  });

  it('refuses the wrong length and characters outside the alphabet', () => {
    expect(base32ToUuid('TOOSHORT')).toBeNull();
    expect(base32ToUuid('0'.repeat(26))).toBeNull(); // 0 and 1 are not in the alphabet
    expect(base32ToUuid('a'.repeat(26))).toBeNull(); // lowercase is normalised before this point
  });

  it('throws on a non-UUID rather than encoding nonsense', () => {
    expect(() => uuidToBase32('not-a-uuid')).toThrow();
  });
});

describe('buildScanUrl', () => {
  it('writes an all-uppercase URL — the thing that buys the QR version', () => {
    const url = buildScanUrl(location, ORIGIN);
    expect(url).toBe(url.toUpperCase());
    // Every character inside the QR alphanumeric charset.
    expect(url).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
  });

  it('is 77 characters against the canonical origin', () => {
    expect(buildScanUrl(location, ORIGIN)).toHaveLength(77);
    expect(buildScanUrl(traveler, ORIGIN)).toHaveLength(77);
  });

  it('distinguishes the two kinds by path segment only', () => {
    expect(buildScanUrl(location, ORIGIN)).toContain('/L/');
    expect(buildScanUrl(traveler, ORIGIN)).toContain('/T/');
  });

  it('tolerates a trailing slash on the origin', () => {
    expect(buildScanUrl(location, 'https://www.jigged.app/')).toBe(buildScanUrl(location, ORIGIN));
  });
});

describe('parseJiggedScan — what we print, we can read', () => {
  it('reads back a printed location label', () => {
    expect(parseJiggedScan(buildScanUrl(location, ORIGIN))).toEqual(location);
  });

  it('reads back a printed traveler', () => {
    expect(parseJiggedScan(buildScanUrl(traveler, ORIGIN))).toEqual(traveler);
  });

  it('reads a bare code, so a wedge scanner or a retyped label still works', () => {
    const bare = `L${uuidToBase32(CO)}${uuidToBase32(LOC)}`;
    expect(parseJiggedScan(bare)).toEqual(location);
  });

  it('keeps the company on a bare code, which the old bare-UUID form could not', () => {
    const bare = `T${uuidToBase32(CO)}${uuidToBase32(PART)}`;
    expect(parseJiggedScan(bare)?.companyId).toBe(CO);
  });

  it('is case-insensitive, in case a handler normalises the path', () => {
    expect(parseJiggedScan(buildScanUrl(traveler, ORIGIN).toLowerCase())).toEqual(traveler);
  });

  it('tolerates surrounding whitespace and a trailing slash', () => {
    expect(parseJiggedScan(`  ${buildScanUrl(location, ORIGIN)}/\n`)).toEqual(location);
  });

  it('works against any origin, because the label may predate a domain change', () => {
    expect(parseJiggedScan(buildScanUrl(location, 'http://localhost:3000'))).toEqual(location);
  });
});

describe('parseJiggedScan — what it refuses', () => {
  const foreign = [
    'https://ups.com/track?tracknum=1Z999AA10123456784',
    'https://jigged.app/dashboard/co/parts',
    'WIFI:S:ShopFloor;T:WPA;P:hunter2;;',
    'not a url at all',
    '',
    '   ',
    // The retired scheme. Nothing printed it that anyone kept, and accepting it would resurrect the
    // `operation=` routing this redesign deleted.
    `https://jigged.app/operator/${CO}/login?location=${LOC}`,
    `https://jigged.app/operator/${CO}/login?job=${OTHER_CO}&part=${PART}`,
    // A bare UUID was a location under the old scheme. It carries no company, so it cannot be.
    LOC,
  ];

  it.each(foreign)('refuses %j', (text) => {
    expect(parseJiggedScan(text)).toBeNull();
  });

  it('refuses an unknown kind letter', () => {
    expect(parseJiggedScan(`${ORIGIN}/X/${uuidToBase32(CO)}${uuidToBase32(LOC)}`)).toBeNull();
  });

  it('refuses a code of the wrong length', () => {
    expect(parseJiggedScan(`${ORIGIN}/L/${uuidToBase32(CO)}`)).toBeNull();
  });

  it('refuses a code with a corrupt pad, rather than inventing a UUID', () => {
    const bad = uuidToBase32(CO) + uuidToBase32(LOC).slice(0, -1) + 'B';
    expect(parseJiggedScan(`${ORIGIN}/L/${bad}`)).toBeNull();
  });
});

describe('scanDestination — the only copy of this mapping', () => {
  it('sends a location label to that bin', () => {
    expect(scanDestination(location)).toBe(`/operator/${CO}/inventory/locations/${LOC}`);
  });

  it('sends a traveler to the part, with no job id in the path', () => {
    expect(scanDestination(traveler)).toBe(`/operator/${CO}/parts/${PART}`);
  });

  it('agrees with what the camera-app passthrough will replay', () => {
    const url = loginPassthroughUrl(traveler);
    const next = new URLSearchParams(url.split('?')[1]).get('next');
    expect(next).toBe(scanDestination(traveler));
    expect(safeNextPath(next, CO)).toBe(scanDestination(traveler));
  });

  it('routes a scan end to end: print, decode, land', () => {
    const scan = parseJiggedScan(buildScanUrl(traveler, ORIGIN));
    expect(scan).not.toBeNull();
    expect(scanDestination(scan!)).toBe(`/operator/${CO}/parts/${PART}`);
  });
});

describe('safeNextPath', () => {
  it('accepts this company’s own operator destinations', () => {
    expect(safeNextPath(`/operator/${CO}/parts/${PART}`, CO)).toBe(`/operator/${CO}/parts/${PART}`);
    expect(safeNextPath(`/operator/${CO}/inventory/locations/${LOC}`, CO)).toBe(
      `/operator/${CO}/inventory/locations/${LOC}`,
    );
  });

  const rejected: Array<[string, string]> = [
    ['an absolute URL elsewhere', 'https://evil.example/steal'],
    ['a protocol-relative URL', `//evil.example/operator/${CO}/parts/x`],
    ['a backslash-smuggled host', `\\\\evil.example/operator/${CO}/parts/x`],
    ['another tenant', `/operator/${OTHER_CO}/parts/${PART}`],
    ['the office surface', `/dashboard/${CO}/parts`],
    ['a traversal', `/operator/${CO}/../../admin`],
    ['a percent escape', `/operator/${CO}/%2e%2e/admin`],
    ['a smuggled query', `/operator/${CO}/parts/x?next=https://evil.example`],
    ['a fragment', `/operator/${CO}/parts/x#@evil.example`],
  ];

  it.each(rejected)('rejects %s', (_label, next) => {
    expect(safeNextPath(next, CO)).toBeNull();
  });

  it('rejects an absent next and a non-UUID company', () => {
    expect(safeNextPath(null, CO)).toBeNull();
    expect(safeNextPath('', CO)).toBeNull();
    expect(safeNextPath(`/operator/co1/parts/${PART}`, 'co1')).toBeNull();
  });
});

describe('foreignCompanyRejection', () => {
  it('accepts a code from the expected company', () => {
    expect(foreignCompanyRejection(location, CO)).toBeNull();
  });

  it('is case-insensitive about the expected company', () => {
    expect(foreignCompanyRejection(location, CO.toUpperCase())).toBeNull();
  });

  it('names a traveler and a label differently, because the operator is holding different paper', () => {
    expect(foreignCompanyRejection(traveler, OTHER_CO)).toMatch(/traveler belongs to a different/i);
    expect(foreignCompanyRejection(location, OTHER_CO)).toMatch(/label belongs to a different/i);
  });

  it('accepts anything when no company is expected — the caller opted out of the check', () => {
    expect(foreignCompanyRejection(location, undefined)).toBeNull();
  });

  it('refuses a foreign code before it can become a navigation', () => {
    const foreignUrl = buildScanUrl({ ...location, companyId: OTHER_CO }, ORIGIN);
    const scan = parseJiggedScan(foreignUrl)!;
    expect(foreignCompanyRejection(scan, CO)).not.toBeNull();
  });
});
