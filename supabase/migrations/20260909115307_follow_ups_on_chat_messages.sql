-- ============================================================================
-- follow_ups: what the assistant offered to look at next
-- ============================================================================
-- Modern chat surfaces end an answer by offering the next question, and the
-- reason is not decoration: a shop owner who does not know what the assistant
-- can be asked will ask it three things and stop. The suggestions are written by
-- the model in the SAME response as the answer -- one call, no second round trip
-- -- because the box decodes at roughly 7 tokens/s and a second call per turn
-- would be a second multi-second wait for a garnish.
--
-- A COLUMN, NOT A payload KEY, for the reason `kind` and `report` are columns:
-- the browser reads this on every thread load and jsonb type-checks nothing.
--
-- NULLABLE, AND NULL IS NOT A GAP. "The model offered nothing" is a real and
-- common outcome -- it is what the handler stores when the answer was a refusal,
-- when the response failed schema validation, or when nothing useful follows.
-- So there is no invariant for the existing rows to violate and NO BACKFILL IS
-- OWED: every row written before today genuinely had no suggestions. That is the
-- distinction the no-silent-fallbacks rule turns on. What is NOT allowed, and is
-- not done here, is a read path that computes suggestions live when the column
-- is empty.

ALTER TABLE public.ai_chat_messages ADD COLUMN follow_ups jsonb;

COMMENT ON COLUMN public.ai_chat_messages.follow_ups IS
  'Assistant rows: up to three questions the model offered to answer next, as a jsonb array of strings, written by the materialising trigger from result.follow_ups. NULL means it offered none -- a normal outcome, not missing data. The browser renders them on the newest turn only and narrows the shape on read (followUpsOf in utils/aiChatAccess.ts), so a malformed array costs the chips and never the answer.';

-- ============================================================================
-- The trigger carries them onto the turn
-- ============================================================================
-- CREATE OR REPLACE, not DROP + CREATE: the signature is unchanged, so the ACL
-- (service_role and jigged_ai_worker only) and the entry in
-- definer_writers_missing_write_gate()'s allowlist both survive. A DROP would
-- destroy the ACL and hand function_execute_leaks() a browser-callable
-- SECURITY DEFINER writer. The COMMENT is re-issued because its text changes.
--
-- Rebuilt from the NEWEST body (20260909005528, which taught it to read
-- payload.request and to materialise a report turn) -- diffed against it rather
-- than assumed, so no behaviour added since the table was created is dropped.
--
-- CHAT ONLY. A report's follow-ups would be suggestions about a document the
-- reader has not opened yet, so the column stays NULL on a report turn.

CREATE OR REPLACE FUNCTION public.ai_jobs_materialize_chat_turn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_next     integer;
    v_question text;
    v_answer   text;
    v_summary  text;
    v_covers   integer;
    v_report   jsonb;
    v_follow   jsonb;
