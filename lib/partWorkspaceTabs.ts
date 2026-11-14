/**
 * The part workspace's tabs, by the `?tab=` slug a link may carry.
 *
 * ONE LIST, read by the workspace that renders the tabs and by the standards test that checks
 * every `/parts/{id}?tab=` link in the app against it. A link to a slug that is not here does not
 * 404: the workspace falls back to its first tab. So a removed tab leaves its links landing
 * somewhere plausible and wrong, which is how `/activity`'s stock rows went on pointing at the
 * Storage tab (`inventory`) for two months after it was removed on 2026-09-09.
 */
export const PART_WORKSPACE_TABS = [
  { slug: 'workspace', label: 'Workspace' },
  // Bought parts only — PartWorkspace filters it out for a made part, where `?tab=buying` falls
  // back to Workspace like any unknown slug.
  { slug: 'buying', label: 'Buying' },
  { slug: 'usage', label: 'Usage' },
  { slug: 'files', label: 'Files' },
  // Labelled Activity; the slug stays 'history' so existing deep links keep working. It is the
  // part's ledger: its stock movements are in this feed.
  { slug: 'history', label: 'Activity' },
] as const;

export type PartWorkspaceTabSlug = (typeof PART_WORKSPACE_TABS)[number]['slug'];
