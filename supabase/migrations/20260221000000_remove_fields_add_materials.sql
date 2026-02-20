-- Migration: Remove customer_code, material_cost, setup_time; Add materials to routing_nodes
-- Date: 2026-02-21

BEGIN;

-- ============================================================
-- 1. Remove customer_code from customers
-- ============================================================

-- Drop the unique constraint on (company_id, customer_code)
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_company_code_unique;

-- Drop the index on customer_code
DROP INDEX IF EXISTS idx_customers_code;

-- Drop the column
ALTER TABLE customers DROP COLUMN IF EXISTS customer_code;

-- Add unique constraint on (company_id, name)
ALTER TABLE customers ADD CONSTRAINT customers_company_name_unique UNIQUE (company_id, name);

-- ============================================================
-- 2. Remove material_cost from parts
-- ============================================================

ALTER TABLE parts DROP COLUMN IF EXISTS material_cost;

-- ============================================================
-- 3. Remove setup_time from routing_nodes, add materials
-- ============================================================

ALTER TABLE routing_nodes DROP COLUMN IF EXISTS setup_time;

-- Add materials JSONB column (array of {inventory_item_id, quantity, unit})
ALTER TABLE routing_nodes ADD COLUMN IF NOT EXISTS materials jsonb DEFAULT '[]'::jsonb;

COMMIT;
