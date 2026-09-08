-- ============================================================================
-- ai_chat_threads, ai_chat_messages: a conversation becomes a record
-- ============================================================================
-- Insights chat was stateless -- one question, one answer, nothing kept but a
-- write-only transcript row. Long conversations on a local 32B at a 32K window
-- need a record to build the prompt FROM, and the shape every current system
-- converges on is the one here: an append-only per-message store is the record,
-- the prompt is a derived projection of it, and a summary of evicted turns is a
-- row of its own that says how far it covers (OpenAI compaction items, Anthropic
-- compaction blocks, OpenCode's summary messages). Deriving history from queue
-- rows was considered and rejected: a queue table is the wrong owner of a
-- conversation, and tool traces and answers would be inseparable.
--
-- WHO WRITES WHAT, and the constraint that shaped it. The desktop worker holds
-- "claim and report ai_jobs, insert ai_calls, and NOTHING else" -- no grant on
-- any tenant table (20260825135302, section 1). Rather than widen that contract,
-- a SECURITY DEFINER trigger on ai_jobs materialises the turn when a job
-- succeeds: the user row from payload.question, the assistant row from
-- result.answer, and a summary row when the handler produced one. The worker
-- keeps writing exactly one table; the browser creates threads under RLS and
-- reads messages; the route reads both to build the replay set and writes
-- neither. Nothing UPDATEs or DELETEs a message: not the browser, not the
-- backend. A thread is archived by deleted_at.
--
-- Also on ai_jobs: thread_id (the join to a thread), kind ('chat' | 'report' --
-- a real column, not a payload key, for the same reason `model` is: the Reports
-- list filters on it and jsonb type-checks nothing), one in-flight job per
-- thread, and error_kind 'context_overflow' -- the native Ollama adapter's
-- fail-visible answer to a prompt that no longer fits the window, where the
-- /v1 path silently cut the schema off the front.

-- ============================================================================
-- 1. Threads
-- ============================================================================
CREATE TABLE public.ai_chat_threads (
    id          uuid        NOT NULL DEFAULT gen_random_uuid(),
    company_id  uuid        NOT NULL,
    created_by  uuid        DEFAULT auth.uid(),
    title       text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,

    CONSTRAINT ai_chat_threads_pkey PRIMARY KEY (id),
    CONSTRAINT ai_chat_threads_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE CASCADE,
    -- SET NULL, not CASCADE: a departed colleague's conversation is still the
    -- shop's record of what was asked and answered.
    CONSTRAINT ai_chat_threads_created_by_fk FOREIGN KEY (created_by)
        REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT ai_chat_threads_title_not_blank CHECK (length(btrim(title)) > 0),
    CONSTRAINT ai_chat_threads_title_cap CHECK (length(title) <= 120)
);

-- The only hot read: "my recent conversations in this shop".
CREATE INDEX idx_ai_chat_threads_recent
    ON public.ai_chat_threads (company_id, created_by, created_at DESC)
    WHERE deleted_at IS NULL;

COMMENT ON TABLE public.ai_chat_threads IS
  'One insights conversation. PER USER: created by the browser under RLS with created_by = auth.uid(), and readable only by that user -- a shop admin does not get a colleague''s questions, matching saved_insights. Title is the first question truncated; no model call names a thread. Archived by deleted_at, never deleted: the messages under it are the record of what the AI told someone.';
COMMENT ON COLUMN public.ai_chat_threads.created_by IS
  'auth.users(id), defaulted from auth.uid() on the browser''s INSERT. The FastAPI route trusts thread_id from the request body (it has no auth of its own -- ai-insights.md, Known gaps), so per-user integrity rests on this RLS, which is why the browser and not the route creates the thread.';

CREATE TRIGGER ai_chat_threads_updated_at
    BEFORE UPDATE ON public.ai_chat_threads
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- 2. Messages
-- ============================================================================
CREATE TABLE public.ai_chat_messages (
    id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
    thread_id          uuid        NOT NULL,
    company_id         uuid        NOT NULL,
    seq                integer     NOT NULL,
    role               text        NOT NULL,
    content            text        NOT NULL,
    chart_config       jsonb,
    tool_trace         jsonb,
    covers_through_seq integer,
    token_estimate     integer,
    job_id             uuid,
    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ai_chat_messages_pkey PRIMARY KEY (id),
    CONSTRAINT ai_chat_messages_thread_fk FOREIGN KEY (thread_id)
        REFERENCES public.ai_chat_threads(id) ON DELETE CASCADE,
    CONSTRAINT ai_chat_messages_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE CASCADE,
    -- SET NULL: the queue row is operational state that may one day be pruned;
    -- the message is the record and outlives it.
    CONSTRAINT ai_chat_messages_job_fk FOREIGN KEY (job_id)
        REFERENCES public.ai_jobs(id) ON DELETE SET NULL,
    CONSTRAINT ai_chat_messages_role_check CHECK (role IN ('user', 'assistant', 'summary')),
    CONSTRAINT ai_chat_messages_seq_positive CHECK (seq >= 1),
    CONSTRAINT ai_chat_messages_thread_seq_unique UNIQUE (thread_id, seq),
    CONSTRAINT ai_chat_messages_content_not_blank CHECK (length(btrim(content)) > 0),
    -- A summary says how far it covers, and only a summary does.
    CONSTRAINT ai_chat_messages_summary_says_what_it_covers
        CHECK ((role = 'summary') = (covers_through_seq IS NOT NULL))
);

CREATE INDEX idx_ai_chat_messages_thread ON public.ai_chat_messages (thread_id, seq);

COMMENT ON TABLE public.ai_chat_messages IS
  'Append-only turns of one thread, in seq order. Written ONLY by the trigger on ai_jobs when a job succeeds (user row from payload, assistant row from result, summary row when the handler compacted); the browser reads, the backend reads, nobody updates or deletes. The prompt for the next turn is the latest summary plus every user/assistant row after its covers_through_seq -- old tool results are never replayed, they live in tool_trace for audit.';
COMMENT ON COLUMN public.ai_chat_messages.covers_through_seq IS
  'Summary rows only: every message with seq <= this is folded into the summary and is not replayed. The next enqueue ships the latest summary plus the rows after this seq.';
COMMENT ON COLUMN public.ai_chat_messages.tool_trace IS
  'Assistant rows: [{sql, description, row_count | error_kind}] for the queries behind the answer. Audit only -- never replayed into a prompt, which is what keeps a 20-turn thread inside a 32K window.';
COMMENT ON COLUMN public.ai_chat_messages.token_estimate IS
  'ceil(length(content) / 4). The handler''s budget arithmetic uses the same estimate; ai_calls.tokens_in is the server''s real count for calibrating it.';

-- ============================================================================
-- 3. ai_jobs: the join, the kind, one in flight, and the new error kind
-- ============================================================================
ALTER TABLE public.ai_jobs
    ADD COLUMN thread_id uuid REFERENCES public.ai_chat_threads(id) ON DELETE SET NULL;

ALTER TABLE public.ai_jobs ADD COLUMN kind text NOT NULL DEFAULT 'chat';
ALTER TABLE public.ai_jobs ADD CONSTRAINT ai_jobs_kind_check CHECK (kind IN ('chat', 'report'));

-- One question at a time per thread. The route turns the violation into a 409;
-- without it two tabs could interleave answers that each ignore the other.
CREATE UNIQUE INDEX ai_jobs_one_in_flight_per_thread
    ON public.ai_jobs (thread_id)
    WHERE thread_id IS NOT NULL AND status IN ('queued', 'claimed', 'running');

-- The Reports list: a shop's recent report jobs, newest first.
CREATE INDEX idx_ai_jobs_reports
    ON public.ai_jobs (company_id, created_at DESC)
    WHERE kind = 'report';

-- Rebuilt from the constraint's NEWEST definition (20260826171255 -- verified,
-- not assumed) so no entry is silently dropped. No backfill: every existing row
-- already satisfies the wider check.
ALTER TABLE public.ai_jobs DROP CONSTRAINT ai_jobs_error_kind_check;
ALTER TABLE public.ai_jobs ADD CONSTRAINT ai_jobs_error_kind_check
    CHECK (error_kind IS NULL OR error_kind IN
        ('ai_offline', 'provider', 'schema', 'timeout', 'page_out_of_range',
         'internal', 'error_echo', 'context_overflow'));

