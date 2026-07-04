import { API_BASE_URL } from '@/lib/api';
import { getTypedSupabase as getSupabase } from '@/lib/supabase';

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

export interface ChatResponse {
  answer: string;
  chart_config: ChartConfig | null;
  tool_calls: string[];
  provider: string;
  tokens_used: number | null;
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
    // Surface the backend's message verbatim: it carries the company's real
    // rate-limit number on 429 and the "AI Insights is disabled" text on 403.
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.detail || `Failed to submit chat query (${response.status})`
    );
  }

  return await response.json();
}
