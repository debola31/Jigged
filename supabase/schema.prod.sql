-- ============================================================
-- Jigged Manufacturing ERP - Database Schema
-- Generated: 2026-05-14T19:11:05Z
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

CREATE TABLE IF NOT EXISTS "public"."feedback"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "page_path" text NOT NULL,
    "page_title" text NOT NULL,
    "feedback_text" text NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "feedback_pkey" PRIMARY KEY (id)
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

CREATE TABLE IF NOT EXISTS "public"."vendors"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "name" text NOT NULL,
    "address_line1" text,
    "address_line2" text,
    "city" text,
    "state" text,
    "postal_code" text,
    "country" text DEFAULT 'USA'::text,
    "legacy_id" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "vendors_pkey" PRIMARY KEY (id),
    CONSTRAINT "vendors_legacy_id_unique_per_company" UNIQUE (company_id, legacy_id),
    CONSTRAINT "vendors_unique_per_company" UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS "public"."parts"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "part_name" text NOT NULL,
    "description" text,
    "is_stocked" boolean NOT NULL DEFAULT false,
    "primary_unit" text,
    "quantity" numeric NOT NULL DEFAULT 0,
    "reorder_point" numeric,
    "preferred_vendor_id" uuid,
    "legacy_id" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    "source" text NOT NULL DEFAULT 'made'::text,
    "markup_rate_id" uuid,
    CONSTRAINT "parts_pkey" PRIMARY KEY (id),
    CONSTRAINT "parts_legacy_id_unique_per_company" UNIQUE (company_id, legacy_id),
    CONSTRAINT "parts_unique_per_company" UNIQUE (company_id, part_name),
    CONSTRAINT "parts_quantity_non_negative" CHECK ((quantity >= (0)::numeric)),
    CONSTRAINT "parts_source_check" CHECK ((source = ANY (ARRAY['made'::text, 'bought'::text]))),
    CONSTRAINT "parts_stocked_requires_unit" CHECK (((NOT is_stocked) OR (primary_unit IS NOT NULL)))
);

CREATE TABLE IF NOT EXISTS "public"."part_pricing_tiers"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "part_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "sequence" integer NOT NULL,
    "quantity" integer NOT NULL,
    "markup_percent" numeric(5,2),
    "unit_price" numeric(12,4),
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "part_pricing_tiers_pkey" PRIMARY KEY (id),
    CONSTRAINT "part_pricing_tiers_unique_seq" UNIQUE (part_id, sequence),
    CONSTRAINT "part_pricing_tiers_quantity_check" CHECK ((quantity > 0))
);

CREATE TABLE IF NOT EXISTS "public"."part_procurement_tiers"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "part_id" uuid NOT NULL,
    "vendor_id" uuid,
    "min_quantity" numeric NOT NULL,
    "cost_per_unit" numeric NOT NULL,
    "quoted_at" date,
    "expires_at" date,
    "notes" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "part_procurement_tiers_pkey" PRIMARY KEY (id),
    CONSTRAINT "part_procurement_tiers_part_id_vendor_id_min_quantity_key" UNIQUE (part_id, vendor_id, min_quantity),
    CONSTRAINT "part_procurement_tiers_cost_per_unit_check" CHECK ((cost_per_unit > (0)::numeric)),
    CONSTRAINT "part_procurement_tiers_min_quantity_check" CHECK ((min_quantity > (0)::numeric))
);

CREATE TABLE IF NOT EXISTS "public"."parts_bom"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "parent_part_id" uuid NOT NULL,
    "child_part_id" uuid NOT NULL,
    "quantity" numeric NOT NULL,
    "unit" text NOT NULL,
    "sequence" integer NOT NULL DEFAULT 0,
    "notes" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "parts_bom_pkey" PRIMARY KEY (id),
    CONSTRAINT "parts_bom_unique_child" UNIQUE (parent_part_id, child_part_id),
    CONSTRAINT "parts_bom_no_self_reference" CHECK ((parent_part_id <> child_part_id)),
    CONSTRAINT "parts_bom_quantity_positive" CHECK ((quantity > (0)::numeric))
);

CREATE TABLE IF NOT EXISTS "public"."parts_unit_conversions"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "part_id" uuid NOT NULL,
    "from_unit" text NOT NULL,
    "to_primary_factor" numeric NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "parts_unit_conversions_pkey" PRIMARY KEY (id),
    CONSTRAINT "parts_unit_conversions_part_unit_unique" UNIQUE (part_id, from_unit),
    CONSTRAINT "parts_unit_conversions_factor_positive" CHECK ((to_primary_factor > (0)::numeric))
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

CREATE TABLE IF NOT EXISTS "public"."job_materials"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "job_id" uuid NOT NULL,
    "job_part_id" uuid NOT NULL,
    "parts_bom_id" uuid,
    "material_part_id" uuid NOT NULL,
    "expected_quantity" numeric NOT NULL DEFAULT 0,
    "actual_quantity" numeric,
    "unit" text NOT NULL,
    "status" text NOT NULL DEFAULT 'pending'::text,
    "consumed_at" timestamp with time zone,
    "consumed_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "job_materials_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_materials_actual_quantity_check" CHECK (((actual_quantity IS NULL) OR (actual_quantity >= (0)::numeric))),
    CONSTRAINT "job_materials_expected_quantity_check" CHECK ((expected_quantity >= (0)::numeric)),
    CONSTRAINT "job_materials_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'consumed'::text, 'skipped'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."quote_materials"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "quote_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "sequence" integer NOT NULL,
    "material_part_id" uuid,
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

CREATE TABLE IF NOT EXISTS "public"."vendor_contacts"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "vendor_id" uuid NOT NULL,
    "name" text NOT NULL,
    "role" text NOT NULL,
    "role_label" text,
    "email" text,
    "phone" text,
    "is_primary" boolean NOT NULL DEFAULT false,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "vendor_contacts_pkey" PRIMARY KEY (id),
    CONSTRAINT "vendor_contacts_role_check" CHECK ((role = ANY (ARRAY['sales'::text, 'accounts_payable'::text, 'quality'::text, 'engineering'::text, 'shipping_receiving'::text, 'customer_service'::text, 'other'::text]))),
    CONSTRAINT "vendor_contacts_role_label_required" CHECK (((role <> 'other'::text) OR ((role_label IS NOT NULL) AND (length(role_label) > 0))))
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

CREATE TABLE IF NOT EXISTS "public"."work_centers"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "name" text NOT NULL,
    "kind" text NOT NULL DEFAULT 'internal'::text,
    "vendor_id" uuid,
    "labor_rate" numeric(10,2),
    "description" text,
    "metadata" jsonb DEFAULT '{}'::jsonb,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "work_centers_pkey" PRIMARY KEY (id),
    CONSTRAINT "work_centers_unique_per_company" UNIQUE (company_id, name),
    CONSTRAINT "work_centers_external_requires_vendor" CHECK (((kind = 'internal'::text) OR (vendor_id IS NOT NULL))),
    CONSTRAINT "work_centers_internal_no_vendor" CHECK (((kind = 'external'::text) OR (vendor_id IS NULL))),
    CONSTRAINT "work_centers_kind_check" CHECK ((kind = ANY (ARRAY['internal'::text, 'external'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."routing_operations"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "routing_id" uuid NOT NULL,
    "work_center_id" uuid NOT NULL,
    "sequence" integer NOT NULL DEFAULT 0,
    "setup_minutes" numeric(8,2) DEFAULT 0,
    "cycle_minutes_per_unit" numeric(8,4),
    "labor_rate_override" numeric(10,2),
    "external_unit_price" numeric(12,4),
    "external_setup_cost" numeric(12,4),
    "instructions" text,
    "metadata" jsonb DEFAULT '{}'::jsonb,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "routing_operations_pkey" PRIMARY KEY (id),
    CONSTRAINT "routing_operations_routing_sequence_unique" UNIQUE (routing_id, sequence)
);

CREATE TABLE IF NOT EXISTS "public"."job_operations"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "job_id" uuid NOT NULL,
    "job_part_id" uuid NOT NULL,
    "sequence" integer NOT NULL,
    "operation_name" text NOT NULL,
    "work_center_id" uuid,
    "estimated_setup_minutes" numeric(8,2) DEFAULT 0,
    "estimated_run_minutes_per_unit" numeric(8,4) DEFAULT 0,
    "actual_setup_minutes" numeric(8,2),
    "actual_run_minutes" numeric(8,2),
    "status" text NOT NULL DEFAULT 'pending'::text,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "assigned_to" uuid,
    "completed_by" uuid,
    "instructions" text,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "routing_operation_id" uuid,
    CONSTRAINT "job_operations_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_operations_job_part_sequence_key" UNIQUE (job_part_id, sequence),
    CONSTRAINT "job_operations_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'skipped'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."inventory_transactions"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "part_id" uuid,
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
    "work_center_id" uuid NOT NULL,
    "started_at" timestamp with time zone DEFAULT now(),
    "ended_at" timestamp with time zone,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "operator_sessions_pkey" PRIMARY KEY (id)
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
ALTER TABLE "public"."feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."inventory_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."markup_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."operator_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."part_pricing_tiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."part_procurement_tiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."parts_bom" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."parts_unit_conversions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quote_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quote_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quote_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."routing_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."routings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."saved_insights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."system_admins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."user_company_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."user_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."vendor_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."vendors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."waitlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."work_centers" ENABLE ROW LEVEL SECURITY;

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

DROP POLICY IF EXISTS "Admins can read feedback for their companies" ON "public"."feedback";
CREATE POLICY "Admins can read feedback for their companies"
    ON "public"."feedback"
    FOR SELECT
    USING ((EXISTS ( SELECT 1
   FROM user_company_access uca
  WHERE ((uca.user_id = auth.uid()) AND (uca.company_id = feedback.company_id) AND (uca.role = 'admin'::text)))));

DROP POLICY IF EXISTS "Users can insert feedback for their companies" ON "public"."feedback";
CREATE POLICY "Users can insert feedback for their companies"
    ON "public"."feedback"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT uca.company_id
   FROM user_company_access uca
  WHERE (uca.user_id = auth.uid()))));

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