COMMENT ON COLUMN public.ai_jobs.thread_id IS
  'The conversation this chat job belongs to, or NULL for a one-off question and for every row before threads existed. No backfill: single-turn is what those rows were. The materialising trigger keys on it.';
COMMENT ON COLUMN public.ai_jobs.kind IS
  'chat (the ask bar) or report (a one-page executive summary). A real column so the Reports list filters on something types/database.ts knows about; the handler dispatches on the same value carried in payload.kind.';
COMMENT ON COLUMN public.ai_jobs.payload IS
  'Feature-specific input. NEVER base64 image bytes: a 40-page drawing package would be a 100MB jsonb row. Images are referenced by Supabase Storage path plus a signed URL, and rendered in memory by the worker. Insights chat: {question, today, thread_id, summary: {content, covers_through_seq} | null, history: [{seq, role, content}]} -- the replay set rides in the payload because the desktop worker gets the job row and nothing else. Insights report: {kind: report, request, today}.';

-- ============================================================================
-- 4. The trigger: a succeeded job becomes a turn
-- ============================================================================
-- SECURITY DEFINER so the worker's report -- an UPDATE on ai_jobs as
-- jigged_ai_worker -- writes the thread without that role holding a grant on it.
--
-- IT MUST NEVER RAISE. An exception here aborts the worker's UPDATE, the job
-- never reads succeeded, the lease sweep times it out, and the user is told a
-- question failed whose answer was already computed. So every failure inside is
-- a WARNING in the Postgres log and the job still settles; the answer stays on
-- the job row (which the browser renders directly), and only the thread's copy
-- of this turn is missing. That is the one silent-degradation trade in this
-- migration, and it is made in favour of the answer reaching the person.
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
BEGIN
    IF NEW.thread_id IS NULL OR NEW.kind <> 'chat' OR NEW.status <> 'succeeded' THEN
        RETURN NEW;
    END IF;
    -- Idempotent on a re-update of an already-succeeded row.
    IF OLD.status = 'succeeded' THEN
        RETURN NEW;
    END IF;

    BEGIN
        v_question := NEW.payload ->> 'question';
        v_answer   := NEW.result  ->> 'answer';
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
            (thread_id, company_id, seq, role, content, chart_config, tool_trace, job_id, token_estimate)
        VALUES (NEW.thread_id, NEW.company_id, v_next, 'assistant', v_answer,
                NULLIF(NEW.result -> 'chart_config', 'null'::jsonb),
                NULLIF(NEW.result -> 'tool_trace', 'null'::jsonb),
                NEW.id, ceil(length(v_answer) / 4.0));

        -- A summary the handler produced after this answer, covering the oldest
        -- turns it evicted. Its own row, never regenerated.
        v_summary := NEW.result ->> 'summary';
        v_covers  := NULLIF(NEW.result ->> 'summary_covers_through_seq', '')::integer;
        IF v_summary IS NOT NULL AND length(btrim(v_summary)) > 0 AND v_covers IS NOT NULL THEN
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
  'AFTER UPDATE trigger on ai_jobs: when a chat job with a thread succeeds, appends the user turn (payload.question), the assistant turn (result.answer, chart_config, tool_trace) and any summary (result.summary, covering result.summary_covers_through_seq) to ai_chat_messages. SECURITY DEFINER so jigged_ai_worker''s report writes the thread without a grant on it. Never raises: a failure is a WARNING and the job still settles, because the answer is already on the job row and losing it would be the worse outcome.';

