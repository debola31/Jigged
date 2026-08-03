-- A per-member cursor for "which 'helpful' marks have I already been shown".
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS ON THE SERVER, WHEN THE VIEW DIGEST IS NOT
-- ═══════════════════════════════════════════════════════════════════════════════
-- `NoteUsageBanner` keeps its acknowledged totals in localStorage, and that was
-- the right call there: the view digest must stay argument-free, because a
-- caller-supplied window is a bisection oracle — narrow it repeatedly and you
-- recover WHEN a note was read, which combined with note_viewers() naming the
-- reader reconstructs "Kurtis had to look this up on Tuesday". `note_views` is
-- RESTRICTIVE ... USING (false) for exactly that reason.
--
-- None of that applies to reactions. `note_reactions_select` already lets any
-- member read every reaction in their company, timestamps included, so a
-- server-side "seen through T" cursor discloses nothing a member could not
-- already query. What it buys is the thing localStorage cannot: the cursor
-- survives a new phone, a cleared browser, and a second device.
--
-- That matters more here than it does for views. The banner's first-run branch
-- silently adopts the current totals so a new device does not announce "312 new
-- views", and pays for it with one lost announcement — acceptable for a number.
-- The thing a named signal would lose is "Sam Carter found your note helpful",
-- which is the entire feature.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE CURSOR
-- ═══════════════════════════════════════════════════════════════════════════════
-- NULL means "never dismissed anything", which is NOT the same as the epoch: the
-- reader treats NULL as "show me the recent window" rather than "show me every
-- reaction ever received", so an operator who has had the app for a year does not
-- open it to a wall of history.
ALTER TABLE public.user_company_access
  ADD COLUMN IF NOT EXISTS reactions_seen_at timestamptz;

COMMENT ON COLUMN public.user_company_access.reactions_seen_at IS
  'Per-member cursor: "helpful" reactions on this member''s own notes created at or before this instant have already been surfaced to them, so they are no longer new. Advanced only by mark_reactions_seen(). NULL means never dismissed. Deliberately server-side rather than localStorage (unlike the view digest) so the cursor survives a new device — note_reactions is already company-readable, so this leaks nothing.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ADVANCING IT
-- ═══════════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER because UPDATE on user_company_access is admin-only ("Admins
-- can update company access"), and it must stay that way — a row-level "update
-- your own row" policy would let any operator rewrite their own `role`. So the
-- write is narrowed to this one column, for the caller's own row, through a
-- function instead.
--
-- TAKES THE TIMESTAMP IT ACTUALLY SHOWED rather than defaulting to now(). A
-- reaction landing between render and the operator's tap would otherwise be
-- marked seen without ever having been on screen, and a missed "Sam Carter found
-- your note helpful" is precisely what this whole mechanism exists to prevent.
-- Clamped to now() so a wrong client clock cannot push the cursor into the
-- future and silently swallow the next week of reactions.
CREATE OR REPLACE FUNCTION public.mark_reactions_seen(
  p_company_id uuid,
  p_seen_through timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  UPDATE public.user_company_access
     SET reactions_seen_at = least(p_seen_through, now())
   WHERE user_id = auth.uid()
     AND company_id = p_company_id
     -- Never move the cursor backwards. Two devices open at once would otherwise
     -- let the staler one un-see what the other already dismissed.
     AND (reactions_seen_at IS NULL OR reactions_seen_at < least(p_seen_through, now()));
$$;

COMMENT ON FUNCTION public.mark_reactions_seen(uuid, timestamptz) IS
  'Advance the caller''s own reactions_seen_at cursor to the newest reaction they were actually shown. Writes one column of one row (the caller''s), never moves backwards, and clamps to now(). SECURITY DEFINER because UPDATE on user_company_access is admin-only and must remain so — a self-update policy would let a member rewrite their own role.';

-- Post-#640 a new function is reachable only through PUBLIC's built-in default,
-- so the REVOKE genuinely closes it and the browser needs an explicit GRANT.
REVOKE EXECUTE ON FUNCTION public.mark_reactions_seen(uuid, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.mark_reactions_seen(uuid, timestamptz)
  TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. THE GUARD KNOWS ABOUT IT
-- ═══════════════════════════════════════════════════════════════════════════════
-- `function_execute_leaks()` must stay empty, and it lists every browser-reachable
-- SECURITY DEFINER function that is not deliberately allowlisted. This one is
-- called straight from the Me tab, so it belongs in the "called directly from
-- application code" group. Re-declared in full rather than patched, because the
-- allowlist lives in the function body.
CREATE OR REPLACE FUNCTION public.function_execute_leaks()
RETURNS TABLE(function_name text, role_name text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT p.proname::text, r.rolname::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  WHERE n.nspname = 'public'
    -- SECURITY DEFINER only. An INVOKER function runs as the caller, so RLS and
    -- table grants still contain it and a browser grant is not a hole; scoping
    -- the guard this way keeps the allowlist to the set that actually matters
    -- instead of every helper in the schema.
    AND p.prosecdef
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    AND p.proname NOT IN (
      -- Named in an RLS policy: the browser cannot query the table without it.
      'company_can_write', 'get_operator_access_id', 'get_user_company_ids',
      'is_company_admin', 'is_system_admin',
      -- Called directly from application code (utils/*Access.ts, app/, hooks/).
      'accept_invitation', 'add_stock_at_location', 'adjust_stock_at_location',
      'create_demo_company', 'create_shipment_with_line_items', 'delete_location',
      'deplete_stock_at_location', 'disable_location_tracking',
      'enable_location_tracking', 'log_note_views', 'log_operator_event',
      'mark_reactions_seen', 'note_viewers', 'reset_demo_company',
      'sync_demo_access', 'transfer_stock',
      -- Called BY a browser-callable SECURITY INVOKER function, which runs as the
      -- caller — so the caller genuinely needs EXECUTE on this one.
      -- (generate_quote_number / generate_direct_job_number -> next_order_number)
      'next_order_number'
    )
  ORDER BY 1, 2;
$$;
