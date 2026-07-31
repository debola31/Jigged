import { describe, it, expect } from 'vitest';
import {
  companyIdFromScan,
  foreignCompanyRejection,
  locationIdFromScan,
  parseJiggedScan,
  scanDestination,
} from '@/lib/jiggedScan';

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

/**
 * Whose label is it? Separate from "what kind of label is it", because only some callers ask —
 * the operator tab-bar scanner does, to refuse another shop's paper before it becomes a
 * navigation.
 */
describe('companyIdFromScan', () => {
  const CO = '0f0f0f0f-1111-2222-3333-444444444444';
  const OTHER = 'deadbeef-1111-2222-3333-444444444444';

  it('reads the company out of a location label', () => {
    expect(companyIdFromScan(`https://jigged.app/operator/${CO}/login?location=${LOC}`)).toBe(CO);
  });

  it('reads the company out of a traveler', () => {
    expect(companyIdFromScan(`https://jigged.app/operator/${CO}/login?job=${JOB}&part=${PART}`)).toBe(
      CO,
    );
  });

  it('distinguishes one company from another', () => {
    expect(companyIdFromScan(`https://jigged.app/operator/${OTHER}/login?location=${LOC}`)).not.toBe(
      CO,
    );
  });

  it('lowercases, so a comparison never fails on case alone', () => {
    expect(
      companyIdFromScan(`https://jigged.app/operator/${CO.toUpperCase()}/login?location=${LOC}`),
    ).toBe(CO);
  });

  /**
   * Null is "can't tell", never "yours". A bare typed UUID has no company in it at all, and a
   * caller must treat that as unverified rather than as a pass — which is why the scanner only
   * refuses on a *mismatch*, not on an absence.
   */
  it('returns null for a bare UUID, which carries no company', () => {
    expect(companyIdFromScan(LOC)).toBeNull();
  });

  it('returns null for a non-UUID path segment rather than guessing', () => {
    // The other fixtures in this file use `co1`; that is not an id we would ever print.
    expect(companyIdFromScan(locationUrl())).toBeNull();
  });

  it('returns null for a foreign URL', () => {
    expect(companyIdFromScan('https://ups.com/track?tracknum=1Z999')).toBeNull();
  });

  it('returns null for a Jigged URL that is not the login passthrough', () => {
    expect(companyIdFromScan(`https://jigged.app/dashboard/${CO}/parts`)).toBeNull();
  });

  it('returns null for junk', () => {
    expect(companyIdFromScan('not a url')).toBeNull();
  });
});

/**
 * Where a scan lands. These assertions exist because the in-app mapping used to be inline in
 * `app/operator/[companyId]/layout.tsx` with no test anywhere — so the single most load-bearing
 * behaviour in the feature, routing an OLD traveller sheet to its step, was unverified.
 *
 * The expected paths below are copied from `postLoginPath` in
 * `app/operator/[companyId]/login/page.tsx`, which is where the same piece of paper goes when it
 * is scanned with the phone's camera app instead. If someone changes one, this should fail.
 */
describe('scanDestination', () => {
  const CO = 'co-1';

  it('sends a location label to that bin', () => {
    expect(scanDestination(CO, { kind: 'location', locationId: LOC })).toBe(
      `/operator/${CO}/inventory/locations/${LOC}`,
    );
  });

  it('sends a current traveller to the job part, where the operator picks the step', () => {
    expect(scanDestination(CO, { kind: 'traveler', jobId: JOB, jobPartId: PART })).toBe(
      `/operator/${CO}/jobs/${JOB}/parts/${PART}`,
    );
  });

  /**
   * The one that matters. Sheets printed before travellers stopped encoding a step are still on
   * the shop floor, and they jump straight to that step. Dropping the operation would silently
   * downgrade an old sheet to the traveller index — worse than the camera-app path it was
   * printed for.
   */
  it('sends an OLD traveller straight to the step it encodes', () => {
    const OP = '12121212-3434-5656-7878-909090909090';
    expect(
      scanDestination(CO, { kind: 'traveler', jobId: JOB, jobPartId: PART, operationId: OP }),
    ).toBe(`/operator/${CO}/jobs/${JOB}/parts/${PART}/operations/${OP}`);
  });

  it('treats an absent operationId the same as one that was never there', () => {
    expect(
      scanDestination(CO, { kind: 'traveler', jobId: JOB, jobPartId: PART, operationId: undefined }),
    ).toBe(`/operator/${CO}/jobs/${JOB}/parts/${PART}`);
  });

  /** End to end: the printed string a scanner reads, through to the path it opens. */
  it('routes a real printed traveller URL end to end', () => {
    const scan = parseJiggedScan(travelerUrl());
    expect(scan).not.toBeNull();
    expect(scanDestination(CO, scan!)).toBe(`/operator/${CO}/jobs/${JOB}/parts/${PART}`);
  });
});

/**
 * The tenant boundary on a scan. A traveller QR printed by another shop decodes perfectly well;
 * before this existed the operator layout pushed the route anyway and let the destination page's
 * RLS fail, so the operator got an error screen after a navigation instead of "that isn't yours".
 */
describe('foreignCompanyRejection', () => {
  const MINE = '0f0f0f0f-1111-2222-3333-444444444444';
  const THEIRS = 'deadbeef-1111-2222-3333-444444444444';
  const url = (co: string, qs: string) => `https://jigged.app/operator/${co}/login?${qs}`;
  const loc = (co: string) => url(co, `location=${LOC}`);
  const trav = (co: string) => url(co, `job=${JOB}&part=${PART}`);

  it('accepts one of your own labels', () => {
    const text = loc(MINE);
    expect(foreignCompanyRejection(text, parseJiggedScan(text)!, MINE)).toBeNull();
  });

  it('refuses another company’s shelf label', () => {
    const text = loc(THEIRS);
    expect(foreignCompanyRejection(text, parseJiggedScan(text)!, MINE)).toMatch(
      /label belongs to a different company/i,
    );
  });

  /** Different paper, different sentence — an operator holding a traveller needs to be told so. */
  it('refuses another company’s traveller, and says traveller', () => {
    const text = trav(THEIRS);
    expect(foreignCompanyRejection(text, parseJiggedScan(text)!, MINE)).toMatch(
      /traveler belongs to a different company/i,
    );
  });

  it('ignores case, so a comparison never fails on that alone', () => {
    const text = loc(MINE.toUpperCase());
    expect(foreignCompanyRejection(text, parseJiggedScan(text)!, MINE)).toBeNull();
  });

  /**
   * Absence is not a mismatch. A bare typed UUID carries no company at all, and refusing it would
   * break the keyboard-wedge and hand-typed paths for no security gain — the caller's own data
   * validation is the backstop there.
   */
  it('lets an unverifiable payload through rather than refusing it', () => {
    expect(foreignCompanyRejection(LOC, parseJiggedScan(LOC)!, MINE)).toBeNull();
  });

  it('does nothing when the caller names no company', () => {
    const text = loc(THEIRS);
    expect(foreignCompanyRejection(text, parseJiggedScan(text)!, undefined)).toBeNull();
  });
});
