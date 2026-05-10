/**
 * Per-company custom unit of measurement. Mirrors the `company_custom_units`
 * table — companies can extend the standard unit list (`lib/standardUnits.ts`)
 * with shop-specific units like "billet", "skein", or "spool" without
 * requiring a code change.
 *
 * The unique constraint is `(company_id, unit_name)`; the access layer surfaces
 * Postgres unique-violation errors as friendly "already exists" messages.
 */
export interface CompanyCustomUnit {
  id: string;
  company_id: string;
  unit_name: string;
  created_at?: string;
}
