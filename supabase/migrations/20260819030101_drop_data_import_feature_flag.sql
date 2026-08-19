-- The guided data importer (/dashboard/{companyId}/import) is now a global feature, not a
-- per-tenant opt-in: the per-entity CSV wizards it replaced are gone, so gating it would
-- leave a shop with no way to import at all. `data_import` is therefore removed from
-- KNOWN_FEATURES in lib/featureFlags.ts.
--
-- readCompanyFeatures() drops keys the registry does not know, so a leftover value is
-- already inert. Strip it anyway: a stale key that nothing reads is a trap for the next
-- person who registers a flag under the same name and inherits years-old tenant answers.
UPDATE public.companies
SET settings = settings #- '{features,data_import}'
WHERE settings #> '{features,data_import}' IS NOT NULL;
