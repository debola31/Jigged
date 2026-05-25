-- Append-only audit log for authentication-adjacent admin actions.
-- First consumer: admin-triggered password reset (POST /team/:id/reset-password).
--
-- Writes happen via service-role in Edge Functions; no INSERT/UPDATE/DELETE
-- policies are defined, so authenticated/anon callers cannot mutate.
-- Company admins can SELECT their own company's rows for review.

CREATE TABLE IF NOT EXISTS "public"."auth_audit_log" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    "target_user_id" uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    "company_id" uuid REFERENCES public.companies(id) ON DELETE SET NULL,
    "event_type" text NOT NULL,
    "outcome" text NOT NULL,
    "error_detail" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "auth_audit_log_pkey" PRIMARY KEY (id),
    CONSTRAINT "auth_audit_log_outcome_check"
        CHECK (outcome IN ('success', 'forbidden', 'failed'))
);

CREATE INDEX IF NOT EXISTS "idx_auth_audit_company_created"
    ON "public"."auth_audit_log" (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS "idx_auth_audit_actor_created"
    ON "public"."auth_audit_log" (actor_user_id, created_at DESC);

ALTER TABLE "public"."auth_audit_log" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company admins read auth audit" ON "public"."auth_audit_log";
CREATE POLICY "Company admins read auth audit"
    ON "public"."auth_audit_log"
    FOR SELECT
    USING (company_id IS NOT NULL AND public.is_company_admin(company_id));
