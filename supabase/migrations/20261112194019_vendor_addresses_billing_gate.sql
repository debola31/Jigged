-- ============================================================================
-- vendor_addresses gets the billing write-gate, through its vendor
-- ============================================================================
-- 20260824022226 created vendor_addresses without the gate, reasoning that the
-- gate "keys on a company_id column this table does not have" and that "a lapsed
-- shop cannot create the parent to hang one on". The second half is true and
-- beside the point: a lapsed shop's EXISTING vendors went on taking new
-- addresses, edits and deletes straight from the browser, because no policy on
-- this table asks company_can_write. vendor_contacts, the identical shape, has
-- been gated through its vendor since 20260725210136.
--
-- Nothing caught it because tenant_tables_missing_write_gate() lists only tables
-- that HAVE a company_id. A parent-resolved child was invisible to it, so the
-- guard CLAUDE.md names as the barrier stayed green. Section 2 gives it the
-- narrowest branch that would have caught this.


-- ============================================================================
-- 1. The gate, resolved through the vendor
-- ============================================================================
-- vendor_contacts' three policies exactly: INSERT and DELETE as 20260725210136
-- wrote them, UPDATE in the USING (true) WITH CHECK shape 20260807015028 gave
-- every child (a blocked update RAISES 42501 naming the policy rather than
-- quietly matching nothing), and the immutability trigger on the gate key, which
-- for a child is its parent FK. The browser never moves an address to another
-- vendor (utils/vendorAddressesAccess.ts writes no vendor_id on update).
DROP POLICY IF EXISTS billing_gate_insert ON public.vendor_addresses;
DROP POLICY IF EXISTS billing_gate_update ON public.vendor_addresses;
DROP POLICY IF EXISTS billing_gate_delete ON public.vendor_addresses;

CREATE POLICY billing_gate_insert ON public.vendor_addresses
    AS RESTRICTIVE FOR INSERT TO authenticated
    WITH CHECK (public.company_can_write(
        (SELECT p.company_id FROM public.vendors p WHERE p.id = vendor_addresses.vendor_id)));

CREATE POLICY billing_gate_update ON public.vendor_addresses
    AS RESTRICTIVE FOR UPDATE TO authenticated
    USING (true)
    WITH CHECK (public.company_can_write(
        (SELECT p.company_id FROM public.vendors p WHERE p.id = vendor_addresses.vendor_id)));

CREATE POLICY billing_gate_delete ON public.vendor_addresses
    AS RESTRICTIVE FOR DELETE TO authenticated
    USING (public.company_can_write(
        (SELECT p.company_id FROM public.vendors p WHERE p.id = vendor_addresses.vendor_id)));

DROP TRIGGER IF EXISTS vendor_addresses_gate_key_immutable ON public.vendor_addresses;
CREATE TRIGGER vendor_addresses_gate_key_immutable
    BEFORE UPDATE ON public.vendor_addresses
    FOR EACH ROW
    WHEN (NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
          AND current_user IN ('authenticated', 'anon'))
    EXECUTE FUNCTION public.reject_gate_key_change();


