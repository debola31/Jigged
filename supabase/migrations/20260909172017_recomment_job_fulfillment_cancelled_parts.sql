-- Re-issue the COMMENT on compute_job_fulfillment_status. The baseline's version
-- cited "PRD §7.1" as the authority for the cancelled-parts rule, and docs/prd.md
-- has never had a §7.1. The rule itself is correct and enforced; only the pointer
-- was dead. See #685.
--
-- No DROP here, deliberately: the function body is unchanged, and dropping it
-- would destroy its ACL along with the comment we are replacing.
COMMENT ON FUNCTION public.compute_job_fulfillment_status(uuid) IS
    'Aggregates job_parts.fulfillment_status across ALL parts of the job. Does NOT filter cancelled parts, so a cancelled-after-partial-ship job legitimately reports fulfillment_status = partially_shipped, and a cancelled-and-unshipped part holds the whole job off fully_shipped. The function body is the enforcement; TestCancellationFulfillmentIndependence covers it.';
