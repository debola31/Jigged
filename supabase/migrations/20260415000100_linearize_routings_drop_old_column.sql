-- ============================================================================
-- Migration: Drop routing_nodes.materials column (post-linearize cleanup)
-- ============================================================================
--
-- Companion to 20260415_linearize_routings_and_relocate_materials.sql.
-- That migration migrates routing_nodes.materials JSONB → routing_materials
-- table and drops routing_edges. This file does the final cleanup: drop
-- the now-unused routing_nodes.materials column.
--
-- Why a separate migration? The linearize migration ends with
--   DROP TABLE routing_edges CASCADE;
-- which removes FK constraints that reference routing_nodes — and that
-- in turn queues internal trigger events on routing_nodes. Postgres
-- refuses to ALTER TABLE a relation with pending trigger events from
-- earlier statements in the same transaction (error 55006). Splitting
-- the column drop into its own transaction sidesteps the issue.
-- ============================================================================

BEGIN;

ALTER TABLE public.routing_nodes DROP COLUMN IF EXISTS materials;

COMMIT;
