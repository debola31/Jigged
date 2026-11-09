-- AI-assistant tokens work only through Jigged's MCP server.
--
-- THE HOLE. Supabase's OAuth server issues an assistant (Claude, ChatGPT, ...) an ordinary user
-- JWT plus a `client_id` claim, with no audience binding. Anyone can publish an MCP server whose
-- protected-resource metadata names Jigged's Supabase as its authorization server; Claude or
-- ChatGPT then register through DCR with a redirect the consent page accepts (claude.ai,
-- chatgpt.com), the Jigged user clicks Allow, and the token is sent to THAT server, which can call
-- the Data API directly with the user's full rights, past every check /mcp makes.
--
-- THE FIX. Every Data API request carrying a `client_id` claim must also carry the header
-- `x-jigged-mcp` whose SHA-256 is registered in private.mcp_gateway_keys. Only the /mcp route
-- holds the key (env MCP_GATEWAY_KEY). Browser sessions carry no client_id and are untouched.
--
--   Data API (PostgREST, GraphQL)  db_pre_request: public.mcp_token_binding(), below
--   Storage                        a RESTRICTIVE policy: OAuth tokens get nothing. No tool needs
--                                  Storage yet; attachment links will be minted server-side
--   Realtime                       nothing to bind: no table is in supabase_realtime
--   FastAPI, Edge Functions        checked in code (api/routes/company_auth.py,
--                                  supabase/functions/_shared/oauthTokens.ts)
--   Auth API (/auth/v1/user)       not reachable from here. Secure password change and secure
--                                  email change in the Auth settings are what keep a leaked
--                                  token from becoming an account takeover
--
-- ONLY A FINGERPRINT IS STORED. The key itself lives in Vercel; the database holds its SHA-256,
-- registered per environment with public.register_mcp_gateway_key() as service role (production
-- by hand, local from supabase/seed.sql). With no key registered, assistant tokens are refused:
-- fail closed.
--
-- FAST PATH. The hook runs before EVERY Data API request in the app, so the common case (no
-- client_id) returns after one claims read, with no table access and no hashing.

-- ============================================================================
-- 1. Where the fingerprints live: a schema the Data API does not expose
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

