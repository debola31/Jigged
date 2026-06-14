-- Retire job_materials consumption tracking in favor of the part BOM.
--
-- Material consumption is no longer tracked on job_materials; the part BOM
-- (parts_bom) is the source of truth and the admin Job page now reads it live.
-- These consumption columns were written only by updateJobMaterial (no caller)
-- and shown only by JobMaterialsCard (never rendered).
--
-- job_materials itself is KEPT as a per-job expected-BOM snapshot
-- (expected_quantity, unit, parts_bom_id, material_part_id), still populated at
-- job creation by create_job_part_operations_from_routing.
--
-- Dropping the columns also drops their dependent objects:
--   - job_materials_actual_quantity_check  (CHECK on actual_quantity)
--   - job_materials_status_check           (CHECK on status)
--   - job_materials_consumed_by_fkey       (FK on consumed_by)

ALTER TABLE "public"."job_materials"
    DROP COLUMN IF EXISTS "actual_quantity",
    DROP COLUMN IF EXISTS "status",
    DROP COLUMN IF EXISTS "consumed_at",
    DROP COLUMN IF EXISTS "consumed_by";
