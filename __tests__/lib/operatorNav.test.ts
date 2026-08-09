import { describe, it, expect } from 'vitest';

import { operatorNavValue } from '@/lib/operatorNav';

const CO = '71000000-0000-0000-0000-000000000002';
const PART = '8a3f9c1d-4b2e-4f6a-9c8d-0e1f2a3b4c5d';

describe('operatorNavValue', () => {
  /**
   * **The reason this file exists.**
   *
   * The traveler moved from `/operator/{co}/jobs/{jobId}/parts/{jobPartId}` to
   * `/operator/{co}/parts/{jobPartId}` so its printed QR could drop a UUID and fit a smaller code.
   * The Jobs tab still lights up on the most-visited operator screen only because this mapping
   * falls through to `jobs` rather than matching a `/jobs` prefix. That is a coincidence worth
   * pinning: a later tidy-up that "obviously" turned the else into `includes('/jobs')` would unlight
   * the tab and break nothing a test could see.
   */
  it('keeps the Jobs tab lit on the relocated traveler route', () => {
    expect(operatorNavValue(`/operator/${CO}/parts/${PART}`)).toBe('jobs');
  });

  it('lights Jobs for the list, a job hub and an operation step', () => {
    expect(operatorNavValue(`/operator/${CO}/jobs`)).toBe('jobs');
    expect(operatorNavValue(`/operator/${CO}/jobs/abc`)).toBe('jobs');
    expect(operatorNavValue(`/operator/${CO}/jobs/abc/parts/${PART}/operations/op1`)).toBe('jobs');
  });

  it('lights the tab that owns each of the other three surfaces', () => {
    expect(operatorNavValue(`/operator/${CO}/inventory`)).toBe('inventory');
    expect(operatorNavValue(`/operator/${CO}/inventory/locations/loc1`)).toBe('inventory');
    expect(operatorNavValue(`/operator/${CO}/maintenance`)).toBe('maintenance');
    expect(operatorNavValue(`/operator/${CO}/my-work`)).toBe('my-work');
  });

  it('falls back to Jobs for an unknown path or none at all', () => {
    expect(operatorNavValue(null)).toBe('jobs');
    expect(operatorNavValue(undefined)).toBe('jobs');
    expect(operatorNavValue(`/operator/${CO}`)).toBe('jobs');
  });
});
