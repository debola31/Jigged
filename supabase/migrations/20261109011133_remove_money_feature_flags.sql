-- Retire the `dashboard_revenue` and `storage_inventory_cost` feature flags.
--
-- Both were opt-OUT kill-switches over money the UI already showed to admins only: the
-- dashboard scorecards' revenue lines, and the Storage page's inventory cost. They are gone from
-- the registry (lib/featureFlags.ts) and every reader, so the admin-only rule is now the one gate.
--
-- WHY A DATA MIGRATION AND NOT JUST THE CODE CHANGE. `readCompanyFeatures` already drops keys
-- the registry does not know, so a stored `false` would be inert. Inert is not clean: the value
-- would sit in every row that ever toggled the flag, it would be copied verbatim onto demo
-- companies by `sync_demo_features`, and anyone reading `settings` later would have to know
-- it means nothing. Every row satisfies the new shape when this finishes, demo companies included.
--
-- Idempotent: the WHERE matches only rows still carrying either key, and `#-` on a missing path
-- is a no-op.

UPDATE public.companies
   SET settings = settings #- '{features,dashboard_revenue}' #- '{features,storage_inventory_cost}'
 WHERE settings -> 'features' ?| ARRAY['dashboard_revenue', 'storage_inventory_cost'];
