import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import type { Json } from '@/types/database';
import type { ChartConfig, SavedInsight } from '@/utils/insightsAccess';

// ============================================================
// Saved Insights — direct Supabase queries (no FastAPI needed)
// ============================================================

/**
 * Get the user's saved insights for a company.
 * RLS policy filters by auth.uid() automatically.
 */
export async function getSavedInsights(
  companyId: string
): Promise<SavedInsight[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('saved_insights')
    .select('id, question, answer, chart_config, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch saved insights: ${error.message}`);
  }

  return (data || []) as SavedInsight[];
}

/**
 * Save a chart/insight to the user's dashboard.
 * Maximum 5 saved insights per company per user.
 * RLS policy validates user_id = auth.uid() on INSERT.
 */
export async function saveInsight(
  companyId: string,
  question: string,
  answer: string,
  chart_config: ChartConfig | null
): Promise<SavedInsight> {
  const supabase = getSupabase();

  // Get the current user ID (needed for the INSERT)
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error('Not authenticated');
  }

  // Check count of existing saved insights
  const { count, error: countError } = await supabase
    .from('saved_insights')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);

  if (countError) {
    throw new Error(`Failed to check saved insights count: ${countError.message}`);
  }

  if ((count ?? 0) >= 5) {
    throw new Error('Maximum 5 saved insights per company. Remove one to save another.');
  }

  const { data, error } = await supabase
    .from('saved_insights')
    .insert({
      user_id: user.id,
      company_id: companyId,
      question,
      answer,
      // chart_config is jsonb in the DB → cast required. ChartConfig is
      // a structured app type; the runtime serialization is correct
      // (JSON.stringify under the hood).
      chart_config: chart_config as unknown as Json,
    })
    .select('id, question, answer, chart_config, created_at')
    .single();

  if (error) {
    throw new Error(`Failed to save insight: ${error.message}`);
  }

  return data as SavedInsight;
}

/**
 * Delete a saved insight from the user's dashboard.
 * RLS policy ensures user can only delete their own insights.
 */
export async function deleteSavedInsight(
  companyId: string,
  insightId: string
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('saved_insights')
    .delete()
    .eq('id', insightId)
    .eq('company_id', companyId);

  if (error) {
    throw new Error(`Failed to delete saved insight: ${error.message}`);
  }
}
