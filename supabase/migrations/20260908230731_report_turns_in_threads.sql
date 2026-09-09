-- ============================================================================
-- Reports are turns in a conversation.
-- ============================================================================
-- A report is asked for from the same composer as a question (the composer's
-- Report mode), so the job joins the thread and the trigger that already
-- materialises chat turns materialises a report turn: the request as the user
-- row, the headline as the assistant row, and the spec the browser draws from
-- stored beside it. The Reports card on the dashboard goes; the History rail
-- lists reports from the job rows as before, and the thread shows them in
-- place.
--
-- Why a column and not a join back to ai_jobs: the message is the record and
-- outlives the queue row (the job FK is ON DELETE SET NULL for that reason), so
-- the thing the reader opens must live on the message.

ALTER TABLE public.ai_chat_messages
    ADD COLUMN report jsonb;

COMMENT ON COLUMN public.ai_chat_messages.report IS
  'For a report turn: {report: <ReportSpec as the handler returned it>, dropped: [titles the chart gate refused], tool_call_count}. Only an assistant row carries one. The browser renders the PDF from this, the same way it does from ai_jobs.result.';

ALTER TABLE public.ai_chat_messages
    ADD CONSTRAINT ai_chat_messages_report_is_an_answer
        CHECK (report IS NULL OR role = 'assistant');

-- The trigger, redefined to know two kinds of job. CREATE OR REPLACE keeps the
-- ACL (service_role and jigged_ai_worker only) and the allowlist entry in
-- definer_writers_missing_write_gate(); the comment is re-issued because its
-- text changes.
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
BEGIN
    IF NEW.thread_id IS NULL OR NEW.kind NOT IN ('chat', 'report') OR NEW.status <> 'succeeded' THEN
        RETURN NEW;
    END IF;
    -- Idempotent on a re-update of an already-succeeded row.
    IF OLD.status = 'succeeded' THEN
        RETURN NEW;
    END IF;

    BEGIN
        IF NEW.kind = 'report' THEN
            -- The request is the question; the headline is the answer; the spec
            -- rides beside it so the reader can open the page from the thread.
            v_question := NEW.payload ->> 'request';
            v_report   := NEW.result  -> 'report';
            IF v_report IS NULL OR v_report = 'null'::jsonb THEN
                RAISE WARNING 'ai_jobs % succeeded with no report; nothing materialised', NEW.id;
                RETURN NEW;
            END IF;
            v_answer := COALESCE(NULLIF(btrim(v_report ->> 'headline'), ''), v_report ->> 'title', 'Report');
        ELSE
            v_question := NEW.payload ->> 'question';
            v_answer   := NEW.result  ->> 'answer';
        END IF;
        IF v_answer IS NULL OR length(btrim(v_answer)) = 0 THEN
            RAISE WARNING 'ai_jobs % succeeded with no answer; nothing materialised', NEW.id;
            RETURN NEW;
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
            (thread_id, company_id, seq, role, content, chart_config, tool_trace, report, job_id, token_estimate)
        VALUES (NEW.thread_id, NEW.company_id, v_next, 'assistant', v_answer,
                CASE WHEN NEW.kind = 'chat' THEN NULLIF(NEW.result -> 'chart_config', 'null'::jsonb) END,
                NULLIF(NEW.result -> 'tool_trace', 'null'::jsonb),
                CASE WHEN NEW.kind = 'report' THEN jsonb_build_object(
                    'report', v_report,
                    'dropped', COALESCE(NEW.result -> 'dropped', '[]'::jsonb),
                    'tool_call_count', jsonb_array_length(COALESCE(NEW.result -> 'tool_calls', '[]'::jsonb))
                ) END,
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
  'AFTER UPDATE trigger on ai_jobs: when a chat or report job with a thread succeeds, appends the user turn (payload.question, or payload.request for a report), the assistant turn (result.answer with chart_config and tool_trace; for a report the headline with the spec in `report`) and, for chat, any summary (result.summary, covering result.summary_covers_through_seq) to ai_chat_messages. SECURITY DEFINER so jigged_ai_worker''s report writes the thread without a grant on it. Never raises: a failure is a WARNING and the job still settles, because the result is already on the job row and losing it would be the worse outcome.';
