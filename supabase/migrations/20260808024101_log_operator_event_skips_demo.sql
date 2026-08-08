-- log_operator_event: write nothing for a demo company.
--
-- WHY. operator_events is the capture funnel, and for the first weeks of the pilot it is
-- the ONLY readable signal — the notes corpus starts empty, so view counts, the login
-- banner and reactions are all structurally silent until somebody writes something. Its
-- header (utils/operatorEventsAccess.ts) sets out what each event distinguishes, and
-- every one of those readings is a RATIO against app_opened:
--
--     app_opened ~ 0                             -> deployment, not the product
--     op_card_opened high, composer_focused ~ 0  -> container fit
--     composer_focused high, note_saved low      -> capture friction
--
-- Until now a demo company could not generate these, because the operator surface had no
-- way into demo mode. It does now: an operator can enter the demo company from the "Me"
-- tab. Exploring the demo is exactly the behaviour that fires app_opened, station_selected,
-- op_card_opened and completion_recorded in bursts — a new hire being shown the app
-- produces a textbook funnel that measures nobody's real work. Left alone it would
-- inflate the denominator of every ratio above and make a good week and a training
-- session indistinguishable.
--
-- WHY SERVER-SIDE. One check here covers all twelve event kinds and every call site,
-- present and future. The alternative — filtering is_demo at read time — is the silent
-- missing-filter failure CLAUDE.md names as the most-violated rule in the repo: an
-- analysis that forgets the filter looks exactly like one that didn't need it. Deciding
-- once, at the write, means the table cannot contain the rows to forget about.
--
-- WHY A SILENT RETURN. This function already returns silently for a non-member, on the
-- rule that instrumentation must never break, block or slow the interaction it measures.
-- A demo company gets the same treatment for the same reason; the caller is
-- fire-and-forget and has no success signal to branch on either way.
--
-- NOT the same question as PostHog. `demo entered` is captured deliberately (see
-- docs/telemetry.md) — we want to know whether anyone explore the demos. What must not happen is
-- demo work being counted as shop-floor work, which is what this prevents.

CREATE OR REPLACE FUNCTION public.log_operator_event(
  p_company_id uuid,
  p_kind       text,
  p_context    jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_actor_id uuid;
BEGIN
  -- Demo data is not shop-floor data. Checked before the membership lookup because
  -- it is the cheaper of the two and neither can rescue the other.
  IF EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id AND is_demo) THEN
    RETURN;
  END IF;

  v_actor_id := public.get_operator_access_id(p_company_id);
  -- Not a member of this company: log nothing rather than raising. Instrumentation must
  -- never be able to break the interaction it is measuring.
  IF v_actor_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.operator_events (company_id, actor_id, kind, context)
  VALUES (p_company_id, v_actor_id, p_kind, COALESCE(p_context, '{}'::jsonb));
END;
$$;

COMMENT ON FUNCTION public.log_operator_event(uuid, text, jsonb) IS
'Records one operator capture-funnel event. Returns void and never raises: a non-member logs nothing, and so does a demo company — demo work must not enter the funnel that every adoption ratio is measured against. Fire-and-forget by contract; callers must not await it.';