CREATE TRIGGER ai_jobs_materialize_chat_turn
    AFTER UPDATE OF status ON public.ai_jobs
    FOR EACH ROW
    WHEN (NEW.status = 'succeeded' AND NEW.thread_id IS NOT NULL)
    EXECUTE FUNCTION public.ai_jobs_materialize_chat_turn();

-- A trigger function is still a function: EXECUTE goes to PUBLIC by default and
-- function_execute_leaks() would list a DEFINER one the browser can call. Name
-- the roles. The two that fire it are the ones that report jobs.
REVOKE EXECUTE ON FUNCTION public.ai_jobs_materialize_chat_turn() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ai_jobs_materialize_chat_turn() TO service_role, jigged_ai_worker;

-- ============================================================================
-- 5. RLS and grants -- both layers, as always
-- ============================================================================
-- Explicit: rls_auto_enable() exists locally and on preview but never in prod.
ALTER TABLE public.ai_chat_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chat_messages ENABLE ROW LEVEL SECURITY;

-- Threads: the browser creates, reads, retitles and archives its OWN. Both
-- halves of the predicate matter: created_by keeps a colleague out, company_id
-- keeps a user who has left the company out even if the row still names them.
CREATE POLICY ai_chat_threads_own ON public.ai_chat_threads
    FOR ALL TO authenticated
    USING (created_by = auth.uid() AND company_id IN (SELECT public.get_user_company_ids()))
    WITH CHECK (created_by = auth.uid() AND company_id IN (SELECT public.get_user_company_ids()));

