/**
 * Initials for a person's avatar.
 *
 * Lifted out of `components/operator/OperatorAccountBlock.tsx` when the office header gained an
 * account menu and would otherwise have hand-rolled a third copy of the same four lines.
 *
 * Returns `''` rather than a placeholder glyph when there is no name: MUI's `Avatar` falls back to
 * whatever child you give it, so an empty string lets the call site decide between a person-shaped
 * icon and a blank — and neither of them invents a name that isn't there.
 *
 * NOT shared with `CompanySwitcher.getInitials`, which is deliberately left alone: it splits on a
 * literal `' '` (so it treats a double space in a company name as an empty word), and it is paired
 * with `getAvatarColor` in the same file. Company names and people's names are different problems.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}
