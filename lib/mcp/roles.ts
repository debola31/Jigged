/**
 * Office roles. Operators are refused everywhere on the MCP server. RLS does not tell an operator
 * from an office user (it is membership-only; the split is `AuthGuard`'s redirect), and a chat
 * window is the easiest place to assemble the per-person activity the surveillance guardrail
 * forbids (docs/modules/operator-view.md).
 */
export const OFFICE_ROLES = ['admin', 'user'] as const;
export type OfficeRole = (typeof OFFICE_ROLES)[number];

export function isOfficeRole(role: string | null | undefined): role is OfficeRole {
  return role === 'admin' || role === 'user';
}