-- Messages: readable through the thread the reader owns. No browser write path
-- at all -- the trigger is the only writer.
CREATE POLICY ai_chat_messages_read_own_thread ON public.ai_chat_messages
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.ai_chat_threads t
         WHERE t.id = ai_chat_messages.thread_id
           AND t.created_by = auth.uid()
           AND t.company_id IN (SELECT public.get_user_company_ids())
    ));

-- Both tables carry company_id, so both take the billing write gate; on
-- messages it is inert (no browser write grant) and on threads it is what stops
-- a lapsed shop opening conversations that would spend inference.
SELECT public.apply_billing_write_gate('public.ai_chat_threads');
SELECT public.apply_billing_write_gate('public.ai_chat_messages');

-- REVOKE FIRST, THEN GRANT (20260818142814 measured why: a new public table
-- arrives with TRUNCATE, REFERENCES, TRIGGER and MAINTAIN for every browser role
-- from the baseline's default privileges). Then exactly what each role needs.
REVOKE ALL ON TABLE public.ai_chat_threads  FROM anon, authenticated, service_role, jigged_ai_readonly;
REVOKE ALL ON TABLE public.ai_chat_messages FROM anon, authenticated, service_role, jigged_ai_readonly;

GRANT SELECT, INSERT, UPDATE ON TABLE public.ai_chat_threads TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ai_chat_threads TO service_role;

-- Append-only, and not by convention: no UPDATE or DELETE grant exists on
-- messages for any role. service_role gets INSERT for the integration tests that
-- seed a thread; the route never writes here.
GRANT SELECT         ON TABLE public.ai_chat_messages TO authenticated;
GRANT SELECT, INSERT ON TABLE public.ai_chat_messages TO service_role;

-- Not a no-op: the baseline's default privileges grant SELECT on every new public
-- table to the AI SQL role. A model must not read conversations -- its own or
-- anyone else's -- through execute_sql.
REVOKE ALL ON TABLE public.ai_chat_threads  FROM jigged_ai_readonly;
REVOKE ALL ON TABLE public.ai_chat_messages FROM jigged_ai_readonly;

-- ============================================================================
-- 6. The guards: exempt the new tables and the new trigger
-- ============================================================================
-- Both tables have company_id, so tenant_tables_missing_ai_decision() lists them
-- until a decision is recorded. The decision: the AI's own plumbing, never
-- readable by the model. Redefined from its NEWEST body (20260906121901, which
-- added lot_certificates -- verified by diffing the two, not assumed) so no
-- entry is dropped.
CREATE OR REPLACE FUNCTION public.tenant_tables_missing_ai_decision()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $fn$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN (
      -- Third-party credentials and customer account numbers. Never.
      'quickbooks_connections', 'quickbooks_customer_map', 'quickbooks_desktop_connections',
      'quickbooks_invoice_line_items', 'quickbooks_invoice_links', 'quickbooks_terms_cache',
      'customer_carrier_accounts',
      -- Authentication, authorisation, and the legal record. Never.
      'user_company_access', 'invitations', 'auth_audit_log', 'terms_acceptances',
      -- Billing state. "Am I paid up" is a support question rather than an
      -- analytics one, and this table backs the write gate.
      'company_billing',
      -- Per-operator pace and attention data. Excluded on the surveillance
      -- guardrail in docs/modules/operator-view.md: an owner able to ask "rank my
      -- operators by speed" is the reporting layer that document forbids, even
      -- though the guardrail's letter covers operator-FACING surfaces only.
      'operator_events', 'job_operation_completions', 'job_operation_intervals',
      'note_views', 'note_reactions',
      -- The AI's own plumbing. Feeding a model its own logs, config, queue and
      -- conversations invites it to answer questions about itself instead of
      -- about the shop.
      'ai_chat_queries', 'ai_config', 'ai_jobs', 'saved_insights',
      'ai_chat_threads', 'ai_chat_messages',
      -- Free text and uploads: note bodies, attachments, comments. Readable in
      -- principle, but each wants its own look at what the text contains before
      -- it lands in a prompt. `lot_certificates` added 20260906121901 -- a mill
      -- cert is a supplier's PDF, and its contents deserve that same look.
      'notes', 'note_media', 'job_attachments', 'part_attachments',
      'work_center_attachments', 'part_comments', 'lot_certificates',
      -- Closed today with no objection known. Opening one is a single
      -- apply_ai_read_access call plus a schema_context.py entry, so that the
      -- model is also told the table exists.
      'company_custom_units', 'company_order_counters', 'feedback',
      'inventory_locations', 'part_location_stock', 'part_customer_references',
      'job_fulfillment_audit'
    )
    -- BOTH layers. has_any_column_privilege rather than has_table_privilege so a
    -- column-level grant still counts as a decision (see `shipments`).
    AND NOT (
      has_any_column_privilege('jigged_ai_readonly', c.oid, 'SELECT')
      AND EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = c.oid AND p.polname = 'ai_readonly_select'
      )
    )
  ORDER BY 1;
