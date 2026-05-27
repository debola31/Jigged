-- Clean up pilot-customer references from COMMENT ON COLUMN metadata.
--
-- Why: PR 1 (#300) scrubbed pilot-customer names ("Contour", "Shane") from
-- application code, docs, marketing pages, and test fixtures. The COMMENT
-- statements that ship to pg_description were deferred at the time because
-- updating them requires a new migration. This migration closes that gap.
--
-- Three columns are affected. The substance of each comment is preserved;
-- only the customer-specific identifiers and the pilot-derived statistic
-- (98.6%) are removed.
--
-- Verification after apply:
--   SELECT * FROM pg_description WHERE description ILIKE '%contour%' OR description ILIKE '%shane%';
-- Expected: zero rows.

COMMENT ON COLUMN public.companies.name
    IS 'Display name of the company/shop. Example: "Acme Precision Machining".';

COMMENT ON COLUMN public.companies.slug
    IS 'URL-friendly unique identifier. Used in routes like /dashboard/{slug}/. Example: "acme-precision".';

COMMENT ON COLUMN public.routing_operations.labor_rate_override
    IS 'Per-step override of the work_center labor_rate, in dollars per hour. Dominant pattern in real shop data: internal ops typically override the work-center default rather than inherit it. NULL = inherit work_center.labor_rate. Used for kind=internal only.';
