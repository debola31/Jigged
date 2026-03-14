-- Grant anon role INSERT and UPDATE on waitlist table
-- Required for unauthenticated landing page "Request Access" form
GRANT INSERT, UPDATE ON public.waitlist TO anon;
