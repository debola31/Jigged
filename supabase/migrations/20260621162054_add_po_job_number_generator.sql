-- Job-number generator for jobs created directly from a customer PO.
--
-- Quote-sourced jobs mirror their quote number (Q-0141 -> J-0141), drawing J-NNNN
-- from the Q-NNNN space. A PO job has no quote, so it needs its own series that
-- can never collide with that mirror. We use a distinct 'PO-J-' prefix with its
-- own per-company counter (mirrors generate_quote_number). 'PO-J-NNNN' never
-- matches '^J-\d+$', so the two series are disjoint.
--
-- A callable function (not a jobs insert trigger) keeps the quote path untouched:
-- a trigger would have to branch quote-vs-PO. createJobFromPurchaseOrder calls
-- this, then relies on the existing jobs_company_id_job_number_key unique
-- constraint (+ a one-shot retry) to settle the MAX+1 race, exactly as the
-- quote-number path already tolerates it.

CREATE OR REPLACE FUNCTION public.generate_po_job_number(company_uuid uuid)
RETURNS text
LANGUAGE plpgsql
AS $function$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(
    MAX(CAST(SUBSTRING(job_number FROM '^PO-J-(\d+)$') AS INTEGER)), 0
  ) + 1
  INTO next_num
  FROM jobs
  WHERE company_id = company_uuid
    AND job_number ~ '^PO-J-\d+$';

  RETURN 'PO-J-' || LPAD(next_num::TEXT, 4, '0');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.generate_po_job_number(uuid) TO anon, authenticated, service_role;
