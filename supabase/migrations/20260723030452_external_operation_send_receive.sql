-- External (outside) operations: shop-floor send/receive lifecycle.
--
-- Operations routed to an external work center (work_centers.kind = 'external')
-- are performed by an outside vendor (e.g. coating). They are not "completed"
-- at a machine — the part leaves the shop and comes back. This migration adds
-- the state and attribution for that lifecycle:
--
--   pending --(Mark Sent Out)--> sent --(Mark Received)--> completed
--
-- 'sent' is an OPTIONAL waypoint: Mark Received also completes directly from
-- 'pending' (recording sent_* = completed_* — the common after-the-fact case).
-- 'received' == 'completed', so every existing part/job status rollup,
-- predecessor check, and deriveStatusFromOps keeps working unchanged (a 'sent'
-- op is <> 'completed', so it holds its part at in_progress). See
-- docs/modules/jobs.md and the plan for the full rationale.

-- 1. Widen the operation status enum with 'sent'.
ALTER TABLE "public"."job_operations"
    DROP CONSTRAINT "job_operations_status_check";
ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_status_check"
        CHECK ("status" = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'sent'::text]));

-- 2. Send attribution (received reuses completed_at / completed_by).
--    sent_by references auth.users(id), mirroring job_operations_completed_by_fkey.
ALTER TABLE "public"."job_operations"
    ADD COLUMN "sent_at" timestamp with time zone,
    ADD COLUMN "sent_by" uuid;
ALTER TABLE "public"."job_operations"
    ADD CONSTRAINT "job_operations_sent_by_fkey" FOREIGN KEY ("sent_by")
        REFERENCES "auth"."users" ("id");

-- Partial index for the company-wide "Outside work" queue (ops at vendor).
CREATE INDEX IF NOT EXISTS "idx_job_ops_sent"
    ON "public"."job_operations" USING btree ("status")
    WHERE ("status" = 'sent');

-- 3. Backfill: prevent stranded rows.
--    The new lifecycle guards refuse to move an external op out of 'in_progress'
--    (markOperationSent requires 'pending'; the internal complete path throws
--    for external ops). Any pre-existing external op sitting in 'in_progress'
--    would be trapped. Normalize them to 'pending' so the guards can act, and
--    log a job_notes 'event' so the state change is NOT silent
--    (CLAUDE.md: no silent runtime fallbacks for data-at-rest issues).
INSERT INTO "public"."job_notes"
    ("company_id", "job_id", "job_part_id", "job_operation_id", "author_id", "note_type", "body")
SELECT j."company_id",
       jo."job_id",
       jo."job_part_id",
       jo."id",
       NULL,
       'event',
       'Outside operation reset from in-progress to not-sent by the external-operations '
       || 'migration (introducing the send/receive lifecycle).'
FROM "public"."job_operations" jo
JOIN "public"."work_centers" wc ON wc."id" = jo."work_center_id"
JOIN "public"."jobs" j ON j."id" = jo."job_id"
WHERE wc."kind" = 'external'
  AND jo."status" = 'in_progress';

UPDATE "public"."job_operations" jo
SET "status" = 'pending',
    "updated_at" = now()
FROM "public"."work_centers" wc
WHERE wc."id" = jo."work_center_id"
  AND wc."kind" = 'external'
  AND jo."status" = 'in_progress';
