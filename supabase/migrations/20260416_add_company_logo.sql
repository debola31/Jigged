-- Migration: Add logo_url column to companies table
-- Stores the Supabase Storage path to the company's logo.
-- Nullable: companies without a logo fall back to a text-only header on
-- printed quotes. Path format: {companyId}/company/logo_{uuid}.{ext}

ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
