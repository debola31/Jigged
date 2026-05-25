-- Make user_company_access.email + .name actually populated.
--
-- Today the team edge function enriches GET responses by joining auth.users
-- with the service role, and the accept-invite flow PATCHes a `name` field —
-- but the `email` column on user_company_access is never written by any code
-- path. Browser-side reads (e.g. quote detail's "Created by" lookup in
-- getQuoteWithRelations) hit user_company_access directly and therefore see
-- NULL email, hiding the creator on every quote.
--
-- Founding users who never accepted an invitation likewise have empty `name`
-- because only the accept-invite flow writes that column.
--
-- Fix:
--   1. Backfill email from auth.users for every existing access row.
--   2. Backfill name from auth.users.raw_user_meta_data when the access row's
--      name is empty.
--   3. Add a BEFORE INSERT trigger so any future row created via RPC, edge
--      function, or direct INSERT auto-populates email from auth.users.

-- 1) Backfill email
UPDATE public.user_company_access uca
SET email = u.email
FROM auth.users u
WHERE uca.user_id = u.id
  AND u.email IS NOT NULL
  AND (uca.email IS NULL OR uca.email = '');

-- 2) Backfill name from auth metadata where empty
UPDATE public.user_company_access uca
SET name = COALESCE(
  NULLIF(u.raw_user_meta_data->>'display_name', ''),
  NULLIF(
    TRIM(BOTH ' ' FROM CONCAT(
      COALESCE(u.raw_user_meta_data->>'first_name', ''),
      ' ',
      COALESCE(u.raw_user_meta_data->>'last_name', '')
    )),
    ''
  ),
  NULLIF(u.raw_user_meta_data->>'full_name', ''),
  NULLIF(u.raw_user_meta_data->>'name', '')
)
FROM auth.users u
WHERE uca.user_id = u.id
  AND (uca.name IS NULL OR uca.name = '')
  AND COALESCE(
    NULLIF(u.raw_user_meta_data->>'display_name', ''),
    NULLIF(u.raw_user_meta_data->>'first_name', ''),
    NULLIF(u.raw_user_meta_data->>'full_name', ''),
    NULLIF(u.raw_user_meta_data->>'name', '')
  ) IS NOT NULL;

-- 3) BEFORE INSERT trigger: populate email from auth.users when not provided.
--    SECURITY DEFINER so it can read auth.users regardless of caller.
CREATE OR REPLACE FUNCTION public.user_company_access_fill_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NEW.email IS NULL OR NEW.email = '' THEN
    SELECT email INTO NEW.email FROM auth.users WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_company_access_fill_email_trg
  ON public.user_company_access;
CREATE TRIGGER user_company_access_fill_email_trg
BEFORE INSERT ON public.user_company_access
FOR EACH ROW
EXECUTE FUNCTION public.user_company_access_fill_email();

COMMENT ON FUNCTION public.user_company_access_fill_email() IS
  'Auto-populates user_company_access.email from auth.users on insert when the caller did not provide it. Without this, browser-side reads of the column return NULL and "Created by" UIs go blank.';
