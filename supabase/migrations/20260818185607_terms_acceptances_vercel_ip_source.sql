-- Prefer the one IP header a proxy in front of Vercel cannot overwrite.
--
-- Vercel's request-header documentation settles the question terms_acceptances.
-- ip_source was designed around:
--
--   x-forwarded-for         "we currently OVERWRITE the X-Forwarded-For header
--                            and do not forward external IPs. This restriction
--                            is in place to prevent IP spoofing."
--   x-real-ip               "identical to the x-forwarded-for header."
--   x-vercel-forwarded-for  "identical to x-forwarded-for. HOWEVER,
--                            x-forwarded-for could be overwritten if you're
--                            using a proxy on top of Vercel."
--
-- So a caller CANNOT spoof their address today: Vercel replaces the header
-- rather than appending to it, and honouring a caller's own X-Forwarded-For is a
-- purchased Enterprise "Trusted Proxy" feature that is not enabled here.
--
-- The residual risk is a FUTURE one and cheap to close now: put a CDN or WAF in
-- front of jigged.app and x-forwarded-for -- and therefore x-real-ip -- becomes
-- whatever that proxy writes, while x-vercel-forwarded-for stays Vercel's own
-- observation. For a table whose whole value is that it cannot be influenced by
-- the party it is evidence against, the least-overwritable header is the right
-- default, and recording WHICH header answered is what lets a reader tell the
-- difference years later.
--
-- A separate migration rather than an edit to 20260818142814, deliberately: that
-- one has already been applied to this PR's Supabase preview branch, and editing
-- an applied migration leaves the branch on the old constraint while the diff
-- looks correct.
ALTER TABLE public.terms_acceptances
    DROP CONSTRAINT terms_acceptances_ip_source_check;

ALTER TABLE public.terms_acceptances
    ADD CONSTRAINT terms_acceptances_ip_source_check
    CHECK (ip_source IS NULL
           OR ip_source IN ('x-vercel-forwarded-for', 'x-real-ip',
                            'x-forwarded-for', 'unavailable'));

COMMENT ON COLUMN public.terms_acceptances.ip_source IS
  'Which header the address came from, or "unavailable". Preference order is x-vercel-forwarded-for, then x-real-ip, then x-forwarded-for: the first is the only one a proxy placed in front of Vercel cannot overwrite. Makes the row say "the platform told us X", and separates a genuinely undeterminable address from a bug that dropped one.';
