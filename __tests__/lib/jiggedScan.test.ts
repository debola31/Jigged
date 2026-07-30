import { describe, it, expect } from 'vitest';
import { parseJiggedScan, locationIdFromScan } from '@/lib/jiggedScan';

/**
 * The location half of this parser is covered in depth by
 * `__tests__/components/scanner/LocationScanner.test.tsx`, which exercises
 * `locationIdFromScan` against a printed label, a bare UUID and seven kinds of foreign code.
 * Those tests pass unchanged through the wrapper, which is the point of keeping it.
 *
 * What's new here is the **traveler** half and the boundary between the two: one scanner now
 * resolves both kinds of Jigged QR, and the ways that can go wrong are all about telling them
 * apart.
 */

const LOC = '11111111-2222-3333-4444-555555555555';
const JOB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PART = '99999999-8888-7777-6666-555555555555';

const locationUrl = (id = LOC) => `https://jigged.app/operator/co1/login?location=${id}`;
const travelerUrl = (job = JOB, part = PART) =>
  `https://jigged.app/operator/co1/login?job=${job}&part=${part}`;

describe('parseJiggedScan — location labels', () => {
  it('reads a printed location label', () => {
    expect(parseJiggedScan(locationUrl())).toEqual({ kind: 'location', locationId: LOC });
  });

  it('reads a bare UUID, so a keyboard wedge or a typed code works', () => {
    expect(parseJiggedScan(LOC)).toEqual({ kind: 'location', locationId: LOC });
  });

  it('lowercases, so a scanner that upper-cases still matches stored ids', () => {
    expect(parseJiggedScan(LOC.toUpperCase())).toEqual({ kind: 'location', locationId: LOC });
    expect(parseJiggedScan(locationUrl(LOC.toUpperCase()))).toEqual({
      kind: 'location',
      locationId: LOC,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseJiggedScan(`  ${LOC}\n`)).toEqual({ kind: 'location', locationId: LOC });
  });
});

describe('parseJiggedScan — job travelers', () => {
  it('reads a printed traveler sheet', () => {
    expect(parseJiggedScan(travelerUrl())).toEqual({
      kind: 'traveler',
      jobId: JOB,
      jobPartId: PART,
    });
  });

  it('lowercases both ids', () => {
    expect(parseJiggedScan(travelerUrl(JOB.toUpperCase(), PART.toUpperCase()))).toEqual({
      kind: 'traveler',
      jobId: JOB,
      jobPartId: PART,
    });
  });

  /**
   * The traveler PDF always emits both. One without the other cannot open a traveler page, so
   * accepting it would navigate somewhere broken — worse than saying "not a Jigged label".
   */
  it('refuses a job id with no part id', () => {
    expect(parseJiggedScan(`https://jigged.app/operator/co1/login?job=${JOB}`)).toBeNull();
  });

  it('refuses a part id with no job id', () => {
    expect(parseJiggedScan(`https://jigged.app/operator/co1/login?part=${PART}`)).toBeNull();
  });

  it('refuses a traveler whose ids are not UUIDs', () => {
    expect(
      parseJiggedScan('https://jigged.app/operator/co1/login?job=J-1234&part=17'),
    ).toBeNull();
  });
});

describe('parseJiggedScan — telling them apart', () => {
  /**
   * Our labels never emit both params. If something malformed does, location wins — which is
   * exactly what the location-only parser did before this became a union, so nothing that used
   * to resolve suddenly starts refusing.
   */
  it('prefers location when a malformed code somehow carries both', () => {
    const both = `https://jigged.app/operator/co1/login?location=${LOC}&job=${JOB}&part=${PART}`;
    expect(parseJiggedScan(both)).toEqual({ kind: 'location', locationId: LOC });
  });

  it('a bare UUID is a location, never a traveler — a traveler needs two ids', () => {
    const scan = parseJiggedScan(JOB);
    expect(scan).toEqual({ kind: 'location', locationId: JOB });
  });

  it('refuses codes from anywhere else', () => {
    for (const foreign of [
      '',
      '   ',
      'https://example.com/?location=not-a-uuid',
      'https://ups.com/track?tracknum=1Z999',
      '0123456789012', // an EAN-13 off a vendor box
      'PART-4140-BAR', // a shop's own part sticker
      'not a url at all',
      `${LOC}-extra`, // a UUID with something appended must not match
      'https://jigged.app/operator/co1/login', // our own login with no payload
    ]) {
      expect(parseJiggedScan(foreign), `should refuse: ${foreign}`).toBeNull();
    }
  });
});

describe('locationIdFromScan — the location-only view', () => {
  it('returns the id for a location scan', () => {
    expect(locationIdFromScan(locationUrl())).toBe(LOC);
  });

  /**
   * The behaviour that must not drift: surfaces that only handle places (the board, the
   * operator bin view) get null for a traveler rather than a job id they'd misread as a
   * location.
   */
  it('returns null for a traveler, not the job id', () => {
    expect(locationIdFromScan(travelerUrl())).toBeNull();
  });

  it('returns null for foreign codes', () => {
    expect(locationIdFromScan('https://ups.com/track?tracknum=1Z999')).toBeNull();
  });
});
