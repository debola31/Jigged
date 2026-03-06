import { API_BASE_URL } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';

// ============================================================
// Types
// ============================================================

export interface InsightCard {
  type: string;
  summary: string;
  metric_data: Record<string, unknown>;
  chart_config: ChartConfig | null;
  computed_at: string;
  is_cached: boolean;
}

export interface ChartConfig {
  chart_type: 'area' | 'pie' | 'bar' | 'bar_horizontal' | 'sparkline';
  data: Record<string, unknown>[];
  x_key: string;
  y_key: string;
  x_label?: string;
  y_label?: string;
}

export interface DashboardInsightsResponse {
  insights: InsightCard[];
}

export interface ChatResponse {
  answer: string;
  chart_config: ChartConfig | null;
  tool_calls: string[];
  provider: string;
  tokens_used: number | null;
}

export interface ChatHistoryItem {
  id: string;
  question: string;
  response: string;
  has_chart: boolean;
  created_at: string;
}

export interface ChatHistoryResponse {
  queries: ChatHistoryItem[];
}

export interface SavedInsight {
  id: string;
  question: string;
  answer: string;
  chart_config: ChartConfig | null;
  created_at: string;
}

// ============================================================
// Helper: Get auth headers
// ============================================================

async function getAuthHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }

  return headers;
}

// ============================================================
// API Functions
// ============================================================

/**
 * Get the 5 pre-built dashboard insight cards.
 * Serves from cache if available, otherwise computes fresh.
 */
export async function getDashboardInsights(
  companyId: string
): Promise<InsightCard[]> {
  const headers = await getAuthHeaders();

  const response = await fetch(
    `${API_BASE_URL}/api/insights/${companyId}/dashboard`,
    {
      method: 'GET',
      headers,
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.detail || `Failed to fetch insights (${response.status})`
    );
  }

  const data: DashboardInsightsResponse = await response.json();
  return data.insights;
}

/**
 * Force-refresh all cached insights for a company.
 */
export async function refreshInsights(
  companyId: string
): Promise<InsightCard[]> {
  const headers = await getAuthHeaders();

  const response = await fetch(
    `${API_BASE_URL}/api/insights/${companyId}/refresh`,
    {
      method: 'POST',
      headers,
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.detail || `Failed to refresh insights (${response.status})`
    );
  }

  const data: DashboardInsightsResponse = await response.json();
  return data.insights;
}

/**
 * Submit a natural language question about company data.
 * Rate limited to 20 queries per company per hour.
 */
export async function submitChatQuery(
  companyId: string,
  question: string
): Promise<ChatResponse> {
  const headers = await getAuthHeaders();

  const response = await fetch(
    `${API_BASE_URL}/api/insights/${companyId}/chat`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ question }),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));

    if (response.status === 429) {
      throw new Error(
        'Rate limit exceeded. Maximum 20 AI chat queries per hour. Please try again later.'
      );
    }

    throw new Error(
      errorData.detail || `Failed to submit chat query (${response.status})`
    );
  }

  return await response.json();
}

/**
 * Get the last 20 chat queries for this company.
 */
export async function getChatHistory(
  companyId: string
): Promise<ChatHistoryItem[]> {
  const headers = await getAuthHeaders();

  const response = await fetch(
    `${API_BASE_URL}/api/insights/${companyId}/chat/history`,
    {
      method: 'GET',
      headers,
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.detail || `Failed to fetch chat history (${response.status})`
    );
  }

  const data: ChatHistoryResponse = await response.json();
  return data.queries;
}

// ============================================================
// Saved Insights
// ============================================================

/**
 * Save a chart/insight to the user's dashboard.
 * Maximum 5 saved insights per company per user.
 */
export async function saveInsight(
  companyId: string,
  question: string,
  answer: string,
  chart_config: ChartConfig | null
): Promise<SavedInsight> {
  const headers = await getAuthHeaders();

  const response = await fetch(
    `${API_BASE_URL}/api/insights/${companyId}/saved`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ question, answer, chart_config }),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.detail || `Failed to save insight (${response.status})`
    );
  }

  return await response.json();
}

/**
 * Get the user's saved insights for a company.
 */
export async function getSavedInsights(
  companyId: string
): Promise<SavedInsight[]> {
  const headers = await getAuthHeaders();

  const response = await fetch(
    `${API_BASE_URL}/api/insights/${companyId}/saved`,
    {
      method: 'GET',
      headers,
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.detail || `Failed to fetch saved insights (${response.status})`
    );
  }

  const data: { insights: SavedInsight[] } = await response.json();
  return data.insights;
}

/**
 * Delete a saved insight from the user's dashboard.
 */
export async function deleteSavedInsight(
  companyId: string,
  insightId: string
): Promise<void> {
  const headers = await getAuthHeaders();

  const response = await fetch(
    `${API_BASE_URL}/api/insights/${companyId}/saved/${insightId}`,
    {
      method: 'DELETE',
      headers,
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.detail || `Failed to delete saved insight (${response.status})`
    );
  }
}
