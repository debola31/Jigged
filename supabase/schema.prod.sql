-- ============================================================
-- Jigged Manufacturing ERP - Database Schema
-- Generated: 2026-05-03T20:01:29Z
-- Schemas: public, storage
-- ============================================================

BEGIN;


-- ============================================================
-- 2. TABLES (ordered by foreign key dependencies)
-- ============================================================
CREATE TABLE IF NOT EXISTS "public"."companies"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "slug" text,
    "settings" jsonb DEFAULT '{}'::jsonb,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "is_demo" boolean DEFAULT false,
    "demo_company_id" uuid,
    "logo_url" text,
    "phone" text,
    "email" text,
    "website" text,
    "address_line1" text,
    "address_line2" text,
    "city" text,
    "state" text,
    "postal_code" text,
    "country" text,
    CONSTRAINT "companies_pkey" PRIMARY KEY (id),
    CONSTRAINT "companies_slug_key" UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS "public"."ai_chat_queries"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "user_id" uuid,
    "question" text NOT NULL,
    "tool_calls" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "response" text NOT NULL,
    "chart_config" jsonb,
    "provider" character varying(20) NOT NULL,
    "model" character varying(50),
    "tokens_used" integer,
    "duration_ms" integer,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "ai_chat_queries_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "public"."ai_config"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "feature" text NOT NULL,
    "provider" text NOT NULL DEFAULT 'anthropic'::text,
    "model" text,
    "settings" jsonb DEFAULT '{}'::jsonb,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "ai_config_pkey" PRIMARY KEY (id),
    CONSTRAINT "ai_config_unique_company_feature" UNIQUE (company_id, feature)
);

CREATE TABLE IF NOT EXISTS "public"."company_custom_units"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "unit_name" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "company_custom_units_pkey" PRIMARY KEY (id),
    CONSTRAINT "company_custom_units_company_id_unit_name_key" UNIQUE (company_id, unit_name)
);

CREATE TABLE IF NOT EXISTS "public"."customers"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "name" text NOT NULL,
    "website" text,
    "contact_name" text,
    "contact_phone" text,
    "contact_email" text,
    "address_line1" text,
    "address_line2" text,
    "city" text,
    "state" text,
    "postal_code" text,
    "country" text DEFAULT 'USA'::text,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "customers_pkey" PRIMARY KEY (id),
    CONSTRAINT "customers_company_name_unique" UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS "public"."demo_data_templates"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "name" character varying(100) NOT NULL,
    "version" integer NOT NULL DEFAULT 1,
    "is_active" boolean DEFAULT false,
    "template_data" jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now(),
    "created_by" uuid,
    CONSTRAINT "demo_templates_pkey" PRIMARY KEY (id),
    CONSTRAINT "demo_templates_name_version_key" UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS "public"."inventory_items"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "primary_unit" text NOT NULL,
    "quantity" numeric NOT NULL DEFAULT 0,
    "cost_per_unit" numeric(12,4),
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "reorder_point" numeric,
    CONSTRAINT "inventory_items_pkey" PRIMARY KEY (id),
    CONSTRAINT "inventory_items_quantity_non_negative" CHECK ((quantity >= (0)::numeric))
);

CREATE TABLE IF NOT EXISTS "public"."inventory_unit_conversions"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "inventory_item_id" uuid NOT NULL,
    "from_unit" text NOT NULL,
    "to_primary_factor" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "inventory_unit_conversions_pkey" PRIMARY KEY (id),
    CONSTRAINT "inventory_unit_conversions_item_unit_unique" UNIQUE (inventory_item_id, from_unit),
    CONSTRAINT "inventory_unit_conversions_factor_positive" CHECK ((to_primary_factor > (0)::numeric))
);

CREATE TABLE IF NOT EXISTS "public"."invitations"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "email" character varying(255) NOT NULL,
    "role" character varying(50) NOT NULL,
    "status" character varying(20) DEFAULT 'pending'::character varying,
    "invited_by" uuid NOT NULL,
    "accepted_by" uuid,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT now(),
    "accepted_at" timestamp with time zone,
    CONSTRAINT "invitations_pkey" PRIMARY KEY (id),
    CONSTRAINT "invitations_role_check" CHECK (((role)::text = ANY ((ARRAY['admin'::character varying, 'user'::character varying, 'operator'::character varying])::text[]))),
    CONSTRAINT "invitations_status_check" CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'expired'::character varying, 'revoked'::character varying])::text[])))
);

CREATE TABLE IF NOT EXISTS "public"."markup_rates"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "name" text NOT NULL,
    "breakpoints" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    "is_default" boolean NOT NULL DEFAULT false,
    CONSTRAINT "markup_rates_pkey" PRIMARY KEY (id),
    CONSTRAINT "markup_rates_name_unique_per_company" UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS "public"."operation_types"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "name" text NOT NULL,
    "labor_rate" numeric(10,2),
    "description" text,
    "metadata" jsonb DEFAULT '{}'::jsonb,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "operation_types_pkey" PRIMARY KEY (id),
    CONSTRAINT "operation_types_company_id_name_key" UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS "public"."parts"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "part_name" text NOT NULL,
    "description" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    "markup_rate_id" uuid,
    CONSTRAINT "parts_pkey" PRIMARY KEY (id),
    CONSTRAINT "parts_unique_per_company" UNIQUE (company_id, part_name)
);

CREATE TABLE IF NOT EXISTS "public"."part_pricing_tiers"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "part_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "sequence" integer NOT NULL,
    "quantity" integer NOT NULL,
    "base_cost_per_unit" numeric(12,4),
    "markup_percent" numeric(5,2),
    "unit_price" numeric(12,4),
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "part_pricing_tiers_pkey" PRIMARY KEY (id),
    CONSTRAINT "part_pricing_tiers_unique_seq" UNIQUE (part_id, sequence),
    CONSTRAINT "part_pricing_tiers_quantity_check" CHECK ((quantity > 0))
);

CREATE TABLE IF NOT EXISTS "public"."quotes"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "quote_number" text NOT NULL,
    "customer_id" uuid,
    "status" text NOT NULL DEFAULT 'active'::text,
    "status_changed_at" timestamp with time zone,
    "converted_at" timestamp with time zone,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "lead_time_days" integer,
    "expiration_date" date,
    CONSTRAINT "quotes_pkey" PRIMARY KEY (id),
    CONSTRAINT "quotes_company_id_quote_number_key" UNIQUE (company_id, quote_number),
    CONSTRAINT "quotes_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."jobs"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "job_number" text NOT NULL,
    "quote_id" uuid,
    "customer_id" uuid,
    "status" text NOT NULL DEFAULT 'not_started'::text,
    "status_changed_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "shipped_at" timestamp with time zone,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "due_date" date,
    "lead_time_days" integer,
    CONSTRAINT "jobs_pkey" PRIMARY KEY (id),
    CONSTRAINT "jobs_company_id_job_number_key" UNIQUE (company_id, job_number),
    CONSTRAINT "jobs_status_check" CHECK ((status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text, 'shipped'::text, 'cancelled'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."quote_line_items"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "quote_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "part_id" uuid NOT NULL,
    "source_tier_id" uuid,
    "sequence" integer NOT NULL,
    "quantity" integer NOT NULL,
    "unit_price" numeric(12,4) NOT NULL,
    "total_price" numeric(12,4),
    "markup_percent" numeric(5,2),
    "base_cost_per_unit" numeric(12,4),
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "is_quote_override" boolean NOT NULL DEFAULT false,
    CONSTRAINT "quote_line_items_pkey" PRIMARY KEY (id),
    CONSTRAINT "quote_line_items_unique_seq" UNIQUE (quote_id, sequence),
    CONSTRAINT "quote_line_items_quantity_check" CHECK ((quantity > 0))
);

CREATE TABLE IF NOT EXISTS "public"."job_parts"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "job_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "part_id" uuid NOT NULL,
    "source_quote_line_item_id" uuid,
    "sequence" integer NOT NULL,
    "quantity" integer NOT NULL,
    "status" text NOT NULL DEFAULT 'not_started'::text,
    "status_changed_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "shipped_at" timestamp with time zone,
    "current_operation_sequence" integer,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "job_parts_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_parts_job_part_unique" UNIQUE (job_id, part_id),
    CONSTRAINT "job_parts_job_sequence_unique" UNIQUE (job_id, sequence),
    CONSTRAINT "job_parts_quantity_check" CHECK ((quantity > 0)),
    CONSTRAINT "job_parts_status_check" CHECK ((status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text, 'shipped'::text, 'cancelled'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."quote_materials"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "quote_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "sequence" integer NOT NULL,
    "inventory_item_id" uuid,
    "item_name" text NOT NULL,
    "quantity" numeric NOT NULL,
    "unit" text,
    "cost_per_unit" numeric,
    "line_cost" numeric,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "part_id" uuid NOT NULL,
    CONSTRAINT "quote_materials_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "public"."quote_operations"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "quote_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "sequence" integer NOT NULL,
    "operation_name" text NOT NULL,
    "run_time_minutes" numeric,
    "setup_time_minutes" numeric,
    "labor_rate" numeric,
    "run_cost" numeric,
    "setup_cost" numeric,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "part_id" uuid NOT NULL,
    CONSTRAINT "quote_operations_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "public"."routings"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "part_id" uuid NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "routings_pkey" PRIMARY KEY (id),
    CONSTRAINT "routings_part_id_unique" UNIQUE (part_id)
);

CREATE TABLE IF NOT EXISTS "public"."routing_materials"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "routing_id" uuid NOT NULL,
    "inventory_item_id" uuid NOT NULL,
    "quantity" numeric NOT NULL,
    "unit" text NOT NULL,
    "sequence" integer NOT NULL DEFAULT 0,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "routing_materials_pkey" PRIMARY KEY (id),
    CONSTRAINT "routing_materials_routing_sequence_unique" UNIQUE (routing_id, sequence),
    CONSTRAINT "routing_materials_quantity_check" CHECK ((quantity > (0)::numeric))
);

CREATE TABLE IF NOT EXISTS "public"."job_materials"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "job_id" uuid NOT NULL,
    "routing_material_id" uuid,
    "inventory_item_id" uuid NOT NULL,
    "expected_quantity" numeric NOT NULL DEFAULT 0,
    "actual_quantity" numeric,
    "unit" text NOT NULL,
    "status" text NOT NULL DEFAULT 'pending'::text,
    "consumed_at" timestamp with time zone,
    "consumed_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    "job_part_id" uuid NOT NULL,
    CONSTRAINT "job_materials_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_materials_actual_quantity_check" CHECK (((actual_quantity IS NULL) OR (actual_quantity >= (0)::numeric))),
    CONSTRAINT "job_materials_expected_quantity_check" CHECK ((expected_quantity >= (0)::numeric)),
    CONSTRAINT "job_materials_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'consumed'::text, 'skipped'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."routing_nodes"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "routing_id" uuid NOT NULL,
    "operation_type_id" uuid NOT NULL,
    "run_time_per_unit" numeric,
    "metadata" jsonb DEFAULT '{}'::jsonb,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "setup_time" numeric DEFAULT 0,
    "sequence" integer NOT NULL DEFAULT 0,
    CONSTRAINT "routing_nodes_pkey" PRIMARY KEY (id),
    CONSTRAINT "routing_nodes_routing_sequence_unique" UNIQUE (routing_id, sequence)
);

CREATE TABLE IF NOT EXISTS "public"."job_operations"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "job_id" uuid NOT NULL,
    "sequence" integer NOT NULL,
    "operation_name" text NOT NULL,
    "operation_type_id" uuid,
    "estimated_setup_minutes" numeric(8,2) DEFAULT 0,
    "estimated_run_minutes_per_unit" numeric(8,4) DEFAULT 0,
    "actual_setup_minutes" numeric(8,2),
    "actual_run_minutes" numeric(8,2),
    "status" text NOT NULL DEFAULT 'pending'::text,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "assigned_to" uuid,
    "completed_by" uuid,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "routing_node_id" uuid,
    "job_part_id" uuid NOT NULL,
    CONSTRAINT "job_operations_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_operations_job_part_sequence_key" UNIQUE (job_part_id, sequence),
    CONSTRAINT "job_operations_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'skipped'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."inventory_transactions"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "inventory_item_id" uuid,
    "item_name" text NOT NULL,
    "type" text NOT NULL,
    "quantity" numeric NOT NULL,
    "unit" text NOT NULL,
    "converted_quantity" numeric NOT NULL,
    "job_id" uuid,
    "job_operation_id" uuid,
    "operator_id" uuid,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT now(),
    "created_by" uuid,
    "has_discrepancy" boolean NOT NULL DEFAULT false,
    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY (id),
    CONSTRAINT "inventory_transactions_quantity_positive" CHECK ((quantity >= (0)::numeric)),
    CONSTRAINT "inventory_transactions_type_check" CHECK ((type = ANY (ARRAY['addition'::text, 'depletion'::text, 'adjustment'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."operator_sessions"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "operator_id" uuid NOT NULL,
    "job_id" uuid NOT NULL,
    "job_operation_id" uuid,
    "operation_type_id" uuid NOT NULL,
    "started_at" timestamp with time zone DEFAULT now(),
    "ended_at" timestamp with time zone,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "operator_sessions_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "public"."saved_insights"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "question" text NOT NULL,
    "answer" text NOT NULL,
    "chart_config" jsonb,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "saved_insights_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "public"."system_admins"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL,
    "created_at" timestamp with time zone DEFAULT now(),
    "created_by" uuid,
    CONSTRAINT "system_admins_pkey" PRIMARY KEY (id),
    CONSTRAINT "system_admins_user_id_key" UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS "public"."user_company_access"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "role" text DEFAULT 'operator'::text,
    "created_at" timestamp with time zone DEFAULT now(),
    "name" text,
    "pin_hash" text,
    "email" text,
    CONSTRAINT "user_company_access_pkey" PRIMARY KEY (id),
    CONSTRAINT "user_company_access_user_id_company_id_key" UNIQUE (user_id, company_id),
    CONSTRAINT "user_company_access_role_check" CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text, 'operator'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."user_preferences"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL,
    "last_company_id" uuid,
    "preferences" jsonb DEFAULT '{}'::jsonb,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "user_preferences_pkey" PRIMARY KEY (id),
    CONSTRAINT "user_preferences_user_id_key" UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS "public"."waitlist"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "email" text NOT NULL,
    "name" text,
    "company_name" text,
    "shop_size" text,
    "status" text NOT NULL DEFAULT 'pending'::text,
    "source" text DEFAULT 'landing_page'::text,
    "created_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "waitlist_pkey" PRIMARY KEY (id),
    CONSTRAINT "waitlist_email_unique" UNIQUE (email)
);

-- ============================================================
-- 3. ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE "public"."ai_chat_queries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ai_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."company_custom_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."demo_data_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."inventory_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."inventory_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."inventory_unit_conversions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."markup_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."operation_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."operator_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."part_pricing_tiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quote_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quote_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quote_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."routing_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."routing_nodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."routings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."saved_insights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."system_admins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."user_company_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."user_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."waitlist" ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. RLS POLICIES
-- ============================================================
DROP POLICY IF EXISTS "Users can insert chat queries for own company" ON "public"."ai_chat_queries";
CREATE POLICY "Users can insert chat queries for own company"
    ON "public"."ai_chat_queries"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE ((user_company_access.user_id = auth.uid()) AND (user_company_access.role = ANY (ARRAY['admin'::text, 'user'::text]))))));