$fn$;

REVOKE EXECUTE ON FUNCTION public.tenant_tables_missing_ai_decision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_tables_missing_ai_decision() TO service_role;

-- The materialising trigger is SECURITY DEFINER and writes two gated tables, so
-- definer_writers_missing_write_gate() lists it. It belongs in the triggers
-- group: the statement that fired it -- the worker's report on a job that was
-- gated at enqueue -- is the gated write. Redefined from its NEWEST body
-- (20260903203741) so no entry is dropped.
CREATE OR REPLACE FUNCTION public.definer_writers_missing_write_gate()
RETURNS TABLE(function_name text)
LANGUAGE sql
STABLE
AS $$
  WITH gated AS (
    SELECT DISTINCT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'billing_gate_insert'
  )
  SELECT p.proname::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND p.prosecdef
    AND EXISTS (
      SELECT 1 FROM gated g
      WHERE pg_get_functiondef(p.oid) ~* ('(insert into|update)\s+(public\.)?' || g.tablename)
    )
    AND pg_get_functiondef(p.oid) NOT LIKE '%company_can_write%'
    AND pg_get_functiondef(p.oid) NOT LIKE '%inv_assert_can_write%'
    AND p.proname NOT IN (
      -- triggers: the statement that fired them was gated
      'seed_new_part_balance', 'note_views_bump_counts',
      'void_intervals_with_completion',
      -- Added 20260903203741: recompute_job_operation_status_from_completion
      -- became SECURITY DEFINER so the guard trigger on job_operations can tell
      -- a derived write from a hand-written one by current_user alone. It writes
      -- job_parts (gated), but it only ever runs FROM a trigger, so the
      -- statement that fired it was itself gated.
      'recompute_job_operation_status_from_completion',
      -- Added 20260907234149: materialises a chat turn from a job the worker
      -- reports; the job was gated when the route enqueued it.
      'ai_jobs_materialize_chat_turn',
      -- internal helpers: no browser EXECUTE, always called post-assertion
      'inv_get_or_create_unassigned', 'recompute_part_quantity_from_locations',
      -- demo bootstrap: company_can_write() is true for is_demo by design
      'seed_demo_data',
      -- known gap, filed separately: browser-callable, genuinely ungated
      'create_shipment_with_line_items'
    )
  ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION public.definer_writers_missing_write_gate() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.definer_writers_missing_write_gate() TO service_role;
