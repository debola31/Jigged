-- Retire three feature flags. Their features become core and unconditional:
--
--   inventory_locations  Storage — the Locations manager + visual builder, the operator Inventory
--                        tab, bin scanning. Already `defaultEnabled: true`, and no tenant in
--                        production had ever stored an explicit `false`, so nothing changes for
--                        anyone. This is a pure key cleanup.
--   machine_maintenance  The per-machine logbook, machine details and manuals. Was opt-in for a
--                        pilot; all three production companies already had it ON, so removing the
--                        flag releases it to nobody new today and to every future company.
--   quickbooks_desktop   The Desktop provider option and the backend /connect endpoint. Was opt-in
--                        at two of three production companies. See the note below — this one has a
--                        cost behind it and the removal was a deliberate decision, not tidying.
--
-- `readCompanyFeatures()` drops keys the registry does not know, so a leftover value is already
-- inert on read. Strip it anyway: a stale key that nothing reads is a trap for the next person who
-- registers a flag under the same name and silently inherits years-old tenant answers. The same
-- argument as 20260819030101_drop_data_import_feature_flag.sql, which is the precedent here.
--
-- WHY THE quickbooks_desktop ROW MATTERS MORE THAN THE OTHER TWO. That flag was enforced in the
-- BACKEND (api/routes/quickbooks_desktop_routes.py) rather than only in the UI, because Conductor
-- bills $49/month per active company file connection — it gated a bill, not an affordance. Removing
-- it makes Desktop self-serve for any company admin, with `verify_company_access(require_admin=True)`
-- as the only remaining check, and that path runs as service-role so the billing write-gate does
-- not apply either. Accepted knowingly; docs/modules/quickbooks-desktop.md carries the standing
-- note on what does and does not fence the cost now.
--
-- NOT A NO-OP TO VERIFY LOCALLY. Every pre-merge gate replays migrations against an EMPTY database,
-- so this UPDATE first does real work in production. Row counts were taken there before merge
-- (project mayuquvexmqjvwkfasxg, 8 companies): 6 rows carry inventory_locations, 6 carry
-- machine_maintenance, 3 carry quickbooks_desktop; ZERO carry inventory_locations = false.
--
-- Object-preserving `#-` rather than a rewrite of `settings`: the column also holds
-- `default_payment_terms`, `custom_payment_terms`, `defaults`, `ai_limits` and `logo_includes_name`,
-- and every writer of this column is read-modify-write.
UPDATE public.companies
SET settings = settings #- '{features,inventory_locations}'
                        #- '{features,machine_maintenance}'
                        #- '{features,quickbooks_desktop}'
WHERE settings #> '{features,inventory_locations}' IS NOT NULL
   OR settings #> '{features,machine_maintenance}' IS NOT NULL
   OR settings #> '{features,quickbooks_desktop}' IS NOT NULL;
