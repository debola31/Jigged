-- ============================================================
-- Jigged Manufacturing Data Platform - Database Schema
-- Generated: 2026-07-16T20:51:51Z
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

CREATE TABLE IF NOT EXISTS "public"."auth_audit_log"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" uuid,
    "target_user_id" uuid,
    "company_id" uuid,
    "event_type" text NOT NULL,
    "outcome" text NOT NULL,
    "error_detail" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "auth_audit_log_pkey" PRIMARY KEY (id),
    CONSTRAINT "auth_audit_log_outcome_check" CHECK ((outcome = ANY (ARRAY['success'::text, 'forbidden'::text, 'failed'::text])))
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

CREATE TABLE IF NOT EXISTS "public"."company_order_counters"
(
    "company_id" uuid NOT NULL,
    "next_number" integer NOT NULL DEFAULT 1,
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "company_order_counters_pkey" PRIMARY KEY (company_id)
);

CREATE TABLE IF NOT EXISTS "public"."customers"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "name" text NOT NULL,
    "website" text,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "customers_pkey" PRIMARY KEY (id),
    CONSTRAINT "customers_company_name_unique" UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS "public"."customer_addresses"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" uuid NOT NULL,
    "address_line1" text,
    "address_line2" text,
    "city" text,
    "state" text,
    "postal_code" text,
    "country" text DEFAULT 'USA'::text,
    "default_billing" boolean NOT NULL DEFAULT false,
    "default_shipping" boolean NOT NULL DEFAULT false,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    "attention_to" text,
    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "public"."customer_contacts"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" uuid NOT NULL,
    "name" text NOT NULL,
    "role" text NOT NULL,
    "role_label" text,
    "email" text,
    "phone" text,
    "is_primary" boolean NOT NULL DEFAULT false,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY (id),
    CONSTRAINT "customer_contacts_role_check" CHECK ((role = ANY (ARRAY['buyer'::text, 'accounts_payable'::text, 'engineering'::text, 'quality'::text, 'shipping_receiving'::text, 'other'::text]))),
    CONSTRAINT "customer_contacts_role_label_required" CHECK (((role <> 'other'::text) OR ((role_label IS NOT NULL) AND (length(role_label) > 0))))
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

CREATE TABLE IF NOT EXISTS "public"."inventory_locations"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "parent_id" uuid,
    "name" text NOT NULL,
    "kind" text,
    "code" text,
    "sort_order" integer NOT NULL DEFAULT 0,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "inventory_locations_pkey" PRIMARY KEY (id),
    CONSTRAINT "inventory_locations_name_not_blank" CHECK ((length(btrim(name)) > 0))
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
    "expiration_date" date,
    "billing_address_id" uuid,
    "shipping_address_id" uuid,
    "contact_id" uuid,
    "payment_terms" text,
    "customer_name" text,
    "bill_to_address" jsonb,
    "ship_to_address" jsonb,
    "contact_snapshot" jsonb,
    "lead_time_text" text,
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
    "status_changed_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "due_date" date,
    "production_status" text NOT NULL,
    "fulfillment_status" text NOT NULL,
    "customer_po_number" text,
    "billing_address_id" uuid,
    "shipping_address_id" uuid,
    "contact_id" uuid,
    "customer_name" text,
    "bill_to_address" jsonb,
    "ship_to_address" jsonb,
    "contact_snapshot" jsonb,
    "invoicing_status" text NOT NULL DEFAULT 'uninvoiced'::text,
    CONSTRAINT "jobs_pkey" PRIMARY KEY (id),
    CONSTRAINT "jobs_company_id_job_number_key" UNIQUE (company_id, job_number),
    CONSTRAINT "jobs_fulfillment_status_check" CHECK ((fulfillment_status = ANY (ARRAY['unshipped'::text, 'partially_shipped'::text, 'fully_shipped'::text]))),
    CONSTRAINT "jobs_invoicing_status_check" CHECK ((invoicing_status = ANY (ARRAY['uninvoiced'::text, 'partially_invoiced'::text, 'fully_invoiced'::text]))),
    CONSTRAINT "jobs_production_status_check" CHECK ((production_status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."job_attachments"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "job_id" uuid NOT NULL,
    "storage_path" text NOT NULL,
    "file_name" text NOT NULL,
    "mime_type" text,
    "size_bytes" bigint,
    "uploaded_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "job_attachments_pkey" PRIMARY KEY (id)
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

CREATE TABLE IF NOT EXISTS "public"."shipments"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "customer_id" uuid NOT NULL,
    "shipping_address_id" uuid,
    "one_time_address" jsonb,
    "packing_slip_number" text NOT NULL,
    "ship_date" date NOT NULL DEFAULT CURRENT_DATE,
    "carrier" text,
    "created_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "voided_at" timestamp with time zone,
    "voided_by" uuid,
    "shipping_method" text,
    "job_id" uuid NOT NULL,
    "customer_name" text,
    "bill_to_address" jsonb,
    "ship_to_address" jsonb,
    CONSTRAINT "shipments_pkey" PRIMARY KEY (id),
    CONSTRAINT "shipments_packing_slip_company_unique" UNIQUE (company_id, packing_slip_number),
    CONSTRAINT "shipments_shipping_method_check" CHECK (((shipping_method IS NULL) OR (shipping_method = ANY (ARRAY['customer_pickup'::text, 'personal_delivery'::text, 'shipment'::text, 'dropship'::text, 'restock'::text]))))
);

CREATE TABLE IF NOT EXISTS "public"."job_fulfillment_audit"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "job_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "from_status" text,
    "to_status" text NOT NULL,
    "triggering_shipment_id" uuid,
    "triggering_user_id" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "job_fulfillment_audit_pkey" PRIMARY KEY (id)
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

CREATE TABLE IF NOT EXISTS "public"."quickbooks_connections"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "realm_id" text NOT NULL,
    "environment" text NOT NULL DEFAULT 'sandbox'::text,
    "access_token" text NOT NULL,
    "access_expires_at" timestamp with time zone NOT NULL,
    "refresh_token" text NOT NULL,
    "refresh_expires_at" timestamp with time zone,
    "token_version" integer NOT NULL DEFAULT 0,
    "reconnect_required" boolean NOT NULL DEFAULT false,
    "qb_company_name" text,
    "default_item_id" text,
    "default_income_account_id" text,
    "connected_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "quickbooks_connections_pkey" PRIMARY KEY (id),
    CONSTRAINT "quickbooks_connections_company_id_key" UNIQUE (company_id),
    CONSTRAINT "quickbooks_connections_environment_check" CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."quickbooks_customer_map"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "customer_id" uuid NOT NULL,
    "realm_id" text NOT NULL,
    "qb_customer_id" text NOT NULL,
    "qb_display_name" text,
    "linked_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "quickbooks_customer_map_pkey" PRIMARY KEY (id),
    CONSTRAINT "quickbooks_customer_map_unique" UNIQUE (company_id, customer_id, realm_id)
);

