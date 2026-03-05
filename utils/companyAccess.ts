import { getSupabase } from '@/lib/supabase';

export interface Company {
  id: string;
  name: string;
  is_demo?: boolean;
  demo_company_id?: string | null;
}

export interface UserCompanyAccess {
  company_id: string;
  role: string;
  companies: Company;
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

    // Single company - go directly to dashboard
    if (companies.length === 1) {
      const companyId = companies[0].company_id;
      await setLastCompany(userId, companyId);
      return `/dashboard/${companyId}`;
    }

    // Multiple companies - check for last accessed
    const lastCompanyId = await getLastCompany(userId);

    if (lastCompanyId) {
      // Verify they still have access to last company
      const hasAccess = companies.some((c) => c.company_id === lastCompanyId);
      if (hasAccess) {
        return `/dashboard/${lastCompanyId}`;
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
    .select('id, name, is_demo, demo_company_id')
    .eq('id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching company:', error);
    return null;
  }

  return data;
}
