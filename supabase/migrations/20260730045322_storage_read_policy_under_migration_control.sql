-- Bring the attachments SELECT policy under migration control.
--
-- **Reading any attachment is broken on every fresh local stack and every Supabase preview
-- branch.** After a `db reset`, `storage.objects` has exactly two policies — INSERT and DELETE,
-- both from `20260725210136_stripe_write_enforcement.sql` — and **no SELECT policy at all**, so
-- `createSignedUrl` answers every request with "Either the object does not exist or you do not have
-- access to it". Not only the machine-maintenance photos this was reported against: part
-- attachments (PDF/STEP/DWG), job attachments and operator note photos are equally unreadable.
--
-- It works in production only because the policy was created there by hand and then captured in
-- `supabase/schema.prod.sql` — which is a *snapshot*, not an applied artifact. This is the exact
-- failure mode `20260728212230_create_attachments_storage_bucket.sql` was written to fix for the
-- BUCKET, whose header records that it "had existed only in the prod snapshot, so uploads returned
-- 'Bucket not found' on every preview branch". That migration fixed the bucket and missed the
-- policy — so uploads started working while reads stayed broken.
--
-- Copied from the prod snapshot, so applying it changes nothing in production.
--
-- DUPLICATE ON PURPOSE. The same policy is added by
-- `20260730021430_storage_read_policy_under_migration_control.sql` on feature/inventory-phase-2,
-- where it was diagnosed first (against location photos). Both start with DROP POLICY IF EXISTS, so
-- whichever runs second simply re-creates an identical policy and neither branch has to wait for
-- the other. Delete this file if the branches are ever reconciled before merge; leaving both costs
-- one redundant statement and nothing else.
--
-- Deliberately **no billing gate**: reads stay open for a lapsed shop, matching the standard in
-- docs/modules/billing.md §4 — you can always look at your own data, you just can't add to it. The
-- INSERT and DELETE policies alongside this one DO carry `company_can_write`.

DROP POLICY IF EXISTS "Users can read files from their company folder" ON storage.objects;

CREATE POLICY "Users can read files from their company folder"
    ON storage.objects
    FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'attachments'
        -- The first path segment is the company id. The bucket_id check comes first so a non-uuid
        -- path never reaches the comparison, and every writer namespaces paths this way through
        -- `generateStoragePath` — `{companyId}/{entityType}/{entityId}/{uuid8}_{name}`.
        AND (storage.foldername(name))[1] IN (
            SELECT company_id::text FROM public.user_company_access
             WHERE user_id = auth.uid()
        )
    );
