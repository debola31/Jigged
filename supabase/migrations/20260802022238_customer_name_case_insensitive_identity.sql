-- A customer's name is its identity, and identity is not case-sensitive.
--
-- Three layers disagreed about that, which is how you get two rows for one
-- company (issue #653, P1):
--
--   * the constraint  customers_company_name_unique (company_id, name)  — case-SENSITIVE
--   * the create pre-check  checkCustomerNameExists  .ilike             — case-INSENSITIVE
--   * the revive lookup     reviveArchivedCustomerByName  .eq           — case-SENSITIVE
--
-- Archive "Acme Corp", then create "acme corp": the pre-check finds nothing
-- (it only looks at LIVE rows), the insert does not collide (the constraint is
-- case-sensitive), no 23505 fires, the revive path never runs, and a second
-- customer row appears. The CSV importer reaches the same end from the other
-- side — it decides is_new on a lowercased name but upserts on the
-- case-sensitive constraint, so "acme corp" against an existing "Acme Corp" is
-- counted as an update, is denied its contact and address, and still inserts.
--
-- The app fix (both lookups become case-insensitive) is in the same commit and
-- is what actually stops it happening. This index is the guard that keeps the
-- class closed: with it, anything that still tries turns a silent duplicate
-- into a loud 23505.
--
-- WHY BOTH INDEXES SURVIVE. customers_company_name_unique stays exactly as it
-- is, because the importer upserts with on_conflict="company_id,name" and
-- PostgREST can only name plain columns — pointing it at an expression index is
-- not possible. The case-sensitive constraint therefore remains the upsert
-- target; the case-insensitive index sits behind it as the real rule. The
-- former is implied by the latter, so keeping both costs one index and no
-- correctness.
--
-- FULL, not partial: archived rows are covered, exactly as the existing
-- constraint covers them. That is what makes reuse-revives work — a collision
-- with an archived row is the signal to un-archive it rather than duplicate.

-- ---------------------------------------------------------------------------
-- 1. De-duplicate what the importer may already have created.
-- ---------------------------------------------------------------------------
-- Only the importer could produce a case-variant (the UI pre-check has always
-- been .ilike), so this is a no-op for most companies.
--
-- These rows are NOT merged. Merging customers means re-pointing quotes, jobs,
-- shipments, addresses and contacts, and choosing which history wins — the
-- module refuses merge/dedup tooling on purpose (docs/modules/customers.md,
-- "Explicitly not built"). Renaming keeps both rows and both histories intact
-- and lets the shop decide.
--
-- Who keeps the name: a LIVE row beats an archived one (the live row is the one
-- being used today), then the oldest wins (it is the one already frozen onto
-- the most documents). Losers get their own id appended — deliberately ugly, so
-- it reads as something that happened TO the data rather than as a name someone
-- chose, and guaranteed not to collide with a second pass.
WITH ranked AS (
    SELECT id,
           name,
           row_number() OVER (
               PARTITION BY company_id, lower(btrim(name))
               ORDER BY (deleted_at IS NOT NULL), created_at, id
           ) AS rn
      FROM public.customers
)
UPDATE public.customers c
   SET name = r.name || ' [' || left(c.id::text, 8) || ']',
       updated_at = now()
  FROM ranked r
 WHERE c.id = r.id
   AND r.rn > 1;

-- ---------------------------------------------------------------------------
-- 2. The rule itself.
-- ---------------------------------------------------------------------------
-- btrim as well as lower: " Acme Corp" and "Acme Corp" are the same company too,
-- and every writer already trims before insert, so this only closes the path
-- around them.
CREATE UNIQUE INDEX IF NOT EXISTS customers_company_name_ci_unique
    ON public.customers (company_id, lower(btrim(name)));

COMMENT ON INDEX public.customers_company_name_ci_unique IS
    'Name is the customer''s identity and identity ignores case and surrounding space, so "Acme Corp", "acme corp" and " Acme Corp " are one company. Covers archived rows (no WHERE clause) because a collision with an archived row is the signal to REVIVE it — see reviveArchivedCustomerByName. The plain customers_company_name_unique constraint is kept alongside this only because the CSV importer upserts with on_conflict="company_id,name" and PostgREST cannot name an expression index; this index is the rule, that constraint is the upsert target.';

-- ---------------------------------------------------------------------------
-- 3. Correct a column COMMENT that describes an intention, not the product.
-- ---------------------------------------------------------------------------
-- jobs.payment_terms was documented as "editable on the job". No job UI writes
-- it — grep of components/jobs and app/dashboard/[companyId]/jobs finds nothing,
-- and createJobFromPO omits the column entirely. Today the only writers are
-- quote conversion and that migration's own backfill, which means a job created
-- directly from a customer PO reaches QuickBooks with no SalesTermRef at all.
-- Stating that plainly is worth more than a comment that sends the next reader
-- looking for a control that does not exist.
COMMENT ON COLUMN public.jobs.payment_terms IS
    'Payment terms this order was sold on, copied from the originating quote at conversion. Pushed to QuickBooks as SalesTermRef when the invoice is created. Distinct from customers.default_payment_terms (the standing agreement, which only seeds a NEW quote) — a job keeps what it was converted with. NOT currently editable on the job: quote conversion is the only writer, so a job created directly from a customer PO carries NULL and its invoice gets no SalesTermRef (QuickBooks then applies its own company default).';