CREATE TABLE private.mcp_gateway_keys (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE private.mcp_gateway_keys IS
  'SHA-256 fingerprints of the MCP gateway keys the /mcp route sends as x-jigged-mcp. public.mcp_token_binding() refuses an OAuth-issued token without one. Register with public.register_mcp_gateway_key(); the keys themselves are never stored.';

-- ============================================================================
-- 2. The Data API hook
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mcp_token_binding()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_client_id text;
  v_presented text;
BEGIN
  v_client_id := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'client_id';
  IF v_client_id IS NULL OR v_client_id = '' THEN
    RETURN;
  END IF;

  v_presented := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-jigged-mcp';
  IF v_presented IS NOT NULL AND EXISTS (
    SELECT 1
      FROM private.mcp_gateway_keys k
     WHERE k.sha256 = encode(extensions.digest(v_presented, 'sha256'), 'hex')
  ) THEN
    RETURN;
  END IF;

  RAISE SQLSTATE 'PGRST' USING
    message = json_build_object(
      'code', 'jigged_mcp_only',
      'message', 'Jigged AI-assistant tokens work only through jigged.app/mcp.'
    )::text,
    detail = json_build_object('status', 403, 'headers', json_build_object())::text;
END;
$$;

COMMENT ON FUNCTION public.mcp_token_binding() IS
  'PostgREST db_pre_request hook: refuses an OAuth-issued token (client_id claim) unless the request carries an x-jigged-mcp key whose SHA-256 is in private.mcp_gateway_keys. Returns at once for every other request. See migration 20261109163801.';

-- PostgREST runs the hook as the requesting role.
REVOKE EXECUTE ON FUNCTION public.mcp_token_binding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mcp_token_binding() TO anon, authenticated, service_role;

ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.mcp_token_binding';
NOTIFY pgrst, 'reload config';

-- ============================================================================
-- 3. Registering a key's fingerprint (service role only)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.register_mcp_gateway_key(p_sha256 text, p_label text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO private.mcp_gateway_keys (sha256, label)
  VALUES (lower(p_sha256), p_label)
  ON CONFLICT (sha256) DO NOTHING;
$$;

COMMENT ON FUNCTION public.register_mcp_gateway_key(text, text) IS
  'Register the SHA-256 (hex) of an MCP gateway key. Service role only. To rotate: register the new key, deploy it to /mcp, then delete the old row from private.mcp_gateway_keys by hand.';

REVOKE EXECUTE ON FUNCTION public.register_mcp_gateway_key(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_mcp_gateway_key(text, text) TO service_role;

-- ============================================================================
-- 4. Storage: OAuth-issued tokens get nothing
-- ============================================================================
-- RESTRICTIVE, so it narrows every existing permissive policy on storage.objects rather than
-- adding to them. Browser sessions have no client_id and pass.
CREATE POLICY "AI assistant tokens cannot use storage"
    ON storage.objects
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING ((auth.jwt() ->> 'client_id') IS NULL)
    WITH CHECK ((auth.jwt() ->> 'client_id') IS NULL);

-- ============================================================================
-- 5. The definer-function guard: mcp_token_binding is browser-callable by design
-- ============================================================================
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
    AND p.prosecdef
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    AND p.proname NOT IN (
      -- Named in an RLS policy: the browser cannot query the table without it.
      'company_can_write', 'get_operator_access_id', 'get_user_company_ids',
      'is_company_admin', 'is_system_admin',
      -- Called directly from application code (utils/*Access.ts, app/, hooks/).
      -- NB: enable_location_tracking / disable_location_tracking are deliberately absent.
      -- 20260802015101 dropped both RPCs; re-listing them here would leave the allowlist
      -- naming functions that no longer exist, which is how this list rots.
      'accept_invitation', 'add_stock_at_location', 'adjust_stock_at_location',
      'create_demo_company', 'create_shipment_with_line_items', 'delete_location',
      'deplete_stock_at_location', 'log_note_views', 'log_operator_event',
      'note_viewers', 'reset_demo_company', 'sync_demo_access', 'transfer_stock',
      -- Added 20260801181116: the count sheet's put-away calls it directly
      -- (`bulkPutAway` in utils/inventoryLocationsAccess.ts).
      'bulk_put_away',
      -- Added 20260803043406: the Me tab dismisses its recognition block through it
      -- (`markHelpfulSeen` in utils/operatorAccess.ts).
      'mark_reactions_seen',
      -- Added 20260810142715: the Storage page's create/duplicate path calls it
      -- directly (`materializeLocationSpec` in utils/inventoryLocationsAccess.ts).
      -- Atomicity IS the feature — the loop it replaces could leave a partial
      -- tree behind an opaque error (#618) — so it cannot be decomposed either.
      'create_location_tree',
      -- Added 20260815192344: the Storage page's `Change layout` calls it directly
      -- (`applyLocationLayout` in utils/inventoryLocationsAccess.ts). Create,
      -- rename, re-parent, move stock and delete must be ONE transaction, and two
      -- of those steps are illegal outside one that defers the container/bin
      -- invariant. `subdivide_location` left the list in the same migration: it is
      -- dropped there, and an allowlist naming functions that no longer exist is
      -- how this list rots.
      'apply_location_layout',
      -- Added 20260816203641: operator cycle-time capture. That migration added
      -- FIVE; get_operator_time_detail was the fifth and is dropped in
      -- 20260825170421, so it leaves this list for the subdivide_location reason --
      -- an allowlist naming functions that no longer exist is how the list rots.
      -- cancel_operation_interval joined the group in 20260826105251: the step
      -- screen calls it directly to discard a running timer.
      -- void_open_intervals_for_operation joined in 20260828124806: the OFFICE
      -- discards someone else's, from the job page's Complete and the Still-running
      -- card's Stop.
      -- pause_operation_interval joined HERE (20260907203755): the step screen
      -- calls it directly to close a span the operator means to come back to. It
      -- is DEFINER for the same reason its two siblings are -- the browser has no
      -- INSERT or UPDATE grant on ended_at/close_reason at all, by construction
      -- (20260816203641's column-scoped GRANT UPDATE names three columns and these
      -- are not among them) -- and it asserts ownership itself.
      -- get_paused_operations joined in 20260907203956: the office card reads
      -- the other half of the forgotten-work channel. Admin-checked inside and
      -- returns no operator identity, exactly like get_open_intervals.
      'start_operation_interval', 'close_operation_interval',
      'cancel_operation_interval', 'pause_operation_interval',
      'void_open_intervals_for_operation',
      'get_operation_actuals', 'get_open_intervals', 'get_paused_operations',
      -- Added 20260903203741: outside-processing shipping. BOTH are browser
      -- callable on purpose. create_outside_shipment IS the send -- it mints
      -- VPS-{jobBase}-{n} under a per-job advisory lock and freezes the vendor
      -- address block, neither of which a PostgREST insert can do, which is why
      -- outside_shipments grants the browser SELECT and nothing else.
      -- void_outside_shipment must void the receipts BEFORE the shipment in one
      -- transaction, or the op -> part -> job cascade crosses the
      -- pg_trigger_depth() > 2 bail and freezes the job status silently.
      -- Both derive company_id from the row rather than taking it as an
      -- argument, and both call company_can_write by hand.
      'create_outside_shipment', 'void_outside_shipment',
      -- Added 20261109163801: PostgREST's db_pre_request hook. PostgREST runs it AS THE
      -- REQUESTING ROLE before every Data API call, so anon and authenticated must be able to
      -- execute it or every request fails. It takes no arguments, returns nothing and reveals
      -- nothing: it only refuses an OAuth-issued token (an AI assistant's) that arrives without
      -- the MCP gateway key. DEFINER because it reads private.mcp_gateway_keys.
      'mcp_token_binding',
      -- Added 20260906121901: the part page's heat-tracking toggle
      -- (`setPartLotTracking`). DEFINER because setting the flag and migrating the
      -- part's lot-less balances into a PRE-TRACKING lot must be one transaction.
      'set_part_lot_tracking',
      -- Called BY a browser-callable SECURITY INVOKER function, which runs as the
      -- caller — so the caller genuinely needs EXECUTE on this one.
      -- (generate_quote_number / generate_direct_job_number -> next_order_number)
      -- (get_ready_operations_for_station -> get_running_operation_ids_for_station,
      --  added 20260826010648, and -> get_paused_operation_ids_for_station,
      --  added 20260907203956 -- same contract, ids and nothing else)
      'next_order_number', 'get_running_operation_ids_for_station',
      'get_paused_operation_ids_for_station',
      -- Added 20261001025551: the job page's Invoices menu calls it directly
      -- (`correctInvoiceRecordedQuantities` in utils/quickbooksAccess.ts) to fix
      -- what Jigged RECORDED an invoice as billing. DEFINER because both invoice
      -- tables deny browser writes by construction and because total_price must be
      -- recomputed server-side from the locked unit_price snapshot -- a caller that
      -- supplied it could make Jigged's revenue figure say anything. Same contract
      -- as create_outside_shipment / void_outside_shipment above: it derives
      -- company_id from the row rather than taking it as an argument, and it calls
      -- company_can_write by hand.
      'correct_invoice_recorded_quantities'
    )
  ORDER BY 1, 2;
$$;
