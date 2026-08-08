-- sync_demo_access: authorize the caller.
--
-- WHAT WAS WRONG. The function is SECURITY DEFINER (it must be — it writes
-- user_company_access rows for OTHER users, which no browser role may do) and is granted
-- EXECUTE to anon and authenticated. It had no caller check of any kind. Its body is
--
--     INSERT INTO user_company_access (user_id, company_id, role, name)
--     SELECT uca.user_id, p_demo_company_id, uca.role, uca.name
--     FROM user_company_access uca
--     WHERE uca.company_id = p_source_company_id ...
--
-- so both company ids came straight from the caller and neither was checked against them.
-- A signed-in user who knew a victim company's UUID could pass their OWN company as the
-- source and the victim as the "demo", and the function would dutifully insert them into
-- the victim company with their own role — an admin somewhere becoming an admin there.
-- Company UUIDs are not secrets; they sit in every URL the app renders.
--
-- Contrast create_demo_company, which has checked `auth.uid()` and admin-of-source since
-- the baseline. sync_demo_access is its sibling and was written without either.
--
-- WHY NOW. Until this change only the office Settings page reached this RPC, behind
-- AdminGuard. The operator "Me" tab now calls it too (a new operator has no mirrored
-- access row in the demo and would be signed out on arrival without the sync), which
-- widens the caller set from admins to every member. Widening the callers of an
-- unauthorized SECURITY DEFINER function without first authorizing it would be the wrong
-- order to do these two things in.
--
-- THE TWO GUARDS, and why both.
--
--   1. The pair must be a real source→demo pair. This is the one that closes the
--      escalation path: an arbitrary company can no longer be named as the target,
--      because companies.demo_company_id has to already point at it. It holds for every
--      caller including service_role, which is why it is unconditional.
--
--   2. A browser caller must belong to the source. Guard 1 alone would still let any
--      signed-in stranger converge someone else's demo on its source — harmless in
--      effect, since it only copies a company onto its own demo, but it is a write on
--      behalf of a company the caller has nothing to do with and there is no reason to
--      allow it. Conditioned on `auth.uid() IS NOT NULL` so service_role keeps working:
--      it has no JWT, it is trusted, and both the backend and the integration suite call
--      through it.
--
-- CREATE OR REPLACE, not DROP + CREATE: a DROP would destroy the ACL and the COMMENT
-- (see CLAUDE.md). The signature is unchanged, so types/database.ts does not move.

CREATE OR REPLACE FUNCTION public.sync_demo_access(p_source_company_id uuid, p_demo_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Guard 1: these two must genuinely be a company and its own demo.
    IF NOT EXISTS (
        SELECT 1 FROM companies
        WHERE id = p_source_company_id
          AND demo_company_id = p_demo_company_id
    ) THEN
        RAISE EXCEPTION 'Access denied: % is not the demo company of %',
            p_demo_company_id, p_source_company_id;
    END IF;

    -- Guard 2: a browser caller must be a member of the source company.
    IF auth.uid() IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = auth.uid()
          AND company_id = p_source_company_id
    ) THEN
        RAISE EXCEPTION 'Access denied: not a member of the source company';
    END IF;

    -- Add any missing access entries (new team members since demo was created)
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT uca.user_id, p_demo_company_id, uca.role, uca.name
    FROM user_company_access uca
    WHERE uca.company_id = p_source_company_id
      AND NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = uca.user_id AND company_id = p_demo_company_id
      );

    -- Update roles that changed in the source company
    UPDATE user_company_access demo_uca
    SET role = source_uca.role
    FROM user_company_access source_uca
    WHERE demo_uca.company_id = p_demo_company_id
      AND source_uca.company_id = p_source_company_id
      AND demo_uca.user_id = source_uca.user_id
      AND demo_uca.role != source_uca.role;

    -- Feature flags the admin has changed on the source since the demo was made.
    PERFORM sync_demo_features(p_source_company_id, p_demo_company_id);
END;
$function$;

COMMENT ON FUNCTION public.sync_demo_access(uuid, uuid) IS
'Lazy convergence of a demo company on its source, called on every entry to an existing demo — from the office Settings page and from the operator "Me" tab. Despite the name it syncs two things: user_company_access (adds members added since, updates changed roles) and settings.features via sync_demo_features. Does not remove members dropped from the source, and does not touch any other settings block. AUTHORIZATION: the pair must be a real source/demo pair (companies.demo_company_id must already point at p_demo_company_id), and a caller with a JWT must be a member of the source company; service_role has no auth.uid() and bypasses the second check by design.';
