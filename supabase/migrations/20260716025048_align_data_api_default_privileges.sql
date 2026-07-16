-- Adopt Supabase's new Data API default ahead of its 2026-10-30 enforcement.
-- https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically
--
-- Supabase is removing the automatic Data API exposure of new tables in `public`.
-- New projects flipped 2026-05-30; existing projects (ours) flip 2026-10-30. These
-- are verbatim the statements Supabase publishes for adopting the new behavior
-- early ("You do not have to wait for October 30").
--
-- WHY RUN IT NOW rather than let 2026-10-30 do it:
--   The baseline (20260527151536_baseline.sql, ~line 6427) asserts
--     ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated, service_role
--   Prod is a long-lived database: the baseline already ran there and never runs
--   again, so Supabase's revoke will stick. But every local `supabase db reset`
--   replays the baseline, which re-grants the permissive default. After 2026-10-30
--   that leaves local permissive while prod is restrictive -- so a new table with a
--   forgotten GRANT would work locally, pass CI, and then 404 through PostgREST in
--   production only. Running the revoke ourselves keeps every database on the same
--   behavior, on our schedule, and makes a forgotten grant fail immediately in dev.
--
-- SCOPE -- do not broaden these. Being stricter than prod merely inverts the
-- divergence above:
--   * No functions revoke. The CLI ships a third `revoke execute on functions`
--     statement, but both the changelog and discussion #45329 publish only the two
--     below, and that CLI SQL is project-creation SQL, not the 2026-10-30 SQL for
--     existing projects. It is moot here regardless: every function in `public` is
--     already granted explicitly, so the functions default privilege does nothing
--     for us. Revisit in October if the enforcement turns out to include it.
--   * jigged_ai_readonly is left alone. It is our own role, Supabase will not
--     touch it, and its reads already require an explicit per-table
--     ai_readonly_select policy. (Note: the baseline ~line 6431 asserts a
--     `GRANT SELECT ON TABLES` default for it, but prod's pg_default_acl has no
--     such entry -- pre-existing baseline/prod drift, unrelated to this change.
--     Nothing here touches it either way.)
--   * Only `FOR ROLE postgres` is revoked, matching Supabase. Prod also carries a
--     permissive `FOR ROLE supabase_admin` TABLES default, but our migrations
--     create objects as `postgres`, and Supabase's own revoke targets `postgres`
--     alone -- so mirroring keeps us aligned rather than clever.
--   * No sequences exist in `public` today (every PK is gen_random_uuid()); the
--     sequence statement is included for fidelity with prod and covers the first
--     `serial` column anyone adds.
--
-- ONLY AFFECTS FUTURE OBJECTS. ALTER DEFAULT PRIVILEGES is not retroactive:
-- every existing table keeps the grants it already has.
--
-- From here on, a new table in `public` needs explicit grants in its own
-- migration, alongside ENABLE ROW LEVEL SECURITY and its policies:
--
--   GRANT SELECT ON public.your_table TO anon;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO authenticated;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES
  FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES
  FROM anon, authenticated, service_role;
