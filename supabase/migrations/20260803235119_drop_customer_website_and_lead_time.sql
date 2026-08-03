-- Drop two customer columns nobody uses.
--
-- customers.website — never referenced by any document. It printed nowhere: the
-- quote PDF and packing slip both render the COMPANY's website (ours), not the
-- customer's, and no other surface read it. It was a field on a form because
-- forms have fields.
--
-- customers.default_lead_time_text — removed on the founder's call, and it is
-- the one this module already predicted. The migration that added it said so:
-- "the weakest of the three defaults on the merits — lead time is a function of
-- shop load and the specific part, so a standing value can become a stale
-- promise." It went in on a 60-day watch list. The verdict came earlier than
-- that, in the founder's words: lead time "only makes sense to set up when
-- quoting since it changes based on current work in progress unrelated to the
-- customer."
--
-- NOT TOUCHED: quotes.lead_time_text. That is where a lead time belongs — stated
-- per quote, at the moment someone judges current shop load. Only the
-- customer-level DEFAULT that pre-filled it is going.
--
-- Both are plain DROPs rather than a deprecation window. Nothing reads either
-- one, so there is nothing to migrate off; leaving them would mean carrying two
-- columns the UI no longer writes, which is how a schema starts lying.

ALTER TABLE public.customers
    DROP COLUMN IF EXISTS website,
    DROP COLUMN IF EXISTS default_lead_time_text;
