// Typed Supabase client (typed-client rollout). Aliased so the 10 call
// sites stay untouched. See CLAUDE.md "Typed Supabase client".
import { getSupabase } from '@/lib/supabase';
import type { CompanyMember } from '@/types/quote';
import type { Json } from '@/types/database';
import {
  readCustomPaymentTerms,
  readCompanyDefaultPaymentTerms,
  MAX_CUSTOM_PAYMENT_TERMS,
} from '@/lib/companyDefaults';
import { toError, toFriendlyError } from '@/lib/supabaseErrors';
import { isUuid } from '@/lib/validators';

export interface Company {
  id: string;
  name: string;
  logo_url?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  // boolean | null mirrors the DB (column has no DEFAULT or NOT NULL).
  // All consumers treat is_demo via truthy checks, so null behaves like
  // false — no consumer changes needed.
  is_demo?: boolean | null;
  demo_company_id?: string | null;
  // Free-form per-tenant settings (feature flags, defaults). Schema: jsonb.
  settings?: Record<string, unknown> | null;
}

/**
 * The shop-contact fields the settings form writes.
 *
 * **`email` and `website` are deliberately absent.** Both columns exist and both were editable for
 * months, and nothing has ever read them — not the quote header, not the packing slip, not the
 * traveler. They were a form writing to itself. The columns are left in place rather than dropped,
 * so the data survives if a document ever wants them; what is removed is the pretence that filling
 * them in does something.
 */
export type CompanyProfilePatch = Pick<
  Company,
  | 'phone'
  | 'address_line1'
  | 'address_line2'
  | 'city'
  | 'state'
  | 'postal_code'
  | 'country'
>;

export interface UserCompanyAccess {
  company_id: string;
  role: string;
  companies: Company;
}

/**
 * Fetch the company's member directory (user_id + display name + email).
 * Used to resolve `created_by` UUIDs to names. The RLS policy added in
 * migration 20260416_members_visible_to_company.sql lets any member read
 * peers in their own company.
 */
export async function getCompanyMembers(companyId: string): Promise<CompanyMember[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('user_company_access')
    .select('user_id, name, email')
    .eq('company_id', companyId)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching company members:', error);
    throw error;
  }

  return (data || []) as CompanyMember[];
}

/**
 * Where a member's home is, given their role in that company.
 *
 * Operators live on the shop floor and are bounced out of `/dashboard/*` by
 * `AuthGuard`; everyone else lands in the office. Exported so the four places
 * that send someone "home" — post-login, `/launch`, the company selector and
 * invite acceptance — cannot drift apart. Three of them used to hardcode
 * `/dashboard` and lean on the AuthGuard bounce to correct it, which worked but
 * cost an extra round trip and a visible flash on a new user's first screen.
 */
export function homePathForRole(role: string | null | undefined, companyId: string): string {
  return role === 'operator' ? `/operator/${companyId}` : `/dashboard/${companyId}`;
}

/**
 * Get all companies the user has access to
 */
export async function getUserCompanies(userId: string): Promise<UserCompanyAccess[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('user_company_access')
    .select(`
      company_id,
      role,
      companies (
        id,
        name,
        is_demo
      )
    `)
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching user companies:', error);
    throw error;
  }

  // Filter out demo companies — they should never appear in company lists
  return ((data || []) as UserCompanyAccess[]).filter(
    (c) => !c.companies?.is_demo
  );
}

/**
 * Get user's last accessed company ID
 */
export async function getLastCompany(userId: string): Promise<string | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('user_preferences')
    .select('last_company_id')
    .eq('user_id', userId)
    .single();

  // PGRST116 = no rows found, which is expected for new users
  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching last company:', error);
    throw error;
  }

  return data?.last_company_id ?? null;
}

/**
 * Set user's last accessed company
 */
export async function setLastCompany(userId: string, companyId: string): Promise<void> {
  const supabase = getSupabase();

  // Guard: never save a demo company as last_company_id
  const { data: company } = await supabase
    .from('companies')
    .select('is_demo')
    .eq('id', companyId)
    .single();

  if (company?.is_demo) {
    return;
  }

  const { error } = await supabase
    .from('user_preferences')
    .upsert({
      user_id: userId,
      last_company_id: companyId,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id',
    });

  if (error) {
    console.error('Error setting last company:', error);
    throw error;
  }
}

/**
 * Determine where to route user after login based on their company access
 *
 * @returns The route path to redirect to:
 * - `/dashboard/{companyId}` if user has access to exactly one company
 * - `/dashboard/{lastCompanyId}` if user has multiple companies and a valid last company
 * - `/select-company` if user has multiple companies and no valid last company
 * - `/no-access` if user has no company access
 */
