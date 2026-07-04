-- Branching pipeline validation — THROWAWAY.
--
-- Purpose: prove the Supabase preview-branch pipeline works end-to-end
-- (preview branch auto-created on PR, committed migrations applied, seed.sql
-- run, Vercel preview deployed against the branch DB, required check reported).
--
-- This only sets a harmless table comment. Close the PR WITHOUT merging so it
-- never reaches production; the preview branch is deleted automatically.
comment on table public.companies is 'branching pipeline validation — safe to revert';
