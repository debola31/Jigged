-- ============================================================================
-- tool_trace entries name WHY a query was refused
-- ============================================================================
-- COMMENT ONLY -- no column, no data, no backfill. The shape of the jsonb this
-- column holds gained a key, and a column comment that describes a shape it no
-- longer holds is worse than none: this one is the first thing anyone reads
-- before writing a query against it, and it is what the 16-vs-6 investigation
-- was read through.
--
-- WHY THE KEY EXISTS. Every SQL failure in the recorded history of this feature
-- had one cause: the model wrote CURRENT_DATE, the validator refused it before
-- execution, and the model rewrote it with $2 and succeeded. Over 2026-09-08..09
-- that was 3 of 27 questions paying an extra round trip -- ten to twenty seconds
-- each on a box decoding at ~7 tokens/s -- and 3 of 3 clock reaches refused.
--
-- Establishing that took a regex over `sql` inside jsonb, by hand, which is not a
-- measurement anyone repeats. `error_reason` is the validator's branch slug, so
-- the same question is now a GROUP BY. It is set ONLY for a pre-execution
-- refusal: a database error has no branch to name, and its absence is what
-- separates "we refused this" from "Postgres did".
--
-- The slug is deliberately not the message. The message is written for the model
-- and gets reworded whenever it stops working; the slug is written for this
-- column and must survive that.

COMMENT ON COLUMN public.ai_chat_messages.tool_trace IS
  'Assistant rows: [{sql, description, row_count | error_kind, error_reason?}] for the queries behind the answer. `error_reason` is the SQL validator''s branch slug (clock, untyped_today, no_company_scope, sensitive_table, off_schema, nesting, ...) and is present only when the query was refused BEFORE execution -- a database error carries error_kind with no reason, which is how the two are told apart. Audit only: never replayed into a prompt, which is what keeps a 20-turn thread inside a 32K window. It is also the only record of what the model actually asked the database, and the only reason the 2026-09-09 "16 then 6 then 11 open quotes" answers could be settled at all.';
