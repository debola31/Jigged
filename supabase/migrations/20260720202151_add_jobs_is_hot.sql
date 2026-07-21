-- "Hot" job flag: the digital equivalent of Contour's pink paper / "HOT" in red
-- pen at the top of a traveler. A rush-job marker that must be impossible to
-- miss anywhere someone decides what to work on next.
--
-- Visibility only — it has NO scheduling, capacity, or due-date behavior, and is
-- distinct from the production_status/fulfillment_status axes and from
-- deleted_at. Settable at job creation and toggleable anytime by office staff.

ALTER TABLE public.jobs
  ADD COLUMN is_hot boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.jobs.is_hot IS
  'Rush/"Hot" job marker — visibility only, no scheduling behavior. Sorts hot jobs first in the admin list and operator station queue.';
