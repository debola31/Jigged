-- Pilot requests from the public showcase page (/showcase): a visitor sends one part file plus an
-- email address, and the Jigged team plans and renders a walkthrough of that part for them.
--
-- WHO TOUCHES WHAT. The browser never talks to this table or this bucket with its own key:
--
--   POST /pilot-requests            (app/pilot-requests/route.ts, service role)
--       validates, rate-limits per email and per IP, inserts the row, and mints a signed upload
--       URL for exactly one object path, `<id>/<file name>`.
--   PUT  <signed upload URL>         (the browser, straight to Storage, with progress)
--       the token authorises that one path; it carries no read or list right.
--   POST /pilot-requests/complete    (app/pilot-requests/complete/route.ts, service role)
--       confirms the object landed, stamps `uploaded_at`, and asks the `notify-pilot-request`
--       Edge Function to email the team. That function claims `notified_at`, so it sends once.
--
-- A NEW TABLE, NOT `waitlist` WITH A SOURCE VALUE. waitlist is UNIQUE on email (a second part from
-- the same person would overwrite the first), its webhook mails the visitor a "we're setting up
-- your shop" welcome that is false here, and `anon` holds INSERT and UPDATE on it. A pilot request
-- has a file, a lifecycle (requested -> uploaded -> notified) and a deletion promise of its own.
--
-- NO `deleted_at`, deliberately, against the archive rule in CLAUDE.md. That rule exists so shop
-- records referenced by documents keep resolving; nothing references a pilot request, nothing in
-- the app lists them, and the form promises the visitor their file is DELETED when they ask. An
-- erasure request is a hard DELETE of the row plus `storage.objects` removal of `storage_path`,
-- done by the team as service role. Archiving would break the promise the visitor was given.
--
-- NO `company_id`, so the billing write-gate does not apply: tenant_tables_missing_write_gate()
-- only inspects tables carrying that column, and the visitor has no company in Jigged anyway.
--
-- NO FUNCTIONS, so nothing here for function_execute_leaks() to flag.

-- ============================================================================
-- 1. The table
-- ============================================================================
CREATE TABLE public.pilot_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL
        CHECK (char_length(email) BETWEEN 3 AND 320
               AND email = lower(btrim(email))
               AND email LIKE '%_@_%'),
    name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 200),
    company_name text CHECK (company_name IS NULL OR char_length(company_name) BETWEEN 1 AND 200),
    note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 4000),
    file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
    file_type text NOT NULL
        CHECK (file_type IN ('step', 'iges', 'parasolid', 'solidworks', 'pdf')),
    -- 50 MiB, the bucket's own limit below, which is the global limit in supabase/config.toml.
    file_size_bytes bigint NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 52428800),
    storage_path text NOT NULL UNIQUE,
    ip_hash text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
    uploaded_at timestamptz,
    notified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- The object lives under the row's own id, so a row can only ever point at its own file.
    CONSTRAINT pilot_requests_storage_path_under_id CHECK (storage_path LIKE id::text || '/_%'),
    -- Nothing is announced before it exists.
    CONSTRAINT pilot_requests_notified_after_upload CHECK (notified_at IS NULL OR uploaded_at IS NOT NULL)
);

-- The two rate-limit reads: "how many from this email / this address in the last day".
CREATE INDEX pilot_requests_email_created_at_idx
    ON public.pilot_requests (email, created_at DESC);
CREATE INDEX pilot_requests_ip_hash_created_at_idx
    ON public.pilot_requests (ip_hash, created_at DESC)
    WHERE ip_hash IS NOT NULL;

COMMENT ON TABLE public.pilot_requests IS
  'Pilot requests from the public /showcase page: one part file plus contact details from a visitor without an account, used only to produce their walkthrough. Service-role only; the browser reaches it through app/pilot-requests/*. Erasure on request is a hard DELETE plus removal of storage_path from the pilot-requests bucket - deliberately not soft-deleted (see the migration header).';
COMMENT ON COLUMN public.pilot_requests.email IS
  'Where the walkthrough link goes. Stored lowercased and trimmed so the per-email rate limit is an equality match.';