export async function getPostLoginRoute(userId: string): Promise<string> {
  try {
    const companies = await getUserCompanies(userId);

    // No company access
    if (!companies || companies.length === 0) {
      return '/no-access';
    }

    // Single company - go directly to dashboard (or operator view)
    if (companies.length === 1) {
      const companyId = companies[0].company_id;
      await setLastCompany(userId, companyId);
      return homePathForRole(companies[0].role, companyId);
    }

    // Multiple companies - check for last accessed
    const lastCompanyId = await getLastCompany(userId);

    if (lastCompanyId) {
      // Verify they still have access to last company
      const match = companies.find((c) => c.company_id === lastCompanyId);
      if (match) {
        return homePathForRole(match.role, lastCompanyId);
      }
    }

    // Multiple companies, no valid last company - show selector
    return '/select-company';
  } catch (error) {
    console.error('Error determining post-login route:', error);
    return '/select-company';
  }
}

/**
 * Verify user has access to a specific company.
 *
 * Returns false ONLY for a definitive "no membership row" answer. Any other failure
 * throws, because the caller (AuthGuard, the sole caller) renders a false return as
 * "You don't have access to this company" — so swallowing a network blip or an RLS
 * error into `false` locks out a user who *does* have access. That's the same
 * conflation of "couldn't check" with "denied" that this fix exists to remove; it just
 * had a second path through here.
 *
 * PGRST116 is PostgREST's "no rows returned" from `.single()`, which genuinely means
 * no membership — that one is a real negative, not an error.
 *
 * A companyId that isn't a UUID is the OTHER real negative, and it is answered here without
 * asking the database. `company_id` is a `uuid` column, so Postgres rejects the comparison with
 * SQLSTATE `22P02` — which is not `PGRST116`, so it took the throw above and AuthGuard rendered
 * "Couldn't check your access just now." with a Try Again that re-ran the identical impossible
 * query, filing a Sentry event every press. `/dashboard/admin` did this twice in production.
 *
 * Returning `false` for it does NOT weaken the "couldn't check is never denied" rule. That rule
 * is about *indeterminacy* — a network blip leaves the answer unknown, so claiming denial is a
 * guess. This is the opposite: a string that cannot be a UUID cannot name a company row, so the
 * answer is known, and known negatives are exactly what `false` is for.
 */
export async function verifyCompanyAccess(userId: string, companyId: string): Promise<boolean> {
  if (!isUuid(companyId)) return false;

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('user_company_access')
    .select('id')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error verifying company access:', error);
    throw toError(error, 'Could not verify company access');
  }

  return !!data;
}

/**
 * Does this user already belong to at least one company?
 *
 * Used by the invite-acceptance page to tell an established Jigged user from a brand-new hire,
 * because nothing else on that page can: an invite sent to an already-registered email falls back
 * to a magic link in the `team-invites` edge function, and a magic link carries no marker saying
 * so. Without this, a two-year customer invited to a second company is shown the same "set up your
 * account" form as a new hire and is asked to invent a password they already have.
 *
 * Deliberately NOT `getUserCompanies`: that filters out demo companies and joins `companies`. Here
 * a demo membership still means "this person has an account with a password", which is the only
 * question being asked, and the join is wasted work.
 *
 * Throws rather than returning false on a read failure — "couldn't check" is not "no account".
 * The caller decides what to do with that; see the accept page, which falls back to the user's
 * auth metadata rather than guessing.
 *
 * `user_company_access` has no `deleted_at` (membership is removed outright, not archived), so
 * there is no soft-delete filter to apply here.
 */
export async function hasAnyCompanyAccess(userId: string): Promise<boolean> {
  const supabase = getSupabase();

  const { count, error } = await supabase
    .from('user_company_access')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) {
    console.error('Error checking existing company access:', error);
    throw toError(error, 'Could not check existing company access');
  }

  return (count ?? 0) > 0;
}

/**
 * Get user's role in a specific company
 */
export async function getUserRole(userId: string, companyId: string): Promise<string | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('user_company_access')
    .select('role')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching user role:', error);
    return null;
  }

  return data?.role ?? null;
}

/**
 * Get a company by ID
 */
