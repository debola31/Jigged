-- Race backstop for quote→job conversion: a quote line item may be converted to
-- at most ONE active job_part.
--
-- convertQuoteToJob is multi-pass (one job per customer PO) and pre-checks which
-- lines are already on a job before inserting. That check is a read-then-write,
-- so two truly-simultaneous conversions of the same line could both pass it and
-- both create a job_part — double-converting the line. The fix is to let the DB
-- be the arbiter: a partial unique index makes the duplicate insert fail (23505),
-- which convertQuoteToJob turns into the same friendly "already on a job" error.
-- The app pre-check stays as the fast path; this is the hard guarantee.
--
-- Scoped to non-cancelled parts (production_status <> 'cancelled') so that
-- CANCELLING a job frees its quote line for re-conversion — no permanently stuck
-- lines. Cancelling a job cancels its job_parts (job.production_status is the
-- roll-up of the parts), so the cancelled part drops out of the index and a fresh
-- active conversion is allowed. (Archiving a job does NOT free the line — the
-- archived job stays the record of that conversion; cancel is the way to redo.)
--
-- No column change ⇒ types/database.ts is unaffected.

CREATE UNIQUE INDEX IF NOT EXISTS job_parts_one_active_per_quote_line
  ON public.job_parts (source_quote_line_item_id)
  WHERE source_quote_line_item_id IS NOT NULL
    AND production_status <> 'cancelled';
