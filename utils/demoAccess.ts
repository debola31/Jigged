import { getTypedSupabase as getSupabase } from '@/lib/supabase';

export interface DemoStatus {
  isDemoCompany: boolean;
  hasDemoCompany: boolean;
  demoCompanyId: string | null;
  sourceCompanyId: string | null;
  sourceCompanyName: string | null;
}

/**
 * Get the demo mode status for a company.
 * If viewing a demo company, resolves the source company via reverse lookup.
 * If viewing a real company, reads demo_company_id directly.
 */
export async function getDemoStatus(companyId: string): Promise<DemoStatus> {
  const supabase = getSupabase();

  const { data: company, error } = await supabase
    .from('companies')
    .select('id, name, is_demo, demo_company_id')
    .eq('id', companyId)
    .single();

  if (error || !company) {
    return {
      isDemoCompany: false,
      hasDemoCompany: false,
      demoCompanyId: null,
      sourceCompanyId: null,
      sourceCompanyName: null,
    };
  }

  if (company.is_demo) {
    // We're viewing a demo company — reverse lookup to find the source
    const { data: source } = await supabase
      .from('companies')
      .select('id, name')
      .eq('demo_company_id', companyId)
      .single();

    return {
      isDemoCompany: true,
      hasDemoCompany: true,
      demoCompanyId: companyId,
      sourceCompanyId: source?.id ?? null,
      sourceCompanyName: source?.name ?? null,
    };
  }

  // We're viewing a real company
  return {
    isDemoCompany: false,
    hasDemoCompany: !!company.demo_company_id,
    demoCompanyId: company.demo_company_id ?? null,
    sourceCompanyId: companyId,
    sourceCompanyName: company.name,
  };
}

/**
 * Create a demo company for the given source company.
 * Returns the demo company ID (idempotent — returns existing if already created).
 */
export async function createDemoCompany(sourceCompanyId: string, userId: string): Promise<string> {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('create_demo_company', {
    p_source_company_id: sourceCompanyId,
    p_user_id: userId,
  });

  if (error) {
    throw new Error(`Failed to create demo company: ${error.message}`);
  }

  return data as string;
}

/**
 * Reset the demo company to its original template state.
 * Wipes all data and re-seeds from the active template.
 */
export async function resetDemoCompany(sourceCompanyId: string, userId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.rpc('reset_demo_company', {
    p_source_company_id: sourceCompanyId,
    p_user_id: userId,
  });

  if (error) {
    throw new Error(`Failed to reset demo company: ${error.message}`);
  }
}

/**
 * Converge a demo company on its source. Called on every entry to an existing
 * demo (see DemoModeProvider), which is what makes it the place lazy syncing
 * happens.
 *
 * Despite the name it syncs two things: team member access (adds members added
 * since, updates changed roles) and `settings.features`. Flags are mirrored
 * because a demo company is filtered out of /admin/companies — the only
 * feature-flag editor — so there is otherwise no way to set them, and a demo
 * showing a different product surface than the company it stands in for is a
 * page that vanishes when you exit demo mode.
 *
 * Other `settings` blocks are deliberately left alone: `defaults` and
 * `default_payment_terms` are editable from the Settings page *inside* demo
 * mode, and re-mirroring them here would revert the user's own edits.
 */
export async function syncDemoAccess(sourceCompanyId: string, demoCompanyId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.rpc('sync_demo_access', {
    p_source_company_id: sourceCompanyId,
    p_demo_company_id: demoCompanyId,
  });

  if (error) {
    throw new Error(`Failed to sync demo access: ${error.message}`);
  }
}