CREATE TABLE IF NOT EXISTS "public"."quickbooks_invoice_links"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "quote_id" uuid,
    "job_id" uuid NOT NULL,
    "realm_id" text NOT NULL,
    "qb_request_id" uuid NOT NULL,
    "qb_invoice_id" text,
    "qb_invoice_doc_number" text,
    "qb_invoice_sync_token" text,
    "status" text NOT NULL DEFAULT 'pending'::text,
    "pushed_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    "qb_invoice_url" text,
    "voided_at" timestamp with time zone,
    "voided_by" uuid,
    CONSTRAINT "quickbooks_invoice_links_pkey" PRIMARY KEY (id),
    CONSTRAINT "quickbooks_invoice_links_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'created'::text, 'error'::text])))
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
    "is_location_tracked" boolean NOT NULL DEFAULT false,
    "costing_batch_quantity" numeric NOT NULL DEFAULT 1,
    CONSTRAINT "parts_pkey" PRIMARY KEY (id),
    CONSTRAINT "parts_legacy_id_unique_per_company" UNIQUE (company_id, legacy_id),
    CONSTRAINT "parts_unique_per_company" UNIQUE (company_id, part_name),
    CONSTRAINT "parts_costing_batch_quantity_check" CHECK (((costing_batch_quantity IS NULL) OR (costing_batch_quantity > (0)::numeric))),
    CONSTRAINT "parts_quantity_non_negative" CHECK ((quantity >= (0)::numeric)),
    CONSTRAINT "parts_requires_unit" CHECK ((primary_unit IS NOT NULL)),
    CONSTRAINT "parts_source_check" CHECK ((source = ANY (ARRAY['made'::text, 'bought'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."part_attachments"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "part_id" uuid NOT NULL,
    "storage_path" text NOT NULL,
    "file_name" text NOT NULL,
    "kind" text NOT NULL DEFAULT 'other'::text,
    "mime_type" text,
    "size_bytes" bigint,
    "uploaded_by" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "part_attachments_pkey" PRIMARY KEY (id),
    CONSTRAINT "part_attachments_kind_check" CHECK ((kind = ANY (ARRAY['pdf'::text, 'step'::text, 'dwg'::text, 'other'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."part_location_stock"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "part_id" uuid NOT NULL,
    "location_id" uuid NOT NULL,
    "quantity" numeric NOT NULL DEFAULT 0,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "part_location_stock_pkey" PRIMARY KEY (id),
    CONSTRAINT "part_location_stock_part_location_unique" UNIQUE (part_id, location_id),
    CONSTRAINT "part_location_stock_quantity_non_negative" CHECK ((quantity >= (0)::numeric))
);

CREATE TABLE IF NOT EXISTS "public"."part_notes"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "part_id" uuid NOT NULL,
    "author_id" uuid,
    "body" text NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "note_type" text NOT NULL DEFAULT 'user'::text,
    CONSTRAINT "part_notes_pkey" PRIMARY KEY (id),
    CONSTRAINT "part_notes_body_not_blank" CHECK ((length(btrim(body)) > 0)),
    CONSTRAINT "part_notes_note_type_check" CHECK ((note_type = ANY (ARRAY['user'::text, 'pricing'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."part_pricing_tiers"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "part_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "sequence" integer NOT NULL,
    "quantity" numeric NOT NULL,
    "markup_percent" numeric(10,6),
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "part_pricing_tiers_pkey" PRIMARY KEY (id),
    CONSTRAINT "part_pricing_tiers_unique_seq" UNIQUE (part_id, sequence),
    CONSTRAINT "part_pricing_tiers_quantity_check" CHECK ((quantity > (0)::numeric))
);

CREATE TABLE IF NOT EXISTS "public"."part_procurement_tiers"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "part_id" uuid NOT NULL,
    "min_quantity" numeric NOT NULL,
    "cost_per_unit" numeric NOT NULL,
    "quoted_at" date,
    "expires_at" date,
    "notes" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "part_procurement_tiers_pkey" PRIMARY KEY (id),
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
    "consume_whole_units" boolean NOT NULL DEFAULT false,
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
    "quantity" numeric NOT NULL,
    "unit_price" numeric(12,4) NOT NULL,
    "total_price" numeric(12,4),
    "markup_percent" numeric(5,2),
    "base_cost_per_unit" numeric(12,4),
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "is_quote_override" boolean NOT NULL DEFAULT false,
    "pricing_basis_snapshot" jsonb,
    "basis_unknown" boolean NOT NULL DEFAULT false,
    CONSTRAINT "quote_line_items_pkey" PRIMARY KEY (id),
    CONSTRAINT "quote_line_items_unique_seq" UNIQUE (quote_id, sequence),
    CONSTRAINT "quote_line_items_quantity_check" CHECK ((quantity > (0)::numeric))
);

CREATE TABLE IF NOT EXISTS "public"."job_parts"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "job_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "part_id" uuid NOT NULL,
    "source_quote_line_item_id" uuid,
    "sequence" integer NOT NULL,
    "quantity" numeric NOT NULL,
    "status_changed_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "current_operation_sequence" integer,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    "production_status" text NOT NULL,
    "fulfillment_status" text NOT NULL,
    "unit_price" numeric(12,4),
    "total_price" numeric(12,4),
    "invoicing_status" text NOT NULL DEFAULT 'uninvoiced'::text,
    CONSTRAINT "job_parts_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_parts_job_part_unique" UNIQUE (job_id, part_id),
    CONSTRAINT "job_parts_job_sequence_unique" UNIQUE (job_id, sequence),
    CONSTRAINT "job_parts_fulfillment_status_check" CHECK ((fulfillment_status = ANY (ARRAY['unshipped'::text, 'partially_shipped'::text, 'fully_shipped'::text]))),
    CONSTRAINT "job_parts_invoicing_status_check" CHECK ((invoicing_status = ANY (ARRAY['uninvoiced'::text, 'partially_invoiced'::text, 'fully_invoiced'::text]))),
    CONSTRAINT "job_parts_production_status_check" CHECK ((production_status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text]))),
    CONSTRAINT "job_parts_quantity_check" CHECK ((quantity > (0)::numeric))
);

CREATE TABLE IF NOT EXISTS "public"."job_materials"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "job_id" uuid NOT NULL,
    "job_part_id" uuid NOT NULL,
    "parts_bom_id" uuid,
    "material_part_id" uuid NOT NULL,
    "expected_quantity" numeric NOT NULL DEFAULT 0,
    "unit" text NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "job_materials_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_materials_expected_quantity_check" CHECK ((expected_quantity >= (0)::numeric))
);

CREATE TABLE IF NOT EXISTS "public"."quickbooks_invoice_line_items"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "invoice_link_id" uuid NOT NULL,
    "job_part_id" uuid NOT NULL,
    "quantity" numeric(12,4) NOT NULL,
    "unit_price" numeric(12,4) NOT NULL,
    "total_price" numeric(12,4) NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "quickbooks_invoice_line_items_pkey" PRIMARY KEY (id),
    CONSTRAINT "qb_ili_link_part_unique" UNIQUE (invoice_link_id, job_part_id),
    CONSTRAINT "qb_ili_quantity_positive" CHECK ((quantity > (0)::numeric))
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
    "units_consumed" numeric,
    CONSTRAINT "quote_materials_pkey" PRIMARY KEY (id),
    CONSTRAINT "quote_materials_units_consumed_check" CHECK (((units_consumed IS NULL) OR (units_consumed >= (0)::numeric)))
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

CREATE TABLE IF NOT EXISTS "public"."shipment_line_items"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "shipment_id" uuid NOT NULL,
    "job_part_id" uuid NOT NULL,
    "quantity" numeric NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "shipment_line_items_pkey" PRIMARY KEY (id),
    CONSTRAINT "shipment_line_items_quantity_positive" CHECK ((quantity > (0)::numeric))
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
    "status" text NOT NULL DEFAULT 'pending'::text,
    "completed_at" timestamp with time zone,
    "completed_by" uuid,
    "instructions" text,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    "routing_operation_id" uuid,
    CONSTRAINT "job_operations_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_operations_job_part_sequence_key" UNIQUE (job_part_id, sequence),
    CONSTRAINT "job_operations_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text])))
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
    "location_id" uuid,
    "transfer_group_id" uuid,
    "location_name" text,
    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY (id),
    CONSTRAINT "inventory_transactions_quantity_positive" CHECK ((quantity >= (0)::numeric)),
    CONSTRAINT "inventory_transactions_type_check" CHECK ((type = ANY (ARRAY['addition'::text, 'depletion'::text, 'adjustment'::text])))
);

CREATE TABLE IF NOT EXISTS "public"."job_notes"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "job_id" uuid NOT NULL,
    "author_id" uuid,
    "body" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "job_part_id" uuid,
    "job_operation_id" uuid,
    "note_type" text NOT NULL DEFAULT 'user'::text,
    CONSTRAINT "job_notes_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_notes_body_blank_or_null" CHECK (((body IS NULL) OR (length(btrim(body)) > 0))),
    CONSTRAINT "job_notes_note_type_check" CHECK ((note_type = ANY (ARRAY['user'::text, 'event'::text]))),
    CONSTRAINT "job_notes_operation_requires_part" CHECK (((job_operation_id IS NULL) OR (job_part_id IS NOT NULL)))
);

CREATE TABLE IF NOT EXISTS "public"."job_note_media"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "note_id" uuid NOT NULL,
    "storage_path" text NOT NULL,
    "thumbnail_path" text,
    "kind" text NOT NULL DEFAULT 'photo'::text,
    "mime_type" text,
    "size_bytes" bigint,
    "width" integer,
    "height" integer,
    "duration_seconds" numeric,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "job_note_media_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_note_media_kind_check" CHECK ((kind = ANY (ARRAY['photo'::text, 'video'::text])))
);

-- ============================================================
-- 3. ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE "public"."ai_chat_queries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ai_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."auth_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."company_custom_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."company_order_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."customer_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."customer_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."demo_data_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."inventory_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."inventory_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_fulfillment_audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_note_media" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."part_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."part_location_stock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."part_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."part_pricing_tiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."part_procurement_tiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."parts_bom" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."parts_unit_conversions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quickbooks_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quickbooks_customer_map" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quickbooks_invoice_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quickbooks_invoice_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quote_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quote_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quote_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."routing_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."routings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."saved_insights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."shipment_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."shipments" ENABLE ROW LEVEL SECURITY;
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

DROP POLICY IF EXISTS "Company admins read auth audit" ON "public"."auth_audit_log";
CREATE POLICY "Company admins read auth audit"
    ON "public"."auth_audit_log"
    FOR SELECT
    USING (((company_id IS NOT NULL) AND is_company_admin(company_id)));

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

DROP POLICY IF EXISTS "Company members manage their customer addresses" ON "public"."customer_addresses";
CREATE POLICY "Company members manage their customer addresses"
    ON "public"."customer_addresses"
    FOR ALL
    USING ((EXISTS ( SELECT 1
   FROM (customers c
     JOIN user_company_access uca ON ((uca.company_id = c.company_id)))
  WHERE ((c.id = customer_addresses.customer_id) AND (uca.user_id = auth.uid())))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM (customers c
     JOIN user_company_access uca ON ((uca.company_id = c.company_id)))
  WHERE ((c.id = customer_addresses.customer_id) AND (uca.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can delete customer_contacts" ON "public"."customer_contacts";
CREATE POLICY "Users can delete customer_contacts"
    ON "public"."customer_contacts"
    FOR DELETE
    USING ((customer_id IN ( SELECT c.id
   FROM customers c
  WHERE (c.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert customer_contacts" ON "public"."customer_contacts";
CREATE POLICY "Users can insert customer_contacts"
    ON "public"."customer_contacts"
    FOR INSERT
    WITH CHECK ((customer_id IN ( SELECT c.id
   FROM customers c
  WHERE (c.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update customer_contacts" ON "public"."customer_contacts";
CREATE POLICY "Users can update customer_contacts"
    ON "public"."customer_contacts"
    FOR UPDATE
    USING ((customer_id IN ( SELECT c.id
   FROM customers c
  WHERE (c.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view customer_contacts" ON "public"."customer_contacts";
CREATE POLICY "Users can view customer_contacts"
    ON "public"."customer_contacts"
    FOR SELECT
    USING ((customer_id IN ( SELECT c.id
   FROM customers c
  WHERE (c.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."customer_contacts";
CREATE POLICY "ai_readonly_select"
    ON "public"."customer_contacts"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((customer_id IN ( SELECT c.id
   FROM customers c
  WHERE (c.company_id = (current_setting('jigged.company_id'::text, true))::uuid))));

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

DROP POLICY IF EXISTS "Users can delete inventory_locations" ON "public"."inventory_locations";
CREATE POLICY "Users can delete inventory_locations"
    ON "public"."inventory_locations"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert inventory_locations" ON "public"."inventory_locations";
CREATE POLICY "Users can insert inventory_locations"
    ON "public"."inventory_locations"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update inventory_locations" ON "public"."inventory_locations";
CREATE POLICY "Users can update inventory_locations"
    ON "public"."inventory_locations"
    FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view inventory_locations" ON "public"."inventory_locations";
CREATE POLICY "Users can view inventory_locations"
    ON "public"."inventory_locations"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

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

DROP POLICY IF EXISTS "Users can delete their company's job_attachments" ON "public"."job_attachments";
CREATE POLICY "Users can delete their company's job_attachments"
    ON "public"."job_attachments"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert their company's job_attachments" ON "public"."job_attachments";
CREATE POLICY "Users can insert their company's job_attachments"
    ON "public"."job_attachments"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view their company's job_attachments" ON "public"."job_attachments";
CREATE POLICY "Users can view their company's job_attachments"
    ON "public"."job_attachments"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view job_fulfillment_audit" ON "public"."job_fulfillment_audit";
CREATE POLICY "Users can view job_fulfillment_audit"
    ON "public"."job_fulfillment_audit"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."job_fulfillment_audit";
CREATE POLICY "ai_readonly_select"
    ON "public"."job_fulfillment_audit"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

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

DROP POLICY IF EXISTS "Authors and admins can delete job_note_media" ON "public"."job_note_media";
CREATE POLICY "Authors and admins can delete job_note_media"
    ON "public"."job_note_media"
    FOR DELETE
    USING ((is_company_admin(company_id) OR (EXISTS ( SELECT 1
   FROM job_notes n
  WHERE ((n.id = job_note_media.note_id) AND (n.author_id = get_operator_access_id(n.company_id)))))));

DROP POLICY IF EXISTS "Users can insert job_note_media" ON "public"."job_note_media";
CREATE POLICY "Users can insert job_note_media"
    ON "public"."job_note_media"
    FOR INSERT
    WITH CHECK (((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)) AND (get_operator_access_id(company_id) IS NOT NULL)));

DROP POLICY IF EXISTS "Users can view job_note_media" ON "public"."job_note_media";
CREATE POLICY "Users can view job_note_media"
    ON "public"."job_note_media"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Authors and admins can delete job_notes" ON "public"."job_notes";
CREATE POLICY "Authors and admins can delete job_notes"
    ON "public"."job_notes"
    FOR DELETE
    USING (((author_id = get_operator_access_id(company_id)) OR is_company_admin(company_id)));

DROP POLICY IF EXISTS "Users can insert own job_notes" ON "public"."job_notes";
CREATE POLICY "Users can insert own job_notes"
    ON "public"."job_notes"
    FOR INSERT
    WITH CHECK (((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)) AND (author_id = get_operator_access_id(company_id))));

DROP POLICY IF EXISTS "Users can view job_notes" ON "public"."job_notes";
CREATE POLICY "Users can view job_notes"
    ON "public"."job_notes"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

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

DROP POLICY IF EXISTS "Uploaders and admins can delete part_attachments" ON "public"."part_attachments";
CREATE POLICY "Uploaders and admins can delete part_attachments"
    ON "public"."part_attachments"
    FOR DELETE
    USING (((uploaded_by = get_operator_access_id(company_id)) OR is_company_admin(company_id)));

DROP POLICY IF EXISTS "Users can insert own part_attachments" ON "public"."part_attachments";
CREATE POLICY "Users can insert own part_attachments"
    ON "public"."part_attachments"
    FOR INSERT
    WITH CHECK (((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)) AND (uploaded_by = get_operator_access_id(company_id))));

DROP POLICY IF EXISTS "Users can view part_attachments" ON "public"."part_attachments";
CREATE POLICY "Users can view part_attachments"
    ON "public"."part_attachments"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view part_location_stock" ON "public"."part_location_stock";
CREATE POLICY "Users can view part_location_stock"
    ON "public"."part_location_stock"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Authors and admins can delete part_notes" ON "public"."part_notes";
CREATE POLICY "Authors and admins can delete part_notes"
    ON "public"."part_notes"
    FOR DELETE
    USING (((author_id = get_operator_access_id(company_id)) OR is_company_admin(company_id)));

DROP POLICY IF EXISTS "Users can insert own part_notes" ON "public"."part_notes";
CREATE POLICY "Users can insert own part_notes"
    ON "public"."part_notes"
    FOR INSERT
    WITH CHECK (((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)) AND (author_id = get_operator_access_id(company_id))));

DROP POLICY IF EXISTS "Users can view part_notes" ON "public"."part_notes";
CREATE POLICY "Users can view part_notes"
    ON "public"."part_notes"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

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

DROP POLICY IF EXISTS "Users can view their company's qb customer map" ON "public"."quickbooks_customer_map";
CREATE POLICY "Users can view their company's qb customer map"
    ON "public"."quickbooks_customer_map"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view their company's qb invoice line items" ON "public"."quickbooks_invoice_line_items";
CREATE POLICY "Users can view their company's qb invoice line items"
    ON "public"."quickbooks_invoice_line_items"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view their company's qb invoice links" ON "public"."quickbooks_invoice_links";
CREATE POLICY "Users can view their company's qb invoice links"
    ON "public"."quickbooks_invoice_links"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

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

DROP POLICY IF EXISTS "Users can delete shipment_line_items" ON "public"."shipment_line_items";
CREATE POLICY "Users can delete shipment_line_items"
    ON "public"."shipment_line_items"
    FOR DELETE
    USING ((shipment_id IN ( SELECT s.id
   FROM shipments s
  WHERE (s.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can insert shipment_line_items" ON "public"."shipment_line_items";
CREATE POLICY "Users can insert shipment_line_items"
    ON "public"."shipment_line_items"
    FOR INSERT
    WITH CHECK ((shipment_id IN ( SELECT s.id
   FROM shipments s
  WHERE (s.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can update shipment_line_items" ON "public"."shipment_line_items";
CREATE POLICY "Users can update shipment_line_items"
    ON "public"."shipment_line_items"
    FOR UPDATE
    USING ((shipment_id IN ( SELECT s.id
   FROM shipments s
  WHERE (s.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "Users can view shipment_line_items" ON "public"."shipment_line_items";
CREATE POLICY "Users can view shipment_line_items"
    ON "public"."shipment_line_items"
    FOR SELECT
    USING ((shipment_id IN ( SELECT s.id
   FROM shipments s
  WHERE (s.company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."shipment_line_items";
CREATE POLICY "ai_readonly_select"
    ON "public"."shipment_line_items"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((EXISTS ( SELECT 1
   FROM shipments s
  WHERE ((s.id = shipment_line_items.shipment_id) AND (s.company_id = (current_setting('jigged.company_id'::text, true))::uuid)))));

DROP POLICY IF EXISTS "Users can delete shipments" ON "public"."shipments";
CREATE POLICY "Users can delete shipments"
    ON "public"."shipments"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert shipments" ON "public"."shipments";
CREATE POLICY "Users can insert shipments"
    ON "public"."shipments"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update shipments" ON "public"."shipments";
CREATE POLICY "Users can update shipments"
    ON "public"."shipments"
    FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can view shipments" ON "public"."shipments";
CREATE POLICY "Users can view shipments"
    ON "public"."shipments"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."shipments";
CREATE POLICY "ai_readonly_select"
    ON "public"."shipments"
    FOR SELECT
    TO jigged_ai_readonly
    USING ((company_id = (current_setting('jigged.company_id'::text, true))::uuid));

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

ALTER TABLE "public"."ai_config"
    ADD CONSTRAINT "ai_config_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."auth_audit_log"
    ADD CONSTRAINT "auth_audit_log_actor_user_id_fkey" FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."auth_audit_log"
    ADD CONSTRAINT "auth_audit_log_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;

ALTER TABLE "public"."auth_audit_log"
    ADD CONSTRAINT "auth_audit_log_target_user_id_fkey" FOREIGN KEY (target_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."companies"
    ADD CONSTRAINT "companies_demo_company_id_fkey" FOREIGN KEY (demo_company_id) REFERENCES companies(id) ON DELETE SET NULL;

ALTER TABLE "public"."company_custom_units"
    ADD CONSTRAINT "company_custom_units_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."company_order_counters"
    ADD CONSTRAINT "company_order_counters_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."customer_addresses"
    ADD CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE "public"."customer_contacts"
    ADD CONSTRAINT "customer_contacts_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE "public"."customers"
    ADD CONSTRAINT "customers_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."demo_data_templates"
    ADD CONSTRAINT "demo_templates_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE "public"."feedback"
    ADD CONSTRAINT "feedback_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."feedback"
    ADD CONSTRAINT "feedback_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."inventory_locations"
    ADD CONSTRAINT "inventory_locations_company_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."inventory_locations"
    ADD CONSTRAINT "inventory_locations_parent_fkey" FOREIGN KEY (parent_id) REFERENCES inventory_locations(id) ON DELETE RESTRICT;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_job_operation_id_fkey" FOREIGN KEY (job_operation_id) REFERENCES job_operations(id) ON DELETE SET NULL;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_location_fkey" FOREIGN KEY (location_id) REFERENCES inventory_locations(id) ON DELETE SET NULL;

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE SET NULL;

ALTER TABLE "public"."invitations"
    ADD CONSTRAINT "invitations_accepted_by_fkey" FOREIGN KEY (accepted_by) REFERENCES auth.users(id);

ALTER TABLE "public"."invitations"
    ADD CONSTRAINT "invitations_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."invitations"
    ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY (invited_by) REFERENCES auth.users(id);

ALTER TABLE "public"."job_attachments"
    ADD CONSTRAINT "job_attachments_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_attachments"
    ADD CONSTRAINT "job_attachments_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_attachments"
    ADD CONSTRAINT "job_attachments_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_fulfillment_audit"
    ADD CONSTRAINT "job_fulfillment_audit_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_fulfillment_audit"
    ADD CONSTRAINT "job_fulfillment_audit_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_fulfillment_audit"
    ADD CONSTRAINT "job_fulfillment_audit_triggering_shipment_id_fkey" FOREIGN KEY (triggering_shipment_id) REFERENCES shipments(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_fulfillment_audit"
    ADD CONSTRAINT "job_fulfillment_audit_triggering_user_id_fkey" FOREIGN KEY (triggering_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_job_part_id_fkey" FOREIGN KEY (job_part_id) REFERENCES job_parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_material_part_id_fkey" FOREIGN KEY (material_part_id) REFERENCES parts(id) ON DELETE RESTRICT;

ALTER TABLE "public"."job_materials"
    ADD CONSTRAINT "job_materials_parts_bom_id_fkey" FOREIGN KEY (parts_bom_id) REFERENCES parts_bom(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_note_media"
    ADD CONSTRAINT "job_note_media_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_note_media"
    ADD CONSTRAINT "job_note_media_note_id_fkey" FOREIGN KEY (note_id) REFERENCES job_notes(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_notes"
    ADD CONSTRAINT "job_notes_author_id_fkey" FOREIGN KEY (author_id) REFERENCES user_company_access(id) ON DELETE SET NULL;

ALTER TABLE "public"."job_notes"
    ADD CONSTRAINT "job_notes_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_notes"
    ADD CONSTRAINT "job_notes_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_notes"
    ADD CONSTRAINT "job_notes_job_operation_id_fkey" FOREIGN KEY (job_operation_id) REFERENCES job_operations(id) ON DELETE CASCADE;

ALTER TABLE "public"."job_notes"
    ADD CONSTRAINT "job_notes_job_part_id_fkey" FOREIGN KEY (job_part_id) REFERENCES job_parts(id) ON DELETE CASCADE;

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
    ADD CONSTRAINT "jobs_billing_address_id_fkey" FOREIGN KEY (billing_address_id) REFERENCES customer_addresses(id) ON DELETE SET NULL;

ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_contact_id_fkey" FOREIGN KEY (contact_id) REFERENCES customer_contacts(id) ON DELETE SET NULL;

ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_quote_id_fkey" FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE SET NULL;

ALTER TABLE "public"."jobs"
    ADD CONSTRAINT "jobs_shipping_address_id_fkey" FOREIGN KEY (shipping_address_id) REFERENCES customer_addresses(id) ON DELETE SET NULL;

ALTER TABLE "public"."part_attachments"
    ADD CONSTRAINT "part_attachments_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_attachments"
    ADD CONSTRAINT "part_attachments_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_attachments"
    ADD CONSTRAINT "part_attachments_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES user_company_access(id) ON DELETE SET NULL;

ALTER TABLE "public"."part_location_stock"
    ADD CONSTRAINT "part_location_stock_company_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_location_stock"
    ADD CONSTRAINT "part_location_stock_location_fkey" FOREIGN KEY (location_id) REFERENCES inventory_locations(id) ON DELETE RESTRICT;

ALTER TABLE "public"."part_location_stock"
    ADD CONSTRAINT "part_location_stock_part_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE RESTRICT;

ALTER TABLE "public"."part_notes"
    ADD CONSTRAINT "part_notes_author_id_fkey" FOREIGN KEY (author_id) REFERENCES user_company_access(id) ON DELETE SET NULL;

ALTER TABLE "public"."part_notes"
    ADD CONSTRAINT "part_notes_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_notes"
    ADD CONSTRAINT "part_notes_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_pricing_tiers"
    ADD CONSTRAINT "part_pricing_tiers_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_pricing_tiers"
    ADD CONSTRAINT "part_pricing_tiers_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."part_procurement_tiers"
    ADD CONSTRAINT "part_procurement_tiers_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."parts"
    ADD CONSTRAINT "parts_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."parts"
    ADD CONSTRAINT "parts_preferred_vendor_id_fkey" FOREIGN KEY (preferred_vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;

ALTER TABLE "public"."parts_bom"
    ADD CONSTRAINT "parts_bom_child_part_id_fkey" FOREIGN KEY (child_part_id) REFERENCES parts(id) ON DELETE RESTRICT;

ALTER TABLE "public"."parts_bom"
    ADD CONSTRAINT "parts_bom_parent_part_id_fkey" FOREIGN KEY (parent_part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."parts_unit_conversions"
    ADD CONSTRAINT "parts_unit_conversions_part_id_fkey" FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

ALTER TABLE "public"."quickbooks_connections"
    ADD CONSTRAINT "quickbooks_connections_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."quickbooks_connections"
    ADD CONSTRAINT "quickbooks_connections_connected_by_fkey" FOREIGN KEY (connected_by) REFERENCES user_company_access(id) ON DELETE SET NULL;

ALTER TABLE "public"."quickbooks_customer_map"
    ADD CONSTRAINT "quickbooks_customer_map_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."quickbooks_customer_map"
    ADD CONSTRAINT "quickbooks_customer_map_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE "public"."quickbooks_customer_map"
    ADD CONSTRAINT "quickbooks_customer_map_linked_by_fkey" FOREIGN KEY (linked_by) REFERENCES user_company_access(id) ON DELETE SET NULL;

ALTER TABLE "public"."quickbooks_invoice_line_items"
    ADD CONSTRAINT "qb_ili_company_fk" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."quickbooks_invoice_line_items"
    ADD CONSTRAINT "qb_ili_job_part_fk" FOREIGN KEY (job_part_id) REFERENCES job_parts(id) ON DELETE RESTRICT;

ALTER TABLE "public"."quickbooks_invoice_line_items"
    ADD CONSTRAINT "qb_ili_link_fk" FOREIGN KEY (invoice_link_id) REFERENCES quickbooks_invoice_links(id) ON DELETE CASCADE;

ALTER TABLE "public"."quickbooks_invoice_links"
    ADD CONSTRAINT "quickbooks_invoice_links_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."quickbooks_invoice_links"
    ADD CONSTRAINT "quickbooks_invoice_links_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

ALTER TABLE "public"."quickbooks_invoice_links"
    ADD CONSTRAINT "quickbooks_invoice_links_pushed_by_fkey" FOREIGN KEY (pushed_by) REFERENCES user_company_access(id) ON DELETE SET NULL;

ALTER TABLE "public"."quickbooks_invoice_links"
    ADD CONSTRAINT "quickbooks_invoice_links_quote_id_fkey" FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE SET NULL;

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
    ADD CONSTRAINT "quotes_billing_address_id_fkey" FOREIGN KEY (billing_address_id) REFERENCES customer_addresses(id) ON DELETE SET NULL;

ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_contact_id_fkey" FOREIGN KEY (contact_id) REFERENCES customer_contacts(id);

ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_shipping_address_id_fkey" FOREIGN KEY (shipping_address_id) REFERENCES customer_addresses(id) ON DELETE SET NULL;

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

ALTER TABLE "public"."shipment_line_items"
    ADD CONSTRAINT "shipment_line_items_job_part_id_fkey" FOREIGN KEY (job_part_id) REFERENCES job_parts(id);

ALTER TABLE "public"."shipment_line_items"
    ADD CONSTRAINT "shipment_line_items_shipment_id_fkey" FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE;

ALTER TABLE "public"."shipments"
    ADD CONSTRAINT "shipments_company_id_fkey" FOREIGN KEY (company_id) REFERENCES companies(id);

ALTER TABLE "public"."shipments"
    ADD CONSTRAINT "shipments_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."shipments"
    ADD CONSTRAINT "shipments_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id);

ALTER TABLE "public"."shipments"
    ADD CONSTRAINT "shipments_job_id_fkey" FOREIGN KEY (job_id) REFERENCES jobs(id);

ALTER TABLE "public"."shipments"
    ADD CONSTRAINT "shipments_shipping_address_id_fkey" FOREIGN KEY (shipping_address_id) REFERENCES customer_addresses(id) ON DELETE SET NULL;

ALTER TABLE "public"."shipments"
    ADD CONSTRAINT "shipments_voided_by_fkey" FOREIGN KEY (voided_by) REFERENCES auth.users(id) ON DELETE SET NULL;

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
CREATE INDEX IF NOT EXISTS idx_auth_audit_actor_created ON public.auth_audit_log USING btree (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_company_created ON public.auth_audit_log USING btree (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_companies_demo_company ON public.companies USING btree (demo_company_id) WHERE (demo_company_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_companies_is_demo ON public.companies USING btree (is_demo) WHERE (is_demo = true);
CREATE INDEX IF NOT EXISTS idx_companies_name ON public.companies USING btree (name);
CREATE INDEX IF NOT EXISTS idx_companies_slug ON public.companies USING btree (slug);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON public.customer_addresses USING btree (customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS customer_contacts_one_primary ON public.customer_contacts USING btree (customer_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON public.customer_contacts USING btree (customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_company ON public.customers USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_customers_name ON public.customers USING btree (company_id, name);
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm ON public.customers USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS inventory_locations_company_parent_idx ON public.inventory_locations USING btree (company_id, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_locations_one_unassigned_per_company ON public.inventory_locations USING btree (company_id) WHERE (name = 'Unassigned'::text);
CREATE INDEX IF NOT EXISTS inventory_transactions_company_id_created_at_idx ON public.inventory_transactions USING btree (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_transactions_discrepancy_idx ON public.inventory_transactions USING btree (company_id, created_at DESC) WHERE (has_discrepancy = true);
CREATE INDEX IF NOT EXISTS inventory_transactions_job_id_idx ON public.inventory_transactions USING btree (job_id) WHERE (job_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS inventory_transactions_job_operation_id_idx ON public.inventory_transactions USING btree (job_operation_id) WHERE (job_operation_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS inventory_transactions_location_idx ON public.inventory_transactions USING btree (location_id) WHERE (location_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS inventory_transactions_part_id_created_at_idx ON public.inventory_transactions USING btree (part_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_transactions_transfer_group_idx ON public.inventory_transactions USING btree (transfer_group_id) WHERE (transfer_group_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_invitations_company_id ON public.invitations USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON public.invitations USING btree (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_email_company ON public.invitations USING btree (email, company_id) WHERE ((status)::text = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_job_attachments_job ON public.job_attachments USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_job_fulfillment_audit_company ON public.job_fulfillment_audit USING btree (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_fulfillment_audit_job ON public.job_fulfillment_audit USING btree (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_materials_job ON public.job_materials USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_job_part_id ON public.job_materials USING btree (job_part_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_material_part ON public.job_materials USING btree (material_part_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_parts_bom ON public.job_materials USING btree (parts_bom_id);
CREATE INDEX IF NOT EXISTS idx_job_note_media_note ON public.job_note_media USING btree (note_id);
CREATE INDEX IF NOT EXISTS idx_job_notes_job_created ON public.job_notes USING btree (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_operations_job_part_id ON public.job_operations USING btree (job_part_id);
CREATE INDEX IF NOT EXISTS idx_job_ops_job ON public.job_operations USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_job_ops_routing_operation ON public.job_operations USING btree (routing_operation_id) WHERE (routing_operation_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_job_ops_status ON public.job_operations USING btree (status);
CREATE INDEX IF NOT EXISTS idx_job_ops_work_center ON public.job_operations USING btree (work_center_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_company_id ON public.job_parts USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_job_id ON public.job_parts USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_part_id ON public.job_parts USING btree (part_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_production_status ON public.job_parts USING btree (production_status);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON public.jobs USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON public.jobs USING btree (customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer_po_number ON public.jobs USING btree (company_id, customer_po_number) WHERE (customer_po_number IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_jobs_customer_po_number_trgm ON public.jobs USING gin (customer_po_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_fulfillment_status ON public.jobs USING btree (company_id, fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_jobs_invoicing_status ON public.jobs USING btree (company_id, invoicing_status);
CREATE INDEX IF NOT EXISTS idx_jobs_job_number_trgm ON public.jobs USING gin (job_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_production_status ON public.jobs USING btree (company_id, production_status);
CREATE INDEX IF NOT EXISTS idx_jobs_quote ON public.jobs USING btree (quote_id);
CREATE INDEX IF NOT EXISTS idx_part_attachments_part_created ON public.part_attachments USING btree (part_id, created_at DESC);
CREATE INDEX IF NOT EXISTS part_location_stock_company_idx ON public.part_location_stock USING btree (company_id);
CREATE INDEX IF NOT EXISTS part_location_stock_location_idx ON public.part_location_stock USING btree (location_id);
CREATE INDEX IF NOT EXISTS part_location_stock_part_idx ON public.part_location_stock USING btree (part_id);
CREATE INDEX IF NOT EXISTS idx_part_notes_part_created ON public.part_notes USING btree (part_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_part_pricing_tiers_company ON public.part_pricing_tiers USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_part_pricing_tiers_part ON public.part_pricing_tiers USING btree (part_id, sequence);
CREATE INDEX IF NOT EXISTS idx_procurement_tiers_expiring ON public.part_procurement_tiers USING btree (part_id, expires_at) WHERE (expires_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_procurement_tiers_part ON public.part_procurement_tiers USING btree (part_id);
CREATE UNIQUE INDEX IF NOT EXISTS part_procurement_tiers_part_id_min_quantity_key ON public.part_procurement_tiers USING btree (part_id, min_quantity);
CREATE INDEX IF NOT EXISTS idx_parts_company_id ON public.parts USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_parts_company_made ON public.parts USING btree (company_id) WHERE (source = 'made'::text);
CREATE INDEX IF NOT EXISTS idx_parts_company_stocked ON public.parts USING btree (company_id) WHERE is_stocked;
CREATE INDEX IF NOT EXISTS idx_parts_part_name ON public.parts USING btree (company_id, part_name);
CREATE INDEX IF NOT EXISTS idx_parts_part_name_trgm ON public.parts USING gin (part_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_parts_preferred_vendor ON public.parts USING btree (preferred_vendor_id) WHERE (preferred_vendor_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_parts_bom_child ON public.parts_bom USING btree (child_part_id);
CREATE INDEX IF NOT EXISTS idx_parts_bom_parent ON public.parts_bom USING btree (parent_part_id);
CREATE INDEX IF NOT EXISTS idx_parts_unit_conversions_part ON public.parts_unit_conversions USING btree (part_id);
CREATE INDEX IF NOT EXISTS idx_qb_ili_job_part ON public.quickbooks_invoice_line_items USING btree (job_part_id);
CREATE INDEX IF NOT EXISTS idx_qb_ili_link ON public.quickbooks_invoice_line_items USING btree (invoice_link_id);
CREATE INDEX IF NOT EXISTS idx_qb_invoice_links_job ON public.quickbooks_invoice_links USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_qb_invoice_links_job_status ON public.quickbooks_invoice_links USING btree (company_id, job_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qb_invoice_links_quote ON public.quickbooks_invoice_links USING btree (quote_id);
CREATE UNIQUE INDEX IF NOT EXISTS quickbooks_invoice_links_realm_request_key ON public.quickbooks_invoice_links USING btree (realm_id, qb_request_id);
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
CREATE INDEX IF NOT EXISTS idx_shipment_line_items_job_part ON public.shipment_line_items USING btree (job_part_id);
CREATE INDEX IF NOT EXISTS idx_shipment_line_items_shipment ON public.shipment_line_items USING btree (shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipments_company ON public.shipments USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_shipments_customer ON public.shipments USING btree (customer_id);
CREATE INDEX IF NOT EXISTS idx_shipments_job_id ON public.shipments USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_shipments_packing_slip ON public.shipments USING btree (company_id, packing_slip_number);
CREATE INDEX IF NOT EXISTS idx_shipments_packing_slip_trgm ON public.shipments USING gin (packing_slip_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_shipments_ship_date ON public.shipments USING btree (company_id, ship_date DESC);
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
CREATE OR REPLACE FUNCTION public._migrate_legacy_shipment_for_job(p_job_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_job record;
    v_shipment_id uuid;
    v_ps text;
    v_address_id uuid;
    v_format text;
    v_year int;
    v_current_year int;
    v_current_seq int;
BEGIN
    SELECT j.id, j.company_id, j.customer_id,
           COALESCE(j.completed_at::date, j.updated_at::date, current_date) AS ship_date
      INTO v_job
      FROM public.jobs j WHERE j.id = p_job_id;

    -- Address resolution: default_shipping → default_billing → sentinel.
    SELECT COALESCE(
        (SELECT a.id FROM public.customer_addresses a
          WHERE a.customer_id = v_job.customer_id AND a.default_shipping = true LIMIT 1),
        (SELECT a.id FROM public.customer_addresses a
          WHERE a.customer_id = v_job.customer_id AND a.default_billing = true LIMIT 1)
    ) INTO v_address_id;

    -- Mint the PS#. This function is invoked at migration time as the
    -- migration role (superuser/postgres), so the SECURITY DEFINER
    -- company-access guard inside next_packing_slip_number would block
    -- it. Inline a copy of the increment logic here — equivalent
    -- arithmetic, no auth check.
    v_year := EXTRACT(year FROM v_job.ship_date)::int;
    UPDATE public.companies
       SET packing_slip_next_seq = CASE
               WHEN packing_slip_seq_year = v_year THEN packing_slip_next_seq + 1
               ELSE 2
           END,
           packing_slip_seq_year = v_year,
           updated_at = now()
     WHERE id = v_job.company_id
    RETURNING packing_slip_seq_year, packing_slip_next_seq, packing_slip_number_format
        INTO v_current_year, v_current_seq, v_format;
    v_ps := public.format_packing_slip_number(v_format, v_year, v_current_seq - 1);

    INSERT INTO public.shipments (
        company_id, customer_id, shipping_address_id, one_time_address,
        packing_slip_number, ship_date, notes,
        created_by, created_at
    ) VALUES (
        v_job.company_id, v_job.customer_id,
        v_address_id,
        CASE WHEN v_address_id IS NULL
             THEN jsonb_build_object(
                'legacy', true,
                'note', 'Address unknown at migration time'
             )
             ELSE NULL END,
        v_ps, v_job.ship_date,
        'Legacy migration: historical shipment imported on schema migration',
        NULL, v_job.ship_date::timestamptz
    ) RETURNING id INTO v_shipment_id;

    INSERT INTO public.shipment_line_items (shipment_id, job_part_id, quantity)
    SELECT v_shipment_id, jp.id, jp.quantity
      FROM public.job_parts jp
     WHERE jp.job_id = p_job_id
       AND jp.fulfillment_status = 'fully_shipped'
       AND NOT EXISTS (
           SELECT 1 FROM public.shipment_line_items sli WHERE sli.job_part_id = jp.id
       );

    RETURN v_shipment_id;
END $function$

;

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

CREATE OR REPLACE FUNCTION public.add_stock_at_location(p_part_id uuid, p_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_tracked boolean;
    v_new_balance numeric; v_rollup numeric;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, is_location_tracked
      INTO v_company, v_item_name, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, p_converted_quantity)
    ON CONFLICT (part_id, location_id)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity
    RETURNING pls.quantity INTO v_new_balance;

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, notes, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_notes, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', v_new_balance, 'part_quantity', v_rollup);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.address_block_snapshot(p_address_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT jsonb_build_object(
           'address_line1', a.address_line1,
           'address_line2', a.address_line2,
           'city',          a.city,
           'state',         a.state,
           'postal_code',   a.postal_code,
           'country',       a.country,
           'attention_to',  a.attention_to
         )
    FROM public.customer_addresses a
   WHERE a.id = p_address_id;
$function$

;

CREATE OR REPLACE FUNCTION public.adjust_stock_at_location(p_part_id uuid, p_location_id uuid, p_new_quantity numeric, p_unit text, p_converted_new_quantity numeric, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_primary_unit text; v_tracked boolean;
    v_current numeric; v_diff numeric; v_rollup numeric; v_notes text;
BEGIN
    IF p_converted_new_quantity < 0 THEN
        RAISE EXCEPTION 'Quantity cannot be negative' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, primary_unit, is_location_tracked
      INTO v_company, v_item_name, v_primary_unit, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    SELECT quantity INTO v_current
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_location_id
       FOR UPDATE;
    v_current := COALESCE(v_current, 0);
    v_diff := p_converted_new_quantity - v_current;

    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, p_converted_new_quantity)
    ON CONFLICT (part_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;

    v_notes := COALESCE(
        p_notes,
        format('Adjusted from %s to %s %s', v_current, p_converted_new_quantity, v_primary_unit));

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, notes, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'adjustment', abs(v_diff), v_primary_unit, abs(v_diff),
         p_location_id, v_notes, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', p_converted_new_quantity, 'part_quantity', v_rollup);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.assert_invoice_not_over_ordered()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_ordered numeric;
    v_existing numeric;
BEGIN
    SELECT quantity INTO v_ordered FROM public.job_parts WHERE id = NEW.job_part_id;
    IF v_ordered IS NULL THEN
        RAISE EXCEPTION 'Job part % not found for invoice line', NEW.job_part_id;
    END IF;
    SELECT COALESCE(SUM(ili.quantity), 0) INTO v_existing
      FROM public.quickbooks_invoice_line_items ili
      JOIN public.quickbooks_invoice_links l ON l.id = ili.invoice_link_id
     WHERE ili.job_part_id = NEW.job_part_id
       AND ili.invoice_link_id <> NEW.invoice_link_id
       AND l.status = 'created'
       AND l.voided_at IS NULL;
    IF v_existing + NEW.quantity > v_ordered THEN
        RAISE EXCEPTION 'Cannot invoice % of job_part %: % ordered, % already invoiced',
            NEW.quantity, NEW.job_part_id, v_ordered, v_existing
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $function$

;

CREATE OR REPLACE FUNCTION public.auto_track_stocked_part()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_loc  uuid;
    v_flag boolean;
BEGIN
    -- Cheap exits first (no DB read): only stocked, not-yet-tracked parts.
    IF NEW.is_stocked IS NOT TRUE OR NEW.is_location_tracked IS TRUE THEN
        RETURN NULL;
    END IF;
    -- Only companies that use inventory locations.
    SELECT (settings->'features'->>'inventory_locations')::boolean INTO v_flag
      FROM public.companies WHERE id = NEW.company_id;
    IF COALESCE(v_flag, false) IS NOT TRUE THEN
        RETURN NULL;
    END IF;

    v_loc := public.inv_get_or_create_unassigned(NEW.company_id);

    UPDATE public.parts SET is_location_tracked = true WHERE id = NEW.id;

    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    VALUES (NEW.company_id, NEW.id, v_loc, NEW.quantity)
    ON CONFLICT (part_id, location_id) DO NOTHING;

    RETURN NULL; -- AFTER trigger
END;
$function$

;

CREATE OR REPLACE FUNCTION public.compute_job_fulfillment_status(p_job_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_total int;
    v_full int;
    v_partial int;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE fulfillment_status = 'fully_shipped'),
           count(*) FILTER (WHERE fulfillment_status = 'partially_shipped')
      INTO v_total, v_full, v_partial
      FROM public.job_parts WHERE job_id = p_job_id;

    IF v_total = 0 THEN RETURN 'unshipped'; END IF;
    IF v_full = v_total THEN RETURN 'fully_shipped'; END IF;
    IF v_full > 0 OR v_partial > 0 THEN RETURN 'partially_shipped'; END IF;
    RETURN 'unshipped';
END $function$

;

CREATE OR REPLACE FUNCTION public.compute_job_invoicing_status(p_job_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_total int;
    v_full int;
    v_partial int;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE invoicing_status = 'fully_invoiced'),
           count(*) FILTER (WHERE invoicing_status = 'partially_invoiced')
      INTO v_total, v_full, v_partial
      FROM public.job_parts WHERE job_id = p_job_id;

    IF v_total = 0 THEN RETURN 'uninvoiced'; END IF;
    IF v_full = v_total THEN RETURN 'fully_invoiced'; END IF;
    IF v_full > 0 OR v_partial > 0 THEN RETURN 'partially_invoiced'; END IF;
    RETURN 'uninvoiced';
END $function$

;

CREATE OR REPLACE FUNCTION public.compute_job_part_fulfillment_status(p_job_part_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_qty_ordered numeric;
    v_qty_shipped numeric;
BEGIN
    SELECT jp.quantity INTO v_qty_ordered
      FROM public.job_parts jp
     WHERE jp.id = p_job_part_id;
    IF v_qty_ordered IS NULL THEN
        RETURN 'unshipped';
    END IF;

    SELECT COALESCE(SUM(sli.quantity), 0) INTO v_qty_shipped
      FROM public.shipment_line_items sli
      JOIN public.shipments s ON s.id = sli.shipment_id
     WHERE sli.job_part_id = p_job_part_id
       AND s.voided_at IS NULL;

    IF v_qty_shipped <= 0 THEN
        RETURN 'unshipped';
    END IF;
    IF v_qty_shipped >= v_qty_ordered THEN
        RETURN 'fully_shipped';
    END IF;
    RETURN 'partially_shipped';
END $function$

;

CREATE OR REPLACE FUNCTION public.compute_job_part_invoicing_status(p_job_part_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_qty_ordered numeric;
    v_qty_invoiced numeric;
BEGIN
    SELECT jp.quantity INTO v_qty_ordered
      FROM public.job_parts jp
     WHERE jp.id = p_job_part_id;
    IF v_qty_ordered IS NULL THEN
        RETURN 'uninvoiced';
    END IF;

    SELECT COALESCE(SUM(ili.quantity), 0) INTO v_qty_invoiced
      FROM public.quickbooks_invoice_line_items ili
      JOIN public.quickbooks_invoice_links l ON l.id = ili.invoice_link_id
     WHERE ili.job_part_id = p_job_part_id
       AND l.status = 'created'
       AND l.voided_at IS NULL;

    IF v_qty_invoiced <= 0 THEN
        RETURN 'uninvoiced';
    END IF;
    IF v_qty_invoiced >= v_qty_ordered THEN
        RETURN 'fully_invoiced';
    END IF;
    RETURN 'partially_invoiced';
END $function$

;

CREATE OR REPLACE FUNCTION public.compute_job_production_status(p_job_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_total int;
    v_cancelled int;
    v_completed int;
    v_in_progress int;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE production_status = 'cancelled'),
           count(*) FILTER (WHERE production_status = 'completed'),
           count(*) FILTER (WHERE production_status = 'in_progress')
      INTO v_total, v_cancelled, v_completed, v_in_progress
      FROM public.job_parts WHERE job_id = p_job_id;

    IF v_total = 0 THEN RETURN 'not_started'; END IF;
    IF v_cancelled = v_total THEN RETURN 'cancelled'; END IF;
    -- All non-cancelled parts completed → completed
    IF v_completed = v_total - v_cancelled THEN RETURN 'completed'; END IF;
    IF v_in_progress > 0 OR v_completed > 0 THEN RETURN 'in_progress'; END IF;
    RETURN 'not_started';
END $function$

;

CREATE OR REPLACE FUNCTION public.compute_part_cost_at_qty(p_part_id uuid, p_qty numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_source text;
    v_part_name text;
    v_routing_id uuid;
    v_total numeric := 0;
    v_op RECORD;
    v_op_cost numeric;
    v_bom RECORD;
    v_to_primary_factor numeric;
    v_qty_in_primary_unit numeric;
    v_consumed numeric;
    v_child_val_qty numeric;
    v_pinned boolean;
    v_child_cost numeric;
    v_tier_cost numeric;
BEGIN
    IF p_qty IS NULL OR p_qty <= 0 THEN
        RAISE EXCEPTION 'compute_part_cost_at_qty: p_qty must be > 0 (got %)', p_qty
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT source, part_name
      INTO v_source, v_part_name
      FROM public.parts
     WHERE id = p_part_id;
    IF v_source IS NULL THEN
        RAISE EXCEPTION 'compute_part_cost_at_qty: part % not found', p_part_id;
    END IF;

    -- ---------- Bought parts: resolve to the part's own tier sheet ----------
    IF v_source = 'bought' THEN
        SELECT t.cost_per_unit
          INTO v_tier_cost
          FROM public.part_procurement_tiers t
         WHERE t.part_id = p_part_id
           AND t.min_quantity <= p_qty
           AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
         ORDER BY t.cost_per_unit ASC,
                  t.min_quantity DESC
         LIMIT 1;
        -- Below every break: floor to the lowest-min tier (smallest pack you can
        -- buy) so the part is still costable, rather than returning NULL.
        IF v_tier_cost IS NULL THEN
            SELECT t.cost_per_unit
              INTO v_tier_cost
              FROM public.part_procurement_tiers t
             WHERE t.part_id = p_part_id
               AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
             ORDER BY t.min_quantity ASC,
                      t.cost_per_unit ASC
             LIMIT 1;
        END IF;
        RETURN v_tier_cost;
    END IF;

    -- ---------- Made parts: own routing + BOM rollup ----------
    SELECT id INTO v_routing_id FROM public.routings WHERE part_id = p_part_id;

    IF v_routing_id IS NOT NULL THEN
        FOR v_op IN
            SELECT ro.setup_minutes,
                   ro.cycle_minutes_per_unit,
                   ro.labor_rate_override,
                   ro.external_unit_price,
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
                        v_part_name
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := (COALESCE(v_op.setup_minutes, 0) / p_qty
                              + COALESCE(v_op.cycle_minutes_per_unit, 0))
                             * COALESCE(v_op.labor_rate_override, v_op.wc_labor_rate)
                             / 60.0;
            ELSE
                IF v_op.external_unit_price IS NULL THEN
                    RAISE EXCEPTION
                        'Cannot compute cost for part %: external routing op has no unit price (external_unit_price is required)',
                        v_part_name
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := COALESCE(v_op.external_unit_price, 0);
            END IF;
            v_total := v_total + v_op_cost;
        END LOOP;
    END IF;

    FOR v_bom IN
        SELECT b.quantity,
               b.unit,
               b.child_part_id,
               b.consume_whole_units,
               c.primary_unit          AS child_primary_unit,
               c.part_name             AS child_part_name,
               c.source                AS child_source,
               c.costing_batch_quantity AS child_costing_batch_quantity
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
                    v_bom.unit, v_bom.child_primary_unit, v_bom.child_part_name
                    USING ERRCODE = 'check_violation';
            END IF;
            v_qty_in_primary_unit := v_bom.quantity * v_to_primary_factor;
        ELSE
            v_qty_in_primary_unit := v_bom.quantity;
        END IF;

        -- Units of the child physically consumed across the parent batch of
        -- p_qty. Whole-unit lines ceiling to discrete stock; fractional lines
        -- are exact.
        IF v_bom.consume_whole_units THEN
            v_consumed := ceil(p_qty * v_qty_in_primary_unit);
        ELSE
            v_consumed := p_qty * v_qty_in_primary_unit;
        END IF;

        -- A MADE child is valued at its standard costing lot size (setup
        -- amortized over the run it's produced in), fixed regardless of how many
        -- this order draws. A BOUGHT child is valued at what we actually consume
        -- (to hit the right procurement tier / floor).
        v_pinned := (v_bom.child_source = 'made');
        IF v_pinned THEN
            v_child_val_qty := v_bom.child_costing_batch_quantity;
        ELSE
            v_child_val_qty := v_consumed;
        END IF;

        v_child_cost := public.compute_part_cost_at_qty(
            v_bom.child_part_id,
            v_child_val_qty
        );

        IF v_child_cost IS NULL THEN
            RETURN NULL;
        END IF;

        IF NOT v_bom.consume_whole_units AND NOT v_pinned THEN
            -- Bought child, fractional consumption — textually identical to the
            -- pre-feature expression so those lines stay byte-for-byte the same.
            v_total := v_total + v_qty_in_primary_unit * v_child_cost;
        ELSE
            -- Made (lot-size valuation) and/or whole-unit ceiling: per parent
            -- unit = consumed units × unit cost, spread across the p_qty units.
            v_total := v_total + (v_consumed * v_child_cost) / p_qty;
        END IF;
    END LOOP;

    RETURN v_total;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.compute_part_cost_explain(p_part_id uuid, p_qty numeric)
 RETURNS TABLE(unit_cost numeric, missing_leaves jsonb, missing_markups jsonb, missing_op_rates jsonb, is_priceable boolean)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_missing_leaves   jsonb;
    v_missing_markups  jsonb;
    v_missing_op_rates jsonb;
    v_unit_cost        numeric;
BEGIN
    WITH RECURSIVE tree(part_id, part_name, source, cumulative_qty, depth) AS (
        SELECT p.id, p.part_name, p.source, p_qty, 0
          FROM public.parts p
         WHERE p.id = p_part_id

        UNION ALL

        SELECT c.id,
               c.part_name,
               c.source,
               CASE
                   -- Made child: value its subtree at its standard costing lot
                   -- size (fixed, not the cascaded consumed qty).
                   WHEN c.source = 'made' THEN
                       c.costing_batch_quantity
                   -- Bought whole-unit line: ceiling the cascaded consumption.
                   WHEN b.consume_whole_units THEN
                       ceil(
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
                           END
                       )
                   -- Bought fractional cascade.
                   ELSE
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
                       END
               END,
               t.depth + 1
          FROM tree t
          JOIN public.parts_bom b ON b.parent_part_id = t.part_id
          JOIN public.parts c     ON c.id = b.child_part_id
         WHERE t.source = 'made'
           AND t.depth < 50
    ),
    -- A bought leaf is "missing" only if it has NO non-expired procurement tier.
    leaves AS (
        SELECT tr.part_id, tr.part_name, tr.depth, tr.cumulative_qty AS qty_required
          FROM tree tr
         WHERE tr.source = 'bought'
           AND NOT EXISTS (
                   SELECT 1
                     FROM public.part_procurement_tiers t
                    WHERE t.part_id = tr.part_id
                      AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
               )
    ),
    -- Only the ROOT part (depth 0 = the part being quoted) needs a markup. A
    -- material's markup is never used inside a parent, so descendants are not
    -- flagged.
    markups AS (
        SELECT tr.part_id, tr.part_name, tr.source, MIN(tr.depth) AS depth
          FROM tree tr
         WHERE tr.depth = 0
           AND NOT EXISTS (
                   SELECT 1 FROM public.part_pricing_tiers pt
                    WHERE pt.part_id = tr.part_id
                      AND pt.markup_percent IS NOT NULL
               )
         GROUP BY tr.part_id, tr.part_name, tr.source
    ),
    op_rates AS (
        SELECT tr.part_id, tr.part_name, MIN(tr.depth) AS depth
          FROM tree tr
          JOIN public.routings r            ON r.part_id = tr.part_id
          JOIN public.routing_operations ro ON ro.routing_id = r.id
          JOIN public.work_centers wc       ON wc.id = ro.work_center_id
         WHERE tr.source = 'made'
           AND (
               (wc.kind = 'internal'
                   AND ro.labor_rate_override IS NULL
                   AND wc.labor_rate IS NULL)
               OR
               (wc.kind <> 'internal'
                   AND ro.external_unit_price IS NULL)
           )
         GROUP BY tr.part_id, tr.part_name
    )
    SELECT
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',      l.part_id,
                            'part_name',    l.part_name,
                            'depth',        l.depth,
                            'qty_required', l.qty_required
                        )
                        ORDER BY l.depth DESC, l.part_name ASC
                    ), '[]'::jsonb)
           FROM leaves l),
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',   m.part_id,
                            'part_name', m.part_name,
                            'depth',     m.depth,
                            'source',    m.source
                        )
                        ORDER BY m.depth ASC, m.part_name ASC
                    ), '[]'::jsonb)
           FROM markups m),
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',   o.part_id,
                            'part_name', o.part_name,
                            'depth',     o.depth
                        )
                        ORDER BY o.depth ASC, o.part_name ASC
                    ), '[]'::jsonb)
           FROM op_rates o)
      INTO v_missing_leaves, v_missing_markups, v_missing_op_rates;

    BEGIN
        v_unit_cost := public.compute_part_cost_at_qty(p_part_id, p_qty);
    EXCEPTION WHEN OTHERS THEN
        v_unit_cost := NULL;
    END;

    unit_cost        := v_unit_cost;
    missing_leaves   := v_missing_leaves;
    missing_markups  := v_missing_markups;
    missing_op_rates := v_missing_op_rates;
    is_priceable     := (v_missing_leaves = '[]'::jsonb
                         AND v_missing_markups = '[]'::jsonb
                         AND v_missing_op_rates = '[]'::jsonb);
    RETURN NEXT;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.contact_block_snapshot(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT jsonb_build_object(
           'name',  c.name,
           'email', c.email,
           'phone', c.phone
         )
    FROM public.customer_contacts c
   WHERE c.id = p_contact_id;
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

CREATE OR REPLACE FUNCTION public.create_shipment_with_line_items(p_company_id uuid, p_customer_id uuid, p_shipping_address_id uuid, p_one_time_address jsonb, p_ship_date date, p_carrier text, p_shipping_method text, p_line_items jsonb, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_packing_slip text;
    v_shipment_id uuid;
    v_user_id uuid := auth.uid();
    v_item jsonb;
    v_pre_status jsonb := '{}'::jsonb;
    v_job_ids uuid[];
    v_job_id uuid;
    v_job_number text;
    v_base text;
    v_seq int;
    r record;
BEGIN
    IF NOT (p_company_id IN (SELECT get_user_company_ids())) THEN
        RAISE EXCEPTION 'create_shipment_with_line_items: caller does not have access to company %',
            p_company_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 1. Resolve the job(s) behind the line items. A packing slip belongs to
    --    exactly one job — reject empty or multi-job inputs.
    SELECT array_agg(DISTINCT jp.job_id)
      INTO v_job_ids
      FROM public.job_parts jp
     WHERE jp.id IN (
        SELECT (item->>'job_part_id')::uuid
          FROM jsonb_array_elements(p_line_items) AS item
     );

    IF v_job_ids IS NULL OR array_length(v_job_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'create_shipment_with_line_items: no job parts resolved from line items';
    END IF;
    IF array_length(v_job_ids, 1) > 1 THEN
        RAISE EXCEPTION 'create_shipment_with_line_items: a packing slip must belong to a single job (got % jobs)',
            array_length(v_job_ids, 1);
    END IF;
    v_job_id := v_job_ids[1];

    -- 2. Lock the job so the per-job packing-slip sequence is collision-free
    --    under concurrent callers. Released at COMMIT/ROLLBACK.
    PERFORM pg_advisory_xact_lock(hashtext('job:' || v_job_id::text));

    -- 3. Snapshot pre-cascade fulfillment_status for the audit row.
    SELECT COALESCE(jsonb_object_agg(j.id::text, j.fulfillment_status), '{}'::jsonb)
      INTO v_pre_status
      FROM public.jobs j
     WHERE j.id = v_job_id;

    -- 4. Mint the job-derived packing-slip number: PS-{jobBase}-{n}, n from 1.
    --    jobBase strips the alpha prefix off job_number (J-0141 -> 0141).
    SELECT j.job_number INTO v_job_number FROM public.jobs j WHERE j.id = v_job_id;
    v_base := regexp_replace(v_job_number, '^[A-Za-z]+-?', '');
    SELECT count(*) + 1 INTO v_seq FROM public.shipments WHERE job_id = v_job_id;
    v_packing_slip := 'PS-' || v_base || '-' || v_seq::text;

    -- 5. Insert shipment + line items. Triggers cascade fulfillment_status.
    INSERT INTO public.shipments (
        company_id, customer_id, shipping_address_id, one_time_address,
        packing_slip_number, ship_date, job_id, carrier, shipping_method,
        created_by
    ) VALUES (
        p_company_id, p_customer_id, p_shipping_address_id, p_one_time_address,
        v_packing_slip, COALESCE(p_ship_date, current_date), v_job_id, p_carrier, p_shipping_method,
        v_user_id
    ) RETURNING id INTO v_shipment_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_line_items) LOOP
        INSERT INTO public.shipment_line_items (shipment_id, job_part_id, quantity)
        VALUES (
            v_shipment_id,
            (v_item->>'job_part_id')::uuid,
            (v_item->>'quantity')::numeric
        );
    END LOOP;

    -- 6. Audit the job iff it crossed forward into fully_shipped.
    FOR r IN
        SELECT j.id AS job_id, j.fulfillment_status AS new_status,
               v_pre_status->>(j.id::text) AS old_status
          FROM public.jobs j
         WHERE j.id::text IN (SELECT jsonb_object_keys(v_pre_status))
    LOOP
        IF r.new_status = 'fully_shipped'
           AND r.old_status IS DISTINCT FROM 'fully_shipped' THEN
            INSERT INTO public.job_fulfillment_audit (
                job_id, company_id, from_status, to_status,
                triggering_shipment_id, triggering_user_id
            ) VALUES (
                r.job_id, p_company_id, r.old_status, r.new_status,
                v_shipment_id, v_user_id
            );
        END IF;
    END LOOP;

    RETURN v_shipment_id;
END $function$

;

CREATE OR REPLACE FUNCTION public.delete_location(p_location_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid;
    v_guard   integer := 0;
BEGIN
    SELECT company_id INTO v_company FROM public.inventory_locations WHERE id = p_location_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'location % not found', p_location_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Refuse only if any location in the subtree still holds stock.
    IF EXISTS (
        WITH RECURSIVE sub AS (
            SELECT id FROM public.inventory_locations WHERE id = p_location_id
            UNION ALL
            SELECT l.id FROM public.inventory_locations l JOIN sub s ON l.parent_id = s.id
        )
        SELECT 1
          FROM public.part_location_stock pls
          JOIN sub ON pls.location_id = sub.id
         WHERE pls.quantity > 0
    ) THEN
        RAISE EXCEPTION 'location subtree still holds stock' USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Drop leftover zero-qty balance rows across the subtree (clients can't —
    -- part_location_stock is SELECT-only). part_location_stock.location_id is
    -- ON DELETE RESTRICT, so these must go before their locations.
    DELETE FROM public.part_location_stock
     WHERE location_id IN (
        WITH RECURSIVE sub AS (
            SELECT id FROM public.inventory_locations WHERE id = p_location_id
            UNION ALL
            SELECT l.id FROM public.inventory_locations l JOIN sub s ON l.parent_id = s.id
        )
        SELECT id FROM sub
     );

    -- Delete the subtree bottom-up. inventory_locations.parent_id is ON DELETE
    -- RESTRICT, so a parent can't be removed while children exist; repeatedly
    -- delete the current leaves of the subtree until the target is gone.
    LOOP
        v_guard := v_guard + 1;
        IF v_guard > 1000 THEN
            RAISE EXCEPTION 'delete_location: subtree too deep or cyclic for %', p_location_id;
        END IF;

        DELETE FROM public.inventory_locations loc
         WHERE loc.id IN (
            WITH RECURSIVE sub AS (
                SELECT id FROM public.inventory_locations WHERE id = p_location_id
                UNION ALL
                SELECT l.id FROM public.inventory_locations l JOIN sub s ON l.parent_id = s.id
            )
            SELECT s.id
              FROM sub s
             WHERE NOT EXISTS (
                SELECT 1 FROM public.inventory_locations c WHERE c.parent_id = s.id
             )
         );

        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.inventory_locations WHERE id = p_location_id);
    END LOOP;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.deplete_stock_at_location(p_part_id uuid, p_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, p_graceful boolean DEFAULT false, p_notes text DEFAULT NULL::text, p_job_id uuid DEFAULT NULL::uuid, p_job_operation_id uuid DEFAULT NULL::uuid, p_operator_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_primary_unit text; v_tracked boolean;
    v_current numeric; v_new numeric; v_rollup numeric;
    v_discrepancy boolean := false; v_shortfall numeric := 0;
    v_notes text; v_disc_note text;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, primary_unit, is_location_tracked
      INTO v_company, v_item_name, v_primary_unit, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    -- Lock the balance row (treat a missing row as 0 on hand).
    SELECT quantity INTO v_current
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_location_id
       FOR UPDATE;
    v_current := COALESCE(v_current, 0);

    v_new := v_current - p_converted_quantity;
    v_notes := p_notes;

    IF v_new < 0 THEN
        IF p_graceful THEN
            v_shortfall := p_converted_quantity - v_current;
            v_new := 0;
            v_discrepancy := true;
            v_disc_note := format(
                '[DISCREPANCY: Confirmed %s %s, but only %s %s was available. Shortfall: %s %s]',
                p_converted_quantity, v_primary_unit, v_current, v_primary_unit, v_shortfall, v_primary_unit);
            v_notes := CASE WHEN v_notes IS NULL OR v_notes = '' THEN v_disc_note
                            ELSE v_notes || ' ' || v_disc_note END;
        ELSE
            RAISE EXCEPTION 'Insufficient stock at location (have %, need %)', v_current, p_converted_quantity
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, v_new)
    ON CONFLICT (part_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, job_id, job_operation_id, operator_id, notes, has_discrepancy, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'depletion', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_job_id, p_job_operation_id, p_operator_id, v_notes, v_discrepancy, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object(
        'location_balance', v_new, 'part_quantity', v_rollup,
        'has_discrepancy', v_discrepancy, 'shortfall', v_shortfall);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.disable_location_tracking(p_part_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_tracked boolean; v_total numeric;
BEGIN
    SELECT company_id, is_location_tracked
      INTO v_company, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT v_tracked THEN
        RETURN jsonb_build_object('part_quantity',
            (SELECT quantity FROM public.parts WHERE id = p_part_id), 'tracked', false, 'noop', true);
    END IF;

    v_total := COALESCE(
        (SELECT SUM(quantity) FROM public.part_location_stock WHERE part_id = p_part_id), 0);

    -- Flip the flag FIRST (so the subsequent DELETE's rollup is a no-op) and set
    -- the collapsed total in the same statement (allowed: tracked is now false).
    UPDATE public.parts
       SET is_location_tracked = false, quantity = v_total, updated_at = now()
     WHERE id = p_part_id;

    DELETE FROM public.part_location_stock WHERE part_id = p_part_id;

    RETURN jsonb_build_object('part_quantity', v_total, 'tracked', false);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.enable_location_tracking(p_part_id uuid, p_initial_location_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_qty numeric; v_tracked boolean; v_loc uuid; v_rollup numeric;
BEGIN
    SELECT company_id, quantity, is_location_tracked
      INTO v_company, v_qty, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Idempotent: already tracked -> no-op.
    IF v_tracked THEN
        SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
        RETURN jsonb_build_object('part_quantity', v_rollup, 'tracked', true, 'noop', true);
    END IF;

    -- Resolve the backfill location: caller-chosen, else find-or-create "Unassigned".
    IF p_initial_location_id IS NOT NULL THEN
        PERFORM public.inv_assert_location_in_company(p_initial_location_id, v_company);
        v_loc := p_initial_location_id;
    ELSE
        PERFORM pg_advisory_xact_lock(hashtext('inv_unassigned:' || v_company::text));
        SELECT id INTO v_loc
          FROM public.inventory_locations
         WHERE company_id = v_company AND name = 'Unassigned';
        IF v_loc IS NULL THEN
            INSERT INTO public.inventory_locations (company_id, name, kind)
            VALUES (v_company, 'Unassigned', 'system')
            RETURNING id INTO v_loc;
        END IF;
    END IF;

    -- Flip the flag FIRST (quantity unchanged -> guard skipped), THEN seed the
    -- backfill balance equal to the pre-existing quantity so the rollup overwrites
    -- parts.quantity with the same SUM. Never let a standalone value coexist.
    UPDATE public.parts SET is_location_tracked = true, updated_at = now() WHERE id = p_part_id;

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, v_loc, v_qty)
    ON CONFLICT (part_id, location_id)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity;

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_id', v_loc, 'part_quantity', v_rollup, 'tracked', true);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.enable_location_tracking_for_company(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_loc   uuid;
    v_count integer;
BEGIN
    v_loc := public.inv_get_or_create_unassigned(p_company_id);

    -- Flip stocked+untracked parts to tracked (quantity unchanged -> guard skips)
    -- and seed each one's whole quantity at "Unassigned" in the same statement,
    -- scoped to ONLY the parts just flipped (so already-tracked parts are untouched).
    WITH flipped AS (
        UPDATE public.parts
           SET is_location_tracked = true, updated_at = now()
         WHERE company_id = p_company_id AND is_stocked AND NOT is_location_tracked
        RETURNING id, company_id, quantity
    )
    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    SELECT company_id, id, v_loc, quantity FROM flipped
    ON CONFLICT (part_id, location_id) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN jsonb_build_object('location_id', v_loc, 'parts_tracked', v_count);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.enforce_job_address_contact_customer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.billing_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.billing_address_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'jobs.billing_address_id % does not belong to customer %',
                NEW.billing_address_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.shipping_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.shipping_address_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'jobs.shipping_address_id % does not belong to customer %',
                NEW.shipping_address_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_contacts
         WHERE id = NEW.contact_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'jobs.contact_id % does not belong to customer %',
                NEW.contact_id, NEW.customer_id;
        END IF;
    END IF;
    RETURN NEW;
END $function$

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

CREATE OR REPLACE FUNCTION public.enforce_quote_address_contact_customer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.billing_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.billing_address_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'quotes.billing_address_id % does not belong to customer %',
                NEW.billing_address_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.shipping_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.shipping_address_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'quotes.shipping_address_id % does not belong to customer %',
                NEW.shipping_address_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_contacts
         WHERE id = NEW.contact_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'quotes.contact_id % does not belong to customer %',
                NEW.contact_id, NEW.customer_id;
        END IF;
    END IF;
    RETURN NEW;
END $function$

;

CREATE OR REPLACE FUNCTION public.enforce_shipment_address_contact_customer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.shipping_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.shipping_address_id
           AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'shipping_address_id % does not belong to customer %',
                NEW.shipping_address_id, NEW.customer_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;
    RETURN NEW;
END $function$

;

CREATE OR REPLACE FUNCTION public.enforce_shipment_customer_id_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
        RAISE EXCEPTION
            'shipments.customer_id is immutable after insert '
            '(attempted to change shipment % from customer % to %)',
            OLD.id, OLD.customer_id, NEW.customer_id
            USING ERRCODE = 'check_violation',
                  HINT = 'Void and recreate the shipment for the correct customer.';
    END IF;
    RETURN NEW;
END $function$

;

CREATE OR REPLACE FUNCTION public.enforce_shipment_line_item_customer_consistency()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_shipment_customer_id uuid;
    v_line_customer_id uuid;
BEGIN
    SELECT customer_id INTO v_shipment_customer_id
      FROM public.shipments
     WHERE id = NEW.shipment_id;

    IF v_shipment_customer_id IS NULL THEN
        -- Parent shipment vanished (or wasn't visible) between row
        -- staging and the BEFORE-row firing. The FK on shipment_id with
        -- ON DELETE CASCADE handles the visible cases; raise here to
        -- surface anything weirder.
        RAISE EXCEPTION 'shipment_line_items.shipment_id % has no parent shipment',
            NEW.shipment_id USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT j.customer_id INTO v_line_customer_id
      FROM public.job_parts jp
      JOIN public.jobs j ON j.id = jp.job_id
     WHERE jp.id = NEW.job_part_id;

    IF v_line_customer_id IS NULL THEN
        RAISE EXCEPTION 'shipment_line_items.job_part_id % does not resolve to a job/customer',
            NEW.job_part_id USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_line_customer_id IS DISTINCT FROM v_shipment_customer_id THEN
        RAISE EXCEPTION
            'shipment_line_items.job_part_id % belongs to customer %, '
            'but parent shipment % is for customer %',
            NEW.job_part_id, v_line_customer_id,
            NEW.shipment_id, v_shipment_customer_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $function$

;

CREATE OR REPLACE FUNCTION public.enforce_tracked_part_quantity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_expected numeric;
BEGIN
    IF NEW.is_location_tracked AND NEW.quantity IS DISTINCT FROM OLD.quantity THEN
        v_expected := COALESCE(
            (SELECT SUM(quantity) FROM public.part_location_stock WHERE part_id = NEW.id),
            0);

        IF NEW.quantity IS DISTINCT FROM v_expected THEN
            RAISE EXCEPTION 'parts.quantity for location-tracked part % is maintained from part_location_stock; direct quantity writes are not allowed (attempted %, expected %)',
                NEW.id, NEW.quantity, v_expected
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.generate_direct_job_number(company_uuid uuid)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN 'J-' || LPAD(public.next_order_number(company_uuid)::text, 4, '0');
END;
$function$

;

CREATE OR REPLACE FUNCTION public.generate_quote_number(company_uuid uuid)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN 'Q-' || LPAD(public.next_order_number(company_uuid)::text, 4, '0');
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

CREATE OR REPLACE FUNCTION public.get_priceable_part_ids(p_company_id uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_costable uuid[];
    v_priceable uuid[];
    v_new uuid[];
BEGIN
    -- COSTABLE — a part whose cost resolves. Markup is NOT required here: a
    -- material's markup is never used when consumed in a parent. Base case:
    -- bought parts with a non-expired procurement tier.
    SELECT COALESCE(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
    INTO v_costable
    FROM public.parts p
    WHERE p.company_id = p_company_id
      AND p.source = 'bought'
      AND EXISTS (
          SELECT 1
          FROM public.part_procurement_tiers pt
          WHERE pt.part_id = p.id
            AND (pt.expires_at IS NULL OR pt.expires_at >= CURRENT_DATE)
      );

    -- Fixed-point: add made parts whose routing is complete and whose BOM
    -- children (if any) are all already costable. Bounded by BOM depth.
    LOOP
        SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
        INTO v_new
        FROM public.parts p
        WHERE p.company_id = p_company_id
          AND p.source = 'made'
          AND NOT (p.id = ANY(v_costable))
          -- Every routing op (if any) must have full pricing.
          AND NOT EXISTS (
              SELECT 1
              FROM public.routings r
              JOIN public.routing_operations ro ON ro.routing_id = r.id
              JOIN public.work_centers wc ON wc.id = ro.work_center_id
              WHERE r.part_id = p.id
                AND (
                    (wc.kind = 'internal'
                        AND ro.labor_rate_override IS NULL
                        AND wc.labor_rate IS NULL)
                    OR
                    (wc.kind <> 'internal'
                        AND ro.external_unit_price IS NULL)
                )
          )
          -- Every BOM child must already be costable.
          AND NOT EXISTS (
              SELECT 1
              FROM public.parts_bom b
              WHERE b.parent_part_id = p.id
                AND NOT (b.child_part_id = ANY(v_costable))
          );

        EXIT WHEN cardinality(v_new) = 0;
        v_costable := v_costable || v_new;
    END LOOP;

    -- PRICEABLE = costable AND has its own non-null-markup pricing tier. Only the
    -- part being sold needs a markup; its materials just need to be costable.
    SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
    INTO v_priceable
    FROM public.parts p
    WHERE p.id = ANY(v_costable)
      AND EXISTS (
          SELECT 1
          FROM public.part_pricing_tiers t
          WHERE t.part_id = p.id
            AND t.markup_percent IS NOT NULL
      );

    RETURN v_priceable;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_procurement_cost(p_part_id uuid, p_qty numeric)
 RETURNS TABLE(unit_cost numeric, vendor_id uuid, tier_id uuid, source text)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_preferred_vendor_id uuid;
    v_tier RECORD;
BEGIN
    SELECT preferred_vendor_id INTO v_preferred_vendor_id
      FROM public.parts WHERE id = p_part_id;

    -- Cheapest non-expired tier on the part's own sheet where min_quantity <=
    -- p_qty. Vendor no longer gates cost; the returned vendor_id is the part's
    -- preferred-vendor label.
    SELECT t.id, t.cost_per_unit
      INTO v_tier
      FROM public.part_procurement_tiers t
     WHERE t.part_id = p_part_id
       AND t.min_quantity <= p_qty
       AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
     ORDER BY t.cost_per_unit ASC,
              t.min_quantity DESC
     LIMIT 1;

    IF FOUND THEN
        unit_cost := v_tier.cost_per_unit;
        vendor_id := v_preferred_vendor_id;
        tier_id   := v_tier.id;
        source    := 'tier';
        RETURN NEXT;
    END IF;
    -- No row when no tier covers p_qty.
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
                AND prev.status <> 'completed'
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
 RETURNS TABLE(job_id uuid, job_part_id uuid, job_operation_id uuid, operation_name text, op_status text, job_number text, part_id uuid, part_name text, part_description text, part_quantity numeric)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH eligible_jobs AS (
        SELECT j.id, j.job_number FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.production_status IN ('not_started', 'in_progress')  -- was j.status (nonexistent column)
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
                 AND prev.status <> 'completed'
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

CREATE OR REPLACE FUNCTION public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_extract_query_trgm$function$

;

CREATE OR REPLACE FUNCTION public.gin_extract_value_trgm(text, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_extract_value_trgm$function$

;

CREATE OR REPLACE FUNCTION public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_trgm_consistent$function$

;

CREATE OR REPLACE FUNCTION public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal)
 RETURNS "char"
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_trgm_triconsistent$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_compress$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_consistent(internal, text, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_consistent$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_decompress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_decompress$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_distance(internal, text, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_distance$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_in(cstring)
 RETURNS gtrgm
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_in$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_options(internal)
 RETURNS void
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE
AS '$libdir/pg_trgm', $function$gtrgm_options$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_out(gtrgm)
 RETURNS cstring
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_out$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_penalty$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_picksplit$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_same(gtrgm, gtrgm, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_same$function$

;

CREATE OR REPLACE FUNCTION public.gtrgm_union(internal, internal)
 RETURNS gtrgm
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_union$function$

;

CREATE OR REPLACE FUNCTION public.inv_assert_location_in_company(p_location_id uuid, p_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF p_location_id IS NULL THEN
        RAISE EXCEPTION 'location_id is required' USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.inventory_locations
         WHERE id = p_location_id AND company_id = p_company_id
    ) THEN
        RAISE EXCEPTION 'location % is not in company %', p_location_id, p_company_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.inv_get_or_create_unassigned(p_company_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_loc uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('inv_unassigned:' || p_company_id::text));
    SELECT id INTO v_loc
      FROM public.inventory_locations
     WHERE company_id = p_company_id AND name = 'Unassigned';
    IF v_loc IS NULL THEN
        INSERT INTO public.inventory_locations (company_id, name, kind)
        VALUES (p_company_id, 'Unassigned', 'system')
        RETURNING id INTO v_loc;
    END IF;
    RETURN v_loc;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.inv_location_path_label(p_location_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE chain AS (
    SELECT id, parent_id, name, 0 AS depth
      FROM public.inventory_locations WHERE id = p_location_id
    UNION ALL
    SELECT l.id, l.parent_id, l.name, c.depth + 1
      FROM public.inventory_locations l JOIN chain c ON l.id = c.parent_id
  )
  SELECT string_agg(name, ' › ' ORDER BY depth DESC) FROM chain;
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

CREATE OR REPLACE FUNCTION public.job_last_ship_date(p_job_id uuid)
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT MAX(s.ship_date)
      FROM public.shipments s
      JOIN public.shipment_line_items sli ON sli.shipment_id = s.id
      JOIN public.job_parts jp ON jp.id = sli.job_part_id
     WHERE s.voided_at IS NULL
       AND jp.job_id = p_job_id;
$function$

;

CREATE OR REPLACE FUNCTION public.job_part_last_ship_date(p_job_part_id uuid)
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT MAX(s.ship_date)
      FROM public.shipments s
      JOIN public.shipment_line_items sli ON sli.shipment_id = s.id
     WHERE s.voided_at IS NULL
       AND sli.job_part_id = p_job_part_id;
$function$

;

CREATE OR REPLACE FUNCTION public.next_order_number(company_uuid uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result integer;
BEGIN
  INSERT INTO public.company_order_counters (company_id, next_number)
  VALUES (company_uuid, 2)
  ON CONFLICT (company_id) DO UPDATE
    SET next_number = public.company_order_counters.next_number + 1,
        updated_at = now()
  RETURNING next_number - 1 INTO result;
  RETURN result;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.recompute_job_part_fulfillment_from_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_jp_id uuid;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_jp_id := COALESCE(NEW.job_part_id, OLD.job_part_id);
    v_new := public.compute_job_part_fulfillment_status(v_jp_id);
    SELECT fulfillment_status INTO v_old
      FROM public.job_parts WHERE id = v_jp_id;
    IF v_new IS DISTINCT FROM v_old THEN
        UPDATE public.job_parts
           SET fulfillment_status = v_new,
               updated_at = now()
         WHERE id = v_jp_id;
    END IF;
    RETURN NULL;
END $function$

;

CREATE OR REPLACE FUNCTION public.recompute_job_part_fulfillment_from_qty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_new text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    -- AFTER trigger: compute_* re-reads job_parts.quantity, which already
    -- holds the new value at this point, so it resolves against NEW.quantity.
    v_new := public.compute_job_part_fulfillment_status(NEW.id);
    IF v_new IS DISTINCT FROM NEW.fulfillment_status THEN
        UPDATE public.job_parts
           SET fulfillment_status = v_new,
               updated_at = now()
         WHERE id = NEW.id;
    END IF;
    RETURN NULL;
END $function$

;

CREATE OR REPLACE FUNCTION public.recompute_job_part_fulfillment_from_void()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    r record;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    IF NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at THEN RETURN NULL; END IF;
    FOR r IN
        SELECT DISTINCT sli.job_part_id
          FROM public.shipment_line_items sli
         WHERE sli.shipment_id = NEW.id
    LOOP
        v_new := public.compute_job_part_fulfillment_status(r.job_part_id);
        SELECT fulfillment_status INTO v_old
          FROM public.job_parts WHERE id = r.job_part_id;
        IF v_new IS DISTINCT FROM v_old THEN
            UPDATE public.job_parts
               SET fulfillment_status = v_new,
                   updated_at = now()
             WHERE id = r.job_part_id;
        END IF;
    END LOOP;
    RETURN NULL;
END $function$

;

CREATE OR REPLACE FUNCTION public.recompute_job_part_invoicing_from_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_jp_id uuid;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_jp_id := COALESCE(NEW.job_part_id, OLD.job_part_id);
    v_new := public.compute_job_part_invoicing_status(v_jp_id);
    SELECT invoicing_status INTO v_old FROM public.job_parts WHERE id = v_jp_id;
    IF v_new IS DISTINCT FROM v_old THEN
        UPDATE public.job_parts SET invoicing_status = v_new, updated_at = now() WHERE id = v_jp_id;
    END IF;
    RETURN NULL;
END $function$

;

CREATE OR REPLACE FUNCTION public.recompute_job_part_invoicing_from_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    r record;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at THEN
        RETURN NULL;
    END IF;
    FOR r IN
        SELECT DISTINCT ili.job_part_id
          FROM public.quickbooks_invoice_line_items ili
         WHERE ili.invoice_link_id = NEW.id
    LOOP
        v_new := public.compute_job_part_invoicing_status(r.job_part_id);
        SELECT invoicing_status INTO v_old FROM public.job_parts WHERE id = r.job_part_id;
        IF v_new IS DISTINCT FROM v_old THEN
            UPDATE public.job_parts SET invoicing_status = v_new, updated_at = now() WHERE id = r.job_part_id;
        END IF;
    END LOOP;
    RETURN NULL;
END $function$

;

CREATE OR REPLACE FUNCTION public.recompute_job_part_invoicing_from_qty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_new text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_new := public.compute_job_part_invoicing_status(NEW.id);
    IF v_new IS DISTINCT FROM NEW.invoicing_status THEN
        UPDATE public.job_parts SET invoicing_status = v_new, updated_at = now() WHERE id = NEW.id;
    END IF;
    RETURN NULL;
END $function$

;

CREATE OR REPLACE FUNCTION public.recompute_part_quantity_from_locations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_part_id uuid := COALESCE(NEW.part_id, OLD.part_id);
    v_tracked boolean;
BEGIN
    SELECT is_location_tracked INTO v_tracked FROM public.parts WHERE id = v_part_id;

    IF COALESCE(v_tracked, false) THEN
        UPDATE public.parts
           SET quantity = COALESCE(
                   (SELECT SUM(quantity) FROM public.part_location_stock WHERE part_id = v_part_id),
                   0),
               updated_at = now()
         WHERE id = v_part_id;
    END IF;

    RETURN NULL; -- AFTER trigger: return value is ignored
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
       OR OLD.location_name     IS DISTINCT FROM NEW.location_name
       OR OLD.transfer_group_id IS DISTINCT FROM NEW.transfer_group_id
    THEN
        RAISE EXCEPTION 'Only the notes field can be updated on inventory transactions';
    END IF;
    RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.search_jobs_by_identifier(p_company_id uuid, p_query text)
 RETURNS TABLE(job_id uuid, match_source text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_pattern text;
BEGIN
    IF p_query IS NULL OR length(trim(p_query)) = 0 THEN
        RETURN;
    END IF;
    v_pattern := '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';

    RETURN QUERY
        SELECT DISTINCT ON (m.job_id) m.job_id, m.match_source
          FROM (
              SELECT j.id AS job_id, 'packing_slip'::text AS match_source, 1::int AS priority
                FROM public.jobs j
                JOIN public.job_parts jp ON jp.job_id = j.id
                JOIN public.shipment_line_items sli ON sli.job_part_id = jp.id
                JOIN public.shipments s ON s.id = sli.shipment_id
               WHERE j.company_id = p_company_id
                 AND s.voided_at IS NULL
                 AND s.packing_slip_number ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'job_number'::text, 2
                FROM public.jobs j
               WHERE j.company_id = p_company_id
                 AND j.job_number ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'customer_po'::text, 3
                FROM public.jobs j
               WHERE j.company_id = p_company_id
                 AND j.customer_po_number ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'customer'::text, 4
                FROM public.jobs j
                JOIN public.customers c ON c.id = j.customer_id
               WHERE j.company_id = p_company_id
                 AND c.name ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'part'::text, 5
                FROM public.jobs j
                JOIN public.job_parts jp ON jp.job_id = j.id
                JOIN public.parts p ON p.id = jp.part_id
               WHERE j.company_id = p_company_id
                 AND p.part_name ILIKE v_pattern
          ) AS m
         ORDER BY m.job_id, m.priority
         LIMIT 100;
END $function$

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
    -- template-supplied cost, emit a part-level procurement tier.
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
                    (part_id, min_quantity, cost_per_unit)
                VALUES (v_new_id, 1, v_part_cost);
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
                        external_unit_price,
                        instructions
                    ) VALUES (
                        v_routing_id,
                        (v_ref_map->>(v_inner->>'work_center_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        NULLIF(v_inner->>'setup_minutes', '')::numeric,
                        NULLIF(v_inner->>'cycle_minutes_per_unit', '')::numeric,
                        NULLIF(v_inner->>'labor_rate_override', '')::numeric,
                        NULLIF(v_inner->>'external_unit_price', '')::numeric,
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

CREATE OR REPLACE FUNCTION public.set_limit(real)
 RETURNS real
 LANGUAGE c
 STRICT
AS '$libdir/pg_trgm', $function$set_limit$function$

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

CREATE OR REPLACE FUNCTION public.show_limit()
 RETURNS real
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$show_limit$function$

;

CREATE OR REPLACE FUNCTION public.show_trgm(text)
 RETURNS text[]
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$show_trgm$function$

;

CREATE OR REPLACE FUNCTION public.similarity(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$similarity$function$

;

CREATE OR REPLACE FUNCTION public.similarity_dist(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$similarity_dist$function$

;

CREATE OR REPLACE FUNCTION public.similarity_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$similarity_op$function$

;

CREATE OR REPLACE FUNCTION public.snapshot_document_party()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
        IF NEW.customer_id IS NOT NULL THEN
            NEW.customer_name := (SELECT name FROM public.customers WHERE id = NEW.customer_id);
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.billing_address_id IS DISTINCT FROM OLD.billing_address_id THEN
        IF NEW.billing_address_id IS NOT NULL THEN
            NEW.bill_to_address := public.address_block_snapshot(NEW.billing_address_id);
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.shipping_address_id IS DISTINCT FROM OLD.shipping_address_id THEN
        IF NEW.shipping_address_id IS NOT NULL THEN
            NEW.ship_to_address := public.address_block_snapshot(NEW.shipping_address_id);
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
        IF NEW.contact_id IS NOT NULL THEN
            NEW.contact_snapshot := public.contact_block_snapshot(NEW.contact_id);
        END IF;
    END IF;

    RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.snapshot_shipment_party()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
        IF NEW.customer_id IS NOT NULL THEN
            NEW.customer_name := (SELECT name FROM public.customers WHERE id = NEW.customer_id);
            NEW.bill_to_address := public.address_block_snapshot(
                (SELECT a.id FROM public.customer_addresses a
                  WHERE a.customer_id = NEW.customer_id AND a.default_billing
                  LIMIT 1));
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.shipping_address_id IS DISTINCT FROM OLD.shipping_address_id THEN
        IF NEW.shipping_address_id IS NOT NULL THEN
            NEW.ship_to_address := public.address_block_snapshot(NEW.shipping_address_id);
        END IF;
    END IF;

    RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.snapshot_transaction_location_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NEW.location_id IS NOT NULL AND NEW.location_name IS NULL THEN
        NEW.location_name := public.inv_location_path_label(NEW.location_id);
    END IF;
    RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.strict_word_similarity(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity$function$

;

CREATE OR REPLACE FUNCTION public.strict_word_similarity_commutator_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_commutator_op$function$

;

CREATE OR REPLACE FUNCTION public.strict_word_similarity_dist_commutator_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_dist_commutator_op$function$

;

CREATE OR REPLACE FUNCTION public.strict_word_similarity_dist_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_dist_op$function$

;

CREATE OR REPLACE FUNCTION public.strict_word_similarity_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_op$function$

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

CREATE OR REPLACE FUNCTION public.sync_job_fulfillment_status_from_parts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_job_id uuid;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_job_id := COALESCE(NEW.job_id, OLD.job_id);
    v_new := public.compute_job_fulfillment_status(v_job_id);
    SELECT fulfillment_status INTO v_old
      FROM public.jobs WHERE id = v_job_id;
    IF v_new IS DISTINCT FROM v_old THEN
        UPDATE public.jobs
           SET fulfillment_status = v_new,
               updated_at = now()
         WHERE id = v_job_id;
    END IF;
    RETURN NULL;
END $function$

;

CREATE OR REPLACE FUNCTION public.sync_job_invoicing_status_from_parts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_job_id uuid;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_job_id := COALESCE(NEW.job_id, OLD.job_id);
    v_new := public.compute_job_invoicing_status(v_job_id);
    SELECT invoicing_status INTO v_old FROM public.jobs WHERE id = v_job_id;
    IF v_new IS DISTINCT FROM v_old THEN
        UPDATE public.jobs SET invoicing_status = v_new, updated_at = now() WHERE id = v_job_id;
    END IF;
    RETURN NULL;
END $function$

;

CREATE OR REPLACE FUNCTION public.sync_job_production_status_from_parts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_job_id uuid;
    v_new text;
    v_now timestamptz := now();
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_job_id := COALESCE(NEW.job_id, OLD.job_id);
    v_new := public.compute_job_production_status(v_job_id);

    UPDATE public.jobs
       SET production_status = v_new,
           status_changed_at = CASE
               WHEN production_status IS DISTINCT FROM v_new THEN v_now
               ELSE status_changed_at
           END,
           started_at = CASE
               WHEN started_at IS NULL AND v_new IN ('in_progress','completed')
                   THEN v_now
               ELSE started_at
           END,
           completed_at = CASE
               WHEN v_new = 'completed' AND completed_at IS NULL THEN v_now
               WHEN v_new = 'in_progress' THEN NULL
               ELSE completed_at
           END,
           updated_at = v_now
     WHERE id = v_job_id;

    RETURN NULL;
END $function$

;

CREATE OR REPLACE FUNCTION public.track_job_production_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.production_status IS DISTINCT FROM NEW.production_status THEN
        NEW.status_changed_at := now();
        IF NEW.production_status = 'in_progress' AND NEW.started_at IS NULL THEN
            NEW.started_at := now();
        ELSIF NEW.production_status = 'completed' AND NEW.completed_at IS NULL THEN
            NEW.completed_at := now();
        END IF;
    END IF;
    RETURN NEW;
END $function$

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

CREATE OR REPLACE FUNCTION public.transfer_stock(p_part_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_tracked boolean;
    v_src numeric; v_from_balance numeric; v_to_balance numeric;
    v_group uuid; v_from_name text; v_to_name text;
    v_from_notes text; v_to_notes text; v_base text;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;
    IF p_from_location_id = p_to_location_id THEN
        RAISE EXCEPTION 'Source and destination locations must differ' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, is_location_tracked
      INTO v_company, v_item_name, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
    PERFORM public.inv_assert_location_in_company(p_from_location_id, v_company);
    PERFORM public.inv_assert_location_in_company(p_to_location_id, v_company);

    -- Lock + verify source has enough (hard fail — you can't move stock you lack).
    SELECT quantity INTO v_src
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_from_location_id
       FOR UPDATE;
    IF v_src IS NULL OR v_src < p_converted_quantity THEN
        RAISE EXCEPTION 'Insufficient stock at source location (have %, need %)',
            COALESCE(v_src, 0), p_converted_quantity USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.part_location_stock
       SET quantity = v_src - p_converted_quantity
     WHERE part_id = p_part_id AND location_id = p_from_location_id
    RETURNING quantity INTO v_from_balance;

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_to_location_id, p_converted_quantity)
    ON CONFLICT (part_id, location_id)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity
    RETURNING pls.quantity INTO v_to_balance;

    v_group := gen_random_uuid();
    SELECT name INTO v_from_name FROM public.inventory_locations WHERE id = p_from_location_id;
    SELECT name INTO v_to_name   FROM public.inventory_locations WHERE id = p_to_location_id;
    v_base := COALESCE(NULLIF(p_notes, ''), '');

    v_from_notes := btrim(v_base || ' ' || format('[Transfer to %s]', v_to_name));
    v_to_notes   := btrim(v_base || ' ' || format('[Transfer from %s]', v_from_name));

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, transfer_group_id, notes, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'depletion', p_quantity, p_unit, p_converted_quantity,
         p_from_location_id, v_group, v_from_notes, auth.uid()),
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_to_location_id, v_group, v_to_notes, auth.uid());

    RETURN jsonb_build_object(
        'transfer_group_id', v_group,
        'from_balance', v_from_balance, 'to_balance', v_to_balance);
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

CREATE OR REPLACE FUNCTION public.word_similarity(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity$function$

;

CREATE OR REPLACE FUNCTION public.word_similarity_commutator_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_commutator_op$function$

;

CREATE OR REPLACE FUNCTION public.word_similarity_dist_commutator_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_dist_commutator_op$function$

;

CREATE OR REPLACE FUNCTION public.word_similarity_dist_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_dist_op$function$

;

CREATE OR REPLACE FUNCTION public.word_similarity_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_op$function$

;

-- ============================================================
-- 8. TRIGGERS
-- ============================================================
DROP TRIGGER IF EXISTS "ai_config_updated_at" ON "public"."ai_config";
CREATE TRIGGER ai_config_updated_at BEFORE UPDATE ON public.ai_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "companies_updated_at" ON "public"."companies";
CREATE TRIGGER companies_updated_at BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "customer_contacts_updated_at" ON "public"."customer_contacts";
CREATE TRIGGER customer_contacts_updated_at BEFORE UPDATE ON public.customer_contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "customers_updated_at" ON "public"."customers";
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "feedback" ON "public"."feedback";
CREATE TRIGGER feedback AFTER INSERT ON public.feedback FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://mayuquvexmqjvwkfasxg.supabase.co/functions/v1/notify-feedback', 'POST', '{"Content-type":"application/json"}', '{}', '5000');

DROP TRIGGER IF EXISTS "enforce_transaction_notes_only_update" ON "public"."inventory_transactions";
CREATE TRIGGER enforce_transaction_notes_only_update BEFORE UPDATE ON public.inventory_transactions FOR EACH ROW EXECUTE FUNCTION restrict_transaction_update_to_notes();

DROP TRIGGER IF EXISTS "trg_snapshot_txn_location" ON "public"."inventory_transactions";
CREATE TRIGGER trg_snapshot_txn_location BEFORE INSERT ON public.inventory_transactions FOR EACH ROW EXECUTE FUNCTION snapshot_transaction_location_name();

DROP TRIGGER IF EXISTS "job_materials_updated_at" ON "public"."job_materials";
CREATE TRIGGER job_materials_updated_at BEFORE UPDATE ON public.job_materials FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "job_operations_updated_at" ON "public"."job_operations";
CREATE TRIGGER job_operations_updated_at BEFORE UPDATE ON public.job_operations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "job_parts_updated_at" ON "public"."job_parts";
CREATE TRIGGER job_parts_updated_at BEFORE UPDATE ON public.job_parts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "trigger_recompute_jp_fulfillment_on_qty" ON "public"."job_parts";
CREATE TRIGGER trigger_recompute_jp_fulfillment_on_qty AFTER UPDATE OF quantity ON public.job_parts FOR EACH ROW WHEN ((old.quantity IS DISTINCT FROM new.quantity)) EXECUTE FUNCTION recompute_job_part_fulfillment_from_qty();

DROP TRIGGER IF EXISTS "trigger_recompute_jp_invoicing_on_qty" ON "public"."job_parts";
CREATE TRIGGER trigger_recompute_jp_invoicing_on_qty AFTER UPDATE OF quantity ON public.job_parts FOR EACH ROW WHEN ((old.quantity IS DISTINCT FROM new.quantity)) EXECUTE FUNCTION recompute_job_part_invoicing_from_qty();

DROP TRIGGER IF EXISTS "trigger_sync_job_fulfillment_from_parts_del" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_fulfillment_from_parts_del AFTER DELETE ON public.job_parts FOR EACH ROW EXECUTE FUNCTION sync_job_fulfillment_status_from_parts();

DROP TRIGGER IF EXISTS "trigger_sync_job_fulfillment_from_parts_ins" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_fulfillment_from_parts_ins AFTER INSERT ON public.job_parts FOR EACH ROW EXECUTE FUNCTION sync_job_fulfillment_status_from_parts();

DROP TRIGGER IF EXISTS "trigger_sync_job_fulfillment_from_parts_upd" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_fulfillment_from_parts_upd AFTER UPDATE OF fulfillment_status ON public.job_parts FOR EACH ROW WHEN ((old.fulfillment_status IS DISTINCT FROM new.fulfillment_status)) EXECUTE FUNCTION sync_job_fulfillment_status_from_parts();

DROP TRIGGER IF EXISTS "trigger_sync_job_invoicing_from_parts_del" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_invoicing_from_parts_del AFTER DELETE ON public.job_parts FOR EACH ROW EXECUTE FUNCTION sync_job_invoicing_status_from_parts();

DROP TRIGGER IF EXISTS "trigger_sync_job_invoicing_from_parts_ins" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_invoicing_from_parts_ins AFTER INSERT ON public.job_parts FOR EACH ROW EXECUTE FUNCTION sync_job_invoicing_status_from_parts();

DROP TRIGGER IF EXISTS "trigger_sync_job_invoicing_from_parts_upd" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_invoicing_from_parts_upd AFTER UPDATE OF invoicing_status ON public.job_parts FOR EACH ROW WHEN ((old.invoicing_status IS DISTINCT FROM new.invoicing_status)) EXECUTE FUNCTION sync_job_invoicing_status_from_parts();

DROP TRIGGER IF EXISTS "trigger_sync_job_production_status_from_parts_del" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_production_status_from_parts_del AFTER DELETE ON public.job_parts FOR EACH ROW EXECUTE FUNCTION sync_job_production_status_from_parts();

DROP TRIGGER IF EXISTS "trigger_sync_job_production_status_from_parts_ins" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_production_status_from_parts_ins AFTER INSERT ON public.job_parts FOR EACH ROW EXECUTE FUNCTION sync_job_production_status_from_parts();

DROP TRIGGER IF EXISTS "trigger_sync_job_production_status_from_parts_upd" ON "public"."job_parts";
CREATE TRIGGER trigger_sync_job_production_status_from_parts_upd AFTER UPDATE OF production_status ON public.job_parts FOR EACH ROW WHEN ((old.production_status IS DISTINCT FROM new.production_status)) EXECUTE FUNCTION sync_job_production_status_from_parts();

DROP TRIGGER IF EXISTS "enforce_job_address_contact_customer_trg" ON "public"."jobs";
CREATE TRIGGER enforce_job_address_contact_customer_trg BEFORE INSERT OR UPDATE OF billing_address_id, shipping_address_id, contact_id, customer_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION enforce_job_address_contact_customer();

DROP TRIGGER IF EXISTS "jobs_updated_at" ON "public"."jobs";
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "trg_snapshot_job_party" ON "public"."jobs";
CREATE TRIGGER trg_snapshot_job_party BEFORE INSERT OR UPDATE OF customer_id, billing_address_id, shipping_address_id, contact_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION snapshot_document_party();

DROP TRIGGER IF EXISTS "trigger_job_production_status_change" ON "public"."jobs";
CREATE TRIGGER trigger_job_production_status_change BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION track_job_production_status_change();

DROP TRIGGER IF EXISTS "trg_recompute_part_quantity" ON "public"."part_location_stock";
CREATE TRIGGER trg_recompute_part_quantity AFTER INSERT OR DELETE OR UPDATE ON public.part_location_stock FOR EACH ROW EXECUTE FUNCTION recompute_part_quantity_from_locations();

DROP TRIGGER IF EXISTS "part_pricing_tiers_updated_at" ON "public"."part_pricing_tiers";
CREATE TRIGGER part_pricing_tiers_updated_at BEFORE UPDATE ON public.part_pricing_tiers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "part_procurement_tiers_updated_at" ON "public"."part_procurement_tiers";
CREATE TRIGGER part_procurement_tiers_updated_at BEFORE UPDATE ON public.part_procurement_tiers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "parts_updated_at" ON "public"."parts";
CREATE TRIGGER parts_updated_at BEFORE UPDATE ON public.parts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "trg_auto_track_stocked_part" ON "public"."parts";
CREATE TRIGGER trg_auto_track_stocked_part AFTER INSERT OR UPDATE OF is_stocked ON public.parts FOR EACH ROW EXECUTE FUNCTION auto_track_stocked_part();

DROP TRIGGER IF EXISTS "trg_enforce_tracked_part_quantity" ON "public"."parts";
CREATE TRIGGER trg_enforce_tracked_part_quantity BEFORE UPDATE ON public.parts FOR EACH ROW EXECUTE FUNCTION enforce_tracked_part_quantity();

DROP TRIGGER IF EXISTS "parts_bom_no_cycles" ON "public"."parts_bom";
CREATE TRIGGER parts_bom_no_cycles BEFORE INSERT OR UPDATE OF parent_part_id, child_part_id ON public.parts_bom FOR EACH ROW EXECUTE FUNCTION enforce_no_bom_cycles();

DROP TRIGGER IF EXISTS "parts_bom_updated_at" ON "public"."parts_bom";
CREATE TRIGGER parts_bom_updated_at BEFORE UPDATE ON public.parts_bom FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "quickbooks_connections_updated_at" ON "public"."quickbooks_connections";
CREATE TRIGGER quickbooks_connections_updated_at BEFORE UPDATE ON public.quickbooks_connections FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "quickbooks_customer_map_updated_at" ON "public"."quickbooks_customer_map";
CREATE TRIGGER quickbooks_customer_map_updated_at BEFORE UPDATE ON public.quickbooks_customer_map FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "quickbooks_invoice_line_items_updated_at" ON "public"."quickbooks_invoice_line_items";
CREATE TRIGGER quickbooks_invoice_line_items_updated_at BEFORE UPDATE ON public.quickbooks_invoice_line_items FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "trigger_assert_invoice_not_over_ordered" ON "public"."quickbooks_invoice_line_items";
CREATE TRIGGER trigger_assert_invoice_not_over_ordered BEFORE INSERT OR UPDATE OF quantity, job_part_id, invoice_link_id ON public.quickbooks_invoice_line_items FOR EACH ROW EXECUTE FUNCTION assert_invoice_not_over_ordered();

DROP TRIGGER IF EXISTS "trigger_recompute_jp_invoicing_on_line_del" ON "public"."quickbooks_invoice_line_items";
CREATE TRIGGER trigger_recompute_jp_invoicing_on_line_del AFTER DELETE ON public.quickbooks_invoice_line_items FOR EACH ROW EXECUTE FUNCTION recompute_job_part_invoicing_from_line();

DROP TRIGGER IF EXISTS "trigger_recompute_jp_invoicing_on_line_ins" ON "public"."quickbooks_invoice_line_items";
CREATE TRIGGER trigger_recompute_jp_invoicing_on_line_ins AFTER INSERT ON public.quickbooks_invoice_line_items FOR EACH ROW EXECUTE FUNCTION recompute_job_part_invoicing_from_line();

DROP TRIGGER IF EXISTS "trigger_recompute_jp_invoicing_on_line_upd" ON "public"."quickbooks_invoice_line_items";
CREATE TRIGGER trigger_recompute_jp_invoicing_on_line_upd AFTER UPDATE OF quantity, job_part_id, invoice_link_id ON public.quickbooks_invoice_line_items FOR EACH ROW EXECUTE FUNCTION recompute_job_part_invoicing_from_line();

DROP TRIGGER IF EXISTS "quickbooks_invoice_links_updated_at" ON "public"."quickbooks_invoice_links";
CREATE TRIGGER quickbooks_invoice_links_updated_at BEFORE UPDATE ON public.quickbooks_invoice_links FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "trigger_recompute_jp_invoicing_on_link" ON "public"."quickbooks_invoice_links";
CREATE TRIGGER trigger_recompute_jp_invoicing_on_link AFTER UPDATE OF status, voided_at ON public.quickbooks_invoice_links FOR EACH ROW EXECUTE FUNCTION recompute_job_part_invoicing_from_link();

DROP TRIGGER IF EXISTS "enforce_quote_address_contact_customer_trg" ON "public"."quotes";
CREATE TRIGGER enforce_quote_address_contact_customer_trg BEFORE INSERT OR UPDATE OF billing_address_id, shipping_address_id, contact_id, customer_id ON public.quotes FOR EACH ROW EXECUTE FUNCTION enforce_quote_address_contact_customer();

DROP TRIGGER IF EXISTS "quotes_updated_at" ON "public"."quotes";
CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "trg_snapshot_quote_party" ON "public"."quotes";
CREATE TRIGGER trg_snapshot_quote_party BEFORE INSERT OR UPDATE OF customer_id, billing_address_id, shipping_address_id, contact_id ON public.quotes FOR EACH ROW EXECUTE FUNCTION snapshot_document_party();

DROP TRIGGER IF EXISTS "trigger_quote_status_change" ON "public"."quotes";
CREATE TRIGGER trigger_quote_status_change BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION track_quote_status_change();

DROP TRIGGER IF EXISTS "trigger_set_quote_number" ON "public"."quotes";
CREATE TRIGGER trigger_set_quote_number BEFORE INSERT ON public.quotes FOR EACH ROW EXECUTE FUNCTION set_quote_number();

DROP TRIGGER IF EXISTS "routing_operations_updated_at" ON "public"."routing_operations";
CREATE TRIGGER routing_operations_updated_at BEFORE UPDATE ON public.routing_operations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "routings_updated_at" ON "public"."routings";
CREATE TRIGGER routings_updated_at BEFORE UPDATE ON public.routings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "enforce_shipment_line_item_customer_consistency_trg" ON "public"."shipment_line_items";
CREATE TRIGGER enforce_shipment_line_item_customer_consistency_trg BEFORE INSERT OR UPDATE OF shipment_id, job_part_id ON public.shipment_line_items FOR EACH ROW EXECUTE FUNCTION enforce_shipment_line_item_customer_consistency();

DROP TRIGGER IF EXISTS "trigger_recompute_jp_fulfillment_on_line_del" ON "public"."shipment_line_items";
CREATE TRIGGER trigger_recompute_jp_fulfillment_on_line_del AFTER DELETE ON public.shipment_line_items FOR EACH ROW EXECUTE FUNCTION recompute_job_part_fulfillment_from_line();

DROP TRIGGER IF EXISTS "trigger_recompute_jp_fulfillment_on_line_ins" ON "public"."shipment_line_items";
CREATE TRIGGER trigger_recompute_jp_fulfillment_on_line_ins AFTER INSERT ON public.shipment_line_items FOR EACH ROW EXECUTE FUNCTION recompute_job_part_fulfillment_from_line();

DROP TRIGGER IF EXISTS "trigger_recompute_jp_fulfillment_on_line_upd" ON "public"."shipment_line_items";
CREATE TRIGGER trigger_recompute_jp_fulfillment_on_line_upd AFTER UPDATE OF quantity, job_part_id, shipment_id ON public.shipment_line_items FOR EACH ROW EXECUTE FUNCTION recompute_job_part_fulfillment_from_line();

DROP TRIGGER IF EXISTS "enforce_shipment_address_contact_customer_trg" ON "public"."shipments";
CREATE TRIGGER enforce_shipment_address_contact_customer_trg BEFORE INSERT OR UPDATE OF shipping_address_id, customer_id ON public.shipments FOR EACH ROW EXECUTE FUNCTION enforce_shipment_address_contact_customer();

DROP TRIGGER IF EXISTS "enforce_shipment_customer_id_immutable_trg" ON "public"."shipments";
CREATE TRIGGER enforce_shipment_customer_id_immutable_trg BEFORE UPDATE OF customer_id ON public.shipments FOR EACH ROW EXECUTE FUNCTION enforce_shipment_customer_id_immutable();

DROP TRIGGER IF EXISTS "trg_snapshot_shipment_party" ON "public"."shipments";
CREATE TRIGGER trg_snapshot_shipment_party BEFORE INSERT OR UPDATE OF customer_id, shipping_address_id ON public.shipments FOR EACH ROW EXECUTE FUNCTION snapshot_shipment_party();

DROP TRIGGER IF EXISTS "trigger_recompute_jp_fulfillment_on_void" ON "public"."shipments";
CREATE TRIGGER trigger_recompute_jp_fulfillment_on_void AFTER UPDATE OF voided_at ON public.shipments FOR EACH ROW EXECUTE FUNCTION recompute_job_part_fulfillment_from_void();

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

COMMENT ON TABLE "public"."customer_contacts"
    IS 'People at a customer. Replaces the single embedded contact_name/email/phone columns on customers. Each row is one person with a role + optional email/phone. At most one row per customer can have is_primary=true (enforced by the customer_contacts_one_primary partial unique index).';

COMMENT ON TABLE "public"."customers"
    IS 'Customer records for each company. Customers place orders, receive quotes, and have jobs manufactured for them. Linked to parts (customer-specific parts), quotes, and jobs. Cannot be deleted if quotes or jobs exist (RESTRICT).';

COMMENT ON TABLE "public"."demo_data_templates"
    IS 'Templates for seeding demo/sample data into new company accounts. Contains versioned JSONB payloads of sample parts, customers, jobs, etc. Only one version per template name can be active at a time.';

COMMENT ON TABLE "public"."feedback"
    IS 'In-app user feedback submissions';

COMMENT ON TABLE "public"."inventory_locations"
    IS 'Company-scoped, arbitrary-depth storage-location tree (cabinet › row › side, etc.). is_qr_anchor marks nodes with a printed QR.';

COMMENT ON TABLE "public"."inventory_transactions"
    IS 'Append-only ledger of inventory changes (addition / depletion / adjustment). Notes are the only mutable column post-insert (enforced by trigger).';

COMMENT ON TABLE "public"."job_fulfillment_audit"
    IS 'Forward-transition log into fully_shipped. Written from create_shipment_with_line_items; never from a trigger (no incidental-ordering ambiguity for triggering_shipment_id). Reverse transitions are captured on shipments.voided_at/voided_by.';

COMMENT ON TABLE "public"."part_location_stock"
    IS 'Per-location stock balances; source of truth for location-tracked parts. SELECT-only via RLS — mutated only through SECURITY DEFINER RPCs that also write inventory_transactions.';

COMMENT ON TABLE "public"."part_procurement_tiers"
    IS 'Part-level bought-part cost tier sheet: (part_id, min_quantity) → cost_per_unit. One set per part, independent of vendor. Cost resolution (compute_part_cost_at_qty / get_procurement_cost) reads these directly; parts.preferred_vendor_id is a supplier label, not a cost filter. Multi-vendor cost sheets / RFQ / POs are deferred to a future purchasing module.';

COMMENT ON TABLE "public"."parts"
    IS 'Unified item master. Replaces the prior two-table split between manufacturable parts and stockable inventory_items.';

COMMENT ON TABLE "public"."parts_bom"
    IS 'BOM edges. Replaces routing_materials — BOM is now part-attached (one BOM per manufactured part), not routing-attached.';

COMMENT ON TABLE "public"."parts_unit_conversions"
    IS 'Per-part conversion factors from alternate units to the part primary_unit. Replaces inventory_unit_conversions.';

COMMENT ON TABLE "public"."quickbooks_invoice_line_items"
    IS 'Per-part quantity + price snapshot for each QuickBooks invoice push. The Jigged-side source of truth for "how much of each job_part is invoiced" (created, non-void links). Written service-role by the FastAPI push endpoint, atomic with the Intuit call.';

COMMENT ON TABLE "public"."routing_operations"
    IS 'Linear list of operations within a routing. Renamed from routing_nodes. Each row points at a work_center; cost field set varies by work_center.kind (internal vs external).';

COMMENT ON TABLE "public"."saved_insights"
    IS 'User-saved AI chat Q&A pairs. When a user finds an AI-generated insight valuable, they can save it for future reference. Includes the original question, answer text, and any chart configuration.';

COMMENT ON TABLE "public"."shipment_line_items"
    IS 'Single source of truth for "what shipped per job_part". Drives compute_job_part_fulfillment_status via trigger A. Voided shipments contribute zero (filtered by shipments.voided_at IS NULL).';

COMMENT ON TABLE "public"."shipments"
    IS 'One shipment per packing slip. Drives jobs.fulfillment_status via shipment_line_items + the recompute_job_part_fulfillment trigger family. voided_at + voided_by support the Phase-3 void action; the cascade reverses fulfillment when set.';

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
    IS 'Display name of the company/shop. Example: "Acme Precision Machining".';

COMMENT ON COLUMN "public"."companies"."slug"
    IS 'URL-friendly unique identifier. Used in routes like /dashboard/{slug}/. Example: "acme-precision".';

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

COMMENT ON COLUMN "public"."customer_addresses"."default_billing"
    IS 'True when this row is the customer''s default billing address. At most one row per customer can be true (enforced by idx_customer_addresses_one_default_billing). The row''s postal data is still a postal address regardless of this flag.';

COMMENT ON COLUMN "public"."customer_addresses"."default_shipping"
    IS 'True when this row is the customer''s default shipping address. At most one row per customer can be true (enforced by idx_customer_addresses_one_default_shipping). Falls back to default_billing in product behavior when no row is default_shipping — see utils/customerAccess.ts pickShippingAddress.';

COMMENT ON COLUMN "public"."customer_addresses"."attention_to"
    IS 'Optional "ATTN:" recipient line that prints above the address on packing slips. The shipment row can override this with shipping_contact_id; see utils/shipmentsAccess.ts resolveAttentionLine.';

COMMENT ON COLUMN "public"."customer_contacts"."role_label"
    IS 'Free-text label used when role=''other''. Lets the UI render "Other (Production Buyer)" without inventing a new enum value for every customer-specific role.';

COMMENT ON COLUMN "public"."customer_contacts"."is_primary"
    IS 'True for the contact treated as the customer''s primary point of contact. Surfaced on the customers list page and as a star badge on the customer detail page. Enforced unique-per-customer by the customer_contacts_one_primary partial index.';

COMMENT ON COLUMN "public"."customers"."id"
    IS 'Primary key. UUID auto-generated.';

COMMENT ON COLUMN "public"."customers"."company_id"
    IS 'FK to companies. Cascades on delete. Isolates customers per tenant.';

COMMENT ON COLUMN "public"."customers"."name"
    IS 'Full legal/display name of customer. Example: "Acme Manufacturing Corp"';

COMMENT ON COLUMN "public"."customers"."website"
    IS 'Customer website URL. Optional.';

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

COMMENT ON COLUMN "public"."inventory_transactions"."location_name"
    IS 'Snapshot of the location''s full path at transaction time, so deleted locations remain referrable in history (mirrors item_name for deleted parts).';

COMMENT ON COLUMN "public"."job_materials"."parts_bom_id"
    IS 'Source parts_bom row this job_material was snapshotted from at job-start (renamed from routing_material_id; BOM is now part-attached, not routing-attached).';

COMMENT ON COLUMN "public"."job_materials"."material_part_id"
    IS 'FK to the consumed material in the unified parts table (renamed from inventory_item_id when the item master was unified).';

COMMENT ON COLUMN "public"."job_materials"."expected_quantity"
    IS 'Quantity expected to be consumed (snapshot from parts_bom.quantity at job-creation time, in `unit`).';

COMMENT ON COLUMN "public"."job_operations"."operation_name"
    IS 'Snapshot of the work_center name at job-creation time. Immune to mid-job renames.';

COMMENT ON COLUMN "public"."job_operations"."work_center_id"
    IS 'FK to the work_center this op runs at (renamed from operation_type_id when operation_types was replaced by work_centers).';

COMMENT ON COLUMN "public"."job_operations"."routing_operation_id"
    IS 'FK to the routing_operation this row was snapshotted from at job creation (renamed from routing_node_id).';

COMMENT ON COLUMN "public"."jobs"."customer_po_number"
    IS 'Customer-issued PO number for this job. Captured at convertQuoteToJob time (or by reorder when applicable). Indexed via the partial unique-per-company index and via pg_trgm for the jobs-list search RPC.';

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

COMMENT ON COLUMN "public"."parts"."is_location_tracked"
    IS 'When true, parts.quantity is a trigger-maintained rollup of part_location_stock and direct quantity writes are rejected.';

COMMENT ON COLUMN "public"."parts"."costing_batch_quantity"
    IS 'Standard costing lot size: the production run this part''s cost is amortized over (setup / batch). A made part is always valued at this quantity when it is consumed as a component in another part''s BOM. Default 1. Bought parts ignore it.';

COMMENT ON COLUMN "public"."parts_bom"."quantity"
    IS 'Quantity of child consumed per unit of parent, expressed in `unit`. Cost rollups convert to the child part primary_unit via parts_unit_conversions if `unit` differs.';

COMMENT ON COLUMN "public"."parts_bom"."unit"
    IS 'Unit the BOM line is denominated in. Canonical for job_materials snapshots; cost rollups convert to the child part primary_unit when different.';

COMMENT ON COLUMN "public"."parts_bom"."sequence"
    IS 'Display order in the BOM panel. Steps of 10 leave room for inserts.';

COMMENT ON COLUMN "public"."parts_bom"."consume_whole_units"
    IS 'true = ceiling material consumption to whole units at the order qty (discrete stock); false = fractional (default, current behavior).';

COMMENT ON COLUMN "public"."parts_unit_conversions"."to_primary_factor"
    IS 'Multiplier: quantity_in_from_unit * to_primary_factor = quantity_in_primary_unit.';

COMMENT ON COLUMN "public"."quickbooks_invoice_links"."voided_at"
    IS 'Reserved for the deferred invoice-void phase. Compute functions already exclude voided links so voiding needs no schema change when built.';

COMMENT ON COLUMN "public"."quote_line_items"."pricing_basis_snapshot"
    IS 'JSON snapshot of the pricing tiers, markup, and resolved tier at quote-create time. Shape: { tiers: [{ id, quantity, unit_price, markup_percent }], resolved_tier_id, resolved_quantity, captured_at }. NULL when basis_unknown=true (pre-snapshot rows).';

COMMENT ON COLUMN "public"."quote_line_items"."basis_unknown"
    IS 'TRUE when this line was created before the basis-snapshot column existed. Renders a "basis unknown" chip on edit; drift detection uses degraded resolved-vs-current comparison. Option C from Issue #317 — Option A (backfill from current tiers) was explicitly dropped to avoid fabricating historical pricing.';

COMMENT ON COLUMN "public"."quote_materials"."material_part_id"
    IS 'FK to the consumed material in the unified parts table (renamed from inventory_item_id when the item master was unified). Optional — supports ad-hoc materials not yet in the catalog.';

COMMENT ON COLUMN "public"."quote_materials"."item_name"
    IS 'Snapshot of the material name at quote-creation time. Survives part renames so historical quotes stay readable.';

COMMENT ON COLUMN "public"."quote_materials"."part_id"
    IS 'The manufactured part this material consumption belongs to (the line-item part on the quote).';

COMMENT ON COLUMN "public"."quote_materials"."units_consumed"
    IS 'Whole/fractional units of this material actually consumed across the quoted order (ceil(order_qty * per-part consumption) in whole-unit mode); NULL = legacy row where `quantity` is the literal per-unit value.';

COMMENT ON COLUMN "public"."quotes"."billing_address_id"
    IS 'Customer address used for BILL TO on the printable quote and downstream shipments. Set at quote creation from the customer''s default_billing row; editable per-quote.';

COMMENT ON COLUMN "public"."quotes"."shipping_address_id"
    IS 'Customer address used for SHIP TO on the printable quote and downstream shipments. Set at quote creation from the customer''s default_shipping row (falling back to default_billing); editable per-quote.';

COMMENT ON COLUMN "public"."quotes"."contact_id"
    IS 'Customer contact the quote is addressed to. Renders as the Customer Contact section on the printed quote (name, role, email, phone). Defaults at quote creation to the customer''s primary contact (is_primary=true in customer_contacts); editable per-quote.';

COMMENT ON COLUMN "public"."quotes"."payment_terms"
    IS 'Payment terms shown on the quote (preset or custom free text), e.g. Net 30, 2/10 Net 30.';

COMMENT ON COLUMN "public"."quotes"."customer_name"
    IS 'Immutable snapshot of the customer name at quote issue time.';

COMMENT ON COLUMN "public"."quotes"."bill_to_address"
    IS 'Immutable snapshot of the billing address block at quote issue time (Document Snapshot Standard). The rendered quote reads this, not the live billing_address_id row.';

COMMENT ON COLUMN "public"."quotes"."ship_to_address"
    IS 'Immutable snapshot of the shipping address block at quote issue time.';

COMMENT ON COLUMN "public"."quotes"."contact_snapshot"
    IS 'Immutable snapshot of the customer contact { name, email, phone } at quote issue time.';

COMMENT ON COLUMN "public"."routing_operations"."sequence"
    IS 'Linear order within the routing. Lower values execute first. Steps of 10 (10, 20, 30...) leave room for inserts.';

COMMENT ON COLUMN "public"."routing_operations"."setup_minutes"
    IS 'One-time per-job setup time, in minutes. Amortized across batch in cost rollups (setup_minutes / qty).';

COMMENT ON COLUMN "public"."routing_operations"."cycle_minutes_per_unit"
    IS 'Per-unit run time, in minutes. Used for kind=internal cost calculation only.';

COMMENT ON COLUMN "public"."routing_operations"."labor_rate_override"
    IS 'Per-step override of the work_center labor_rate, in dollars per hour. Dominant pattern in real shop data: internal ops typically override the work-center default rather than inherit it. NULL = inherit work_center.labor_rate. Used for kind=internal only.';

COMMENT ON COLUMN "public"."routing_operations"."external_unit_price"
    IS 'For kind=external only: cost per output unit charged by the vendor.';

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

COMMENT ON COLUMN "public"."shipments"."one_time_address"
    IS 'Reserved for Phase 3 ad-hoc shipping. Either shipping_address_id OR one_time_address must be set (XOR shipments_one_address_source).';

COMMENT ON COLUMN "public"."shipments"."shipping_method"
    IS 'How the goods left: customer_pickup | personal_delivery | shipment | dropship (resale) | restock (to in-store stock). Replaces the retired shipping_arrangement. Enum-via-CHECK.';

COMMENT ON COLUMN "public"."shipments"."job_id"
    IS 'The single job this packing slip belongs to. All shipment_line_items resolve to job_parts of this job (enforced in create_shipment_with_line_items). Source of the PS-{jobBase}-{n} number.';

COMMENT ON COLUMN "public"."shipments"."bill_to_address"
    IS 'Immutable snapshot of the bill-to address block at shipment/packing-slip issue time.';

COMMENT ON COLUMN "public"."shipments"."ship_to_address"
    IS 'Immutable snapshot of the ship-to address block at shipment issue time.';

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

-- ============================================================
-- 12. GRANTS & DEFAULT PRIVILEGES
-- ============================================================
-- A role reaches a table through the Data API only if it holds a GRANT
-- here; RLS then filters rows. Both layers are required.
--
-- New tables in `public` are NOT granted automatically (Supabase changelog
-- #45329). The default privileges at the end of this section decide what,
-- if anything, a newly created object is exposed to.

GRANT ALL ON TABLE "public"."ai_chat_queries" TO "anon";
GRANT ALL ON TABLE "public"."ai_chat_queries" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_chat_queries" TO "postgres";
GRANT ALL ON TABLE "public"."ai_chat_queries" TO "service_role";
GRANT ALL ON TABLE "public"."ai_config" TO "anon";
GRANT ALL ON TABLE "public"."ai_config" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_config" TO "postgres";
GRANT ALL ON TABLE "public"."ai_config" TO "service_role";
GRANT ALL ON TABLE "public"."auth_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."auth_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."auth_audit_log" TO "postgres";
GRANT ALL ON TABLE "public"."auth_audit_log" TO "service_role";
GRANT ALL ON TABLE "public"."companies" TO "anon";
GRANT ALL ON TABLE "public"."companies" TO "authenticated";
GRANT SELECT ON TABLE "public"."companies" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."companies" TO "postgres";
GRANT ALL ON TABLE "public"."companies" TO "service_role";
GRANT ALL ON TABLE "public"."company_custom_units" TO "anon";
GRANT ALL ON TABLE "public"."company_custom_units" TO "authenticated";
GRANT ALL ON TABLE "public"."company_custom_units" TO "postgres";
GRANT ALL ON TABLE "public"."company_custom_units" TO "service_role";
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "public"."company_order_counters" TO "anon";
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "public"."company_order_counters" TO "authenticated";
GRANT ALL ON TABLE "public"."company_order_counters" TO "postgres";
GRANT ALL ON TABLE "public"."company_order_counters" TO "service_role";
GRANT ALL ON TABLE "public"."customer_addresses" TO "anon";
GRANT ALL ON TABLE "public"."customer_addresses" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_addresses" TO "postgres";
GRANT ALL ON TABLE "public"."customer_addresses" TO "service_role";
GRANT ALL ON TABLE "public"."customer_contacts" TO "anon";
GRANT ALL ON TABLE "public"."customer_contacts" TO "authenticated";
GRANT SELECT ON TABLE "public"."customer_contacts" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."customer_contacts" TO "postgres";
GRANT ALL ON TABLE "public"."customer_contacts" TO "service_role";
GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";
GRANT SELECT ON TABLE "public"."customers" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."customers" TO "postgres";
GRANT ALL ON TABLE "public"."customers" TO "service_role";
GRANT ALL ON TABLE "public"."demo_data_templates" TO "anon";
GRANT ALL ON TABLE "public"."demo_data_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."demo_data_templates" TO "postgres";
GRANT ALL ON TABLE "public"."demo_data_templates" TO "service_role";
GRANT ALL ON TABLE "public"."feedback" TO "anon";
GRANT ALL ON TABLE "public"."feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."feedback" TO "postgres";
GRANT ALL ON TABLE "public"."feedback" TO "service_role";
GRANT ALL ON TABLE "public"."inventory_locations" TO "anon";
GRANT ALL ON TABLE "public"."inventory_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_locations" TO "postgres";
GRANT ALL ON TABLE "public"."inventory_locations" TO "service_role";
GRANT ALL ON TABLE "public"."inventory_transactions" TO "anon";
GRANT ALL ON TABLE "public"."inventory_transactions" TO "authenticated";
GRANT SELECT ON TABLE "public"."inventory_transactions" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."inventory_transactions" TO "postgres";
GRANT ALL ON TABLE "public"."inventory_transactions" TO "service_role";
GRANT ALL ON TABLE "public"."invitations" TO "anon";
GRANT ALL ON TABLE "public"."invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."invitations" TO "postgres";
GRANT ALL ON TABLE "public"."invitations" TO "service_role";
GRANT ALL ON TABLE "public"."job_attachments" TO "anon";
GRANT ALL ON TABLE "public"."job_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."job_attachments" TO "postgres";
GRANT ALL ON TABLE "public"."job_attachments" TO "service_role";
GRANT ALL ON TABLE "public"."job_fulfillment_audit" TO "anon";
GRANT ALL ON TABLE "public"."job_fulfillment_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."job_fulfillment_audit" TO "postgres";
GRANT ALL ON TABLE "public"."job_fulfillment_audit" TO "service_role";
GRANT ALL ON TABLE "public"."job_materials" TO "anon";
GRANT ALL ON TABLE "public"."job_materials" TO "authenticated";
GRANT SELECT ON TABLE "public"."job_materials" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."job_materials" TO "postgres";
GRANT ALL ON TABLE "public"."job_materials" TO "service_role";
GRANT ALL ON TABLE "public"."job_note_media" TO "anon";
GRANT ALL ON TABLE "public"."job_note_media" TO "authenticated";
GRANT ALL ON TABLE "public"."job_note_media" TO "postgres";
GRANT ALL ON TABLE "public"."job_note_media" TO "service_role";
GRANT ALL ON TABLE "public"."job_notes" TO "anon";
GRANT ALL ON TABLE "public"."job_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."job_notes" TO "postgres";
GRANT ALL ON TABLE "public"."job_notes" TO "service_role";
GRANT ALL ON TABLE "public"."job_operations" TO "anon";
GRANT ALL ON TABLE "public"."job_operations" TO "authenticated";
GRANT SELECT ON TABLE "public"."job_operations" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."job_operations" TO "postgres";
GRANT ALL ON TABLE "public"."job_operations" TO "service_role";
GRANT ALL ON TABLE "public"."job_parts" TO "anon";
GRANT ALL ON TABLE "public"."job_parts" TO "authenticated";
GRANT SELECT ON TABLE "public"."job_parts" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."job_parts" TO "postgres";
GRANT ALL ON TABLE "public"."job_parts" TO "service_role";
GRANT ALL ON TABLE "public"."jobs" TO "anon";
GRANT ALL ON TABLE "public"."jobs" TO "authenticated";
GRANT SELECT ON TABLE "public"."jobs" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."jobs" TO "postgres";
GRANT ALL ON TABLE "public"."jobs" TO "service_role";
GRANT ALL ON TABLE "public"."part_attachments" TO "anon";
GRANT ALL ON TABLE "public"."part_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."part_attachments" TO "postgres";
GRANT ALL ON TABLE "public"."part_attachments" TO "service_role";
GRANT ALL ON TABLE "public"."part_location_stock" TO "anon";
GRANT ALL ON TABLE "public"."part_location_stock" TO "authenticated";
GRANT ALL ON TABLE "public"."part_location_stock" TO "postgres";
GRANT ALL ON TABLE "public"."part_location_stock" TO "service_role";
GRANT ALL ON TABLE "public"."part_notes" TO "anon";
GRANT ALL ON TABLE "public"."part_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."part_notes" TO "postgres";
GRANT ALL ON TABLE "public"."part_notes" TO "service_role";
GRANT ALL ON TABLE "public"."part_pricing_tiers" TO "anon";
GRANT ALL ON TABLE "public"."part_pricing_tiers" TO "authenticated";
GRANT SELECT ON TABLE "public"."part_pricing_tiers" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."part_pricing_tiers" TO "postgres";
GRANT ALL ON TABLE "public"."part_pricing_tiers" TO "service_role";
GRANT ALL ON TABLE "public"."part_procurement_tiers" TO "anon";
GRANT ALL ON TABLE "public"."part_procurement_tiers" TO "authenticated";
GRANT ALL ON TABLE "public"."part_procurement_tiers" TO "postgres";
GRANT ALL ON TABLE "public"."part_procurement_tiers" TO "service_role";
GRANT ALL ON TABLE "public"."parts" TO "anon";
GRANT ALL ON TABLE "public"."parts" TO "authenticated";
GRANT SELECT ON TABLE "public"."parts" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."parts" TO "postgres";
GRANT ALL ON TABLE "public"."parts" TO "service_role";
GRANT ALL ON TABLE "public"."parts_bom" TO "anon";
GRANT ALL ON TABLE "public"."parts_bom" TO "authenticated";
GRANT SELECT ON TABLE "public"."parts_bom" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."parts_bom" TO "postgres";
GRANT ALL ON TABLE "public"."parts_bom" TO "service_role";
GRANT ALL ON TABLE "public"."parts_unit_conversions" TO "anon";
GRANT ALL ON TABLE "public"."parts_unit_conversions" TO "authenticated";
GRANT SELECT ON TABLE "public"."parts_unit_conversions" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."parts_unit_conversions" TO "postgres";
GRANT ALL ON TABLE "public"."parts_unit_conversions" TO "service_role";
GRANT ALL ON TABLE "public"."quickbooks_connections" TO "postgres";
GRANT ALL ON TABLE "public"."quickbooks_connections" TO "service_role";
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "public"."quickbooks_customer_map" TO "anon";
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "public"."quickbooks_customer_map" TO "authenticated";
GRANT ALL ON TABLE "public"."quickbooks_customer_map" TO "postgres";
GRANT ALL ON TABLE "public"."quickbooks_customer_map" TO "service_role";
GRANT ALL ON TABLE "public"."quickbooks_invoice_line_items" TO "anon";
GRANT ALL ON TABLE "public"."quickbooks_invoice_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."quickbooks_invoice_line_items" TO "postgres";
GRANT ALL ON TABLE "public"."quickbooks_invoice_line_items" TO "service_role";
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "public"."quickbooks_invoice_links" TO "anon";
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "public"."quickbooks_invoice_links" TO "authenticated";
GRANT ALL ON TABLE "public"."quickbooks_invoice_links" TO "postgres";
GRANT ALL ON TABLE "public"."quickbooks_invoice_links" TO "service_role";
GRANT ALL ON TABLE "public"."quote_line_items" TO "anon";
GRANT ALL ON TABLE "public"."quote_line_items" TO "authenticated";
GRANT SELECT ON TABLE "public"."quote_line_items" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."quote_line_items" TO "postgres";
GRANT ALL ON TABLE "public"."quote_line_items" TO "service_role";
GRANT ALL ON TABLE "public"."quote_materials" TO "anon";
GRANT ALL ON TABLE "public"."quote_materials" TO "authenticated";
GRANT SELECT ON TABLE "public"."quote_materials" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."quote_materials" TO "postgres";
GRANT ALL ON TABLE "public"."quote_materials" TO "service_role";
GRANT ALL ON TABLE "public"."quote_operations" TO "anon";
GRANT ALL ON TABLE "public"."quote_operations" TO "authenticated";
GRANT SELECT ON TABLE "public"."quote_operations" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."quote_operations" TO "postgres";
GRANT ALL ON TABLE "public"."quote_operations" TO "service_role";
GRANT ALL ON TABLE "public"."quotes" TO "anon";
GRANT ALL ON TABLE "public"."quotes" TO "authenticated";
GRANT SELECT ON TABLE "public"."quotes" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."quotes" TO "postgres";
GRANT ALL ON TABLE "public"."quotes" TO "service_role";
GRANT ALL ON TABLE "public"."routing_operations" TO "anon";
GRANT ALL ON TABLE "public"."routing_operations" TO "authenticated";
GRANT SELECT ON TABLE "public"."routing_operations" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."routing_operations" TO "postgres";
GRANT ALL ON TABLE "public"."routing_operations" TO "service_role";
GRANT ALL ON TABLE "public"."routings" TO "anon";
GRANT ALL ON TABLE "public"."routings" TO "authenticated";
GRANT SELECT ON TABLE "public"."routings" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."routings" TO "postgres";
GRANT ALL ON TABLE "public"."routings" TO "service_role";
GRANT ALL ON TABLE "public"."saved_insights" TO "anon";
GRANT ALL ON TABLE "public"."saved_insights" TO "authenticated";
GRANT ALL ON TABLE "public"."saved_insights" TO "postgres";
GRANT ALL ON TABLE "public"."saved_insights" TO "service_role";
GRANT ALL ON TABLE "public"."shipment_line_items" TO "anon";
GRANT ALL ON TABLE "public"."shipment_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."shipment_line_items" TO "postgres";
GRANT ALL ON TABLE "public"."shipment_line_items" TO "service_role";
GRANT ALL ON TABLE "public"."shipments" TO "anon";
GRANT ALL ON TABLE "public"."shipments" TO "authenticated";
GRANT ALL ON TABLE "public"."shipments" TO "postgres";
GRANT ALL ON TABLE "public"."shipments" TO "service_role";
GRANT ALL ON TABLE "public"."system_admins" TO "anon";
GRANT ALL ON TABLE "public"."system_admins" TO "authenticated";
GRANT ALL ON TABLE "public"."system_admins" TO "postgres";
GRANT ALL ON TABLE "public"."system_admins" TO "service_role";
GRANT ALL ON TABLE "public"."user_company_access" TO "anon";
GRANT ALL ON TABLE "public"."user_company_access" TO "authenticated";
GRANT ALL ON TABLE "public"."user_company_access" TO "postgres";
GRANT ALL ON TABLE "public"."user_company_access" TO "service_role";
GRANT ALL ON TABLE "public"."user_preferences" TO "anon";
GRANT ALL ON TABLE "public"."user_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."user_preferences" TO "postgres";
GRANT ALL ON TABLE "public"."user_preferences" TO "service_role";
GRANT ALL ON TABLE "public"."vendor_contacts" TO "anon";
GRANT ALL ON TABLE "public"."vendor_contacts" TO "authenticated";
GRANT SELECT ON TABLE "public"."vendor_contacts" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."vendor_contacts" TO "postgres";
GRANT ALL ON TABLE "public"."vendor_contacts" TO "service_role";
GRANT ALL ON TABLE "public"."vendors" TO "anon";
GRANT ALL ON TABLE "public"."vendors" TO "authenticated";
GRANT SELECT ON TABLE "public"."vendors" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."vendors" TO "postgres";
GRANT ALL ON TABLE "public"."vendors" TO "service_role";
GRANT ALL ON TABLE "public"."waitlist" TO "anon";
GRANT ALL ON TABLE "public"."waitlist" TO "authenticated";
GRANT ALL ON TABLE "public"."waitlist" TO "postgres";
GRANT ALL ON TABLE "public"."waitlist" TO "service_role";
GRANT ALL ON TABLE "public"."work_centers" TO "anon";
GRANT ALL ON TABLE "public"."work_centers" TO "authenticated";
GRANT SELECT ON TABLE "public"."work_centers" TO "jigged_ai_readonly";
GRANT ALL ON TABLE "public"."work_centers" TO "postgres";
GRANT ALL ON TABLE "public"."work_centers" TO "service_role";

-- Default privileges — what a NEWLY created object is granted.
-- anon/authenticated/service_role absent from TABLES means new tables
-- are invisible to the Data API until granted explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

COMMIT;
