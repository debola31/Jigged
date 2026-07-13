-- Quote lead time becomes free text; the job due date is entered manually.
--
-- Lead time was a structured (lead_time_value, lead_time_unit) pair normalized
-- into lead_time_days, and the quote→job conversion auto-computed the job due
-- date as today + lead_time_days. That's too rigid — users want to type things
-- like "2–3 weeks", "In stock", or "Call to confirm". Replace the three numeric
-- columns with one free-text column. The due-date-from-lead-time derivation is
-- severed in app code (convertQuoteToJob), where the due date now comes only
-- from a required picker at conversion time.

-- 1. Add the free-text column (nullable; "required" is enforced in the quote form).
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS lead_time_text text;

-- 2. Backfill from the stated value+unit (faithful wording, e.g. "6 weeks"),
--    falling back to the normalized day count, so no stated lead time is lost.
UPDATE public.quotes
   SET lead_time_text = CASE
       WHEN lead_time_value IS NOT NULL AND lead_time_unit IS NOT NULL
           THEN lead_time_value::text || ' ' || replace(lead_time_unit, '_', ' ')
       WHEN lead_time_days IS NOT NULL
           THEN lead_time_days::text || ' days'
       ELSE NULL
   END
 WHERE lead_time_text IS NULL;

-- 3. seed_demo_data (demo-company reset) still INSERTs quotes.lead_time_days.
--    Rather than transcribe the whole function (it embeds a large JSON demo
--    template), fetch its current definition and surgically swap the quotes
--    insert's lead-time column + value to write lead_time_text (a "<n> days"
--    string derived from the template's day count). Fail loud if the expected
--    patterns aren't present, so a future body change can't silently no-op this.
DO $$
DECLARE
    v_def text := pg_get_functiondef('public.seed_demo_data(uuid, uuid, text)'::regprocedure);
BEGIN
    IF strpos(v_def, 'lead_time_days, expiration_date, created_by)') = 0
       OR strpos(v_def, 'NULLIF(v_item->>''lead_time_days'', '''')::integer,') = 0 THEN
        RAISE EXCEPTION 'seed_demo_data: expected lead-time insert patterns not found — update this migration';
    END IF;
    v_def := replace(v_def,
        'lead_time_days, expiration_date, created_by)',
        'lead_time_text, expiration_date, created_by)');
    v_def := replace(v_def,
        'NULLIF(v_item->>''lead_time_days'', '''')::integer,',
        'NULLIF(v_item->>''lead_time_days'', '''') || '' days'',');
    EXECUTE v_def;
END $$;

-- 4. Drop the three numeric lead-time columns. Dropping lead_time_unit
--    auto-drops its CHECK constraint. lead_time_text is now the only source.
ALTER TABLE public.quotes
    DROP COLUMN IF EXISTS lead_time_value,
    DROP COLUMN IF EXISTS lead_time_unit,
    DROP COLUMN IF EXISTS lead_time_days;

-- 5. jobs.lead_time_days was a write-only snapshot of the quote's numeric lead
--    time — never read or displayed. With lead time now free text and the due
--    date entered manually at conversion, it has no consumer. Drop it.
ALTER TABLE public.jobs DROP COLUMN IF EXISTS lead_time_days;