DROP POLICY IF EXISTS "Users can read own company chat history" ON "public"."ai_chat_queries";
CREATE POLICY "Users can read own company chat history"
    ON "public"."ai_chat_queries"
    FOR SELECT
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE ((user_company_access.user_id = auth.uid()) AND (user_company_access.role = ANY (ARRAY['admin'::text, 'user'::text]))))));

DROP POLICY IF EXISTS "Admins can delete AI config" ON "public"."ai_config";
CREATE POLICY "Admins can delete AI config"
    ON "public"."ai_config"
    FOR DELETE
    USING (is_company_admin(company_id));

DROP POLICY IF EXISTS "Admins can insert AI config" ON "public"."ai_config";
CREATE POLICY "Admins can insert AI config"
    ON "public"."ai_config"
    FOR INSERT
    WITH CHECK (is_company_admin(company_id));

DROP POLICY IF EXISTS "Admins can update AI config" ON "public"."ai_config";
CREATE POLICY "Admins can update AI config"
    ON "public"."ai_config"
    FOR UPDATE
    USING (is_company_admin(company_id));

DROP POLICY IF EXISTS "Users can view their company's AI config" ON "public"."ai_config";
CREATE POLICY "Users can view their company's AI config"
    ON "public"."ai_config"
    FOR SELECT
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "Admins can update companies" ON "public"."companies";
CREATE POLICY "Admins can update companies"
    ON "public"."companies"
    FOR UPDATE
    USING (is_company_admin(id));

DROP POLICY IF EXISTS "Users can create companies" ON "public"."companies";
CREATE POLICY "Users can create companies"
    ON "public"."companies"
    FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view their companies" ON "public"."companies";