BEGIN
    IF NEW.thread_id IS NULL OR NEW.kind NOT IN ('chat', 'report') OR NEW.status <> 'succeeded' THEN
        RETURN NEW;
    END IF;
    -- Idempotent on a re-update of an already-succeeded row.
    IF OLD.status = 'succeeded' THEN
        RETURN NEW;
    END IF;

    BEGIN
        -- The person's words: payload.question through the chat door, payload.request
        -- through the report door. A report the model chose in a conversation has
        -- the former and kind = 'report'.
        v_question := COALESCE(NEW.payload ->> 'question', NEW.payload ->> 'request');

        IF NEW.kind = 'report' THEN
            -- The headline is the answer; the spec rides beside it so the reader
            -- can open the page from the thread.
            v_report := NEW.result -> 'report';
            IF v_report IS NULL OR v_report = 'null'::jsonb THEN
                RAISE WARNING 'ai_jobs % succeeded with no report; nothing materialised', NEW.id;
                RETURN NEW;
            END IF;
            v_answer := COALESCE(NULLIF(btrim(v_report ->> 'headline'), ''), v_report ->> 'title', 'Report');
        ELSE
            v_answer := NEW.result ->> 'answer';
        END IF;
        IF v_answer IS NULL OR length(btrim(v_answer)) = 0 THEN
            RAISE WARNING 'ai_jobs % succeeded with no answer; nothing materialised', NEW.id;
            RETURN NEW;
        END IF;

        -- Stored only when it is genuinely a non-empty ARRAY. A model that
        -- returned a string, an object or [] leaves the column NULL, which the
        -- browser and this column's comment both read as "offered none". The
        -- shape is checked here as well as in the browser because this is the
        -- write path, and a jsonb column enforces nothing on its own.
        IF NEW.kind = 'chat'
           AND jsonb_typeof(NEW.result -> 'follow_ups') = 'array'
           AND jsonb_array_length(NEW.result -> 'follow_ups') > 0 THEN
            v_follow := NEW.result -> 'follow_ups';
        ELSE
            v_follow := NULL;
        END IF;

        -- The one-in-flight index means no other job on this thread can be
        -- materialising concurrently, so max(seq) is safe to read here.
        SELECT COALESCE(MAX(seq), 0) INTO v_next
          FROM public.ai_chat_messages WHERE thread_id = NEW.thread_id;

        IF v_question IS NOT NULL AND length(btrim(v_question)) > 0 THEN
            v_next := v_next + 1;
            INSERT INTO public.ai_chat_messages
                (thread_id, company_id, seq, role, content, job_id, token_estimate)
            VALUES (NEW.thread_id, NEW.company_id, v_next, 'user', v_question, NEW.id,
                    ceil(length(v_question) / 4.0));
        END IF;

        v_next := v_next + 1;
        INSERT INTO public.ai_chat_messages
            (thread_id, company_id, seq, role, content, chart_config, tool_trace, report,
             follow_ups, job_id, token_estimate)
        VALUES (NEW.thread_id, NEW.company_id, v_next, 'assistant', v_answer,
                CASE WHEN NEW.kind = 'chat' THEN NULLIF(NEW.result -> 'chart_config', 'null'::jsonb) END,
                NULLIF(NEW.result -> 'tool_trace', 'null'::jsonb),
                CASE WHEN NEW.kind = 'report' THEN jsonb_build_object(
                    'report', v_report,
                    'dropped', COALESCE(NEW.result -> 'dropped', '[]'::jsonb),
                    'tool_call_count', jsonb_array_length(COALESCE(NEW.result -> 'tool_calls', '[]'::jsonb))
                ) END,
                v_follow,
                NEW.id, ceil(length(v_answer) / 4.0));

        -- A summary the chat handler produced after this answer, covering the
        -- oldest turns it evicted. Its own row, never regenerated. A report makes
        -- no summary.
        v_summary := NEW.result ->> 'summary';
        v_covers  := NULLIF(NEW.result ->> 'summary_covers_through_seq', '')::integer;
        IF NEW.kind = 'chat' AND v_summary IS NOT NULL AND length(btrim(v_summary)) > 0 AND v_covers IS NOT NULL THEN
            v_next := v_next + 1;
            INSERT INTO public.ai_chat_messages
                (thread_id, company_id, seq, role, content, covers_through_seq, job_id, token_estimate)
            VALUES (NEW.thread_id, NEW.company_id, v_next, 'summary', v_summary, v_covers, NEW.id,
                    ceil(length(v_summary) / 4.0));
        END IF;

        UPDATE public.ai_chat_threads SET updated_at = now() WHERE id = NEW.thread_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ai_jobs_materialize_chat_turn: job % on thread % not materialised: %',
            NEW.id, NEW.thread_id, SQLERRM;
    END;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ai_jobs_materialize_chat_turn() IS
  'AFTER UPDATE trigger on ai_jobs: when a chat or report job with a thread succeeds, appends the user turn (payload.question, or payload.request through the report door), the assistant turn (result.answer with chart_config, tool_trace and, for chat, result.follow_ups; for a report the headline with the spec in `report`) and, for chat, any summary (result.summary, covering result.summary_covers_through_seq) to ai_chat_messages. A chat job whose model chose compose_report settles with kind = ''report'' and materialises as one. SECURITY DEFINER so jigged_ai_worker''s report writes the thread without a grant on it. Never raises: a failure is a WARNING and the job still settles, because the result is already on the job row and losing it would be the worse outcome.';
