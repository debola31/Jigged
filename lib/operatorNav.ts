/**
 * Which bottom-nav tab a path lights up.
 *
 * Extracted from the operator layout so it can be asserted without mounting a client layout that
 * needs Supabase, a station context and a router. It is a pure string mapping; it should never have
 * needed a component to be true.
 *
 * **Jobs is the fall-through, not a `/jobs` prefix match, and that is load-bearing.** When the job
 * traveler moved from `/operator/{co}/jobs/{jobId}/parts/{jobPartId}` to
 * `/operator/{co}/parts/{jobPartId}` — so its printed QR could drop a UUID and fit a smaller code —
 * the tab kept working only because of this shape. A prefix match would have silently unlit the tab
 * on the single most-visited operator screen, and no test would have said so.
 *
 * `/profile` needs no branch: it redirects to `/my-work`, which already matches.
 */
export type OperatorNavValue = 'inventory' | 'maintenance' | 'my-work' | 'jobs';

export function operatorNavValue(pathname: string | null | undefined): OperatorNavValue {
  if (!pathname) return 'jobs';
  if (pathname.includes('/inventory')) return 'inventory';
  if (pathname.includes('/maintenance')) return 'maintenance';
  if (pathname.includes('/my-work')) return 'my-work';
  return 'jobs';
}