-- ============================================================================
-- 2. The guard sees parent-resolved children
-- ============================================================================
-- Rebuilt from its newest definition (20261109155810). The first SELECT is that
-- body verbatim but for its ORDER BY, which now closes the UNION; the exempt list
-- is untouched.
--
-- The second SELECT is the narrowest test that names vendor_addresses: a table
-- with NO company_id, a foreign key into a table the gate already covers (so its
-- rows are a gated parent's), and a write the browser role holds with no gate
-- policy for that verb. On the day it was written it lists vendor_addresses and
-- nothing else -- customer_addresses, customer_contacts, vendor_contacts,
-- job_materials, job_operations, parts_bom, parts_unit_conversions,
-- routing_operations and shipment_line_items all carry their three policies, and
-- the company_id-less tables with no gated parent (companies, user_preferences,
-- system_admins, waitlist, demo_data_templates) are out of its reach by design.
-- A child that must stay ungated is argued in a NOT IN beside it, the way the
-- first SELECT's exempt list works.
--
-- has_any_column_privilege for INSERT and UPDATE, because a column-scoped grant
-- is still a browser write (outside_shipment_receipts holds one); DELETE has no
-- column form.
CREATE OR REPLACE FUNCTION public.tenant_tables_missing_write_gate()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN (
      -- identity / bootstrap (gating would block signup / team / preferences)
      'companies', 'user_company_access', 'user_preferences', 'system_admins',
      'invitations', 'demo_data_templates', 'waitlist', 'saved_insights', 'feedback',
      'company_billing',
      -- service-role-only / SELECT-only (writes never come from the browser).
      -- `part_location_stock` was removed from this list in 20260801150944: its
      -- writes DO come from the browser, through SECURITY DEFINER RPCs, and the
      -- exemption was what hid issue #645.
      -- `quickbooks_invoice_links` and `quickbooks_invoice_line_items` left the
      -- list HERE for the same reason: correct_invoice_recorded_quantities is a
      -- browser-callable SECURITY DEFINER writer, so "writes never come from the
      -- browser" stopped being true of them. Both are gated below.
      'auth_audit_log', 'job_fulfillment_audit',
      'company_order_counters', 'quickbooks_connections', 'quickbooks_customer_map',
      'quickbooks_desktop_connections', 'quickbooks_terms_cache',
      -- SECURITY DEFINER-only writers; see 20260728040701
      'note_views', 'operator_events',
      -- `operator_time_access_log` stood HERE, added 20260816203641 and carried
      -- forward by 20260818142814. The table is dropped in 20260825170421, so
      -- the entry goes with it. job_operation_intervals is unaffected: it IS
      -- gated (apply_billing_write_gate, 20260816203641), so it is satisfied by
      -- the policy-existence check below and never by this list.
      -- Append-only legal record, service-role write only
      'terms_acceptances',
      -- The AI-assistant (MCP) call log, 20261109155810: written only by the /mcp route as
      -- service role, never by the browser. Gating it would also leave a lapsed company's
      -- refused calls unrecorded, the opposite of what an audit log is for.
      'mcp_tool_calls'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.relname
        AND p.policyname = 'billing_gate_insert'
    )
  UNION
  -- Parent-resolved children (20261112194019): vendor_addresses shipped ungated
  -- for eleven weeks with this guard green, because it has no company_id.
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint fk
       WHERE fk.conrelid = c.oid AND fk.contype = 'f'
         AND EXISTS (SELECT 1 FROM pg_policy gp
                      WHERE gp.polrelid = fk.confrelid AND gp.polname = 'billing_gate_insert')
    )
    AND (
         (has_any_column_privilege('authenticated', c.oid, 'INSERT')
          AND NOT EXISTS (SELECT 1 FROM pg_policy p
                           WHERE p.polrelid = c.oid AND p.polname = 'billing_gate_insert'))
      OR (has_any_column_privilege('authenticated', c.oid, 'UPDATE')
          AND NOT EXISTS (SELECT 1 FROM pg_policy p
                           WHERE p.polrelid = c.oid AND p.polname = 'billing_gate_update'))
      OR (has_table_privilege('authenticated', c.oid, 'DELETE')
          AND NOT EXISTS (SELECT 1 FROM pg_policy p
                           WHERE p.polrelid = c.oid AND p.polname = 'billing_gate_delete'))
    )
  ORDER BY 1;
$$;

-- CREATE OR REPLACE keeps the ACL. The COMMENT is re-issued.
COMMENT ON FUNCTION public.tenant_tables_missing_write_gate() IS
  'Lists public tables that can bypass the billing write-gate: a table with a company_id column that is neither billing-gated nor exempt, and (since 20261112194019) a parent-resolved child -- no company_id, a foreign key into a gated table -- on which the browser role holds a write with no billing_gate_* policy for that verb. A CI test asserts this returns no rows, so a new tenant table left un-gated fails the build instead of silently bypassing billing.';


-- ============================================================================
-- 3. vendor_addresses is gated, and the guard says so
-- ============================================================================
-- Scoped to this table: the whole list is CI's assertion, and an unrelated drift
-- elsewhere must not hold this migration hostage.
DO $check$
BEGIN
    IF (SELECT count(*) FROM pg_policy
         WHERE polrelid = 'public.vendor_addresses'::regclass
           AND polname IN ('billing_gate_insert', 'billing_gate_update', 'billing_gate_delete')) <> 3 THEN
        RAISE EXCEPTION 'vendor_addresses is missing a billing_gate_* policy';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tenant_tables_missing_write_gate() t
                WHERE t.table_name = 'vendor_addresses') THEN
        RAISE EXCEPTION 'tenant_tables_missing_write_gate() still flags vendor_addresses';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tenant_tables_with_silent_update_gate() t
                WHERE t.table_name = 'vendor_addresses') THEN
        RAISE EXCEPTION 'vendor_addresses gates UPDATE in the silent USING (...) shape';
    END IF;
END
$check$;
