import { describe, it, expect, beforeEach } from 'vitest';
import {
  companyIdFromPath,
  companyProperties,
  setAnalyticsCompany,
  __resetAnalyticsCompany,
} from '@/lib/analyticsCompany';

const A = '752325ba-2159-41a7-9cd2-716faf5a596b';
const B = '774c7608-0879-4cb1-9e68-6afdb5d27c3c';

beforeEach(() => __resetAnalyticsCompany());

describe('companyIdFromPath', () => {
  it('reads the company from dashboard and operator routes', () => {
    expect(companyIdFromPath(`/dashboard/${A}`)).toBe(A);
    expect(companyIdFromPath(`/dashboard/${A}/quotes/new`)).toBe(A);
    expect(companyIdFromPath(`/operator/${A}/jobs`)).toBe(A);
  });

  /**
   * An absent property is honest; a placeholder becomes a fake row in every
   * breakdown. These routes genuinely have no company.
   */
  it('returns null for routes with no company', () => {
    for (const p of ['/login', '/', '/select-company', `/accept-invite/${A}`, '/admin']) {
      expect(companyIdFromPath(p), p).toBeNull();
    }
  });

  it('does not match a non-UUID segment', () => {
    expect(companyIdFromPath('/dashboard/not-a-uuid/quotes')).toBeNull();
  });

  it('normalises case so one company is one breakdown row', () => {
    expect(companyIdFromPath(`/dashboard/${A.toUpperCase()}`)).toBe(A);
  });
});

describe('companyProperties', () => {
  it('sends nothing at all off a company route', () => {
    setAnalyticsCompany({ id: A, name: 'Contour Tool & Machine' });
    expect(companyProperties('/login')).toEqual({});
  });

  it('sends the id alone when no name has been resolved yet', () => {
    expect(companyProperties(`/dashboard/${A}/parts`)).toEqual({ company_id: A });
  });

  it('sends both once the app supplies a matching name', () => {
    setAnalyticsCompany({ id: A, name: 'Contour Tool & Machine' });
    expect(companyProperties(`/dashboard/${A}/parts`)).toEqual({
      company_id: A,
      company_name: 'Contour Tool & Machine',
    });
  });

  /**
   * THE CASE THIS MODULE EXISTS FOR. A user with access to several companies
   * navigates from A to B; for a beat the cached name still says A. Attaching
   * it would attribute one customer's behaviour to another — silently, and in a
   * way no test of the happy path would catch. The URL wins.
   */
  it('drops a stale name when the URL has moved to another company', () => {
    setAnalyticsCompany({ id: A, name: 'Contour Tool & Machine' });
    expect(companyProperties(`/dashboard/${B}/quotes`)).toEqual({ company_id: B });
  });

  it('clears on sign-out', () => {
    setAnalyticsCompany({ id: A, name: 'Contour Tool & Machine' });
    setAnalyticsCompany(null);
    expect(companyProperties(`/dashboard/${A}`)).toEqual({ company_id: A });
  });
});