export async function getCompany(companyId: string): Promise<Company | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('companies')
    .select(
      'id, name, logo_url, phone, email, website, address_line1, address_line2, city, state, postal_code, country, is_demo, demo_company_id, settings'
    )
    .eq('id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching company:', error);
    return null;
  }

  // companies.settings is jsonb in the DB → generated type is Json
  // (string | number | boolean | object | array). The app treats it as
  // a config object (e.g. `settings.features` in app/admin/page.tsx),
  // so we narrow here. If a primitive ever lands in this column it
  // would be a write-side bug; reads stay strongly typed.
  return data as Company | null;
}

/**
 * The webhook-fed Stripe billing cache row for a company. Read-only on the
 * client (only the service-role webhook writes it). Entitlement is derived from
 * this via `getEntitlement` in `lib/entitlement.ts`.
 */
export interface CompanyBilling {
  company_id: string;
  billing_exempt: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  subscription_price_id: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  canceled_at: string | null;
  ended_at: string | null;
  trial_end: string | null;
}

/**
 * Read a company's Stripe billing cache. Returns `null` when the company has no
 * billing row (a new, never-subscribed company → the subscribe funnel). Throws
 * on a genuine read error so the caller can surface it to Sentry rather than
 * silently defaulting entitlement — this is a billing path. Reads via RLS; touches
 * Stripe zero times, so it is safe on mount.
 */