COMMENT ON COLUMN public.pilot_requests.name IS 'Optional. Visitor-supplied.';
COMMENT ON COLUMN public.pilot_requests.company_name IS 'Optional. Visitor-supplied.';
COMMENT ON COLUMN public.pilot_requests.note IS 'Optional free text from the visitor about the part.';
COMMENT ON COLUMN public.pilot_requests.file_name IS
  'The file name as the visitor''s computer had it, for the team''s reference. The object key is storage_path.';
COMMENT ON COLUMN public.pilot_requests.file_type IS
  'Format family from the extension (CAD MIME types are unreliable): step = .step/.stp, iges = .igs/.iges, parasolid = .x_t/.x_b, solidworks = .sldprt, pdf = a drawing.';
COMMENT ON COLUMN public.pilot_requests.file_size_bytes IS
  'Declared by the browser at request time, replaced by the stored object''s real size when the upload is confirmed.';
COMMENT ON COLUMN public.pilot_requests.storage_path IS
  'Object key in the private pilot-requests bucket: <id>/<sanitised file name>. Minted by the server, never by the browser.';
COMMENT ON COLUMN public.pilot_requests.ip_hash IS
  'HMAC-SHA256 of the client address, keyed with the server secret, for the per-address rate limit only. Never the address itself. Null when the address could not be determined.';
COMMENT ON COLUMN public.pilot_requests.uploaded_at IS
  'When the server confirmed the object exists. Null means the visitor never finished uploading.';
COMMENT ON COLUMN public.pilot_requests.notified_at IS
  'When notify-pilot-request claimed this row to email the team. The claim (UPDATE ... WHERE notified_at IS NULL) is what makes the email send once.';

-- ============================================================================
-- 2. RLS - enabled, and NO policies
-- ============================================================================
-- Explicit: public.rls_auto_enable() exists locally and on preview branches but never in
-- production. With RLS on and no policy, anon and authenticated are denied every row even if a
-- grant ever appears; service_role bypasses RLS and is the only intended caller.
ALTER TABLE public.pilot_requests ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. Grants - backend-only table
-- ============================================================================
-- anon gets NOTHING, not even INSERT. A visitor does create rows, but only through
-- POST /pilot-requests, which is where the validation, the honeypot and the rate limit live; an
-- anon INSERT grant would let a script skip all three and fill the table directly.
--
-- Named revokes, not REVOKE ALL. 20260716025048 removed only the DML half of the baseline's
-- default privileges, so a new public table still arrives with TRUNCATE, REFERENCES, TRIGGER and
-- MAINTAIN for anon and authenticated (docs/modules/legal-acceptance.md, "The default-privilege
-- trap"), and with SELECT for the insights AI's role. Those are the privileges actually present,
-- so those are the ones revoked.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.pilot_requests FROM anon, authenticated;
REVOKE SELECT ON TABLE public.pilot_requests FROM jigged_ai_readonly;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pilot_requests TO service_role;

-- ============================================================================
-- 4. The bucket - private
-- ============================================================================
--   public = false           - no public URL; an object is reachable only through a signed URL
--                              the service role mints
--   file_size_limit = 50 MiB - supabase/config.toml's global `file_size_limit`. A bucket cannot
--                              usefully exceed the project's global limit; raise both together
--                              if 100 MB parts turn up
--   allowed_mime_types       - the browser always sends one of these two, chosen by the server
--                              from the extension: application/pdf for drawings, and
--                              application/octet-stream for CAD, whose own MIME types are
--                              unreliable. Storage refuses anything else, whatever calls it
--
-- NO POLICIES on storage.objects for this bucket, deliberately: no read, list or write for anon or
-- authenticated. A signed upload URL needs no policy (the token authorises its one path), and
-- the team reads files as service role, from the dashboard.
--
-- ON CONFLICT DO NOTHING so a replay never rewrites a live bucket's settings.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pilot-requests', 'pilot-requests', false, 52428800,
        ARRAY['application/octet-stream', 'application/pdf'])
ON CONFLICT (id) DO NOTHING;