DROP POLICY IF EXISTS "Users can delete part_procurement_tiers" ON "public"."part_procurement_tiers";
CREATE POLICY "Users can delete part_procurement_tiers"
    ON "public"."part_procurement_tiers"
    FOR DELETE
    USING ((part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert part_procurement_tiers" ON "public"."part_procurement_tiers";
CREATE POLICY "Users can insert part_procurement_tiers"
    ON "public"."part_procurement_tiers"
    FOR INSERT
    WITH CHECK ((part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update part_procurement_tiers" ON "public"."part_procurement_tiers";
CREATE POLICY "Users can update part_procurement_tiers"
    ON "public"."part_procurement_tiers"
    FOR UPDATE
    USING ((part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view part_procurement_tiers" ON "public"."part_procurement_tiers";
CREATE POLICY "Users can view part_procurement_tiers"
    ON "public"."part_procurement_tiers"
    FOR SELECT
    USING ((part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."part_procurement_tiers";
CREATE POLICY "ai_readonly_select"
    ON "public"."part_procurement_tiers"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM parts
  WHERE ((parts.id = part_procurement_tiers.part_id) AND (parts.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

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

DROP POLICY IF EXISTS "Users can delete parts_bom" ON "public"."parts_bom";
CREATE POLICY "Users can delete parts_bom"
    ON "public"."parts_bom"
    FOR DELETE
    USING ((parent_part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert parts_bom" ON "public"."parts_bom";
CREATE POLICY "Users can insert parts_bom"
    ON "public"."parts_bom"
    FOR INSERT
    WITH CHECK ((parent_part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update parts_bom" ON "public"."parts_bom";
CREATE POLICY "Users can update parts_bom"
    ON "public"."parts_bom"
    FOR UPDATE
    USING ((parent_part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view parts_bom" ON "public"."parts_bom";
CREATE POLICY "Users can view parts_bom"
    ON "public"."parts_bom"
    FOR SELECT
    USING ((parent_part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."parts_bom";
CREATE POLICY "ai_readonly_select"
    ON "public"."parts_bom"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM parts
  WHERE ((parts.id = parts_bom.parent_part_id) AND (parts.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

DROP POLICY IF EXISTS "Users can delete parts_unit_conversions" ON "public"."parts_unit_conversions";
CREATE POLICY "Users can delete parts_unit_conversions"
    ON "public"."parts_unit_conversions"
    FOR DELETE
    USING ((part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert parts_unit_conversions" ON "public"."parts_unit_conversions";
CREATE POLICY "Users can insert parts_unit_conversions"
    ON "public"."parts_unit_conversions"
    FOR INSERT
    WITH CHECK ((part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update parts_unit_conversions" ON "public"."parts_unit_conversions";
CREATE POLICY "Users can update parts_unit_conversions"
    ON "public"."parts_unit_conversions"
    FOR UPDATE
    USING ((part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view parts_unit_conversions" ON "public"."parts_unit_conversions";
CREATE POLICY "Users can view parts_unit_conversions"
    ON "public"."parts_unit_conversions"
    FOR SELECT
    USING ((part_id IN ( SELECT parts.id
   FROM parts
  WHERE (parts.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."parts_unit_conversions";
CREATE POLICY "ai_readonly_select"
    ON "public"."parts_unit_conversions"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM parts
  WHERE ((parts.id = parts_unit_conversions.part_id) AND (parts.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

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

DROP POLICY IF EXISTS "Users can delete routing_operations" ON "public"."routing_operations";
CREATE POLICY "Users can delete routing_operations"
    ON "public"."routing_operations"
    FOR DELETE
    USING ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert routing_operations" ON "public"."routing_operations";
CREATE POLICY "Users can insert routing_operations"
    ON "public"."routing_operations"
    FOR INSERT
    WITH CHECK ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update routing_operations" ON "public"."routing_operations";
CREATE POLICY "Users can update routing_operations"
    ON "public"."routing_operations"
    FOR UPDATE
    USING ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view routing_operations" ON "public"."routing_operations";
CREATE POLICY "Users can view routing_operations"
    ON "public"."routing_operations"
    FOR SELECT
    USING ((routing_id IN ( SELECT routings.id
   FROM routings
  WHERE (routings.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."routing_operations";
CREATE POLICY "ai_readonly_select"
    ON "public"."routing_operations"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM routings
  WHERE ((routings.id = routing_operations.routing_id) AND (routings.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

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

DROP POLICY IF EXISTS "Users can delete vendor_contacts" ON "public"."vendor_contacts";
CREATE POLICY "Users can delete vendor_contacts"
    ON "public"."vendor_contacts"
    FOR DELETE
    USING ((vendor_id IN ( SELECT v.id
   FROM vendors v
  WHERE (v.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert vendor_contacts" ON "public"."vendor_contacts";
CREATE POLICY "Users can insert vendor_contacts"
    ON "public"."vendor_contacts"
    FOR INSERT
    WITH CHECK ((vendor_id IN ( SELECT v.id
   FROM vendors v
  WHERE (v.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update vendor_contacts" ON "public"."vendor_contacts";
CREATE POLICY "Users can update vendor_contacts"
    ON "public"."vendor_contacts"
    FOR UPDATE
    USING ((vendor_id IN ( SELECT v.id
   FROM vendors v
  WHERE (v.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view vendor_contacts" ON "public"."vendor_contacts";
CREATE POLICY "Users can view vendor_contacts"
    ON "public"."vendor_contacts"
    FOR SELECT
    USING ((vendor_id IN ( SELECT v.id
   FROM vendors v
  WHERE (v.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."vendor_contacts";
CREATE POLICY "ai_readonly_select"
    ON "public"."vendor_contacts"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((vendor_id IN ( SELECT v.id
   FROM vendors v
  WHERE (v.company_id = (current_setting('jigged.company_id'::text, true))::uuid))));

DROP POLICY IF EXISTS "Users can delete vendors" ON "public"."vendors";
CREATE POLICY "Users can delete vendors"
    ON "public"."vendors"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert vendors" ON "public"."vendors";
CREATE POLICY "Users can insert vendors"
    ON "public"."vendors"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update vendors" ON "public"."vendors";
CREATE POLICY "Users can update vendors"
    ON "public"."vendors"
    FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view vendors" ON "public"."vendors";
CREATE POLICY "Users can view vendors"
    ON "public"."vendors"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."vendors";
CREATE POLICY "ai_readonly_select"
    ON "public"."vendors"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

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

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."work_centers";
CREATE POLICY "ai_readonly_select"
    ON "public"."work_centers"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

DROP POLICY IF EXISTS "work_centers_delete" ON "public"."work_centers";
CREATE POLICY "work_centers_delete"
    ON "public"."work_centers"
    FOR DELETE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "work_centers_insert" ON "public"."work_centers";
CREATE POLICY "work_centers_insert"
    ON "public"."work_centers"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "work_centers_select" ON "public"."work_centers";
CREATE POLICY "work_centers_select"
    ON "public"."work_centers"
    FOR SELECT
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

DROP POLICY IF EXISTS "work_centers_update" ON "public"."work_centers";
CREATE POLICY "work_centers_update"
    ON "public"."work_centers"
    FOR UPDATE
    USING ((company_id IN ( SELECT user_company_access.company_id
   FROM user_company_access
  WHERE (user_company_access.user_id = auth.uid()))));

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

ALTER TABLE "public"."feedback"
    ADD CONSTRAINT "feedback_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."feedback"
    ADD CONSTRAINT "feedback_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_job_operation_id_fkey" FOREIGN KEY (job_operation_id) REFERENCES job_operations(id) ON DELETE SET NULL;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE SET NULL;

ALTER TABLE "public"."invitations"
    ADD CONSTRAINT "invitations_accepted_by_fkey" FOREIGN KEY (accepted_by) REFERENCES auth.users(id);

ALTER TABLE "public"."invitations"
    ADD CONSTRAINT "invitations_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."invitations"
    ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY (invited_by) REFERENCES auth.users(id);

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_consumed_by_fkey" FOREIGN KEY (consumed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_job_part_id_fkey" FOREIGN KEY (job_part_id) REFERENCES job_parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_material_part_id_fkey" FOREIGN KEY (material_part_id) REFERENCES parts(id) ON DELETE RESTRICT;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_parts_bom_id_fkey" FOREIGN KEY (parts_bom_id) REFERENCES parts_bom(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_assigned_to_fkey" FOREIGN KEY (assigned_to) REFERENCES auth.users(id);

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_completed_by_fkey" FOREIGN KEY (completed_by) REFERENCES auth.users(id);

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_job_part_id_fkey" FOREIGN KEY (job_part_id) REFERENCES job_parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_routing_operation_id_fkey" FOREIGN KEY (routing_operation_id) REFERENCES routing_operations(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_work_center_id_fkey" FOREIGN KEY (work_center_id) REFERENCES work_centers(id) ON DELETE SET NULL;

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

ALTER TABLE "public"."operator_sessions"
    ADD CONSTRAINT "operator_sessions_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."operator_sessions"
    ADD CONSTRAINT "operator_sessions_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."operator_sessions"
    ADD CONSTRAINT "operator_sessions_job_operation_id_fkey" FOREIGN KEY (job_operation_id) REFERENCES job_operations(id) ON DELETE SET NULL;

ALTER TABLE "public"."operator_sessions"
    ADD CONSTRAINT "operator_sessions_work_center_id_fkey" FOREIGN KEY (work_center_id) REFERENCES work_centers(id) ON DELETE RESTRICT;

ALTER TABLE "public"."part_pricing_tiers"
    ADD CONSTRAINT "part_pricing_tiers_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_pricing_tiers"
    ADD CONSTRAINT "part_pricing_tiers_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_procurement_tiers"
    ADD CONSTRAINT "part_procurement_tiers_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_procurement_tiers"
    ADD CONSTRAINT "part_procurement_tiers_vendor_id_fkey" FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT;

ALTER TABLE "public"."parts"
    ADD CONSTRAINT "parts_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."parts"
    ADD CONSTRAINT "parts_markup_rate_id_fkey" FOREIGN KEY (markup_rate_id) REFERENCES markup_rates(id) ON DELETE SET NULL;

ALTER TABLE "public"."parts"
    ADD CONSTRAINT "parts_preferred_vendor_id_fkey" FOREIGN KEY (preferred_vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;

ALTER TABLE "public"."parts_bom"
    ADD CONSTRAINT "parts_bom_child_part_id_fkey" FOREIGN KEY (child_part_id) REFERENCES parts(id) ON DELETE RESTRICT;

ALTER TABLE "public"."parts_bom"
    ADD CONSTRAINT "parts_bom_parent_part_id_fkey" FOREIGN KEY (parent_part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."parts_unit_conversions"
    ADD CONSTRAINT "parts_unit_conversions_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

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
    ADD CONSTRAINT "quote_materials_material_part_id_fkey" FOREIGN KEY (material_part_id) REFERENCES parts(id) ON DELETE SET NULL;

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

ALTER TABLE "public"."routing_operations"
    ADD CONSTRAINT "routing_operations_routing_id_fkey" FOREIGN KEY (routing_id) REFERENCES routings(id) ON DELETE CASCADE;

ALTER TABLE "public"."routing_operations"
    ADD CONSTRAINT "routing_operations_work_center_id_fkey" FOREIGN KEY (work_center_id) REFERENCES work_centers(id) ON DELETE RESTRICT;

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

ALTER TABLE "public"."vendor_contacts"
    ADD CONSTRAINT "vendor_contacts_vendor_id_fkey" FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE;

ALTER TABLE "public"."vendors"
    ADD CONSTRAINT "vendors_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."work_centers"
    ADD CONSTRAINT "work_centers_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."work_centers"
    ADD CONSTRAINT "work_centers_vendor_id_fkey" FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE RESTRICT;

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
CREATE INDEX IF NOT EXISTS inventory_transactions_company_id_created_at_idx ON public.inventory_transactions USING btree (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_transactions_discrepancy_idx ON public.inventory_transactions USING btree (company_id, created_at DESC) WHERE (has_discrepancy = true);
CREATE INDEX IF NOT EXISTS inventory_transactions_job_id_idx ON public.inventory_transactions USING btree (job_id) WHERE (job_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS inventory_transactions_job_operation_id_idx ON public.inventory_transactions USING btree (job_operation_id) WHERE (job_operation_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS inventory_transactions_part_id_created_at_idx ON public.inventory_transactions USING btree (part_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invitations_company_id ON public.invitations USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON public.invitations USING btree (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_email_company ON public.invitations USING btree (email, company_id) WHERE ((status)::text = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_job_materials_job ON public.job_materials USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_job_part_id ON public.job_materials USING btree (job_part_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_material_part ON public.job_materials USING btree (material_part_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_parts_bom ON public.job_materials USING btree (parts_bom_id);
CREATE INDEX IF NOT EXISTS idx_job_operations_job_part_id ON public.job_operations USING btree (job_part_id);
CREATE INDEX IF NOT EXISTS idx_job_ops_assigned ON public.job_operations USING btree (assigned_to) WHERE (assigned_to IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_job_ops_job ON public.job_operations USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_job_ops_routing_operation ON public.job_operations USING btree (routing_operation_id) WHERE (routing_operation_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_job_ops_status ON public.job_operations USING btree (status);
CREATE INDEX IF NOT EXISTS idx_job_ops_work_center ON public.job_operations USING btree (work_center_id);
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
CREATE INDEX IF NOT EXISTS idx_operator_sessions_active ON public.operator_sessions USING btree (operator_id) WHERE (ended_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_company ON public.operator_sessions USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_job ON public.operator_sessions USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_job_op ON public.operator_sessions USING btree (job_operation_id);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_operator ON public.operator_sessions USING btree (operator_id);
CREATE INDEX IF NOT EXISTS idx_part_pricing_tiers_company ON public.part_pricing_tiers USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_part_pricing_tiers_part ON public.part_pricing_tiers USING btree (part_id, sequence);
CREATE INDEX IF NOT EXISTS idx_procurement_tiers_expiring ON public.part_procurement_tiers USING btree (part_id, expires_at) WHERE (expires_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_procurement_tiers_part ON public.part_procurement_tiers USING btree (part_id);
CREATE INDEX IF NOT EXISTS idx_procurement_tiers_vendor ON public.part_procurement_tiers USING btree (vendor_id) WHERE (vendor_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_parts_company_id ON public.parts USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_parts_company_made ON public.parts USING btree (company_id) WHERE (source = 'made'::text);
CREATE INDEX IF NOT EXISTS idx_parts_company_stocked ON public.parts USING btree (company_id) WHERE is_stocked;
CREATE INDEX IF NOT EXISTS idx_parts_markup_rate_id ON public.parts USING btree (markup_rate_id);
CREATE INDEX IF NOT EXISTS idx_parts_part_name ON public.parts USING btree (company_id, part_name);
CREATE INDEX IF NOT EXISTS idx_parts_preferred_vendor ON public.parts USING btree (preferred_vendor_id) WHERE (preferred_vendor_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_parts_bom_child ON public.parts_bom USING btree (child_part_id);
CREATE INDEX IF NOT EXISTS idx_parts_bom_parent ON public.parts_bom USING btree (parent_part_id);
CREATE INDEX IF NOT EXISTS idx_parts_unit_conversions_part ON public.parts_unit_conversions USING btree (part_id);
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
CREATE INDEX IF NOT EXISTS idx_routing_operations_routing ON public.routing_operations USING btree (routing_id, sequence);
CREATE INDEX IF NOT EXISTS idx_routing_operations_work_center ON public.routing_operations USING btree (work_center_id);
CREATE INDEX IF NOT EXISTS idx_routings_company ON public.routings USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_routings_part ON public.routings USING btree (part_id);
CREATE INDEX IF NOT EXISTS idx_saved_insights_user_company ON public.saved_insights USING btree (user_id, company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_company_access_company_id ON public.user_company_access USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_user_company_access_name ON public.user_company_access USING btree (name);
CREATE INDEX IF NOT EXISTS idx_user_company_access_user_id ON public.user_company_access USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON public.user_preferences USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_vendor_contacts_vendor ON public.vendor_contacts USING btree (vendor_id);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_contacts_one_primary ON public.vendor_contacts USING btree (vendor_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_vendors_company ON public.vendors USING btree (company_id);
CREATE INDEX IF NOT EXISTS waitlist_created_at_idx ON public.waitlist USING btree (created_at);
CREATE INDEX IF NOT EXISTS waitlist_email_idx ON public.waitlist USING btree (email);
CREATE INDEX IF NOT EXISTS idx_work_centers_company ON public.work_centers USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_work_centers_company_kind ON public.work_centers USING btree (company_id, kind);
CREATE INDEX IF NOT EXISTS idx_work_centers_vendor ON public.work_centers USING btree (vendor_id) WHERE (vendor_id IS NOT NULL);

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

CREATE OR REPLACE FUNCTION public.bulk_apply_markup_rate(p_company_id uuid, p_part_ids uuid[], p_rate_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_rate_breakpoints jsonb;
    v_part_id          uuid;
    v_qty              integer;
    v_markup           numeric;
    v_sequence         integer;
    v_base_cost        numeric;
    v_unit_price       numeric;
    v_has_null_price   boolean;
    v_updated          integer := 0;
    v_price_uncomputed integer := 0;
    v_failed           jsonb := '[]'::jsonb;
BEGIN
    -- Lookup rate. RLS on markup_rates restricts to the caller's companies, so
    -- a mismatched p_company_id will simply not find the row.
    SELECT breakpoints INTO v_rate_breakpoints
    FROM public.markup_rates
    WHERE id = p_rate_id AND company_id = p_company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Markup rate % not found in company %', p_rate_id, p_company_id;
    END IF;

    FOREACH v_part_id IN ARRAY p_part_ids LOOP
        BEGIN
            v_has_null_price := false;
            v_sequence := 0;

            DELETE FROM public.part_pricing_tiers WHERE part_id = v_part_id;

            FOR v_qty, v_markup IN
                SELECT FLOOR((bp->>'qty')::numeric)::integer,
                       (bp->>'markup_percent')::numeric
                FROM jsonb_array_elements(v_rate_breakpoints) bp
                WHERE (bp->>'qty')::numeric > 0
                ORDER BY (bp->>'qty')::numeric ASC
            LOOP
                v_sequence := v_sequence + 10;

                -- Cost compute can RAISE (missing rate / external pricing /
                -- unit conversion) or return NULL (bought leaf with no
                -- procurement tier). Either way: store NULL unit_price, flag
                -- the part, keep going. The outer SQL block's commit is what
                -- locks tier rows in, so a nested EXCEPTION here doesn't lose
                -- the DELETE we already issued.
                BEGIN
                    v_base_cost := public.compute_part_cost_at_qty(v_part_id, v_qty);
                    IF v_base_cost IS NULL THEN
                        v_unit_price := NULL;
                        v_has_null_price := true;
                    ELSE
                        v_unit_price := v_base_cost * (1 + v_markup / 100);
                    END IF;
                EXCEPTION WHEN OTHERS THEN
                    v_unit_price := NULL;
                    v_has_null_price := true;
                END;

                INSERT INTO public.part_pricing_tiers
                    (part_id, company_id, sequence, quantity, markup_percent, unit_price)
                VALUES
                    (v_part_id, p_company_id, v_sequence, v_qty, v_markup, v_unit_price);
            END LOOP;

            UPDATE public.parts
                SET markup_rate_id = p_rate_id
              WHERE id = v_part_id;

            v_updated := v_updated + 1;
            IF v_has_null_price THEN
                v_price_uncomputed := v_price_uncomputed + 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_failed := v_failed || jsonb_build_object(
                'part_id', v_part_id,
                'error',   SQLERRM
            );
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'updated',          v_updated,
        'price_uncomputed', v_price_uncomputed,
        'failed',           v_failed
    );
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

CREATE OR REPLACE FUNCTION public.compute_part_cost_at_qty(p_part_id uuid, p_qty numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_source text;
    v_routing_id uuid;
    v_total numeric := 0;
    v_op RECORD;
    v_op_cost numeric;
    v_bom RECORD;
    v_to_primary_factor numeric;
    v_qty_in_primary_unit numeric;
    v_child_cost numeric;
    v_tier_cost numeric;
BEGIN
    IF p_qty IS NULL OR p_qty <= 0 THEN
        RAISE EXCEPTION 'compute_part_cost_at_qty: p_qty must be > 0 (got %)', p_qty
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT source INTO v_source FROM public.parts WHERE id = p_part_id;
    IF v_source IS NULL THEN
        RAISE EXCEPTION 'compute_part_cost_at_qty: part % not found', p_part_id;
    END IF;

    -- ---------- Bought parts: resolve to a procurement tier ----------
    IF v_source = 'bought' THEN
        SELECT t.cost_per_unit
          INTO v_tier_cost
          FROM public.part_procurement_tiers t
         WHERE t.part_id = p_part_id
           AND t.min_quantity <= p_qty
           AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
         ORDER BY (t.vendor_id IS NULL) ASC,
                  t.cost_per_unit ASC,
                  t.min_quantity DESC
         LIMIT 1;
        RETURN v_tier_cost;  -- NULL propagates if no tier matches
    END IF;

    -- ---------- Made parts: own routing + BOM rollup ----------
    SELECT id INTO v_routing_id FROM public.routings WHERE part_id = p_part_id;

    IF v_routing_id IS NOT NULL THEN
        FOR v_op IN
            SELECT ro.setup_minutes,
                   ro.cycle_minutes_per_unit,
                   ro.labor_rate_override,
                   ro.external_unit_price,
                   ro.external_setup_cost,
                   wc.kind          AS wc_kind,
                   wc.labor_rate    AS wc_labor_rate
              FROM public.routing_operations ro
              JOIN public.work_centers wc ON wc.id = ro.work_center_id
             WHERE ro.routing_id = v_routing_id
        LOOP
            IF v_op.wc_kind = 'internal' THEN
                IF v_op.labor_rate_override IS NULL AND v_op.wc_labor_rate IS NULL THEN
                    RAISE EXCEPTION
                        'Cannot compute cost for part %: internal routing op has no labor rate (neither override nor work_center default)',
                        p_part_id
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := (COALESCE(v_op.setup_minutes, 0) / p_qty
                              + COALESCE(v_op.cycle_minutes_per_unit, 0))
                             * COALESCE(v_op.labor_rate_override, v_op.wc_labor_rate)
                             / 60.0;
            ELSE
                IF v_op.external_unit_price IS NULL AND v_op.external_setup_cost IS NULL THEN
                    RAISE EXCEPTION
                        'Cannot compute cost for part %: external routing op has no pricing (neither external_unit_price nor external_setup_cost)',
                        p_part_id
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := COALESCE(v_op.external_unit_price, 0)
                             + COALESCE(v_op.external_setup_cost, 0) / p_qty;
            END IF;
            v_total := v_total + v_op_cost;
        END LOOP;
    END IF;

    FOR v_bom IN
        SELECT b.quantity,
               b.unit,
               b.child_part_id,
               c.primary_unit AS child_primary_unit
          FROM public.parts_bom b
          JOIN public.parts c ON c.id = b.child_part_id
         WHERE b.parent_part_id = p_part_id
    LOOP
        IF v_bom.unit IS DISTINCT FROM v_bom.child_primary_unit THEN
            SELECT to_primary_factor INTO v_to_primary_factor
              FROM public.parts_unit_conversions
             WHERE part_id = v_bom.child_part_id
               AND from_unit = v_bom.unit;
            IF v_to_primary_factor IS NULL THEN
                RAISE EXCEPTION
                    'No unit conversion from % to % for part %',
                    v_bom.unit, v_bom.child_primary_unit, v_bom.child_part_id
                    USING ERRCODE = 'check_violation';
            END IF;
            v_qty_in_primary_unit := v_bom.quantity * v_to_primary_factor;
        ELSE
            v_qty_in_primary_unit := v_bom.quantity;
        END IF;

        v_child_cost := public.compute_part_cost_at_qty(
            v_bom.child_part_id,
            p_qty * v_qty_in_primary_unit
        );

        IF v_child_cost IS NULL THEN
            RETURN NULL;
        END IF;

        v_total := v_total + v_qty_in_primary_unit * v_child_cost;
    END LOOP;

    RETURN v_total;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.compute_part_cost_explain(p_part_id uuid, p_qty numeric)
 RETURNS TABLE(unit_cost numeric, missing_leaves jsonb)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_missing jsonb;
BEGIN
    WITH RECURSIVE tree(part_id, part_name, source, cumulative_qty, depth) AS (
        SELECT p.id, p.part_name, p.source, p_qty, 0
          FROM public.parts p
         WHERE p.id = p_part_id

        UNION ALL

        SELECT c.id,
               c.part_name,
               c.source,
               t.cumulative_qty *
                   CASE
                       WHEN b.unit IS DISTINCT FROM c.primary_unit THEN
                           b.quantity * COALESCE(
                               (SELECT uc.to_primary_factor
                                  FROM public.parts_unit_conversions uc
                                 WHERE uc.part_id = c.id
                                   AND uc.from_unit = b.unit),
                               1
                           )
                       ELSE b.quantity
                   END,
               t.depth + 1
          FROM tree t
          JOIN public.parts_bom b ON b.parent_part_id = t.part_id
          JOIN public.parts c     ON c.id = b.child_part_id
         WHERE t.source = 'made'
           AND t.depth < 50
    ),
    missing AS (
        SELECT tr.part_id, tr.part_name, tr.depth, tr.cumulative_qty AS qty_required
          FROM tree tr
         WHERE tr.source = 'bought'
           AND NOT EXISTS (
               SELECT 1
                 FROM public.part_procurement_tiers t
                WHERE t.part_id = tr.part_id
                  AND t.min_quantity <= tr.cumulative_qty
                  AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
           )
    )
    SELECT COALESCE(
              jsonb_agg(
                  jsonb_build_object(
                      'part_id', m.part_id,
                      'part_name', m.part_name,
                      'depth', m.depth,
                      'qty_required', m.qty_required
                  )
                  ORDER BY m.depth DESC, m.part_name ASC
              ),
              '[]'::jsonb
           )
      INTO v_missing
      FROM missing m;

    unit_cost := public.compute_part_cost_at_qty(p_part_id, p_qty);
    missing_leaves := v_missing;
    RETURN NEXT;
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
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied: cannot create demo company for another user';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = p_user_id
          AND company_id = p_source_company_id
          AND role = 'admin'
    ) THEN
        RAISE EXCEPTION 'Access denied: must be admin of source company';
    END IF;

    -- Idempotency: return existing demo if linked
    SELECT demo_company_id INTO v_existing_demo_id
    FROM companies
    WHERE id = p_source_company_id;

    IF v_existing_demo_id IS NOT NULL THEN
        RETURN v_existing_demo_id;
    END IF;

    SELECT name INTO v_source_name FROM companies WHERE id = p_source_company_id;
    IF v_source_name IS NULL THEN
        RAISE EXCEPTION 'Source company not found: %', p_source_company_id;
    END IF;

    INSERT INTO companies (name, is_demo)
    VALUES (v_source_name || ' - Demo', TRUE)
    RETURNING id INTO v_demo_company_id;

    UPDATE companies SET demo_company_id = v_demo_company_id
    WHERE id = p_source_company_id;

    -- Mirror access (operator/user/admin all preserved)
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT uca.user_id, v_demo_company_id, uca.role, uca.name
    FROM user_company_access uca
    WHERE uca.company_id = p_source_company_id;

    PERFORM seed_demo_data(v_demo_company_id, p_user_id, p_template_name::text);

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
    v_op record;
    v_seq integer := 10;
    v_job_id uuid;
    v_part_id uuid;
    v_min_seq integer;
BEGIN
    SELECT job_id INTO v_job_id FROM job_parts WHERE id = p_job_part_id;
    IF v_job_id IS NULL THEN
        RAISE EXCEPTION 'job_part % not found', p_job_part_id;
    END IF;

    -- The routing's part_id is the parent for any BOM snapshot below.
    SELECT part_id INTO v_part_id FROM routings WHERE id = p_routing_id;
    IF v_part_id IS NULL THEN
        RAISE EXCEPTION 'routing % not found', p_routing_id;
    END IF;

    -- Snapshot routing_operations → job_operations.
    FOR v_op IN
        SELECT ro.*, wc.name AS operation_name
        FROM routing_operations ro
        JOIN work_centers wc ON ro.work_center_id = wc.id
        WHERE ro.routing_id = p_routing_id
          AND NOT EXISTS (
              SELECT 1 FROM job_operations jo
              WHERE jo.job_part_id = p_job_part_id
                AND jo.routing_operation_id = ro.id
          )
        ORDER BY ro.sequence, ro.created_at
    LOOP
        INSERT INTO job_operations (
            job_id, job_part_id, sequence, operation_name, work_center_id,
            instructions, estimated_setup_minutes, estimated_run_minutes_per_unit,
            status, routing_operation_id
        ) VALUES (
            v_job_id, p_job_part_id, v_seq, v_op.operation_name, v_op.work_center_id,
            v_op.instructions, COALESCE(v_op.setup_minutes, 0), v_op.cycle_minutes_per_unit,
            'pending', v_op.id
        );
        v_seq := v_seq + 10;
        v_count := v_count + 1;
    END LOOP;

    -- Snapshot parts_bom (the part's BOM) → job_materials. Idempotent on
    -- parts_bom_id. The BOM is now part-attached, not routing-attached, so
    -- we read parts_bom WHERE parent_part_id = the routing's part.
    INSERT INTO job_materials (job_id, job_part_id, parts_bom_id, material_part_id, expected_quantity, unit)
    SELECT v_job_id, p_job_part_id, b.id, b.child_part_id, b.quantity, b.unit
    FROM parts_bom b
    WHERE b.parent_part_id = v_part_id
      AND NOT EXISTS (
          SELECT 1 FROM job_materials jm
          WHERE jm.job_part_id = p_job_part_id
            AND jm.parts_bom_id = b.id
      );

    -- Set the job_part's current operation cursor to the lowest sequence we wrote.
    SELECT MIN(sequence) INTO v_min_seq FROM job_operations WHERE job_part_id = p_job_part_id;
    IF v_min_seq IS NOT NULL THEN
        UPDATE job_parts SET current_operation_sequence = v_min_seq WHERE id = p_job_part_id;
    END IF;

    RETURN v_count;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.enforce_no_bom_cycles()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_cycle_found boolean;
BEGIN
    WITH RECURSIVE descendants(part_id, depth) AS (
        SELECT NEW.child_part_id, 1
        UNION ALL
        SELECT b.child_part_id, d.depth + 1
        FROM parts_bom b
        JOIN descendants d ON b.parent_part_id = d.part_id
        WHERE d.depth < 50
    )
    SELECT EXISTS (SELECT 1 FROM descendants WHERE part_id = NEW.parent_part_id)
    INTO v_cycle_found;

    IF v_cycle_found THEN
        RAISE EXCEPTION 'Adding BOM edge %→% would create a cycle',
            NEW.parent_part_id, NEW.child_part_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
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

CREATE OR REPLACE FUNCTION public.get_procurement_cost(p_part_id uuid, p_qty numeric)
 RETURNS TABLE(unit_cost numeric, vendor_id uuid, tier_id uuid, source text)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_tier RECORD;
BEGIN
    -- Pick the cheapest non-expired tier where min_quantity ≤ p_qty, with
    -- vendor-specific tiers (vendor_id IS NOT NULL) preferred over NULL-vendor
    -- tiers (import / internal-estimate rows). NULL-vendor wins only when no
    -- vendor-specific tier matches the qty.
    SELECT t.id, t.cost_per_unit, t.vendor_id
      INTO v_tier
      FROM public.part_procurement_tiers t
     WHERE t.part_id = p_part_id
       AND t.min_quantity <= p_qty
       AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
     ORDER BY (t.vendor_id IS NULL) ASC,
              t.cost_per_unit ASC,
              t.min_quantity DESC
     LIMIT 1;

    IF FOUND THEN
        unit_cost := v_tier.cost_per_unit;
        vendor_id := v_tier.vendor_id;
        tier_id := v_tier.id;
        source := 'tier';
        RETURN NEXT;
    END IF;
    -- No row returned when no tier matches. Callers must treat empty as NULL.
END;
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

CREATE OR REPLACE FUNCTION public.get_ready_operations_for_station(p_company_id uuid, p_work_center_id uuid)
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
        WHERE jo.work_center_id = p_work_center_id
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

    -- Delete in FK-respecting order. job_materials/job_operations live under
    -- jobs (not company-scoped directly), so we pivot through jobs first.
    DELETE FROM operator_sessions WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM job_materials WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_parts WHERE company_id = v_demo_company_id;
    DELETE FROM jobs WHERE company_id = v_demo_company_id;
    DELETE FROM quote_line_items WHERE company_id = v_demo_company_id;
    DELETE FROM quote_materials WHERE company_id = v_demo_company_id;
    DELETE FROM quote_operations WHERE company_id = v_demo_company_id;
    DELETE FROM quotes WHERE company_id = v_demo_company_id;
    -- routing_operations cascades from routings (FK ON DELETE CASCADE), but
    -- being explicit makes the order obvious.
    DELETE FROM routing_operations
        WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    -- parts_bom rows have no company_id; pivot through the parent part.
    DELETE FROM parts_bom
        WHERE parent_part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM part_pricing_tiers WHERE company_id = v_demo_company_id;
    -- parts_unit_conversions also has no company_id; pivot through part.
    DELETE FROM parts_unit_conversions
        WHERE part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM parts WHERE company_id = v_demo_company_id;
    DELETE FROM work_centers WHERE company_id = v_demo_company_id;
    DELETE FROM vendors WHERE company_id = v_demo_company_id;
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
    IF OLD.company_id          IS DISTINCT FROM NEW.company_id
       OR OLD.part_id          IS DISTINCT FROM NEW.part_id
       OR OLD.item_name        IS DISTINCT FROM NEW.item_name
       OR OLD.type             IS DISTINCT FROM NEW.type
       OR OLD.quantity         IS DISTINCT FROM NEW.quantity
       OR OLD.unit             IS DISTINCT FROM NEW.unit
       OR OLD.converted_quantity IS DISTINCT FROM NEW.converted_quantity
       OR OLD.job_id           IS DISTINCT FROM NEW.job_id
       OR OLD.job_operation_id IS DISTINCT FROM NEW.job_operation_id
       OR OLD.operator_id      IS DISTINCT FROM NEW.operator_id
       OR OLD.created_at       IS DISTINCT FROM NEW.created_at
       OR OLD.created_by       IS DISTINCT FROM NEW.created_by
       OR OLD.has_discrepancy  IS DISTINCT FROM NEW.has_discrepancy
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

CREATE OR REPLACE FUNCTION public.seed_demo_data(p_company_id uuid, p_user_id uuid, p_template_name text DEFAULT 'default'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_template jsonb;
    v_ref_map jsonb := '{}'::jsonb;
    v_item jsonb;
    v_inner jsonb;
    v_contact jsonb;
    v_new_id uuid;
    v_routing_id uuid;
    v_quote_id uuid;
    v_job_id uuid;
    v_job_part_id uuid;
    v_part_id uuid;
    v_part_source text;
    v_part_cost numeric;
BEGIN
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    IF v_template->'vendors' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'vendors') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO vendors (id, company_id, name,
                                 address_line1, address_line2, city, state, postal_code, country,
                                 legacy_id)
            VALUES (v_new_id, p_company_id, v_item->>'name',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'),
                    v_item->>'legacy_id');

            IF v_item->'contacts' IS NOT NULL THEN
                FOR v_contact IN SELECT * FROM jsonb_array_elements(v_item->'contacts') LOOP
                    INSERT INTO vendor_contacts (vendor_id, name, role, role_label,
                                                 email, phone, is_primary)
                    VALUES (v_new_id,
                            v_contact->>'name',
                            COALESCE(v_contact->>'role', 'sales'),
                            v_contact->>'role_label',
                            v_contact->>'email',
                            v_contact->>'phone',
                            COALESCE((v_contact->>'is_primary')::boolean, false));
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'work_centers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'work_centers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO work_centers (id, company_id, name, kind, vendor_id,
                                      labor_rate, description)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    COALESCE(v_item->>'kind', 'internal'),
                    CASE WHEN v_item->>'vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'vendor_ref'))::uuid
                         ELSE NULL END,
                    NULLIF(v_item->>'labor_rate', '')::numeric,
                    v_item->>'description');
        END LOOP;
    END IF;

    -- Parts: cost_per_unit dropped from parts. For bought parts with a
    -- template-supplied cost, emit a NULL-vendor procurement tier.
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            v_part_source := COALESCE(v_item->>'source', 'made');
            v_part_cost := NULLIF(v_item->>'cost_per_unit', '')::numeric;

            INSERT INTO parts (id, company_id, part_name, description,
                               source, is_stocked,
                               primary_unit, quantity,
                               reorder_point, preferred_vendor_id, legacy_id)
            VALUES (v_new_id, p_company_id,
                    v_item->>'part_name', v_item->>'description',
                    v_part_source,
                    COALESCE((v_item->>'is_stocked')::boolean, false),
                    v_item->>'primary_unit',
                    COALESCE((v_item->>'quantity')::numeric, 0),
                    NULLIF(v_item->>'reorder_point', '')::numeric,
                    CASE WHEN v_item->>'preferred_vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'preferred_vendor_ref'))::uuid
                         ELSE NULL END,
                    v_item->>'legacy_id');

            IF v_part_source = 'bought' AND v_part_cost IS NOT NULL AND v_part_cost > 0 THEN
                INSERT INTO part_procurement_tiers
                    (part_id, vendor_id, min_quantity, cost_per_unit)
                VALUES (v_new_id, NULL, 1, v_part_cost);
            END IF;
        END LOOP;
    END IF;

    IF v_template->'parts_bom' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts_bom') LOOP
            INSERT INTO parts_bom (parent_part_id, child_part_id, quantity, unit, sequence, notes)
            VALUES ((v_ref_map->>(v_item->>'parent_ref'))::uuid,
                    (v_ref_map->>(v_item->>'child_ref'))::uuid,
                    (v_item->>'quantity')::numeric,
                    v_item->>'unit',
                    COALESCE((v_item->>'sequence')::integer, 0),
                    v_item->>'notes');
        END LOOP;
    END IF;

    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_routing_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_routing_id::text));
            INSERT INTO routings (id, company_id, part_id, name, description, created_by)
            VALUES (v_routing_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::uuid,
                    v_item->>'name', v_item->>'description', p_user_id);

            IF v_item->'operations' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'operations') LOOP
                    INSERT INTO routing_operations (
                        routing_id, work_center_id, sequence,
                        setup_minutes, cycle_minutes_per_unit,
                        labor_rate_override,
                        external_unit_price, external_setup_cost,
                        instructions
                    ) VALUES (
                        v_routing_id,
                        (v_ref_map->>(v_inner->>'work_center_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        NULLIF(v_inner->>'setup_minutes', '')::numeric,
                        NULLIF(v_inner->>'cycle_minutes_per_unit', '')::numeric,
                        NULLIF(v_inner->>'labor_rate_override', '')::numeric,
                        NULLIF(v_inner->>'external_unit_price', '')::numeric,
                        NULLIF(v_inner->>'external_setup_cost', '')::numeric,
                        v_inner->>'instructions'
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO customers (id, company_id, name,
                                   contact_name, contact_email, contact_phone,
                                   address_line1, address_line2, city, state, postal_code, country,
                                   website)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    v_item->>'contact_name', v_item->>'contact_email', v_item->>'contact_phone',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'),
                    v_item->>'website');
        END LOOP;
    END IF;

    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_quote_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_quote_id::text));
            INSERT INTO quotes (id, company_id, customer_id, status,
                                lead_time_days, expiration_date, created_by)
            VALUES (v_quote_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid
                         ELSE NULL END,
                    COALESCE(v_item->>'status', 'active'),
                    NULLIF(v_item->>'lead_time_days', '')::integer,
                    NULLIF(v_item->>'expiration_date', '')::date,
                    p_user_id);

            IF v_item->'line_items' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'line_items') LOOP
                    INSERT INTO quote_line_items (
                        quote_id, company_id, part_id,
                        sequence, quantity, unit_price, total_price
                    ) VALUES (
                        v_quote_id, p_company_id,
                        (v_ref_map->>(v_inner->>'part_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        (v_inner->>'quantity')::integer,
                        (v_inner->>'unit_price')::numeric,
                        NULLIF(v_inner->>'total_price', '')::numeric
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_job_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_job_id::text));

            INSERT INTO jobs (id, company_id, customer_id, quote_id,
                              job_number, status, created_by)
            VALUES (v_job_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid
                         ELSE NULL END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::uuid
                         ELSE NULL END,
                    COALESCE(v_item->>'job_number',
                             'J-DEMO-' || substr(v_job_id::text, 1, 8)),
                    COALESCE(v_item->>'status', 'not_started'),
                    p_user_id);

            IF v_item->'parts' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'parts') LOOP
                    v_part_id := (v_ref_map->>(v_inner->>'part_ref'))::uuid;
                    v_job_part_id := gen_random_uuid();

                    INSERT INTO job_parts (id, job_id, company_id, part_id,
                                           sequence, quantity, status)
                    VALUES (v_job_part_id, v_job_id, p_company_id, v_part_id,
                            COALESCE((v_inner->>'sequence')::integer, 10),
                            COALESCE((v_inner->>'quantity')::integer, 1),
                            COALESCE(v_inner->>'status', 'not_started'));

                    IF v_inner->>'routing_ref' IS NOT NULL THEN
                        PERFORM create_job_part_operations_from_routing(
                            v_job_part_id,
                            (v_ref_map->>(v_inner->>'routing_ref'))::uuid
                        );
                    END IF;
                END LOOP;
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

DROP TRIGGER IF EXISTS "enforce_transaction_notes_only_update" ON "public"."inventory_transactions";
CREATE TRIGGER enforce_transaction_notes_only_update BEFORE UPDATE ON public.inventory_transactions FOR EACH ROW EXECUTE FUNCTION restrict_transaction_update_to_notes();

DROP TRIGGER IF EXISTS "job_materials_updated_at" ON "public"."job_materials";
CREATE TRIGGER job_materials_updated_at BEFORE UPDATE ON public.job_materials FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "job_operations_updated_at" ON "public"."job_operations";
CREATE TRIGGER job_operations_updated_at BEFORE UPDATE ON public.job_operations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "job_parts_updated_at" ON "public"."job_parts";
CREATE TRIGGER job_parts_updated_at BEFORE UPDATE ON public.job_parts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

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

DROP TRIGGER IF EXISTS "operator_sessions_updated_at" ON "public"."operator_sessions";
CREATE TRIGGER operator_sessions_updated_at BEFORE UPDATE ON public.operator_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "part_pricing_tiers_updated_at" ON "public"."part_pricing_tiers";
CREATE TRIGGER part_pricing_tiers_updated_at BEFORE UPDATE ON public.part_pricing_tiers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "part_procurement_tiers_updated_at" ON "public"."part_procurement_tiers";
CREATE TRIGGER part_procurement_tiers_updated_at BEFORE UPDATE ON public.part_procurement_tiers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "parts_updated_at" ON "public"."parts";
CREATE TRIGGER parts_updated_at BEFORE UPDATE ON public.parts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "parts_bom_no_cycles" ON "public"."parts_bom";
CREATE TRIGGER parts_bom_no_cycles BEFORE INSERT OR UPDATE OF parent_part_id, child_part_id ON public.parts_bom FOR EACH ROW EXECUTE FUNCTION enforce_no_bom_cycles();

DROP TRIGGER IF EXISTS "parts_bom_updated_at" ON "public"."parts_bom";
CREATE TRIGGER parts_bom_updated_at BEFORE UPDATE ON public.parts_bom FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "quotes_updated_at" ON "public"."quotes";
CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "trigger_quote_status_change" ON "public"."quotes";
CREATE TRIGGER trigger_quote_status_change BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION track_quote_status_change();

DROP TRIGGER IF EXISTS "trigger_set_quote_number" ON "public"."quotes";
CREATE TRIGGER trigger_set_quote_number BEFORE INSERT ON public.quotes FOR EACH ROW EXECUTE FUNCTION set_quote_number();

DROP TRIGGER IF EXISTS "routing_operations_updated_at" ON "public"."routing_operations";
CREATE TRIGGER routing_operations_updated_at BEFORE UPDATE ON public.routing_operations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "routings_updated_at" ON "public"."routings";
CREATE TRIGGER routings_updated_at BEFORE UPDATE ON public.routings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "user_company_access_fill_email_trg" ON "public"."user_company_access";
CREATE TRIGGER user_company_access_fill_email_trg BEFORE INSERT ON public.user_company_access FOR EACH ROW EXECUTE FUNCTION user_company_access_fill_email();

DROP TRIGGER IF EXISTS "user_preferences_updated_at" ON "public"."user_preferences";
CREATE TRIGGER user_preferences_updated_at BEFORE UPDATE ON public.user_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "vendor_contacts_updated_at" ON "public"."vendor_contacts";
CREATE TRIGGER vendor_contacts_updated_at BEFORE UPDATE ON public.vendor_contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "vendors_updated_at" ON "public"."vendors";
CREATE TRIGGER vendors_updated_at BEFORE UPDATE ON public.vendors FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "waitlist" ON "public"."waitlist";
CREATE TRIGGER waitlist AFTER INSERT ON public.waitlist FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://mayuquvexmqjvwkfasxg.supabase.co/functions/v1/notify-waitlist', 'POST', '{"Content-type":"application/json","Authorization":"Bearer [REDACTED]"}', '{}', '5000');

DROP TRIGGER IF EXISTS "work_centers_updated_at" ON "public"."work_centers";
CREATE TRIGGER work_centers_updated_at BEFORE UPDATE ON public.work_centers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


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

COMMENT ON TABLE "public"."feedback"
    IS 'In-app user feedback submissions';

COMMENT ON TABLE "public"."inventory_transactions"
    IS 'Append-only ledger of inventory changes (addition / depletion / adjustment). Notes are the only mutable column post-insert (enforced by trigger).';

COMMENT ON TABLE "public"."markup_rates"
    IS 'Named, reusable markup matrices (qty × markup%) per company. Applied to parts via snapshot — copies breakpoints into part_pricing_tiers, no link.';

COMMENT ON TABLE "public"."operator_sessions"
    IS 'Work sessions tracking when operators are working on jobs. Used for time tracking and job progress.';

COMMENT ON TABLE "public"."part_procurement_tiers"
    IS 'Vendor-keyed tiered pricing for bought parts. Each row is one (vendor, min_quantity, cost_per_unit) point on a vendor''s tier sheet. vendor_id may be NULL for "internal estimate" rows. Ordering of tiers within a vendor sheet is derived from min_quantity ASC — no separate sequence column. Resolved at read time via get_procurement_cost(part_id, qty), which picks the cheapest non-expired tier where min_quantity <= qty across all vendors.';

COMMENT ON TABLE "public"."parts"
    IS 'Unified item master. Replaces the prior two-table split between manufacturable parts and stockable inventory_items.';

COMMENT ON TABLE "public"."parts_bom"
    IS 'BOM edges. Replaces routing_materials — BOM is now part-attached (one BOM per manufactured part), not routing-attached.';

COMMENT ON TABLE "public"."parts_unit_conversions"
    IS 'Per-part conversion factors from alternate units to the part primary_unit. Replaces inventory_unit_conversions.';

COMMENT ON TABLE "public"."routing_operations"
    IS 'Linear list of operations within a routing. Renamed from routing_nodes. Each row points at a work_center; cost field set varies by work_center.kind (internal vs external).';

COMMENT ON TABLE "public"."saved_insights"
    IS 'User-saved AI chat Q&A pairs. When a user finds an AI-generated insight valuable, they can save it for future reference. Includes the original question, answer text, and any chart configuration.';

COMMENT ON TABLE "public"."system_admins"
    IS 'Platform-level administrator access. Users in this table have system-wide admin privileges that span across all companies. Separate from company-level roles in user_company_access.';

COMMENT ON TABLE "public"."user_company_access"
    IS 'Junction table linking Supabase auth users to companies with role-based access. Enables multi-tenant access control. Users can belong to multiple companies with different roles (admin, user, operator).';

COMMENT ON TABLE "public"."user_preferences"
    IS 'Per-user preferences and settings. Stores last accessed company for quick switching, UI preferences, and other user-specific configuration as JSONB.';

COMMENT ON TABLE "public"."vendor_contacts"
    IS 'People at a vendor. Replaces the single embedded contact_name/email/phone columns on vendors. Each row is one person with a role + optional email/phone. At most one row per vendor can have is_primary=true (enforced by the vendor_contacts_one_primary partial unique index).';

COMMENT ON TABLE "public"."vendors"
    IS 'Supplier / outside-op partner. Roles are derived from references in parts.preferred_vendor_id and work_centers.vendor_id; no capability flags here.';

COMMENT ON TABLE "public"."waitlist"
    IS 'Pre-launch waitlist signups from the landing page. Captures prospective customer info (email, name, company, shop size) and tracks signup status (pending, approved, invited) and acquisition source.';

COMMENT ON TABLE "public"."work_centers"
    IS 'Capacity bucket for routing operations. Replaces operation_types. Either an internal machine/cell (kind=internal, labor_rate set) or an external vendor (kind=external, vendor_id set).';

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

COMMENT ON COLUMN "public"."feedback"."page_path"
    IS 'The URL pathname where feedback was submitted';

COMMENT ON COLUMN "public"."feedback"."page_title"
    IS 'Human-readable page name at time of submission';

COMMENT ON COLUMN "public"."inventory_transactions"."part_id"
    IS 'FK to parts (set NULL on part delete to preserve history). Renamed from inventory_item_id when the item master was unified.';

COMMENT ON COLUMN "public"."inventory_transactions"."item_name"
    IS 'Snapshot of the part name at transaction time. Survives part renames so historical ledger entries stay readable.';

COMMENT ON COLUMN "public"."job_materials"."parts_bom_id"
    IS 'Source parts_bom row this job_material was snapshotted from at job-start (renamed from routing_material_id; BOM is now part-attached, not routing-attached).';

COMMENT ON COLUMN "public"."job_materials"."material_part_id"
    IS 'FK to the consumed material in the unified parts table (renamed from inventory_item_id when the item master was unified).';

COMMENT ON COLUMN "public"."job_materials"."expected_quantity"
    IS 'Quantity expected to be consumed (snapshot from parts_bom.quantity at job-creation time, in `unit`).';

COMMENT ON COLUMN "public"."job_materials"."actual_quantity"
    IS 'Quantity actually consumed, recorded by the operator on completion. NULL until consumed.';

COMMENT ON COLUMN "public"."job_operations"."operation_name"
    IS 'Snapshot of the work_center name at job-creation time. Immune to mid-job renames.';

COMMENT ON COLUMN "public"."job_operations"."work_center_id"
    IS 'FK to the work_center this op runs at (renamed from operation_type_id when operation_types was replaced by work_centers).';

COMMENT ON COLUMN "public"."job_operations"."routing_operation_id"
    IS 'FK to the routing_operation this row was snapshotted from at job creation (renamed from routing_node_id).';

COMMENT ON COLUMN "public"."markup_rates"."breakpoints"
    IS 'JSONB array of {qty: int>0, markup_percent: number}. Sorted by qty ascending. At least one breakpoint required at write time.';

COMMENT ON COLUMN "public"."operator_sessions"."job_operation_id"
    IS 'The specific job operation step being worked. Inferred from job + operation_type when session starts.';

COMMENT ON COLUMN "public"."operator_sessions"."work_center_id"
    IS 'FK to the work_center this session ran at (renamed from operation_type_id when operation_types was replaced by work_centers).';

COMMENT ON COLUMN "public"."operator_sessions"."ended_at"
    IS 'NULL while session is active. Set when operator stops or completes work.';

COMMENT ON COLUMN "public"."part_procurement_tiers"."vendor_id"
    IS 'Vendor offering this tier. NULL = "internal estimate" (sketch before sourcing). When set, ON DELETE RESTRICT prevents removing a vendor that still has live tier sheets — drop the tiers first.';

COMMENT ON COLUMN "public"."part_procurement_tiers"."min_quantity"
    IS 'Lower bound (inclusive) of this tier in the part''s primary unit. A row with min_quantity=100 means "this price applies when ordering >= 100 of this part". Combined with the next-larger tier from the same vendor, defines a half-open break range.';

COMMENT ON COLUMN "public"."part_procurement_tiers"."cost_per_unit"
    IS 'Per-primary_unit cost at this tier. Always positive (CHECK).';

COMMENT ON COLUMN "public"."part_procurement_tiers"."expires_at"
    IS 'Date when this tier expires. Tiers past their expires_at are excluded by get_procurement_cost. NULL = never expires (open-ended quote).';

COMMENT ON COLUMN "public"."parts"."is_stocked"
    IS 'True if quantities of this part are tracked in inventory (renamed from is_stockable in the 20260504 migration to match shop-floor language). Used for the "Stocked" saved view, the inventory panel on the part detail page, and the reorder alerts query.';

COMMENT ON COLUMN "public"."parts"."primary_unit"
    IS 'Canonical unit of the on-hand quantity and the cost_per_unit. Required when is_stocked=true (parts_stocked_requires_unit CHECK); may be NULL for made-only parts.';

COMMENT ON COLUMN "public"."parts"."quantity"
    IS 'On-hand quantity in primary_unit. Defaults to 0; updated by inventory_transactions and the import flow.';

COMMENT ON COLUMN "public"."parts"."reorder_point"
    IS 'Threshold below which the inventory alert fires (quantity <= reorder_point). NULL disables the alert.';

COMMENT ON COLUMN "public"."parts"."preferred_vendor_id"
    IS 'Default supplier for procurement. The presence of any row pointing at a vendor makes that vendor a "supplier" in the derived-role calculation on the Vendors page.';

COMMENT ON COLUMN "public"."parts"."legacy_id"
    IS 'Source-system identifier from CSV import; allows ON CONFLICT (company_id, legacy_id) DO UPDATE for safe re-import. NULL for hand-created parts.';

COMMENT ON COLUMN "public"."parts"."source"
    IS 'How this part is sourced. ''made'' = produced in-shop (will have a routing); ''bought'' = procured from a vendor. Combined with is_stocked, classifies the part into one of four quadrants (Custom Made / Sub-assembly / Raw Material / Service+Drop-ship). Replaces the prior is_manufacturable boolean — see the 20260504 migration header for the (false,false)→''made'' orphan-default rationale.';

COMMENT ON COLUMN "public"."parts_bom"."quantity"
    IS 'Quantity of child consumed per unit of parent, expressed in `unit`. Cost rollups convert to the child part primary_unit via parts_unit_conversions if `unit` differs.';

COMMENT ON COLUMN "public"."parts_bom"."unit"
    IS 'Unit the BOM line is denominated in. Canonical for job_materials snapshots; cost rollups convert to the child part primary_unit when different.';

COMMENT ON COLUMN "public"."parts_bom"."sequence"
    IS 'Display order in the BOM panel. Steps of 10 leave room for inserts.';

COMMENT ON COLUMN "public"."parts_unit_conversions"."to_primary_factor"
    IS 'Multiplier: quantity_in_from_unit * to_primary_factor = quantity_in_primary_unit.';

COMMENT ON COLUMN "public"."quote_materials"."material_part_id"
    IS 'FK to the consumed material in the unified parts table (renamed from inventory_item_id when the item master was unified). Optional — supports ad-hoc materials not yet in the catalog.';

COMMENT ON COLUMN "public"."quote_materials"."item_name"
    IS 'Snapshot of the material name at quote-creation time. Survives part renames so historical quotes stay readable.';

COMMENT ON COLUMN "public"."quote_materials"."part_id"
    IS 'The manufactured part this material consumption belongs to (the line-item part on the quote).';

COMMENT ON COLUMN "public"."routing_operations"."sequence"
    IS 'Linear order within the routing. Lower values execute first. Steps of 10 (10, 20, 30...) leave room for inserts.';

COMMENT ON COLUMN "public"."routing_operations"."setup_minutes"
    IS 'One-time per-job setup time, in minutes. Amortized across batch in cost rollups (setup_minutes / qty).';

COMMENT ON COLUMN "public"."routing_operations"."cycle_minutes_per_unit"
    IS 'Per-unit run time, in minutes. Used for kind=internal cost calculation only.';

COMMENT ON COLUMN "public"."routing_operations"."labor_rate_override"
    IS 'Per-step override of the work_center labor_rate, in dollars per hour. Dominant pattern in real shop data (98.6% of comparable Contour rows override). NULL = inherit work_center.labor_rate. Used for kind=internal only.';

COMMENT ON COLUMN "public"."routing_operations"."external_unit_price"
    IS 'For kind=external only: cost per output unit charged by the vendor.';

COMMENT ON COLUMN "public"."routing_operations"."external_setup_cost"
    IS 'For kind=external only: one-time per-job setup charge from the vendor; amortizes across batch.';

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

COMMENT ON COLUMN "public"."vendor_contacts"."role_label"
    IS 'Free-text label used when role=''other''. Lets the UI render "Other (Production Manager)" without inventing a new enum value for every shop-specific role.';

COMMENT ON COLUMN "public"."vendor_contacts"."is_primary"
    IS 'True for the contact treated as the vendor''s primary point of contact. Surfaced on the vendors list page and as a star badge on the vendor detail page. Enforced unique-per-vendor by the vendor_contacts_one_primary partial index.';

COMMENT ON COLUMN "public"."vendors"."legacy_id"
    IS 'Source-system identifier from CSV import; allows ON CONFLICT (company_id, legacy_id) DO UPDATE for safe re-import.';

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

COMMENT ON COLUMN "public"."work_centers"."kind"
    IS 'internal = in-house machine/cell with an hourly labor_rate; external = outside-op partner identified by vendor_id (cost is per-routing_operation, not hourly).';

COMMENT ON COLUMN "public"."work_centers"."vendor_id"
    IS 'For kind=external only: the vendor performing the operation. Required when kind=external, must be NULL when kind=internal.';

COMMENT ON COLUMN "public"."work_centers"."labor_rate"
    IS 'Default hourly labor rate in dollars; used when kind=internal and no per-routing_operation override is set. Meaningless / typically NULL when kind=external.';

-- ============================================================
-- 11. STORAGE BUCKETS
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('attachments', 'attachments', false, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

COMMIT;
