// Typed Supabase client (typed-client rollout). Aliased so the 10 call
// sites stay untouched. See CLAUDE.md "Typed Supabase client".
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import type { CompanyMember } from '@/types/quote';
import type { Json } from '@/types/database';

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

export type CompanyProfilePatch = Pick<
  Company,
  | 'phone'
  | 'email'
  | 'website'
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
      const prefix = companies[0].role === 'operator' ? 'operator' : 'dashboard';
      return `/${prefix}/${companyId}`;
    }

    // Multiple companies - check for last accessed
    const lastCompanyId = await getLastCompany(userId);

    if (lastCompanyId) {
      // Verify they still have access to last company
      const match = companies.find((c) => c.company_id === lastCompanyId);
      if (match) {
        const prefix = match.role === 'operator' ? 'operator' : 'dashboard';
        return `/${prefix}/${lastCompanyId}`;
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
 * Verify user has access to a specific company
 */
export async function verifyCompanyAccess(userId: string, companyId: string): Promise<boolean> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('user_company_access')
    .select('id')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error verifying company access:', error);
    return false;
  }

  return !!data;
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
    throw new Error(`Failed to update company logo: ${error.message}`);
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
    throw new Error(`Failed to update company profile: ${error.message}`);
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
    throw new Error(`Failed to update company defaults: ${error.message}`);
  }
}