export async function getCompanyBilling(companyId: string): Promise<CompanyBilling | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('company_billing')
    .select(
      'company_id, billing_exempt, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_price_id, current_period_end, cancel_at, canceled_at, ended_at, trial_end'
    )
    .eq('company_id', companyId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read company_billing for ${companyId}: ${error.message}`);
  }

  return (data as CompanyBilling | null) ?? null;
}

/**
 * Update the company's logo storage path (or clear it by passing null).
 * The caller is responsible for uploading/removing the file in storage.
 */
export async function updateCompanyLogo(
  companyId: string,
  logoPath: string | null
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('companies')
    .update({ logo_url: logoPath, updated_at: new Date().toISOString() })
    .eq('id', companyId);

  if (error) {
    console.error('Error updating company logo:', error);
    throw toFriendlyError(error, {
      entity: 'logo',
      fallback: 'Failed to update the company logo.',
    });
  }
}

/**
 * Update the company's shop-contact profile (address, phone, email, website).
 * These fields power the "FROM" block on printable quote PDFs. Any field
 * passed as empty string is stored as null so downstream renderers can skip it.
 */
export async function updateCompanyProfile(
  companyId: string,
  patch: CompanyProfilePatch
): Promise<void> {
  const supabase = getSupabase();

  const normalized: Record<string, string | null> = {};
  (Object.keys(patch) as (keyof CompanyProfilePatch)[]).forEach((key) => {
    const raw = patch[key];
    const trimmed = typeof raw === 'string' ? raw.trim() : raw;
    normalized[key] = trimmed ? trimmed : null;
  });

  const { error } = await supabase
    .from('companies')
    .update({ ...normalized, updated_at: new Date().toISOString() })
    .eq('id', companyId);

  if (error) {
    console.error('Error updating company profile:', error);
    throw toFriendlyError(error, {
      entity: 'company profile',
      fallback: 'Failed to update the company profile.',
    });
  }
}

/**
 * Merge numeric business defaults into companies.settings.defaults (jsonb).
 * Read-modify-write of the whole settings object so the sibling `features`
 * block (feature flags) is preserved. Keys should be CompanyDefaultKey values;
 * see lib/companyDefaults.ts for the registry + read helpers.
 */
export async function updateCompanyDefaults(
  companyId: string,
  patch: Record<string, number>,
): Promise<void> {
  const supabase = getSupabase();

  const company = await getCompany(companyId);
  if (!company) {
    throw new Error('Company not found.');
  }

  const settings = (company.settings ?? {}) as Record<string, unknown>;
  const existingDefaults = (settings.defaults ?? {}) as Record<string, unknown>;
  const nextSettings = {
    ...settings,
    defaults: { ...existingDefaults, ...patch },
  } as Json;

  const { error } = await supabase
    .from('companies')
    .update({ settings: nextSettings, updated_at: new Date().toISOString() })
    .eq('id', companyId);

  if (error) {
    console.error('Error updating company defaults:', error);
    throw toFriendlyError(error, {
      entity: 'settings',
      fallback: 'Failed to update company defaults.',
    });
  }
}

/**
 * Read a company's saved custom payment terms (the free-text terms it kept for
 * reuse via the quote form's payment-terms combobox). See readCustomPaymentTerms.
 */
export async function getCustomPaymentTerms(companyId: string): Promise<string[]> {
  const company = await getCompany(companyId);
  return readCustomPaymentTerms(company);
}

/**
 * Read-modify-write the whole settings object (preserving the sibling
 * `defaults` / `features` blocks), replacing `custom_payment_terms`. Internal —
 * callers use addCustomPaymentTerm / removeCustomPaymentTerm.
 */
async function writeCustomPaymentTerms(companyId: string, terms: string[]): Promise<void> {
  const supabase = getSupabase();
  const company = await getCompany(companyId);
  if (!company) {
    throw new Error('Company not found.');
  }
  const settings = (company.settings ?? {}) as Record<string, unknown>;
  const nextSettings = { ...settings, custom_payment_terms: terms } as Json;
  const { error } = await supabase
    .from('companies')
    .update({ settings: nextSettings, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) {
    console.error('Error updating custom payment terms:', error);
    throw toFriendlyError(error, {
      entity: 'payment term',
      fallback: 'Failed to save that payment term.',
    });
  }
}

/**
 * Add a custom payment term to the company's saved list; returns the new list.
 * De-duplicated, most-recent-first, capped at MAX_CUSTOM_PAYMENT_TERMS. A blank
 * term is a no-op (returns the existing list unchanged).
 */
export async function addCustomPaymentTerm(companyId: string, term: string): Promise<string[]> {
  const trimmed = term.trim();
  const existing = await getCustomPaymentTerms(companyId);
  if (trimmed === '') return existing;
  const next = [trimmed, ...existing.filter((t) => t !== trimmed)].slice(
    0,
    MAX_CUSTOM_PAYMENT_TERMS,
  );
  await writeCustomPaymentTerms(companyId, next);
  return next;
}

/**
 * Remove a custom payment term from the company's saved list; returns the new
 * list.
 */
export async function removeCustomPaymentTerm(companyId: string, term: string): Promise<string[]> {
  const existing = await getCustomPaymentTerms(companyId);
  const next = existing.filter((t) => t !== term);
  await writeCustomPaymentTerms(companyId, next);
  return next;
}

/**
 * Read the shop-wide default payment terms. See readCompanyDefaultPaymentTerms
 * for why this lives beside the numeric `defaults` block rather than in it.
 */
export async function getCompanyDefaultPaymentTerms(companyId: string): Promise<string | null> {
  const company = await getCompany(companyId);
  return readCompanyDefaultPaymentTerms(company);
}

/**
 * Set (or clear) the shop-wide default payment terms.
 *
 * Read-modify-write of the whole settings object, mirroring
 * writeCustomPaymentTerms — the outer spread is what keeps the sibling
 * `features`, `defaults` and `custom_payment_terms` blocks alive; writing the
 * key alone would silently drop every feature flag on the company.
 *
 * A blank value stores null rather than '', so "unset" has exactly one
 * representation and the reader never has to distinguish empty from absent.
 */
export async function setCompanyDefaultPaymentTerms(
  companyId: string,
  terms: string,
): Promise<string | null> {
  const supabase = getSupabase();
  const company = await getCompany(companyId);
  if (!company) {
    throw new Error('Company not found.');
  }
  const next = terms.trim() || null;
  const settings = (company.settings ?? {}) as Record<string, unknown>;
  const nextSettings = { ...settings, default_payment_terms: next } as Json;
  const { error } = await supabase
    .from('companies')
    .update({ settings: nextSettings, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) {
    console.error('Error updating default payment terms:', error);
    throw toFriendlyError(error, {
      entity: 'payment terms',
      fallback: 'Failed to save default payment terms.',
    });
  }
  return next;
}

/**
 * Record whether the shop's logo already contains its company name.
 *
 * Read-modify-write of the whole settings object, mirroring the payment-terms writers above — the
 * outer spread is what keeps the sibling `features`, `defaults` and `custom_payment_terms` blocks
 * alive; writing the key alone would silently drop every feature flag on the company.
 *
 * See `readLogoIncludesName` for why this is a question rather than something we detect.
 */
export async function setLogoIncludesName(
  companyId: string,
  includesName: boolean,
): Promise<void> {
  const supabase = getSupabase();
  const company = await getCompany(companyId);
  if (!company) {
    throw new Error('Company not found.');
  }
  const settings = (company.settings ?? {}) as Record<string, unknown>;
  const nextSettings = { ...settings, logo_includes_name: includesName } as Json;
  const { error } = await supabase
    .from('companies')
    .update({ settings: nextSettings, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) {
    console.error('Error updating logo naming setting:', error);
    throw toFriendlyError(error, {
      entity: 'logo setting',
      fallback: 'Failed to save that setting.',
    });
  }
}
