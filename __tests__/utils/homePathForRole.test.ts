import { describe, it, expect, vi } from 'vitest';

// `homePathForRole` is pure, but it lives in companyAccess.ts alongside the query
// helpers — and lib/supabase.ts builds a browser client at module scope, which throws
// without env vars. Same stub every other utils test uses.
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
  getTypedSupabase: () => ({}),
}));

import { homePathForRole } from '@/utils/companyAccess';

/**
 * Small function, but it is now the single source of truth for four call sites
 * (post-login, /launch, the company selector, invite acceptance). Three of those
 * used to hardcode /dashboard and lean on the AuthGuard bounce to correct it, so
 * the thing worth pinning is that an operator never gets sent to the office.
 */
describe('homePathForRole', () => {
  const companyId = 'c0ffee00-0000-4000-8000-000000000000';

  it('sends operators to the shop floor', () => {
    expect(homePathForRole('operator', companyId)).toBe(`/operator/${companyId}`);
  });

  it('sends admins and users to the office', () => {
    expect(homePathForRole('admin', companyId)).toBe(`/dashboard/${companyId}`);
    expect(homePathForRole('user', companyId)).toBe(`/dashboard/${companyId}`);
  });

  // An unknown or absent role must not resolve to the shop floor: the operator view
  // has no company-management surface at all, so guessing wrong in that direction
  // strands the person. The office has its own guards to correct an over-grant.
  it('defaults to the office when the role is unknown, null or undefined', () => {
    expect(homePathForRole(null, companyId)).toBe(`/dashboard/${companyId}`);
    expect(homePathForRole(undefined, companyId)).toBe(`/dashboard/${companyId}`);
    expect(homePathForRole('something-new', companyId)).toBe(`/dashboard/${companyId}`);
  });
});
