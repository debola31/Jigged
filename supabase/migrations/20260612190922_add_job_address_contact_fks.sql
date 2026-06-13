-- Jobs now carry their own billing/shipping address + contact, mirroring
-- quotes. Previously these lived ONLY on the quote and were dropped at
-- conversion, so a job had no shippable address of its own. They are FKs
-- into the customer's address book (not denormalized text), copied from the
-- source quote at conversion and editable on the job afterwards.

ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS billing_address_id uuid,
    ADD COLUMN IF NOT EXISTS shipping_address_id uuid,
    ADD COLUMN IF NOT EXISTS contact_id uuid;

ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_billing_address_id_fkey
        FOREIGN KEY (billing_address_id) REFERENCES public.customer_addresses(id) ON DELETE SET NULL,
    ADD CONSTRAINT jobs_shipping_address_id_fkey
        FOREIGN KEY (shipping_address_id) REFERENCES public.customer_addresses(id) ON DELETE SET NULL,
    ADD CONSTRAINT jobs_contact_id_fkey
        FOREIGN KEY (contact_id) REFERENCES public.customer_contacts(id) ON DELETE SET NULL;

-- Backfill existing jobs from their source quote so every pre-existing row
-- satisfies the new invariant (no runtime "if missing, look at the quote"
-- fallback in the read path). Manual jobs without a quote keep NULLs, which
-- the UI surfaces as "not set" — an explicit gap, not a hidden one.
UPDATE public.jobs j
   SET billing_address_id  = q.billing_address_id,
       shipping_address_id = q.shipping_address_id,
       contact_id          = q.contact_id
  FROM public.quotes q
 WHERE j.quote_id = q.id
   AND j.customer_id = q.customer_id;

-- Same integrity guard quotes use: an address/contact assigned to a job must
-- belong to that job's customer.
CREATE OR REPLACE FUNCTION public.enforce_job_address_contact_customer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.billing_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.billing_address_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'jobs.billing_address_id % does not belong to customer %',
                NEW.billing_address_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.shipping_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.shipping_address_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'jobs.shipping_address_id % does not belong to customer %',
                NEW.shipping_address_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_contacts
         WHERE id = NEW.contact_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'jobs.contact_id % does not belong to customer %',
                NEW.contact_id, NEW.customer_id;
        END IF;
    END IF;
    RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS enforce_job_address_contact_customer_trg ON public.jobs;
CREATE TRIGGER enforce_job_address_contact_customer_trg
    BEFORE INSERT OR UPDATE OF billing_address_id, shipping_address_id, contact_id, customer_id
    ON public.jobs
    FOR EACH ROW EXECUTE FUNCTION public.enforce_job_address_contact_customer();
