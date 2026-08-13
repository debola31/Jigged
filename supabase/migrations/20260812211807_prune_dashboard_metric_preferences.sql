-- Retire the dashboard metric picker's stored preferences.
--
-- The scorecard row is now four fixed metrics — Overdue, Open Jobs, Completed,
-- Open Quotes — with no picker and no second page. Three preference keys existed
-- only to serve the picker and have no reader left in the codebase:
--
--   dashboard_metrics                        which metrics were pinned, and their order
--   dashboard_overdue_selectable_migrated    a one-time flag for folding Overdue into
--                                            pre-existing pinned lists
--   dashboard_metric_periods                 a per-metric map of Today / This Week
--
-- The last one is REPLACED rather than simply dropped: the Completed card still
-- has a period control, so its value is carried across to a single scalar,
-- `dashboard_completed_period`. Preference order is deliberate — a period set on
-- `completed_jobs` wins, then one set on the retired `revenue` metric, since a
-- user who chose a window for their revenue figure meant that window for money,
-- and money now lives on the Completed card. Anything else falls to the default
-- ('this_week') by absence rather than by being written out.
--
-- Dropping the keys rather than leaving them is the point: an orphaned blob in
-- jsonb is dead weight that reads like live configuration to whoever finds it
-- next. `user_preferences.preferences` holds other, unrelated keys, so this
-- edits the object rather than clearing the column.

UPDATE public.user_preferences
SET preferences = (
      preferences
        - 'dashboard_metrics'
        - 'dashboard_overdue_selectable_migrated'
        - 'dashboard_metric_periods'
    )
    || CASE
         WHEN preferences #>> '{dashboard_metric_periods,completed_jobs}' IN ('today', 'this_week')
           THEN jsonb_build_object(
                  'dashboard_completed_period',
                  preferences #>> '{dashboard_metric_periods,completed_jobs}')
         WHEN preferences #>> '{dashboard_metric_periods,revenue}' IN ('today', 'this_week')
           THEN jsonb_build_object(
                  'dashboard_completed_period',
                  preferences #>> '{dashboard_metric_periods,revenue}')
         ELSE '{}'::jsonb
       END,
    updated_at = now()
WHERE preferences ?| ARRAY[
        'dashboard_metrics',
        'dashboard_overdue_selectable_migrated',
        'dashboard_metric_periods'
      ];
