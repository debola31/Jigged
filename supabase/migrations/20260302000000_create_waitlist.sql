-- ============================================================
-- Waitlist Table
-- Created: 2026-03-02
-- Description: Stores email signups from marketing pages
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."waitlist" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "email" text NOT NULL,
    "source" text DEFAULT 'landing_page',
    "created_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "waitlist_pkey" PRIMARY KEY (id),
    CONSTRAINT "waitlist_email_unique" UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS "waitlist_email_idx" ON "public"."waitlist" (email);
CREATE INDEX IF NOT EXISTS "waitlist_created_at_idx" ON "public"."waitlist" (created_at);

ALTER TABLE "public"."waitlist" ENABLE ROW LEVEL SECURITY;

COMMIT;