CREATE POLICY "Users can view their companies"
    ON "public"."companies"
    FOR SELECT
    USING ((id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."companies";
CREATE POLICY "ai_readonly_select"
    ON "public"."companies"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "Users can delete company_custom_units" ON "public"."company_custom_units";
CREATE POLICY "Users can delete company_custom_units"
    ON "public"."company_custom_units"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert company_custom_units" ON "public"."company_custom_units";
CREATE POLICY "Users can insert company_custom_units"
    ON "public"."company_custom_units"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view company_custom_units" ON "public"."company_custom_units";
CREATE POLICY "Users can view company_custom_units"
    ON "public"."company_custom_units"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can delete customers" ON "public"."customers";
CREATE POLICY "Users can delete customers"
    ON "public"."customers"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert customers" ON "public"."customers";
CREATE POLICY "Users can insert customers"
    ON "public"."customers"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update customers" ON "public"."customers";
CREATE POLICY "Users can update customers"
    ON "public"."customers"
    FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view customers" ON "public"."customers";
CREATE POLICY "Users can view customers"
    ON "public"."customers"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."customers";
CREATE POLICY "ai_readonly_select"
    ON "public"."customers"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "All authenticated users can read active templates" ON "public"."demo_data_templates";
CREATE POLICY "All authenticated users can read active templates"
    ON "public"."demo_data_templates"
    FOR SELECT
    USING ((is_active = true));

DROP POLICY IF EXISTS "System admins can manage demo_data_templates" ON "public"."demo_data_templates";
CREATE POLICY "System admins can manage demo_data_templates"
    ON "public"."demo_data_templates"
    FOR ALL
    USING (is_system_admin(auth.uid()));

DROP POLICY IF EXISTS "Users can delete inventory_items" ON "public"."inventory_items";
CREATE POLICY "Users can delete inventory_items"
    ON "public"."inventory_items"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert inventory_items" ON "public"."inventory_items";
CREATE POLICY "Users can insert inventory_items"
    ON "public"."inventory_items"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update inventory_items" ON "public"."inventory_items";
CREATE POLICY "Users can update inventory_items"
    ON "public"."inventory_items"
    FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view inventory_items" ON "public"."inventory_items";
CREATE POLICY "Users can view inventory_items"
    ON "public"."inventory_items"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."inventory_items";
CREATE POLICY "ai_readonly_select"
    ON "public"."inventory_items"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "Users can insert inventory_transactions" ON "public"."inventory_transactions";
CREATE POLICY "Users can insert inventory_transactions"
    ON "public"."inventory_transactions"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update inventory_transaction_notes" ON "public"."inventory_transactions";
CREATE POLICY "Users can update inventory_transaction_notes"
    ON "public"."inventory_transactions"
    FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view inventory_transactions" ON "public"."inventory_transactions";
CREATE POLICY "Users can view inventory_transactions"
    ON "public"."inventory_transactions"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."inventory_transactions";
CREATE POLICY "ai_readonly_select"
    ON "public"."inventory_transactions"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "Users can delete inventory_unit_conversions" ON "public"."inventory_unit_conversions";
CREATE POLICY "Users can delete inventory_unit_conversions"
    ON "public"."inventory_unit_conversions"
    FOR DELETE
    USING ((inventory_item_id IN ( SELECT inventory_items.id
   FROM inventory_items
  WHERE (inventory_items.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert inventory_unit_conversions" ON "public"."inventory_unit_conversions";
CREATE POLICY "Users can insert inventory_unit_conversions"
    ON "public"."inventory_unit_conversions"
    FOR INSERT
    WITH CHECK ((inventory_item_id IN ( SELECT inventory_items.id
   FROM inventory_items
  WHERE (inventory_items.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update inventory_unit_conversions" ON "public"."inventory_unit_conversions";
CREATE POLICY "Users can update inventory_unit_conversions"
    ON "public"."inventory_unit_conversions"
    FOR UPDATE
    USING ((inventory_item_id IN ( SELECT inventory_items.id
   FROM inventory_items
  WHERE (inventory_items.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view inventory_unit_conversions" ON "public"."inventory_unit_conversions";
CREATE POLICY "Users can view inventory_unit_conversions"
    ON "public"."inventory_unit_conversions"
    FOR SELECT
    USING ((inventory_item_id IN ( SELECT inventory_items.id
   FROM inventory_items
  WHERE (inventory_items.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."inventory_unit_conversions";
CREATE POLICY "ai_readonly_select"
    ON "public"."inventory_unit_conversions"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM inventory_items
  WHERE ((inventory_items.id = inventory_unit_conversions.inventory_item_id) AND (inventory_items.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

DROP POLICY IF EXISTS "Admins can manage invitations" ON "public"."invitations";
CREATE POLICY "Admins can manage invitations"
    ON "public"."invitations"
    FOR ALL
    USING (is_company_admin(company_id));

DROP POLICY IF EXISTS "Users can read invitations for their email" ON "public"."invitations";
CREATE POLICY "Users can read invitations for their email"
    ON "public"."invitations"
    FOR SELECT
    USING (((email)::text = (( SELECT users.email
   FROM auth.users
  WHERE (users.id = auth.uid())))::text));

DROP POLICY IF EXISTS "Users can delete job_materials" ON "public"."job_materials";
CREATE POLICY "Users can delete job_materials"
    ON "public"."job_materials"
    FOR DELETE
    USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert job_materials" ON "public"."job_materials";
CREATE POLICY "Users can insert job_materials"
    ON "public"."job_materials"
    FOR INSERT
    WITH CHECK ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update job_materials" ON "public"."job_materials";
CREATE POLICY "Users can update job_materials"
    ON "public"."job_materials"
    FOR UPDATE
    USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view job_materials" ON "public"."job_materials";
CREATE POLICY "Users can view job_materials"
    ON "public"."job_materials"
    FOR SELECT
    USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."job_materials";
CREATE POLICY "ai_readonly_select"
    ON "public"."job_materials"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM jobs
  WHERE ((jobs.id = job_materials.job_id) AND (jobs.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

DROP POLICY IF EXISTS "Users can delete job_operations" ON "public"."job_operations";
CREATE POLICY "Users can delete job_operations"
    ON "public"."job_operations"
    FOR DELETE
    USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert job_operations" ON "public"."job_operations";
CREATE POLICY "Users can insert job_operations"
    ON "public"."job_operations"
    FOR INSERT
    WITH CHECK ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update job_operations" ON "public"."job_operations";
CREATE POLICY "Users can update job_operations"
    ON "public"."job_operations"
    FOR UPDATE
    USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view job_operations" ON "public"."job_operations";
CREATE POLICY "Users can view job_operations"
    ON "public"."job_operations"
    FOR SELECT
    USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."job_operations";
CREATE POLICY "ai_readonly_select"
    ON "public"."job_operations"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM jobs
  WHERE ((jobs.id = job_operations.job_id) AND (jobs.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

DROP POLICY IF EXISTS "Users can delete job_parts" ON "public"."job_parts";
CREATE POLICY "Users can delete job_parts"
    ON "public"."job_parts"
    FOR DELETE
    USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert job_parts" ON "public"."job_parts";
CREATE POLICY "Users can insert job_parts"
    ON "public"."job_parts"
    FOR INSERT
    WITH CHECK ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update job_parts" ON "public"."job_parts";
CREATE POLICY "Users can update job_parts"
    ON "public"."job_parts"
    FOR UPDATE
    USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view job_parts" ON "public"."job_parts";
CREATE POLICY "Users can view job_parts"
    ON "public"."job_parts"
    FOR SELECT
    USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."job_parts";
CREATE POLICY "ai_readonly_select"
    ON "public"."job_parts"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM jobs
  WHERE ((jobs.id = job_parts.job_id) AND (jobs.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

DROP POLICY IF EXISTS "Users can delete jobs" ON "public"."jobs";
CREATE POLICY "Users can delete jobs"
    ON "public"."jobs"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert jobs" ON "public"."jobs";
CREATE POLICY "Users can insert jobs"
    ON "public"."jobs"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update jobs" ON "public"."jobs";
CREATE POLICY "Users can update jobs"
    ON "public"."jobs"
    FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view jobs" ON "public"."jobs";
CREATE POLICY "Users can view jobs"
    ON "public"."jobs"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."jobs";
CREATE POLICY "ai_readonly_select"
    ON "public"."jobs"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."markup_rates";
CREATE POLICY "ai_readonly_select"
    ON "public"."markup_rates"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "markup_rates_delete" ON "public"."markup_rates";
CREATE POLICY "markup_rates_delete"
    ON "public"."markup_rates"
    FOR DELETE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "markup_rates_insert" ON "public"."markup_rates";
CREATE POLICY "markup_rates_insert"
    ON "public"."markup_rates"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "markup_rates_select" ON "public"."markup_rates";
CREATE POLICY "markup_rates_select"
    ON "public"."markup_rates"
    FOR SELECT
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "markup_rates_update" ON "public"."markup_rates";
CREATE POLICY "markup_rates_update"
    ON "public"."markup_rates"
    FOR UPDATE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."operation_types";
CREATE POLICY "ai_readonly_select"
    ON "public"."operation_types"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "operation_types_delete" ON "public"."operation_types";
CREATE POLICY "operation_types_delete"
    ON "public"."operation_types"
    FOR DELETE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "operation_types_insert" ON "public"."operation_types";
CREATE POLICY "operation_types_insert"
    ON "public"."operation_types"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "operation_types_select" ON "public"."operation_types";
CREATE POLICY "operation_types_select"
    ON "public"."operation_types"
    FOR SELECT
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "operation_types_update" ON "public"."operation_types";
CREATE POLICY "operation_types_update"
    ON "public"."operation_types"
    FOR UPDATE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "Admins can delete company sessions" ON "public"."operator_sessions";
CREATE POLICY "Admins can delete company sessions"
    ON "public"."operator_sessions"
    FOR DELETE
    USING (is_company_admin(company_id));

DROP POLICY IF EXISTS "Admins can read company sessions" ON "public"."operator_sessions";
CREATE POLICY "Admins can read company sessions"
    ON "public"."operator_sessions"
    FOR SELECT
    USING (is_company_admin(company_id));

DROP POLICY IF EXISTS "Operators can insert own sessions" ON "public"."operator_sessions";
CREATE POLICY "Operators can insert own sessions"
    ON "public"."operator_sessions"
    FOR INSERT
    WITH CHECK ((operator_id = get_operator_access_id(company_id)));

DROP POLICY IF EXISTS "Operators can read own sessions" ON "public"."operator_sessions";
CREATE POLICY "Operators can read own sessions"
    ON "public"."operator_sessions"
    FOR SELECT
    USING ((operator_id = get_operator_access_id(company_id)));

DROP POLICY IF EXISTS "Operators can update own sessions" ON "public"."operator_sessions";
CREATE POLICY "Operators can update own sessions"
    ON "public"."operator_sessions"
    FOR UPDATE
    USING ((operator_id = get_operator_access_id(company_id)))
    WITH CHECK ((operator_id = get_operator_access_id(company_id)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."operator_sessions";
CREATE POLICY "ai_readonly_select"
    ON "public"."operator_sessions"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."part_pricing_tiers";
CREATE POLICY "ai_readonly_select"
    ON "public"."part_pricing_tiers"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "part_pricing_tiers_delete" ON "public"."part_pricing_tiers";
CREATE POLICY "part_pricing_tiers_delete"
    ON "public"."part_pricing_tiers"
    FOR DELETE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "part_pricing_tiers_insert" ON "public"."part_pricing_tiers";
CREATE POLICY "part_pricing_tiers_insert"
    ON "public"."part_pricing_tiers"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "part_pricing_tiers_select" ON "public"."part_pricing_tiers";
CREATE POLICY "part_pricing_tiers_select"
    ON "public"."part_pricing_tiers"
    FOR SELECT
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "part_pricing_tiers_update" ON "public"."part_pricing_tiers";
CREATE POLICY "part_pricing_tiers_update"
    ON "public"."part_pricing_tiers"
    FOR UPDATE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "Users can delete parts for their companies" ON "public"."parts";
CREATE POLICY "Users can delete parts for their companies"
    ON "public"."parts"
    FOR DELETE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "Users can insert parts for their companies" ON "public"."parts";
CREATE POLICY "Users can insert parts for their companies"
    ON "public"."parts"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "Users can update parts for their companies" ON "public"."parts";
CREATE POLICY "Users can update parts for their companies"
    ON "public"."parts"
    FOR UPDATE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "Users can view parts for their companies" ON "public"."parts";
CREATE POLICY "Users can view parts for their companies"
    ON "public"."parts"
    FOR SELECT
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."parts";
CREATE POLICY "ai_readonly_select"
    ON "public"."parts"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."quote_line_items";
CREATE POLICY "ai_readonly_select"
    ON "public"."quote_line_items"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "quote_line_items_delete" ON "public"."quote_line_items";
CREATE POLICY "quote_line_items_delete"
    ON "public"."quote_line_items"
    FOR DELETE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "quote_line_items_insert" ON "public"."quote_line_items";
CREATE POLICY "quote_line_items_insert"
    ON "public"."quote_line_items"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "quote_line_items_select" ON "public"."quote_line_items";
CREATE POLICY "quote_line_items_select"
    ON "public"."quote_line_items"
    FOR SELECT
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "quote_line_items_update" ON "public"."quote_line_items";
CREATE POLICY "quote_line_items_update"
    ON "public"."quote_line_items"
    FOR UPDATE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."quote_materials";
CREATE POLICY "ai_readonly_select"
    ON "public"."quote_materials"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "quote_materials_delete" ON "public"."quote_materials";
CREATE POLICY "quote_materials_delete"
    ON "public"."quote_materials"
    FOR DELETE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "quote_materials_insert" ON "public"."quote_materials";
CREATE POLICY "quote_materials_insert"
    ON "public"."quote_materials"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "quote_materials_select" ON "public"."quote_materials";
CREATE POLICY "quote_materials_select"
    ON "public"."quote_materials"
    FOR SELECT
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "quote_materials_update" ON "public"."quote_materials";
CREATE POLICY "quote_materials_update"
    ON "public"."quote_materials"
    FOR UPDATE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."quote_operations";
CREATE POLICY "ai_readonly_select"
    ON "public"."quote_operations"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "quote_operations_delete" ON "public"."quote_operations";
CREATE POLICY "quote_operations_delete"
    ON "public"."quote_operations"
    FOR DELETE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "quote_operations_insert" ON "public"."quote_operations";
CREATE POLICY "quote_operations_insert"
    ON "public"."quote_operations"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "quote_operations_select" ON "public"."quote_operations";
CREATE POLICY "quote_operations_select"
    ON "public"."quote_operations"
    FOR SELECT
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "quote_operations_update" ON "public"."quote_operations";
CREATE POLICY "quote_operations_update"
    ON "public"."quote_operations"
    FOR UPDATE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "Users can delete quotes" ON "public"."quotes";
CREATE POLICY "Users can delete quotes"
    ON "public"."quotes"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert quotes" ON "public"."quotes";
CREATE POLICY "Users can insert quotes"
    ON "public"."quotes"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update quotes" ON "public"."quotes";
CREATE POLICY "Users can update quotes"
    ON "public"."quotes"
    FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view quotes" ON "public"."quotes";
CREATE POLICY "Users can view quotes"
    ON "public"."quotes"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."quotes";
CREATE POLICY "ai_readonly_select"
    ON "public"."quotes"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "Users can delete routing_materials" ON "public"."routing_materials";
CREATE POLICY "Users can delete routing_materials"
    ON "public"."routing_materials"
    FOR DELETE
    USING ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert routing_materials" ON "public"."routing_materials";
CREATE POLICY "Users can insert routing_materials"
    ON "public"."routing_materials"
    FOR INSERT
    WITH CHECK ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update routing_materials" ON "public"."routing_materials";
CREATE POLICY "Users can update routing_materials"
    ON "public"."routing_materials"
    FOR UPDATE
    USING ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view routing_materials" ON "public"."routing_materials";
CREATE POLICY "Users can view routing_materials"
    ON "public"."routing_materials"
    FOR SELECT
    USING ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."routing_materials";
CREATE POLICY "ai_readonly_select"
    ON "public"."routing_materials"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM routings
  WHERE ((routings.id = routing_materials.routing_id) AND (routings.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

DROP POLICY IF EXISTS "Users can delete routing_nodes" ON "public"."routing_nodes";
CREATE POLICY "Users can delete routing_nodes"
    ON "public"."routing_nodes"
    FOR DELETE
    USING ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert routing_nodes" ON "public"."routing_nodes";
CREATE POLICY "Users can insert routing_nodes"
    ON "public"."routing_nodes"
    FOR INSERT
    WITH CHECK ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update routing_nodes" ON "public"."routing_nodes";
CREATE POLICY "Users can update routing_nodes"
    ON "public"."routing_nodes"
    FOR UPDATE
    USING ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view routing_nodes" ON "public"."routing_nodes";
CREATE POLICY "Users can view routing_nodes"
    ON "public"."routing_nodes"
    FOR SELECT
    USING ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."routing_nodes";
CREATE POLICY "ai_readonly_select"
    ON "public"."routing_nodes"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM routings
  WHERE ((routings.id = routing_nodes.routing_id) AND (routings.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

DROP POLICY IF EXISTS "Users can delete routings" ON "public"."routings";
CREATE POLICY "Users can delete routings"
    ON "public"."routings"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert routings" ON "public"."routings";
CREATE POLICY "Users can insert routings"
    ON "public"."routings"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update routings" ON "public"."routings";
CREATE POLICY "Users can update routings"
    ON "public"."routings"
    FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view routings" ON "public"."routings";
CREATE POLICY "Users can view routings"
    ON "public"."routings"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."routings";
CREATE POLICY "ai_readonly_select"
    ON "public"."routings"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "Users can delete own saved insights" ON "public"."saved_insights";
CREATE POLICY "Users can delete own saved insights"
    ON "public"."saved_insights"
    FOR DELETE
    USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can insert own saved insights" ON "public"."saved_insights";
CREATE POLICY "Users can insert own saved insights"
    ON "public"."saved_insights"
    FOR INSERT
    WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can read own saved insights" ON "public"."saved_insights";
CREATE POLICY "Users can read own saved insights"
    ON "public"."saved_insights"
    FOR SELECT
    USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "System admins can insert system_admins" ON "public"."system_admins";
CREATE POLICY "System admins can insert system_admins"
    ON "public"."system_admins"
    FOR INSERT
    WITH CHECK (is_system_admin(auth.uid()));

DROP POLICY IF EXISTS "System admins can read system_admins" ON "public"."system_admins";
CREATE POLICY "System admins can read system_admins"
    ON "public"."system_admins"
    FOR SELECT
    USING (is_system_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can delete company access" ON "public"."user_company_access";
CREATE POLICY "Admins can delete company access"
    ON "public"."user_company_access"
    FOR DELETE
    USING (is_company_admin(company_id));

DROP POLICY IF EXISTS "Admins can insert company access" ON "public"."user_company_access";
CREATE POLICY "Admins can insert company access"
    ON "public"."user_company_access"
    FOR INSERT
    WITH CHECK ((is_company_admin(company_id) OR (user_id = auth.uid())));

DROP POLICY IF EXISTS "Admins can update company access" ON "public"."user_company_access";
CREATE POLICY "Admins can update company access"
    ON "public"."user_company_access"
    FOR UPDATE
    USING (is_company_admin(company_id));

DROP POLICY IF EXISTS "Admins can view company access" ON "public"."user_company_access";
CREATE POLICY "Admins can view company access"
    ON "public"."user_company_access"
    FOR SELECT
    USING (is_company_admin(company_id));

DROP POLICY IF EXISTS "Members can view company member profiles" ON "public"."user_company_access";
CREATE POLICY "Members can view company member profiles"
    ON "public"."user_company_access"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can read own access record" ON "public"."user_company_access";
CREATE POLICY "Users can read own access record"
    ON "public"."user_company_access"
    FOR SELECT
    USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can update own name" ON "public"."user_company_access";
CREATE POLICY "Users can update own name"
    ON "public"."user_company_access"
    FOR UPDATE
    USING ((user_id = auth.uid()))
    WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can view own access" ON "public"."user_company_access";
CREATE POLICY "Users can view own access"
    ON "public"."user_company_access"
    FOR SELECT
    USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can delete own preferences" ON "public"."user_preferences";
CREATE POLICY "Users can delete own preferences"
    ON "public"."user_preferences"
    FOR DELETE
    USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can insert own preferences" ON "public"."user_preferences";
CREATE POLICY "Users can insert own preferences"
    ON "public"."user_preferences"
    FOR INSERT
    WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can update own preferences" ON "public"."user_preferences";
CREATE POLICY "Users can update own preferences"
    ON "public"."user_preferences"
    FOR UPDATE
    USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can view own preferences" ON "public"."user_preferences";
CREATE POLICY "Users can view own preferences"
    ON "public"."user_preferences"
    FOR SELECT
    USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "anon_insert_waitlist" ON "public"."waitlist";
CREATE POLICY "anon_insert_waitlist"
    ON "public"."waitlist"
    FOR INSERT
    TO anon
    WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_waitlist" ON "public"."waitlist";
CREATE POLICY "anon_update_waitlist"
    ON "public"."waitlist"
    FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Users can delete files from their company folder" ON "storage"."objects";
CREATE POLICY "Users can delete files from their company folder"
    ON "storage"."objects"
    FOR DELETE
    TO authenticated
    USING (((bucket_id = 'attachments'::text) AND ((storage.foldername(name))[1] IN ( SELECT (user_company_access.company_id)::text AS company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can read files from their company folder" ON "storage"."objects";
CREATE POLICY "Users can read files from their company folder"
    ON "storage"."objects"
    FOR SELECT
    TO authenticated
    USING (((bucket_id = 'attachments'::text) AND ((storage.foldername(name))[1] IN ( SELECT (user_company_access.company_id)::text AS company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can upload files to their company folder" ON "storage"."objects";
CREATE POLICY "Users can upload files to their company folder"
    ON "storage"."objects"
    FOR INSERT
    TO authenticated
    WITH CHECK (((bucket_id = 'attachments'::text) AND ((storage.foldername(name))[1] IN ( SELECT (user_company_access.company_id)::text AS company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid())))));

-- ============================================================
-- 5. FOREIGN KEY CONSTRAINTS
-- ============================================================
ALTER TABLE "public"."ai_chat_queries"
    ADD CONSTRAINT "ai_chat_queries_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."ai_chat_queries"
    ADD CONSTRAINT "ai_chat_queries_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."ai_config"
    ADD CONSTRAINT "ai_config_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."companies"
    ADD CONSTRAINT "companies_demo_company_id_fkey" FOREIGN KEY (demo_company_id) REFERENCES companies(id) ON DELETE SET NULL;

ALTER TABLE "public"."company_custom_units"
    ADD CONSTRAINT "company_custom_units_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."customers"
    ADD CONSTRAINT "customers_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."demo_data_templates"
    ADD CONSTRAINT "demo_templates_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_item_id_fkey" FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_job_operation_id_fkey" FOREIGN KEY (job_operation_id) REFERENCES job_operations(id) ON DELETE SET NULL;

ALTER TABLE "public"."inventory_unit_conversions"
    ADD CONSTRAINT "inventory_unit_conversions_item_id_fkey" FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;

ALTER TABLE "public"."invitations"
    ADD CONSTRAINT "invitations_accepted_by_fkey" FOREIGN KEY (accepted_by) REFERENCES auth.users(id);

ALTER TABLE "public"."invitations"
    ADD CONSTRAINT "invitations_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."invitations"
    ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY (invited_by) REFERENCES auth.users(id);

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_consumed_by_fkey" FOREIGN KEY (consumed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_inventory_item_id_fkey" FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE RESTRICT;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_job_part_id_fkey" FOREIGN KEY (job_part_id) REFERENCES job_parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_routing_material_id_fkey" FOREIGN KEY (routing_material_id) REFERENCES routing_materials(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_assigned_to_fkey" FOREIGN KEY (assigned_to) REFERENCES auth.users(id);

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_completed_by_fkey" FOREIGN KEY (completed_by) REFERENCES auth.users(id);

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_job_part_id_fkey" FOREIGN KEY (job_part_id) REFERENCES job_parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_operation_type_id_fkey" FOREIGN KEY (operation_type_id) REFERENCES operation_types(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_routing_node_id_fkey" FOREIGN KEY (routing_node_id) REFERENCES routing_nodes(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_parts"
    ADD CONSTRAINT "job_parts_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_parts"
    ADD CONSTRAINT "job_parts_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_parts"
    ADD CONSTRAINT "job_parts_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id);

ALTER TABLE "public"."job_parts"
    ADD CONSTRAINT "job_parts_source_quote_line_item_id_fkey" FOREIGN KEY (source_quote_line_item_id) REFERENCES quote_line_items(id) ON DELETE SET NULL;

ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_quote_id_fkey" FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE SET NULL;

ALTER TABLE "public"."markup_rates"
    ADD CONSTRAINT "markup_rates_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."operation_types"
    ADD CONSTRAINT "operation_types_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."operator_sessions"
    ADD CONSTRAINT "operator_sessions_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."operator_sessions"
    ADD CONSTRAINT "operator_sessions_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."operator_sessions"
    ADD CONSTRAINT "operator_sessions_job_operation_id_fkey" FOREIGN KEY (job_operation_id) REFERENCES job_operations(id) ON DELETE SET NULL;

ALTER TABLE "public"."operator_sessions"
    ADD CONSTRAINT "operator_sessions_operation_type_id_fkey" FOREIGN KEY (operation_type_id) REFERENCES operation_types(id) ON DELETE RESTRICT;

ALTER TABLE "public"."part_pricing_tiers"
    ADD CONSTRAINT "part_pricing_tiers_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_pricing_tiers"
    ADD CONSTRAINT "part_pricing_tiers_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."parts"
    ADD CONSTRAINT "parts_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."parts"
    ADD CONSTRAINT "parts_markup_rate_id_fkey" FOREIGN KEY (markup_rate_id) REFERENCES markup_rates(id) ON DELETE SET NULL;

ALTER TABLE "public"."quote_line_items"
    ADD CONSTRAINT "quote_line_items_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."quote_line_items"
    ADD CONSTRAINT "quote_line_items_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id);

ALTER TABLE "public"."quote_line_items"
    ADD CONSTRAINT "quote_line_items_quote_id_fkey" FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE;

ALTER TABLE "public"."quote_line_items"
    ADD CONSTRAINT "quote_line_items_source_tier_id_fkey" FOREIGN KEY (source_tier_id) REFERENCES part_pricing_tiers(id) ON DELETE SET NULL;

ALTER TABLE "public"."quote_materials"
    ADD CONSTRAINT "quote_materials_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."quote_materials"
    ADD CONSTRAINT "quote_materials_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE RESTRICT;

ALTER TABLE "public"."quote_materials"
    ADD CONSTRAINT "quote_materials_quote_id_fkey" FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE;

ALTER TABLE "public"."quote_operations"
    ADD CONSTRAINT "quote_operations_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."quote_operations"
    ADD CONSTRAINT "quote_operations_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE RESTRICT;

ALTER TABLE "public"."quote_operations"
    ADD CONSTRAINT "quote_operations_quote_id_fkey" FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE;

ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE "public"."routing_materials"
    ADD CONSTRAINT "routing_materials_inventory_item_id_fkey" FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE RESTRICT;

ALTER TABLE "public"."routing_materials"
    ADD CONSTRAINT "routing_materials_routing_id_fkey" FOREIGN KEY (routing_id) REFERENCES routings(id) ON DELETE CASCADE;

ALTER TABLE "public"."routing_nodes"
    ADD CONSTRAINT "routing_nodes_operation_type_id_fkey" FOREIGN KEY (operation_type_id) REFERENCES operation_types(id) ON DELETE RESTRICT;

ALTER TABLE "public"."routing_nodes"
    ADD CONSTRAINT "routing_nodes_routing_id_fkey" FOREIGN KEY (routing_id) REFERENCES routings(id) ON DELETE CASCADE;

ALTER TABLE "public"."routings"
    ADD CONSTRAINT "routings_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."routings"
    ADD CONSTRAINT "routings_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE "public"."routings"
    ADD CONSTRAINT "routings_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."saved_insights"
    ADD CONSTRAINT "saved_insights_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."saved_insights"
    ADD CONSTRAINT "saved_insights_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."system_admins"
    ADD CONSTRAINT "system_admins_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE "public"."system_admins"
    ADD CONSTRAINT "system_admins_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id);

ALTER TABLE "public"."user_company_access"
    ADD CONSTRAINT "user_company_access_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."user_company_access"
    ADD CONSTRAINT "user_company_access_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_last_company_id_fkey" FOREIGN KEY (last_company_id) REFERENCES companies(id) ON DELETE SET NULL;

ALTER TABLE "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ============================================================
-- 6. INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_ai_chat_queries_rate_limit ON public.ai_chat_queries USING btree (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_companies_demo_company ON public.companies USING btree (demo_company_id) WHERE (demo_company_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_companies_is_demo ON public.companies USING btree (is_demo) WHERE (is_demo = true);
CREATE INDEX IF NOT EXISTS idx_companies_name ON public.companies USING btree (name);
CREATE INDEX IF NOT EXISTS idx_companies_slug ON public.companies USING btree (slug);
CREATE INDEX IF NOT EXISTS idx_customers_company ON public.customers USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_customers_name ON public.customers USING btree (company_id, name);
CREATE INDEX IF NOT EXISTS inventory_items_company_id_idx ON public.inventory_items USING btree (company_id);
CREATE INDEX IF NOT EXISTS inventory_items_company_id_name_idx ON public.inventory_items USING btree (company_id, name);
CREATE INDEX IF NOT EXISTS inventory_transactions_company_id_created_at_idx ON public.inventory_transactions USING btree (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_transactions_discrepancy_idx ON public.inventory_transactions USING btree (company_id, created_at DESC) WHERE (has_discrepancy = true);
CREATE INDEX IF NOT EXISTS inventory_transactions_item_id_created_at_idx ON public.inventory_transactions USING btree (inventory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_transactions_job_id_idx ON public.inventory_transactions USING btree (job_id) WHERE (job_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS inventory_transactions_job_operation_id_idx ON public.inventory_transactions USING btree (job_operation_id) WHERE (job_operation_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS inventory_unit_conversions_item_id_idx ON public.inventory_unit_conversions USING btree (inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_invitations_company_id ON public.invitations USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON public.invitations USING btree (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_email_company ON public.invitations USING btree (email, company_id) WHERE ((status)::text = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_job_materials_inventory ON public.job_materials USING btree (inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_job ON public.job_materials USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_job_part_id ON public.job_materials USING btree (job_part_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_routing_material ON public.job_materials USING btree (routing_material_id);
CREATE INDEX IF NOT EXISTS idx_job_operations_job_part_id ON public.job_operations USING btree (job_part_id);
CREATE INDEX IF NOT EXISTS idx_job_ops_assigned ON public.job_operations USING btree (assigned_to) WHERE (assigned_to IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_job_ops_job ON public.job_operations USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_job_ops_operation_type ON public.job_operations USING btree (operation_type_id);
CREATE INDEX IF NOT EXISTS idx_job_ops_routing_node ON public.job_operations USING btree (routing_node_id) WHERE (routing_node_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_job_ops_status ON public.job_operations USING btree (status);
CREATE INDEX IF NOT EXISTS idx_job_parts_company_id ON public.job_parts USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_job_id ON public.job_parts USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_part_id ON public.job_parts USING btree (part_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_status ON public.job_parts USING btree (status);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON public.jobs USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON public.jobs USING btree (customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_quote ON public.jobs USING btree (quote_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON public.jobs USING btree (company_id, status);
CREATE INDEX IF NOT EXISTS idx_markup_rates_company ON public.markup_rates USING btree (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS markup_rates_one_default_per_company ON public.markup_rates USING btree (company_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_operation_types_company ON public.operation_types USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_active ON public.operator_sessions USING btree (operator_id) WHERE (ended_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_company ON public.operator_sessions USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_job ON public.operator_sessions USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_job_op ON public.operator_sessions USING btree (job_operation_id);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_operator ON public.operator_sessions USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_part_pricing_tiers_company ON public.part_pricing_tiers USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_part_pricing_tiers_part ON public.part_pricing_tiers USING btree (part_id, sequence);
CREATE INDEX IF NOT EXISTS idx_parts_company_id ON public.parts USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_parts_markup_rate_id ON public.parts USING btree (markup_rate_id);
CREATE INDEX IF NOT EXISTS idx_parts_part_name ON public.parts USING btree (company_id, part_name);
CREATE INDEX IF NOT EXISTS idx_quote_line_items_company ON public.quote_line_items USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_quote_line_items_part ON public.quote_line_items USING btree (part_id);
CREATE INDEX IF NOT EXISTS idx_quote_line_items_quote ON public.quote_line_items USING btree (quote_id, sequence);
CREATE INDEX IF NOT EXISTS idx_quote_materials_company ON public.quote_materials USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_quote_materials_quote ON public.quote_materials USING btree (quote_id, sequence);
CREATE INDEX IF NOT EXISTS idx_quote_materials_quote_part ON public.quote_materials USING btree (quote_id, part_id);
CREATE INDEX IF NOT EXISTS idx_quote_operations_company ON public.quote_operations USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_quote_operations_quote ON public.quote_operations USING btree (quote_id, sequence);
CREATE INDEX IF NOT EXISTS idx_quote_operations_quote_part ON public.quote_operations USING btree (quote_id, part_id);
CREATE INDEX IF NOT EXISTS idx_quotes_company ON public.quotes USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON public.quotes USING btree (customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_number ON public.quotes USING btree (quote_number);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON public.quotes USING btree (company_id, status);
CREATE INDEX IF NOT EXISTS idx_routing_materials_inventory ON public.routing_materials USING btree (inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_routing_materials_routing ON public.routing_materials USING btree (routing_id, sequence);
CREATE INDEX IF NOT EXISTS idx_routing_nodes_operation_type ON public.routing_nodes USING btree (operation_type_id);
CREATE INDEX IF NOT EXISTS idx_routing_nodes_routing ON public.routing_nodes USING btree (routing_id);
CREATE INDEX IF NOT EXISTS idx_routing_nodes_routing_sequence ON public.routing_nodes USING btree (routing_id, sequence);
CREATE INDEX IF NOT EXISTS idx_routings_company ON public.routings USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_routings_part ON public.routings USING btree (part_id);
CREATE INDEX IF NOT EXISTS idx_saved_insights_user_company ON public.saved_insights USING btree (user_id, company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_company_access_company_id ON public.user_company_access USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_user_company_access_name ON public.user_company_access USING btree (name);
CREATE INDEX IF NOT EXISTS idx_user_company_access_user_id ON public.user_company_access USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON public.user_preferences USING btree (user_id);
CREATE INDEX IF NOT EXISTS waitlist_created_at_idx ON public.waitlist USING btree (created_at);
CREATE INDEX IF NOT EXISTS waitlist_email_idx ON public.waitlist USING btree (email);

-- ============================================================
-- 7. FUNCTIONS
-- ============================================================
CREATE OR REPLACE FUNCTION public.accept_invitation(p_invitation_id uuid, p_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_inv RECORD;
BEGIN
    -- Lock the invitation row to prevent concurrent acceptance
    SELECT * INTO v_inv FROM invitations
    WHERE id = p_invitation_id AND status = 'pending' AND expires_at > NOW()
    FOR UPDATE;

    IF v_inv IS NULL THEN
        RAISE EXCEPTION 'Invalid or expired invitation';
    END IF;

    -- Create user_company_access if not exists
    -- Name is empty — the accept-invite page prompts the user for their name
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT p_user_id, v_inv.company_id, v_inv.role, ''
    WHERE NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = p_user_id AND company_id = v_inv.company_id
    );

    -- Mark invitation as accepted
    UPDATE invitations
    SET status = 'accepted', accepted_by = p_user_id, accepted_at = NOW()
    WHERE id = v_inv.id;

    RETURN v_inv.company_id;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.compute_job_status(p_job_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_total int;
    v_cancelled int;
    v_shipped int;
    v_completed int;
    v_in_progress int;
BEGIN
    SELECT
      count(*),
      count(*) FILTER (WHERE status = 'cancelled'),
      count(*) FILTER (WHERE status = 'shipped'),
      count(*) FILTER (WHERE status = 'completed'),
      count(*) FILTER (WHERE status = 'in_progress')
    INTO v_total, v_cancelled, v_shipped, v_completed, v_in_progress
    FROM job_parts
    WHERE job_id = p_job_id;

    IF v_total = 0 THEN RETURN 'not_started'; END IF;
    IF v_cancelled = v_total THEN RETURN 'cancelled'; END IF;
    IF v_shipped = v_total THEN RETURN 'shipped'; END IF;
    IF v_completed + v_shipped = v_total THEN RETURN 'completed'; END IF;
    IF v_in_progress > 0 OR v_completed > 0 OR v_shipped > 0 THEN RETURN 'in_progress'; END IF;
    RETURN 'not_started';
END;
$function$

;

CREATE OR REPLACE FUNCTION public.convert_quote_to_job(p_quote_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_quote RECORD;
  v_job_id UUID;
  v_routing_id UUID;
  v_ops_count INTEGER;
BEGIN
  -- Get the quote
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  IF v_quote.status != 'accepted' THEN
    RAISE EXCEPTION 'Quote must be accepted before converting. Current status: %', v_quote.status;
  END IF;

  IF v_quote.converted_to_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'Quote already converted to job: %', v_quote.converted_to_job_id;
  END IF;

  -- Auto-resolve routing from part
  IF v_quote.part_id IS NOT NULL THEN
    SELECT id INTO v_routing_id FROM routings WHERE part_id = v_quote.part_id;
  END IF;

  IF v_routing_id IS NULL AND v_quote.part_id IS NOT NULL THEN
    RAISE EXCEPTION 'No routing defined for part. Create a routing before converting to a job.';
  END IF;

  -- Create the job (only columns that exist on the jobs table)
  INSERT INTO jobs (
    company_id,
    quote_id,
    customer_id,
    part_id,
    description,
    created_by
  ) VALUES (
    v_quote.company_id,
    v_quote.id,
    v_quote.customer_id,
    v_quote.part_id,
    COALESCE(p_notes, v_quote.description),
    v_quote.created_by
  )
  RETURNING id INTO v_job_id;

  -- If there's a routing, copy operations to the job
  IF v_routing_id IS NOT NULL THEN
    SELECT create_job_operations_from_routing(v_job_id, v_routing_id) INTO v_ops_count;
  END IF;

  -- Update the quote with conversion info
  UPDATE quotes
  SET
    converted_to_job_id = v_job_id,
    converted_at = NOW(),
    status = 'converted',
    status_changed_at = NOW()
  WHERE id = p_quote_id;

  RETURN v_job_id;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.create_demo_company(p_source_company_id uuid, p_user_id uuid, p_template_name character varying DEFAULT 'default'::character varying)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_source_name TEXT;
    v_demo_company_id UUID;
    v_existing_demo_id UUID;
BEGIN
    -- Auth check: caller must be the requesting user
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied: cannot create demo company for another user';
    END IF;

    -- Role check: caller must be admin of source company
    IF NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = p_user_id
          AND company_id = p_source_company_id
          AND role = 'admin'
    ) THEN
        RAISE EXCEPTION 'Access denied: must be admin of source company';
    END IF;

    -- Idempotency: return existing demo company if one exists
    SELECT demo_company_id INTO v_existing_demo_id
    FROM companies
    WHERE id = p_source_company_id;

    IF v_existing_demo_id IS NOT NULL THEN
        RETURN v_existing_demo_id;
    END IF;

    -- Get source company name
    SELECT name INTO v_source_name
    FROM companies WHERE id = p_source_company_id;

    IF v_source_name IS NULL THEN
        RAISE EXCEPTION 'Source company not found: %', p_source_company_id;
    END IF;

    -- Create demo company
    INSERT INTO companies (name, is_demo)
    VALUES (v_source_name || ' - Demo', TRUE)
    RETURNING id INTO v_demo_company_id;

    -- Link demo to source company
    UPDATE companies SET demo_company_id = v_demo_company_id
    WHERE id = p_source_company_id;

    -- Mirror all user_company_access from source to demo
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT uca.user_id, v_demo_company_id, uca.role, uca.name
    FROM user_company_access uca
    WHERE uca.company_id = p_source_company_id;

    -- Seed demo data from active template
    PERFORM seed_demo_data(v_demo_company_id, p_user_id, p_template_name);

    RETURN v_demo_company_id;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.create_job_part_operations_from_routing(p_job_part_id uuid, p_routing_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_count integer := 0;
    v_node record;
    v_seq integer := 10;
    v_job_id uuid;
    v_min_seq integer;
BEGIN
    SELECT job_id INTO v_job_id FROM job_parts WHERE id = p_job_part_id;
    IF v_job_id IS NULL THEN
        RAISE EXCEPTION 'job_part % not found', p_job_part_id;
    END IF;

    FOR v_node IN
        SELECT rn.*, ot.name AS operation_name
        FROM routing_nodes rn
        JOIN operation_types ot ON rn.operation_type_id = ot.id
        WHERE rn.routing_id = p_routing_id
        ORDER BY rn.sequence, rn.created_at
    LOOP
        INSERT INTO job_operations (
            job_id, job_part_id, sequence, operation_name, operation_type_id,
            estimated_setup_minutes, estimated_run_minutes_per_unit,
            status, routing_node_id
        ) VALUES (
            v_job_id, p_job_part_id, v_seq, v_node.operation_name, v_node.operation_type_id,
            COALESCE(v_node.setup_time, 0), v_node.run_time_per_unit,
            'pending', v_node.id
        );
        v_seq := v_seq + 10;
        v_count := v_count + 1;
    END LOOP;

    INSERT INTO job_materials (job_id, job_part_id, routing_material_id, inventory_item_id, expected_quantity, unit)
    SELECT v_job_id, p_job_part_id, rm.id, rm.inventory_item_id, rm.quantity, rm.unit
    FROM routing_materials rm
    WHERE rm.routing_id = p_routing_id
      AND NOT EXISTS (
          SELECT 1 FROM job_materials jm
          WHERE jm.job_part_id = p_job_part_id AND jm.routing_material_id = rm.id
      );

    SELECT MIN(sequence) INTO v_min_seq FROM job_operations WHERE job_part_id = p_job_part_id;
    IF v_min_seq IS NOT NULL THEN
        UPDATE job_parts SET current_operation_sequence = v_min_seq WHERE id = p_job_part_id;
    END IF;

    RETURN v_count;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.generate_quote_number(company_uuid uuid)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(
    MAX(CAST(SUBSTRING(quote_number FROM 'Q-(\d+)') AS INTEGER)), 0
  ) + 1
  INTO next_num
  FROM quotes
  WHERE company_id = company_uuid
    AND quote_number ~ '^Q-\d+$';
  
  RETURN 'Q-' || LPAD(next_num::TEXT, 4, '0');
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_operator_access_id(check_company_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT id FROM user_company_access
  WHERE user_id = auth.uid()
    AND company_id = check_company_id
  LIMIT 1;
$function$

;

CREATE OR REPLACE FUNCTION public.get_ready_operations_batch(p_job_ids uuid[])
 RETURNS TABLE(job_id uuid, operation_name text, ready_count integer)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH
    in_progress_ops AS (
        SELECT jo.job_id, jo.operation_name, COUNT(*)::integer AS cnt
        FROM job_operations jo
        WHERE jo.job_id = ANY(p_job_ids)
          AND jo.status = 'in_progress'
        GROUP BY jo.job_id, jo.operation_name
    ),
    jobs_with_in_progress AS (
        SELECT DISTINCT ip.job_id FROM in_progress_ops ip
    ),
    -- Per-part readiness: predecessors compared inside the same job_part.
    ready_ops AS (
        SELECT jo.job_id, jo.operation_name
        FROM job_operations jo
        WHERE jo.job_id = ANY(p_job_ids)
          AND jo.job_id NOT IN (SELECT jwi.job_id FROM jobs_with_in_progress jwi)
          AND jo.status = 'pending'
          AND NOT EXISTS (
              SELECT 1 FROM job_operations prev
              WHERE prev.job_part_id = jo.job_part_id
                AND prev.sequence < jo.sequence
                AND prev.status NOT IN ('completed', 'skipped')
          )
    ),
    ready_agg AS (
        SELECT ro.job_id, MIN(ro.operation_name) AS operation_name, COUNT(*)::integer AS ready_count
        FROM ready_ops ro
        GROUP BY ro.job_id
    )
    SELECT ip.job_id, ip.operation_name, ip.cnt AS ready_count
    FROM in_progress_ops ip
    UNION ALL
    SELECT ra.job_id, ra.operation_name, ra.ready_count
    FROM ready_agg ra;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_ready_operations_for_station(p_company_id uuid, p_operation_type_id uuid)
 RETURNS TABLE(job_id uuid, job_part_id uuid, job_operation_id uuid, operation_name text, op_status text, job_number text, part_id uuid, part_name text, part_description text, part_quantity integer)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH eligible_jobs AS (
        SELECT j.id, j.job_number FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.status IN ('not_started', 'in_progress')
    ),
    station_ops AS (
        SELECT jo.id, jo.job_id, jo.job_part_id, jo.operation_name, jo.status, jo.sequence, ej.job_number
        FROM job_operations jo
        JOIN eligible_jobs ej ON ej.id = jo.job_id
        WHERE jo.operation_type_id = p_operation_type_id
          AND jo.status IN ('pending', 'in_progress')
    ),
    ready_or_active AS (
        SELECT so.id, so.job_id, so.job_part_id, so.operation_name, so.status, so.job_number
        FROM station_ops so
        WHERE so.status = 'in_progress'
           OR NOT EXISTS (
               SELECT 1 FROM job_operations prev
               WHERE prev.job_part_id = so.job_part_id
                 AND prev.sequence < so.sequence
                 AND prev.status NOT IN ('completed', 'skipped')
           )
    )
    SELECT
        ra.job_id,
        ra.job_part_id,
        ra.id AS job_operation_id,
        ra.operation_name,
        ra.status AS op_status,
        ra.job_number,
        jp.part_id,
        p.part_name,
        p.description AS part_description,
        jp.quantity AS part_quantity
    FROM ready_or_active ra
    JOIN job_parts jp ON jp.id = ra.job_part_id
    JOIN parts p ON p.id = jp.part_id;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_user_company_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT company_id FROM user_company_access WHERE user_id = auth.uid();
$function$

;

CREATE OR REPLACE FUNCTION public.is_company_admin(check_company_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM user_company_access
    WHERE user_id = auth.uid()
      AND company_id = check_company_id
      AND role = 'admin'
  );
$function$

;

CREATE OR REPLACE FUNCTION public.is_system_admin(check_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN EXISTS (SELECT 1 FROM system_admins WHERE user_id = check_user_id);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.reset_demo_company(p_source_company_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_demo_company_id uuid;
BEGIN
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    SELECT demo_company_id INTO v_demo_company_id
    FROM companies WHERE id = p_source_company_id;

    IF v_demo_company_id IS NULL THEN
        RAISE EXCEPTION 'No demo company exists for company: %', p_source_company_id;
    END IF;

    DELETE FROM operator_sessions WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM job_materials WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_parts WHERE company_id = v_demo_company_id;
    DELETE FROM jobs WHERE company_id = v_demo_company_id;
    DELETE FROM quotes WHERE company_id = v_demo_company_id;
    DELETE FROM routing_materials WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routing_nodes WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    DELETE FROM parts WHERE company_id = v_demo_company_id;
    DELETE FROM part_categories WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_items WHERE company_id = v_demo_company_id;
    DELETE FROM operation_types WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;
    DELETE FROM ai_chat_queries WHERE company_id = v_demo_company_id;

    PERFORM seed_demo_data(v_demo_company_id, p_user_id);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.restrict_transaction_update_to_notes()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.company_id IS DISTINCT FROM NEW.company_id
       OR OLD.inventory_item_id IS DISTINCT FROM NEW.inventory_item_id
       OR OLD.item_name IS DISTINCT FROM NEW.item_name
       OR OLD.type IS DISTINCT FROM NEW.type
       OR OLD.quantity IS DISTINCT FROM NEW.quantity
       OR OLD.unit IS DISTINCT FROM NEW.unit
       OR OLD.converted_quantity IS DISTINCT FROM NEW.converted_quantity
       OR OLD.job_id IS DISTINCT FROM NEW.job_id
       OR OLD.job_operation_id IS DISTINCT FROM NEW.job_operation_id
       OR OLD.operator_id IS DISTINCT FROM NEW.operator_id
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR OLD.created_by IS DISTINCT FROM NEW.created_by
       OR OLD.has_discrepancy IS DISTINCT FROM NEW.has_discrepancy
    THEN
        RAISE EXCEPTION 'Only the notes field can be updated on inventory transactions';
    END IF;
    RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.seed_default_markup_rates()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO public.markup_rates (company_id, name, breakpoints, is_default) VALUES
    (NEW.id,
     'Default',
     '[{"qty": 1, "markup_percent": 25}]'::jsonb,
     true),
    (NEW.id,
     'Volume tiers',
     '[{"qty": 1, "markup_percent": 25},
       {"qty": 10, "markup_percent": 22},
       {"qty": 100, "markup_percent": 18},
       {"qty": 1000, "markup_percent": 15}]'::jsonb,
     false),
    (NEW.id,
     'Premium small batch',
     '[{"qty": 1, "markup_percent": 40},
       {"qty": 10, "markup_percent": 32}]'::jsonb,
     false);
  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.seed_demo_data(p_company_id uuid, p_user_id uuid, p_template_name character varying DEFAULT 'default'::character varying)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_template jsonb;
    v_ref_map jsonb := '{}'::jsonb;
    v_item jsonb;
    v_op jsonb;
    v_new_id uuid;
    v_job_id uuid;
    v_job_part_id uuid;
    v_part_id uuid;
BEGIN
    SELECT template INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    -- Customers
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO customers (id, company_id, name, contact_name, contact_email, contact_phone,
                                   address_line1, address_line2, city, state, postal_code, country, website,
                                   created_at, updated_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', v_item->>'contact_name', v_item->>'contact_email', v_item->>'contact_phone',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country','USA'), v_item->>'website',
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Operation types
    IF v_template->'operation_types' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'operation_types') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO operation_types (id, company_id, name, description, hourly_rate, created_at, updated_at)
            VALUES (v_new_id, p_company_id, v_item->>'name', v_item->>'description',
                    (v_item->>'hourly_rate')::numeric,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Inventory items
    IF v_template->'inventory_items' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_items') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO inventory_items (id, company_id, item_name, description, unit, current_stock,
                                          minimum_stock, cost_per_unit, location, created_at, updated_at)
            VALUES (v_new_id, p_company_id, v_item->>'item_name', v_item->>'description',
                    COALESCE(v_item->>'unit','each'),
                    COALESCE((v_item->>'current_stock')::numeric, 0),
                    COALESCE((v_item->>'minimum_stock')::numeric, 0),
                    COALESCE((v_item->>'cost_per_unit')::numeric, 0),
                    v_item->>'location',
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Parts
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO parts (id, company_id, part_name, description, category_id,
                               created_by, created_at, updated_at)
            VALUES (v_new_id, p_company_id, v_item->>'part_name', v_item->>'description',
                    NULL, p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Routings, routing_nodes, routing_materials
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO routings (id, company_id, part_id, name, description,
                                  created_by, created_at, updated_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::uuid,
                    v_item->>'name', v_item->>'description',
                    p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));

            IF v_item->'nodes' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'nodes') LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::text));
                    INSERT INTO routing_nodes (id, routing_id, operation_type_id, sequence,
                                               run_time_per_unit, setup_time,
                                               metadata, created_at, updated_at)
                    VALUES (v_new_id,
                            (v_ref_map->>(v_item->>'_ref'))::uuid,
                            (v_ref_map->>(v_op->>'operation_type_ref'))::uuid,
                            (v_op->>'sequence')::integer,
                            COALESCE((v_op->>'run_time_per_unit')::numeric, 0),
                            COALESCE((v_op->>'setup_time')::numeric, 0),
                            COALESCE((v_op->'metadata'), '{}'::jsonb),
                            COALESCE((v_op->>'created_at')::timestamptz, now()),
                            COALESCE((v_op->>'updated_at')::timestamptz, now()));
                END LOOP;
            END IF;

            IF v_item->'materials' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'materials') LOOP
                    INSERT INTO routing_materials (id, routing_id, inventory_item_id,
                                                   quantity, unit, sequence)
                    VALUES (gen_random_uuid(),
                            (v_ref_map->>(v_item->>'_ref'))::uuid,
                            (v_ref_map->>(v_op->>'inventory_item_ref'))::uuid,
                            (v_op->>'quantity')::numeric,
                            v_op->>'unit',
                            COALESCE((v_op->>'sequence')::integer, 0));
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO quotes (id, company_id, customer_id, status,
                                lead_time_days, expiration_date,
                                created_by, created_at, updated_at,
                                status_changed_at, converted_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::uuid,
                    COALESCE(v_item->>'status', 'active'),
                    (v_item->>'lead_time_days')::integer,
                    (v_item->>'expiration_date')::date,
                    p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()),
                    (v_item->>'status_changed_at')::timestamptz,
                    (v_item->>'converted_at')::timestamptz);
        END LOOP;
    END IF;

    -- Jobs: insert one job + one job_parts per (job, part_ref). Operations and
    -- materials hang off the job_part.
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_new_id := gen_random_uuid();
            v_job_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));

            INSERT INTO jobs (id, company_id, customer_id, quote_id,
                              job_number, status, created_by, created_at,
                              started_at, completed_at, shipped_at, status_changed_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::uuid,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::uuid ELSE NULL END,
                    COALESCE(v_item->>'job_number', 'J-DEMO-' || substr(v_new_id::text, 1, 8)),
                    COALESCE(v_item->>'status', 'not_started'),
                    p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    (v_item->>'started_at')::timestamptz,
                    (v_item->>'completed_at')::timestamptz,
                    (v_item->>'shipped_at')::timestamptz,
                    (v_item->>'status_changed_at')::timestamptz);

            IF v_item->>'part_ref' IS NOT NULL THEN
                v_part_id := (v_ref_map->>(v_item->>'part_ref'))::uuid;
                v_job_part_id := gen_random_uuid();

                INSERT INTO job_parts (id, job_id, company_id, part_id,
                                       sequence, quantity, status,
                                       status_changed_at, started_at, completed_at, shipped_at,
                                       created_at, updated_at)
                VALUES (v_job_part_id, v_job_id, p_company_id, v_part_id,
                        10,
                        COALESCE((v_item->>'quantity')::integer, 1),
                        COALESCE(v_item->>'status', 'not_started'),
                        (v_item->>'status_changed_at')::timestamptz,
                        (v_item->>'started_at')::timestamptz,
                        (v_item->>'completed_at')::timestamptz,
                        (v_item->>'shipped_at')::timestamptz,
                        COALESCE((v_item->>'created_at')::timestamptz, now()),
                        COALESCE((v_item->>'created_at')::timestamptz, now()));

                IF v_item->'operations' IS NOT NULL THEN
                    FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'operations') LOOP
                        v_new_id := gen_random_uuid();
                        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::text));
                        INSERT INTO job_operations (id, job_id, job_part_id, sequence, operation_name,
                                                    operation_type_id, estimated_setup_minutes,
                                                    estimated_run_minutes_per_unit,
                                                    actual_setup_minutes, actual_run_minutes,
                                                    status, routing_node_id,
                                                    started_at, completed_at, created_at)
                        VALUES (v_new_id, v_job_id, v_job_part_id,
                                (v_op->>'sequence')::integer,
                                v_op->>'operation_name',
                                CASE WHEN v_op->>'operation_type_ref' IS NOT NULL
                                     THEN (v_ref_map->>(v_op->>'operation_type_ref'))::uuid ELSE NULL END,
                                COALESCE((v_op->>'estimated_setup_minutes')::numeric,
                                         (v_op->>'estimated_setup_hours')::numeric * 60, 0),
                                COALESCE((v_op->>'estimated_run_minutes_per_unit')::numeric,
                                         (v_op->>'estimated_run_hours_per_unit')::numeric * 60, 0),
                                COALESCE((v_op->>'actual_setup_minutes')::numeric,
                                         (v_op->>'actual_setup_hours')::numeric * 60),
                                COALESCE((v_op->>'actual_run_minutes')::numeric,
                                         (v_op->>'actual_run_hours')::numeric * 60),
                                COALESCE(v_op->>'status', 'pending'),
                                CASE WHEN v_op->>'routing_node_ref' IS NOT NULL
                                     THEN (v_ref_map->>(v_op->>'routing_node_ref'))::uuid ELSE NULL END,
                                (v_op->>'started_at')::timestamptz,
                                (v_op->>'completed_at')::timestamptz,
                                COALESCE((v_op->>'created_at')::timestamptz, now()));
                    END LOOP;
                END IF;

                INSERT INTO job_materials (job_id, job_part_id, routing_material_id,
                                           inventory_item_id, expected_quantity, unit)
                SELECT v_job_id, v_job_part_id, rm.id, rm.inventory_item_id, rm.quantity, rm.unit
                FROM routing_materials rm
                JOIN routings r ON r.id = rm.routing_id
                WHERE r.part_id = v_part_id;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            IF v_item->>'converted_to_job_ref' IS NOT NULL THEN
                UPDATE quotes
                SET converted_at = (v_item->>'converted_at')::timestamptz
                WHERE id = (v_ref_map->>(v_item->>'_ref'))::uuid;
            END IF;
        END LOOP;
    END IF;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.set_quote_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.quote_number IS NULL OR NEW.quote_number = '' THEN
    NEW.quote_number := generate_quote_number(NEW.company_id);
  END IF;
  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.sync_demo_access(p_source_company_id uuid, p_demo_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Add any missing access entries (new team members since demo was created)
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT uca.user_id, p_demo_company_id, uca.role, uca.name
    FROM user_company_access uca
    WHERE uca.company_id = p_source_company_id
      AND NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = uca.user_id AND company_id = p_demo_company_id
      );

    -- Update roles that changed in the source company
    UPDATE user_company_access demo_uca
    SET role = source_uca.role
    FROM user_company_access source_uca
    WHERE demo_uca.company_id = p_demo_company_id
      AND source_uca.company_id = p_source_company_id
      AND demo_uca.user_id = source_uca.user_id
      AND demo_uca.role != source_uca.role;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.sync_job_status_from_parts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_job_id uuid;
    v_new_status text;
    v_now timestamptz := now();
BEGIN
    v_job_id := COALESCE(NEW.job_id, OLD.job_id);
    v_new_status := compute_job_status(v_job_id);

    UPDATE jobs
    SET status = v_new_status,
        status_changed_at = CASE WHEN status IS DISTINCT FROM v_new_status THEN v_now ELSE status_changed_at END,
        started_at = CASE
            WHEN started_at IS NULL AND v_new_status IN ('in_progress','completed','shipped')
              THEN v_now ELSE started_at END,
        completed_at = CASE
            WHEN v_new_status IN ('completed','shipped') AND completed_at IS NULL THEN v_now
            WHEN v_new_status = 'in_progress' THEN NULL
            ELSE completed_at END,
        shipped_at = CASE
            WHEN v_new_status = 'shipped' AND shipped_at IS NULL THEN v_now
            WHEN v_new_status <> 'shipped' THEN NULL
            ELSE shipped_at END,
        updated_at = v_now
    WHERE id = v_job_id;

    RETURN NULL;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.track_job_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.status_changed_at := NOW();

    -- Auto-set timestamps based on status
    IF NEW.status = 'in_progress' AND NEW.started_at IS NULL THEN
      NEW.started_at := NOW();
    ELSIF NEW.status = 'completed' AND NEW.completed_at IS NULL THEN
      NEW.completed_at := NOW();
    ELSIF NEW.status = 'shipped' AND NEW.shipped_at IS NULL THEN
      NEW.shipped_at := NOW();
    END IF;
  END IF;
  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.track_quote_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.status_changed_at := NOW();
  END IF;
  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.update_inventory_items_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.user_company_access_fill_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF NEW.email IS NULL OR NEW.email = '' THEN
    SELECT email INTO NEW.email FROM auth.users WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$function$

;

-- ============================================================
-- 8. TRIGGERS
-- ============================================================
DROP TRIGGER IF EXISTS "ai_config_updated_at" ON "public"."ai_config";
CREATE TRIGGER ai_config_updated_at BEFORE UPDATE ON public.ai_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "companies_seed_default_markup_rates" ON "public"."companies";
CREATE TRIGGER companies_seed_default_markup_rates AFTER INSERT ON public.companies FOR EACH ROW EXECUTE FUNCTION seed_default_markup_rates();

DROP TRIGGER IF EXISTS "companies_updated_at" ON "public"."companies";
CREATE TRIGGER companies_updated_at BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "customers_updated_at" ON "public"."customers";
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "inventory_items_updated_at" ON "public"."inventory_items";
CREATE TRIGGER inventory_items_updated_at BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION update_inventory_items_updated_at();

DROP TRIGGER IF EXISTS "enforce_transaction_notes_only_update" ON "public"."inventory_transactions";
CREATE TRIGGER enforce_transaction_notes_only_update BEFORE UPDATE ON public.inventory_transactions FOR EACH ROW EXECUTE FUNCTION restrict_transaction_update_to_notes();

DROP TRIGGER IF EXISTS "job_materials_updated_at" ON "public"."job_materials";
CREATE TRIGGER job_materials_updated_at BEFORE UPDATE ON public.job_materials FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "job_operations_updated_at" ON "public"."job_operations";
CREATE TRIGGER job_operations_updated_at BEFORE UPDATE ON public.job_operations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "trigger_sync_job_status_from_parts_del" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_status_from_parts_del AFTER DELETE ON public.job_parts FOR EACH ROW EXECUTE FUNCTION sync_job_status_from_parts();

DROP TRIGGER IF EXISTS "trigger_sync_job_status_from_parts_ins" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_status_from_parts_ins AFTER INSERT ON public.job_parts FOR EACH ROW EXECUTE FUNCTION sync_job_status_from_parts();

DROP TRIGGER IF EXISTS "trigger_sync_job_status_from_parts_upd" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_status_from_parts_upd AFTER UPDATE OF status ON public.job_parts FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION sync_job_status_from_parts();

DROP TRIGGER IF EXISTS "jobs_updated_at" ON "public"."jobs";
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "trigger_job_status_change" ON "public"."jobs";
CREATE TRIGGER trigger_job_status_change BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION track_job_status_change();

DROP TRIGGER IF EXISTS "markup_rates_updated_at" ON "public"."markup_rates";
CREATE TRIGGER markup_rates_updated_at BEFORE UPDATE ON public.markup_rates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "update_operation_types_updated_at" ON "public"."operation_types";
CREATE TRIGGER update_operation_types_updated_at BEFORE UPDATE ON public.operation_types FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "operator_sessions_updated_at" ON "public"."operator_sessions";
CREATE TRIGGER operator_sessions_updated_at BEFORE UPDATE ON public.operator_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "part_pricing_tiers_updated_at" ON "public"."part_pricing_tiers";
CREATE TRIGGER part_pricing_tiers_updated_at BEFORE UPDATE ON public.part_pricing_tiers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "parts_updated_at" ON "public"."parts";
CREATE TRIGGER parts_updated_at BEFORE UPDATE ON public.parts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "quotes_updated_at" ON "public"."quotes";
CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "trigger_quote_status_change" ON "public"."quotes";
CREATE TRIGGER trigger_quote_status_change BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION track_quote_status_change();

DROP TRIGGER IF EXISTS "trigger_set_quote_number" ON "public"."quotes";
CREATE TRIGGER trigger_set_quote_number BEFORE INSERT ON public.quotes FOR EACH ROW EXECUTE FUNCTION set_quote_number();

DROP TRIGGER IF EXISTS "update_quotes_updated_at" ON "public"."quotes";
CREATE TRIGGER update_quotes_updated_at BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "routing_materials_updated_at" ON "public"."routing_materials";
CREATE TRIGGER routing_materials_updated_at BEFORE UPDATE ON public.routing_materials FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "routing_nodes_updated_at" ON "public"."routing_nodes";
CREATE TRIGGER routing_nodes_updated_at BEFORE UPDATE ON public.routing_nodes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "routings_updated_at" ON "public"."routings";
CREATE TRIGGER routings_updated_at BEFORE UPDATE ON public.routings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "user_company_access_fill_email_trg" ON "public"."user_company_access";
CREATE TRIGGER user_company_access_fill_email_trg BEFORE INSERT ON public.user_company_access FOR EACH ROW EXECUTE FUNCTION user_company_access_fill_email();

DROP TRIGGER IF EXISTS "user_preferences_updated_at" ON "public"."user_preferences";
CREATE TRIGGER user_preferences_updated_at BEFORE UPDATE ON public.user_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "waitlist" ON "public"."waitlist";
CREATE TRIGGER waitlist AFTER INSERT ON public.waitlist FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://mayuquvexmqjvwkfasxg.supabase.co/functions/v1/notify-waitlist', 'POST', '{"Content-type":"application/json","Authorization":"Bearer [REDACTED]"}', '{}', '5000');


-- ============================================================
-- 10. COMMENTS
-- ============================================================
COMMENT ON TABLE "public"."ai_chat_queries"
    IS 'Log of AI chat conversations. Stores every question a user asks the AI assistant along with the generated response, tool calls made, chart configs, and token usage metrics for cost tracking.';

COMMENT ON TABLE "public"."ai_config"
    IS 'AI/LLM configuration per company per feature. Stores provider settings (e.g., Anthropic, OpenAI), model selection, and feature-specific parameters for AI-powered functionality like CSV import analysis.';

COMMENT ON TABLE "public"."companies"
    IS 'Multi-tenant root table. Each company represents a separate manufacturing shop/business with isolated data. All other tables reference company_id for tenant isolation via RLS policies.';

COMMENT ON TABLE "public"."company_custom_units"
    IS 'Custom measurement units defined per company for inventory tracking. Supplements the standard built-in units. Each unit name must be unique within a company.';

COMMENT ON TABLE "public"."customers"
    IS 'Customer records for each company. Customers place orders, receive quotes, and have jobs manufactured for them. Linked to parts (customer-specific parts), quotes, and jobs. Cannot be deleted if quotes or jobs exist (RESTRICT).';

COMMENT ON TABLE "public"."demo_data_templates"
    IS 'Templates for seeding demo/sample data into new company accounts. Contains versioned JSONB payloads of sample parts, customers, jobs, etc. Only one version per template name can be active at a time.';

COMMENT ON TABLE "public"."inventory_items"
    IS 'Core inventory item records with primary unit tracking. Stores materials, supplies, and other trackable items.';

COMMENT ON TABLE "public"."inventory_transactions"
    IS 'Full audit trail of all inventory changes (FR-13). Transactions are immutable.';

COMMENT ON TABLE "public"."inventory_unit_conversions"
    IS 'Secondary units with conversion factors to primary unit. Enables flexible inventory tracking (FR-1).';

COMMENT ON TABLE "public"."job_materials"
    IS 'Materials expected and consumed for a job. Snapshot from routing_materials at job creation time.';

COMMENT ON TABLE "public"."job_operations"
    IS 'Actual operation steps for a specific job. Tracks real-time progress: status, actual hours, quantities completed/scrapped, assigned operator. Shop floor operators interact primarily with this table.';

COMMENT ON TABLE "public"."jobs"
    IS 'Active manufacturing work orders. Created from quotes or directly. Tracks quantities ordered/completed/scrapped, due dates, priority, and current status. Contains job_operations as child records for step-by-step tracking.';

COMMENT ON TABLE "public"."markup_rates"
    IS 'Named, reusable markup matrices (qty × markup%) per company. Applied to parts via snapshot — copies breakpoints into part_pricing_tiers, no link.';

COMMENT ON TABLE "public"."operation_types"
    IS 'Operation types available in the shop (e.g., HURCO Mill, Mazak Lathe). Defines what work can be done and at what hourly cost.';

COMMENT ON TABLE "public"."operator_sessions"
    IS 'Work sessions tracking when operators are working on jobs. Used for time tracking and job progress.';

COMMENT ON TABLE "public"."part_pricing_tiers"
    IS 'Quantity price breaks for a part (the "estimate" layer). Seeded from part_categories.default_markup_percent. Selected tiers are snapshotted into quote_line_items at quote creation.';

COMMENT ON TABLE "public"."parts"
    IS 'Parts catalog. Each part has a company-unique part number, description, and flexible volume-based pricing stored as JSONB. Parts are company-wide entities (not customer-specific). Referenced by quotes, jobs, and routings (1:1).';

COMMENT ON TABLE "public"."quote_line_items"
    IS 'Immutable snapshot of selected pricing tiers at quote creation. Multiple parts per quote, multiple tiers per part.';

COMMENT ON TABLE "public"."quote_materials"
    IS 'Per-material cost snapshot captured at quote creation from the part routing. Rows are immutable after creation so the cost breakdown survives later routing edits.';

COMMENT ON TABLE "public"."quote_operations"
    IS 'Per-operation cost snapshot captured at quote creation from the part routing. Rows are immutable after creation so the cost breakdown survives later routing edits.';

COMMENT ON TABLE "public"."quotes"
    IS 'Sales quotes/estimates sent to customers before work begins. Contains pricing, lead time estimates, and can be converted to jobs. Tracks quote status (draft, sent, accepted, rejected, expired) and links to the job if converted.';

COMMENT ON TABLE "public"."routing_materials"
    IS 'Materials needed for the entire routing (job-level shopping list). Replaces the per-operation routing_nodes.materials JSONB.';

COMMENT ON TABLE "public"."routing_nodes"
    IS 'Workflow nodes 
 representing operations in a routing diagram. Each node is an 
 operation that can be connected to other nodes via edges to define 
 execution flow. Supports parallel and series execution patterns.';

COMMENT ON TABLE "public"."routings"
    IS 'Manufacturing process definitions (one per part). Each routing is a DAG of operation nodes connected by edges defining execution dependencies. Deleting a part cascades to its routing.';

COMMENT ON TABLE "public"."saved_insights"
    IS 'User-saved AI chat Q&A pairs. When a user finds an AI-generated insight valuable, they can save it for future reference. Includes the original question, answer text, and any chart configuration.';

COMMENT ON TABLE "public"."system_admins"
    IS 'Platform-level administrator access. Users in this table have system-wide admin privileges that span across all companies. Separate from company-level roles in user_company_access.';

COMMENT ON TABLE "public"."user_company_access"
    IS 'Junction table linking Supabase auth users to companies with role-based access. Enables multi-tenant access control. Users can belong to multiple companies with different roles (admin, user, operator).';

COMMENT ON TABLE "public"."user_preferences"
    IS 'Per-user preferences and settings. Stores last accessed company for quick switching, UI preferences, and other user-specific configuration as JSONB.';

COMMENT ON TABLE "public"."waitlist"
    IS 'Pre-launch waitlist signups from the landing page. Captures prospective customer info (email, name, company, shop size) and tracks signup status (pending, approved, invited) and acquisition source.';

COMMENT ON COLUMN "public"."ai_chat_queries"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."ai_chat_queries"."company_id"
    IS 'FK to companies. Isolates chat history per tenant.';

COMMENT ON COLUMN "public"."ai_chat_queries"."user_id"
    IS 'FK to auth.users. The user who asked the question. Nullable for system-generated queries.';

COMMENT ON COLUMN "public"."ai_chat_queries"."question"
    IS 'The natural-language question the user asked the AI assistant.';

COMMENT ON COLUMN "public"."ai_chat_queries"."tool_calls"
    IS 'JSONB array of tool/function calls the AI made to answer the question (e.g., SQL queries, calculations). Default: empty array.';

COMMENT ON COLUMN "public"."ai_chat_queries"."response"
    IS 'The AI-generated text response displayed to the user.';

COMMENT ON COLUMN "public"."ai_chat_queries"."chart_config"
    IS 'Optional JSONB chart configuration if the AI generated a visualization (chart type, data series, labels).';

COMMENT ON COLUMN "public"."ai_chat_queries"."provider"
    IS 'AI provider used for this query. Examples: "anthropic", "openai".';

COMMENT ON COLUMN "public"."ai_chat_queries"."model"
    IS 'Specific model identifier used. Examples: "claude-sonnet-4-20250514", "gpt-4o".';

COMMENT ON COLUMN "public"."ai_chat_queries"."tokens_used"
    IS 'Total token count (input + output) consumed by this query. Used for cost monitoring.';

COMMENT ON COLUMN "public"."ai_chat_queries"."duration_ms"
    IS 'Wall-clock time in milliseconds for the AI to generate the response.';

COMMENT ON COLUMN "public"."ai_chat_queries"."created_at"
    IS 'Timestamp when the query was made. Auto-set on insert.';

COMMENT ON COLUMN "public"."ai_config"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."ai_config"."company_id"
    IS 'FK to companies. Cascades on delete. Each company has separate AI config.';

COMMENT ON COLUMN "public"."ai_config"."feature"
    IS 'Feature identifier this config applies to. Examples: "csv_import", "quote_generation", "job_scheduling"';

COMMENT ON COLUMN "public"."ai_config"."provider"
    IS 'AI provider name. Default: "anthropic". Other options: "openai", "google".';

COMMENT ON COLUMN "public"."ai_config"."model"
    IS 'Specific model identifier. Examples: "claude-sonnet-4-20250514", "gpt-4o"';

COMMENT ON COLUMN "public"."ai_config"."settings"
    IS 'Provider/feature-specific settings as JSONB. May include: temperature, max_tokens, system prompts.';

COMMENT ON COLUMN "public"."ai_config"."created_at"
    IS 'Timestamp when config was created.';

COMMENT ON COLUMN "public"."ai_config"."updated_at"
    IS 'Timestamp of last update. Auto-updated via trigger.';

COMMENT ON COLUMN "public"."companies"."id"
    IS 'Primary key. UUID auto-generated. Referenced by all other tables for multi-tenant isolation.';

COMMENT ON COLUMN "public"."companies"."name"
    IS 'Display name of the company/shop. Example: "Contour Tool & Machine"';

COMMENT ON COLUMN "public"."companies"."slug"
    IS 'URL-friendly unique identifier. Used in routes like /dashboard/{slug}/. Example: "contour-tool"';

COMMENT ON COLUMN "public"."companies"."settings"
    IS 'Company-wide settings as JSONB. May include: default currency, timezone, fiscal year start, feature flags.';

COMMENT ON COLUMN "public"."companies"."created_at"
    IS 'Timestamp when company record was created. Auto-set on insert.';

COMMENT ON COLUMN "public"."companies"."updated_at"
    IS 'Timestamp of last update. Auto-updated via trigger.';

COMMENT ON COLUMN "public"."company_custom_units"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."company_custom_units"."company_id"
    IS 'FK to companies. Cascades on delete. Custom units are per-company.';

COMMENT ON COLUMN "public"."company_custom_units"."unit_name"
    IS 'Display name of the custom unit. Example: "barrel", "spool". Must be unique within the company.';

COMMENT ON COLUMN "public"."company_custom_units"."created_at"
    IS 'Timestamp when the custom unit was created. Auto-set on insert.';

COMMENT ON COLUMN "public"."customers"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."customers"."company_id"
    IS 'FK to companies. Cascades on delete. Isolates customers per tenant.';

COMMENT ON COLUMN "public"."customers"."name"
    IS 'Full legal/display name of customer. Example: "Acme Manufacturing Corp"';

COMMENT ON COLUMN "public"."customers"."website"
    IS 'Customer website URL. Optional.';

COMMENT ON COLUMN "public"."customers"."contact_name"
    IS 'Primary contact person name at customer.';

COMMENT ON COLUMN "public"."customers"."contact_phone"
    IS 'Primary contact phone number.';

COMMENT ON COLUMN "public"."customers"."contact_email"
    IS 'Primary contact email address.';

COMMENT ON COLUMN "public"."customers"."address_line1"
    IS 'Street address line 1.';

COMMENT ON COLUMN "public"."customers"."address_line2"
    IS 'Street address line 2 (suite, unit, etc.).';

COMMENT ON COLUMN "public"."customers"."city"
    IS 'City name.';

COMMENT ON COLUMN "public"."customers"."state"
    IS 'State/province code or name.';

COMMENT ON COLUMN "public"."customers"."postal_code"
    IS 'ZIP/postal code.';

COMMENT ON COLUMN "public"."customers"."country"
    IS 'Country code or name. Default: "USA"';

COMMENT ON COLUMN "public"."customers"."created_at"
    IS 'Timestamp when customer was created.';

COMMENT ON COLUMN "public"."customers"."updated_at"
    IS 'Timestamp of last update. Auto-updated via trigger.';

COMMENT ON COLUMN "public"."demo_data_templates"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."demo_data_templates"."name"
    IS 'Template name identifier. Example: "precision_machining_shop". Unique per version.';

COMMENT ON COLUMN "public"."demo_data_templates"."version"
    IS 'Version number for this template. Allows iterating on demo data while keeping history. Default: 1.';

COMMENT ON COLUMN "public"."demo_data_templates"."is_active"
    IS 'Whether this template version is the active one used for new demo accounts. Default: false.';

COMMENT ON COLUMN "public"."demo_data_templates"."template_data"
    IS 'JSONB payload containing all demo data: parts, customers, jobs, operations, inventory, etc. Structured for the seed function to process.';

COMMENT ON COLUMN "public"."demo_data_templates"."created_at"
    IS 'Timestamp when the template was created. Auto-set on insert.';

COMMENT ON COLUMN "public"."demo_data_templates"."created_by"
    IS 'FK to auth.users. The admin who created this template. Nullable.';

COMMENT ON COLUMN "public"."inventory_items"."primary_unit"
    IS 'Base unit of measure (e.g., lbs, kg, pcs)';

COMMENT ON COLUMN "public"."inventory_items"."quantity"
    IS 'Current quantity in primary unit, must be >= 0';

COMMENT ON COLUMN "public"."inventory_transactions"."item_name"
    IS 'Snapshot of item name at transaction time for audit trail (preserved if item deleted)';

COMMENT ON COLUMN "public"."inventory_transactions"."type"
    IS 'addition (stock in), depletion (stock out), adjustment (correction)';

COMMENT ON COLUMN "public"."inventory_transactions"."converted_quantity"
    IS 'Quantity converted to primary unit';

COMMENT ON COLUMN "public"."inventory_transactions"."has_discrepancy"
    IS 'True when confirmed usage exceeded available stock. Transaction records full operator-confirmed amount, but inventory was only depleted to zero.';

COMMENT ON COLUMN "public"."inventory_unit_conversions"."to_primary_factor"
    IS 'Multiply quantity in from_unit by this factor to get quantity in primary unit';

COMMENT ON COLUMN "public"."job_materials"."routing_material_id"
    IS 'Source routing_material this row was copied from. SET NULL if the routing material is later deleted.';

COMMENT ON COLUMN "public"."job_materials"."expected_quantity"
    IS 'Quantity expected to be consumed (snapshot from routing_materials.quantity at job creation).';

COMMENT ON COLUMN "public"."job_materials"."actual_quantity"
    IS 'Quantity actually consumed, recorded by the operator on completion. NULL until consumed.';

COMMENT ON COLUMN "public"."job_operations"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."job_operations"."job_id"
    IS 'FK to jobs. Cascades on delete - operations deleted with job.';

COMMENT ON COLUMN "public"."job_operations"."sequence"
    IS 'Order of operation within job. Unique per job.';

COMMENT ON COLUMN "public"."job_operations"."operation_name"
    IS 'Name of the operation. Copied from routing or manually entered.';

COMMENT ON COLUMN "public"."job_operations"."operation_type_id"
    IS 'FK to operation_types. What type of operation is performed. SET NULL if operation type deleted.';

COMMENT ON COLUMN "public"."job_operations"."estimated_setup_minutes"
    IS 'Estimated one-time setup minutes from routing (per batch, not per unit).';

COMMENT ON COLUMN "public"."job_operations"."estimated_run_minutes_per_unit"
    IS 'Estimated run minutes per unit from routing.';

COMMENT ON COLUMN "public"."job_operations"."actual_setup_minutes"
    IS 'Actual setup minutes recorded by operator.';

COMMENT ON COLUMN "public"."job_operations"."actual_run_minutes"
    IS 'Actual total run minutes recorded by operator.';

COMMENT ON COLUMN "public"."job_operations"."status"
    IS 'Operation status. Values: pending, in_progress, completed, skipped. Default: pending';

COMMENT ON COLUMN "public"."job_operations"."started_at"
    IS 'Timestamp when operator started this operation.';

COMMENT ON COLUMN "public"."job_operations"."completed_at"
    IS 'Timestamp when operation was completed.';

COMMENT ON COLUMN "public"."job_operations"."assigned_to"
    IS 'UUID of operator assigned to this operation.';

COMMENT ON COLUMN "public"."job_operations"."completed_by"
    IS 'UUID of operator who completed this operation.';

COMMENT ON COLUMN "public"."job_operations"."notes"
    IS 'Operator notes, issues encountered, etc.';

COMMENT ON COLUMN "public"."job_operations"."created_at"
    IS 'Timestamp when operation record was created.';

COMMENT ON COLUMN "public"."job_operations"."updated_at"
    IS 'Timestamp of last update. Auto-updated via trigger.';

COMMENT ON COLUMN "public"."job_operations"."routing_node_id"
    IS 'FK to routing_nodes. Links this job operation back to the specific node in the routing DAG it was created from. NULL for operations created before this migration or ad-hoc operations.';

COMMENT ON COLUMN "public"."jobs"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."jobs"."company_id"
    IS 'FK to companies. Cascades on delete.';

COMMENT ON COLUMN "public"."jobs"."job_number"
    IS 'Unique job/work order number within company. Example: "J-2024-001", "WO-00042"';

COMMENT ON COLUMN "public"."jobs"."quote_id"
    IS 'FK to quotes. Set if job created from accepted quote. SET NULL if quote deleted.';

COMMENT ON COLUMN "public"."jobs"."customer_id"
    IS 'FK to customers. Required - every job must have a customer. RESTRICT on delete.';

COMMENT ON COLUMN "public"."jobs"."status"
    IS 'Job lifecycle status. Values: pending, in_progress, on_hold, completed, shipped, cancelled. Default: pending';

COMMENT ON COLUMN "public"."jobs"."status_changed_at"
    IS 'Timestamp when status last changed.';

COMMENT ON COLUMN "public"."jobs"."started_at"
    IS 'Timestamp when first operation began.';

COMMENT ON COLUMN "public"."jobs"."completed_at"
    IS 'Timestamp when all operations completed.';

COMMENT ON COLUMN "public"."jobs"."shipped_at"
    IS 'Timestamp when job was shipped to customer.';

COMMENT ON COLUMN "public"."jobs"."created_by"
    IS 'UUID of user who created the job. References Supabase auth.users.';

COMMENT ON COLUMN "public"."jobs"."created_at"
    IS 'Timestamp when job was created.';

COMMENT ON COLUMN "public"."jobs"."updated_at"
    IS 'Timestamp of last update. Auto-updated via trigger.';

COMMENT ON COLUMN "public"."jobs"."due_date"
    IS 'Date the job is due to ship. Typically CURRENT_DATE + lead_time_days at conversion. Used to flag overdue jobs.';

COMMENT ON COLUMN "public"."jobs"."lead_time_days"
    IS 'Lead time in days, copied from the source quote at conversion. Editable on the job after the fact.';

COMMENT ON COLUMN "public"."markup_rates"."breakpoints"
    IS 'JSONB array of {qty: int>0, markup_percent: number}. Sorted by qty ascending. At least one breakpoint required at write time.';

COMMENT ON COLUMN "public"."operation_types"."id"
    IS 'Primary key (auto-generated UUID)';

COMMENT ON COLUMN "public"."operation_types"."company_id"
    IS 'Foreign key to companies table (multi-tenant isolation)';

COMMENT ON COLUMN "public"."operation_types"."name"
    IS 'Operation type name (e.g., "HURCO Mill", "EDM", "GRINDING")';

COMMENT ON COLUMN "public"."operation_types"."labor_rate"
    IS 'Hourly rate in dollars (e.g., 135.00)';

COMMENT ON COLUMN "public"."operation_types"."description"
    IS 'Optional description or notes';

COMMENT ON COLUMN "public"."operation_types"."metadata"
    IS 'Flexible JSONB for shop-specific data (setup_time_minutes, capabilities, legacy_id, etc.)';

COMMENT ON COLUMN "public"."operation_types"."created_at"
    IS 'Timestamp when record was created';

COMMENT ON COLUMN "public"."operation_types"."updated_at"
    IS 'Timestamp when record was last updated';

COMMENT ON COLUMN "public"."operator_sessions"."job_operation_id"
    IS 'The specific job operation step being worked. Inferred from job + operation_type when session starts.';

COMMENT ON COLUMN "public"."operator_sessions"."operation_type_id"
    IS 'The operation type from the station QR code. Identifies which workstation the operator is at.';

COMMENT ON COLUMN "public"."operator_sessions"."ended_at"
    IS 'NULL while session is active. Set when operator stops or completes work.';

COMMENT ON COLUMN "public"."parts"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."parts"."company_id"
    IS 'FK to companies. Cascades on delete. Isolates parts per tenant.';

COMMENT ON COLUMN "public"."parts"."part_name"
    IS 'Display name for this part (unique per company).';

COMMENT ON COLUMN "public"."parts"."description"
    IS 'Human-readable description of what the part is. Example: "Recess Tool Bit", "Aluminum Bracket Assembly"';

COMMENT ON COLUMN "public"."parts"."created_at"
    IS 'Timestamp when part was created.';

COMMENT ON COLUMN "public"."parts"."updated_at"
    IS 'Timestamp of last update. Auto-updated via trigger.';

COMMENT ON COLUMN "public"."quotes"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."quotes"."company_id"
    IS 'FK to companies. Cascades on delete.';

COMMENT ON COLUMN "public"."quotes"."quote_number"
    IS 'Unique quote identifier within company. Example: "Q-2024-001", "QTE-00042"';

COMMENT ON COLUMN "public"."quotes"."customer_id"
    IS 'FK to customers. RESTRICT on delete - cannot delete customer with quotes.';

COMMENT ON COLUMN "public"."quotes"."status"
    IS 'Quote lifecycle status. Values: draft, pending_approval, approved, rejected, accepted, expired, converted. Default: draft';

COMMENT ON COLUMN "public"."quotes"."status_changed_at"
    IS 'Timestamp when status last changed. For tracking response times.';

COMMENT ON COLUMN "public"."quotes"."converted_at"
    IS 'Timestamp when quote was converted to job.';

COMMENT ON COLUMN "public"."quotes"."created_by"
    IS 'UUID of user who created the quote. References Supabase auth.users.';

COMMENT ON COLUMN "public"."quotes"."created_at"
    IS 'Timestamp when quote was created.';

COMMENT ON COLUMN "public"."quotes"."updated_at"
    IS 'Timestamp of last update. Auto-updated via trigger.';

COMMENT ON COLUMN "public"."quotes"."lead_time_days"
    IS 'Lead time promised to the customer in days. Copied to jobs.lead_time_days on conversion.';

COMMENT ON COLUMN "public"."quotes"."expiration_date"
    IS 'Date at which the quote expires. Defaults to created_at + 10 days. Informational — expiration never blocks conversion.';

COMMENT ON COLUMN "public"."routing_materials"."sequence"
    IS 'Display order in the routing builder. Steps of 10.';

COMMENT ON COLUMN "public"."routing_nodes"."id"
    IS 'Unique 
 identifier for the routing node';

COMMENT ON COLUMN "public"."routing_nodes"."routing_id"
    IS 'Foreign 
 key to the parent routing this node belongs to';

COMMENT ON COLUMN "public"."routing_nodes"."operation_type_id"
    IS 'Foreign key to the operation type (e.g., CNC Mill, Lathe, 
 Inspect)';

COMMENT ON COLUMN "public"."routing_nodes"."run_time_per_unit"
    IS 'Estimated run time per unit in minutes for this operation';

COMMENT ON COLUMN "public"."routing_nodes"."metadata"
    IS 'Optional 
 JSON metadata (can store UI position hints for custom layouts)';

COMMENT ON COLUMN "public"."routing_nodes"."created_at"
    IS 'Timestamp when the node was created';

COMMENT ON COLUMN "public"."routing_nodes"."updated_at"
    IS 'Timestamp when the node was last updated';

COMMENT ON COLUMN "public"."routing_nodes"."setup_time"
    IS 'One-time setup/changeover time in minutes. Applies once per batch, not per unit.';

COMMENT ON COLUMN "public"."routing_nodes"."sequence"
    IS 'Linear order of operations within the routing. Lower values execute first. Steps of 10 (10, 20, 30...) leave room for future inserts.';

COMMENT ON COLUMN "public"."routings"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."routings"."company_id"
    IS 'FK to companies. Cascades on delete.';

COMMENT ON COLUMN "public"."routings"."part_id"
    IS 'FK to parts. Optional - routing can be part-specific or standalone template. SET NULL if part deleted.';

COMMENT ON COLUMN "public"."routings"."name"
    IS 'Routing name/identifier. Example: "Standard Widget Process", "Rush Assembly"';

COMMENT ON COLUMN "public"."routings"."description"
    IS 'Detailed description of the manufacturing process.';

COMMENT ON COLUMN "public"."routings"."created_by"
    IS 'UUID of user who created the routing.';

COMMENT ON COLUMN "public"."routings"."created_at"
    IS 'Timestamp when routing was created.';

COMMENT ON COLUMN "public"."routings"."updated_at"
    IS 'Timestamp of last update. Auto-updated via trigger.';

COMMENT ON COLUMN "public"."saved_insights"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."saved_insights"."user_id"
    IS 'FK to auth.users. The user who saved this insight.';

COMMENT ON COLUMN "public"."saved_insights"."company_id"
    IS 'FK to companies. Isolates saved insights per tenant.';

COMMENT ON COLUMN "public"."saved_insights"."question"
    IS 'The original question that was asked to generate this insight.';

COMMENT ON COLUMN "public"."saved_insights"."answer"
    IS 'The AI-generated answer text that the user saved.';

COMMENT ON COLUMN "public"."saved_insights"."chart_config"
    IS 'Optional JSONB chart configuration saved with the insight.';

COMMENT ON COLUMN "public"."saved_insights"."created_at"
    IS 'Timestamp when the insight was saved. Auto-set on insert.';

COMMENT ON COLUMN "public"."system_admins"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."system_admins"."user_id"
    IS 'FK to auth.users. The user granted system admin privileges. Must be unique.';

COMMENT ON COLUMN "public"."system_admins"."created_at"
    IS 'Timestamp when admin access was granted. Auto-set on insert.';

COMMENT ON COLUMN "public"."system_admins"."created_by"
    IS 'FK to auth.users. The admin who granted this access. Nullable for initial bootstrap.';

COMMENT ON COLUMN "public"."user_company_access"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."user_company_access"."user_id"
    IS 'FK to Supabase auth.users. The user being granted access.';

COMMENT ON COLUMN "public"."user_company_access"."company_id"
    IS 'FK to companies. Cascades on delete. The company user can access.';

COMMENT ON COLUMN "public"."user_company_access"."role"
    IS 'Role in the company: admin (full access), user (can use all modules), operator (shop floor access only)';

COMMENT ON COLUMN "public"."user_company_access"."created_at"
    IS 'Timestamp when access was granted.';

COMMENT ON COLUMN "public"."user_company_access"."name"
    IS 'Display name for the team member. Stored here for easy querying without service role access to auth.users.';

COMMENT ON COLUMN "public"."user_preferences"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."user_preferences"."user_id"
    IS 'FK to Supabase auth.users. Unique - one preferences record per user.';

COMMENT ON COLUMN "public"."user_preferences"."last_company_id"
    IS 'FK to companies. Last company user accessed. For quick switching. SET NULL if company deleted.';

COMMENT ON COLUMN "public"."user_preferences"."preferences"
    IS 'User preferences as JSONB. May include: theme, default_view, notification_settings, UI preferences.';

COMMENT ON COLUMN "public"."user_preferences"."created_at"
    IS 'Timestamp when preferences record was created.';

COMMENT ON COLUMN "public"."user_preferences"."updated_at"
    IS 'Timestamp of last update. Auto-updated via trigger.';

COMMENT ON COLUMN "public"."waitlist"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."waitlist"."email"
    IS 'Email address of the signup. Must be unique across the waitlist.';

COMMENT ON COLUMN "public"."waitlist"."name"
    IS 'Full name of the person signing up. Optional.';

COMMENT ON COLUMN "public"."waitlist"."company_name"
    IS 'Name of their manufacturing company/shop. Optional.';

COMMENT ON COLUMN "public"."waitlist"."shop_size"
    IS 'Self-reported shop size. Examples: "1-5 employees", "6-20 employees", "21-50 employees". Optional.';

COMMENT ON COLUMN "public"."waitlist"."status"
    IS 'Signup status. Values: "pending" (default), "approved", "invited", "converted". Tracks progression through the onboarding funnel.';

COMMENT ON COLUMN "public"."waitlist"."source"
    IS 'Acquisition source tracking. Default: "landing_page". Other examples: "referral", "demo_request".';

COMMENT ON COLUMN "public"."waitlist"."created_at"
    IS 'Timestamp when the signup occurred. Auto-set on insert.';

-- ============================================================
-- 11. STORAGE BUCKETS
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('attachments', 'attachments', false, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

COMMIT;
