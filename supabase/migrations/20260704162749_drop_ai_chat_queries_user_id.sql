-- Drop the unused ai_chat_queries.user_id column.
--
-- Rationale (issue #80): AI chat rate limiting is per-company, not per-user.
-- Every insert wrote user_id = NULL and nothing ever read it — the rate-limit
-- count keys off company_id, and the only other reader (the chat-history
-- endpoint) was removed in this change and never selected user_id anyway.
--
-- The dependent FK constraint (ai_chat_queries_user_id_fkey -> auth.users) and
-- the column comment drop automatically with the column. No RLS policy or index
-- references user_id (all are company_id-based), so nothing else is affected.

ALTER TABLE public.ai_chat_queries DROP COLUMN IF EXISTS user_id;
