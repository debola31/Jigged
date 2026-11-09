-- Drop the two Database Webhooks that sent the waitlist and feedback emails.
--
-- Both were created in the production dashboard, never in a migration (the baseline removed them
-- for branch portability, 20260527151536_baseline.sql), and each called its Edge Function with a
-- legacy service_role JWT stored in the trigger. The project's legacy API keys were disabled on
-- 2026-03-11, and from then every call was refused (401 "Legacy API keys are disabled") inside
-- pg_net, where nothing reported it: no sign-up confirmation, team heads-up or feedback email
-- went out for eight months.
--
-- The emails are now asked for by the app itself, which reports a failure to Sentry:
--   waitlist → app/actions/waitlist.ts → lib/waitlistServer.ts → notify-waitlist (secret key)
--   feedback → utils/feedbackAccess.ts → notify-feedback (the person's own session)
--
-- IF EXISTS because these triggers exist only in production: local and preview databases built
-- from the migrations never had them.
DROP TRIGGER IF EXISTS "waitlist" ON public.waitlist;
DROP TRIGGER IF EXISTS "feedback" ON public.feedback;
