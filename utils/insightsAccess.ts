import { API_BASE_URL } from '@/lib/api';
import type { Database } from '@/types/database';
import { getSupabase } from '@/lib/supabase';

// ============================================================
// Types
// ============================================================

/**
 * What a card on the dashboard renders. Every one of them is a saved insight.
 *
 * It used to also carry `type`, `metric_data` and `is_cached`, from the withdrawn
 * pre-built "5 cached cards" panel. The one construction site left passes
 * `type: 'saved'`, `metric_data: {}` and `is_cached: false` — literals, on every
 * render — which made the alert list and the type-label lookup in InsightCard
 * statically unreachable. Fields nothing can vary are not fields.
 */
export interface InsightCard {
  summary: string;
  chart_config: ChartConfig | null;
  computed_at: string;
}

export interface ChartConfig {
  chart_type: 'area' | 'pie' | 'bar' | 'bar_horizontal' | 'sparkline';
  data: Record<string, unknown>[];
  x_key: string;
  y_key: string;
  x_label?: string;
  y_label?: string;
}

/** What lands in `ai_jobs.result`, and what the ask bar renders. */
export interface ChatResponse {
  answer: string;
  chart_config: ChartConfig | null;
  tool_calls: string[];
  /** Whoever ACTUALLY answered: anthropic | ollama | deepinfra. */
  provider: string;
  model?: string | null;
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
 * Ask a question. Returns a JOB ID, not an answer.
 *
 * The answer arrives on the `ai_jobs` row, which the browser polls directly under
 * RLS — see `hooks/useAiJob.ts`. Two reasons that is worth the extra hop: the
 * request no longer has to outlive a model, so the 60-second serverless wall stops
 * applying to this path at all; and the poll costs zero function invocations and
 * zero AI credits, because it is a `SELECT` on one row the user already owns.
 *
 * This is the ONLY thing that creates AI work. The feature flag and the
 * per-company hourly cap sit behind it, which is what keeps the polling loops
 * above honest.
 */
export async function submitChatQuery(
  companyId: string,
  question: string,
): Promise<ChatEnqueued> {
  const headers = await getAuthHeaders();

  const response = await fetch(`${API_BASE_URL}/api/insights/${companyId}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ question }),
  });

  if (!response.ok) {
    // Surface the backend's message verbatim: it carries the company's real
    // rate-limit number on 429, the "AI Insights is disabled" text on 403, and the
    // offline sentence on 503. `detail` is always a plain string on purpose —
    // _map_llm_error keeps it one, because this line renders it into an Alert and
    // an object would show the user "[object Object]".
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to submit chat query (${response.status})`);
  }

  return (await response.json()) as ChatEnqueued;
}

// ============================================================
// The job row, read straight from Supabase
// ============================================================

export interface ChatEnqueued {
  job_id: string;
  status: string;
  executor: 'worker' | 'backend';
}

/**
 * One queue row, as the browser sees it — DERIVED from the generated schema, not
 * restated. `status` is therefore `string`, because the column is `text` with a
 * CHECK rather than a Postgres enum (this schema has none), and hand-writing it as
 * a union here would be a claim types/database.ts does not make. Narrow with the
 * helpers below.
 *
 * `result` is `Json` because the column is jsonb — use `chatResultOf()` rather than
 * asserting, so a shape change surfaces as "no answer" instead of a blank card.
 */
export type AiJob = Pick<
  Database['public']['Tables']['ai_jobs']['Row'],
  | 'id'
  | 'status'
  | 'executor'
  | 'model'
  | 'result'
  | 'error'
  | 'error_kind'
  | 'created_at'
  | 'expires_at'
  | 'lease_expires_at'
  | 'batch_key'
>;

const TERMINAL: readonly string[] = ['succeeded', 'failed', 'timed_out'];

export function isTerminal(job: AiJob | null): boolean {
  return !!job && TERMINAL.includes(job.status);
}

export function isInFlight(job: AiJob | null): boolean {
  return !!job && (job.status === 'claimed' || job.status === 'running');
}

/**
 * INLINE LITERAL, not a shared const. `getSupabase()` type-checks `.select()`
 * against types/database.ts, and it can only do that when the column list is a
 * literal — a runtime-concatenated string collapses the result to
 * `GenericStringError[]` and the only way out is a cast, which is exactly the
 * erasure CLAUDE.md forbids. Duplicating twelve column names is the cheaper price.
 */
const AI_JOB_SELECT =
  'id, status, executor, model, result, error, error_kind, created_at, expires_at, lease_expires_at, batch_key' as const;

/**
 * Narrow `ai_jobs.result` to the answer shape.
 *
 * The column is `jsonb`, so the generated types give it back as `Json` and nothing
 * downstream knows it is a ChatResponse. Checked at runtime rather than asserted:
 * a job written by an older worker, or a handler that changed shape, would
 * otherwise render as a blank card with no clue why.
 */
export function chatResultOf(job: AiJob | null): ChatResponse | null {
  const raw = job?.result;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.answer !== 'string') return null;
  return {
    answer: candidate.answer,
    chart_config: (candidate.chart_config as ChartConfig | null) ?? null,
    tool_calls: Array.isArray(candidate.tool_calls) ? (candidate.tool_calls as string[]) : [],
    provider: typeof candidate.provider === 'string' ? candidate.provider : 'unknown',
    model: typeof candidate.model === 'string' ? candidate.model : null,
    tokens_used: typeof candidate.tokens_used === 'number' ? candidate.tokens_used : null,
  };
}

/**
 * Read one job. RLS scopes it to the caller's own companies, so there is nothing
 * to check here beyond "did we get a row".
 *
 * Deliberately NOT a FastAPI endpoint. A status poll through Vercel would cost one
 * function invocation every second or two per open tab, to read a single row the
 * browser is already allowed to read.
 */
export async function getAiJob(jobId: string): Promise<AiJob | null> {
  const { data, error } = await getSupabase()
    .from('ai_jobs')
    .select(AI_JOB_SELECT)
    .eq('id', jobId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Whether a live worker can serve `model`, from the heartbeat table.
 *
 * MODEL-AWARE, matching the server-side sweep exactly: a worker that is up but has
 * never loaded qwen3-vl:4b is not coverage for a drawing job, and treating it as
 * such would leave that job pending forever behind a box that looks alive.
 *
 * A HINT, NOT THE AUTHORITY. The enqueue response is authoritative — this exists so
 * the ask bar can say "offline" before someone types a question, and because the
 * staleness comparison happens against the CLIENT's clock, which can be wrong.
 */
export async function isAiWorkerAvailable(model?: string): Promise<boolean> {
  const staleAfter = new Date(Date.now() - WORKER_STALE_AFTER_MS).toISOString();
  const { data, error } = await getSupabase()
    .from('ai_workers')
    .select('models, last_seen_at')
    .gte('last_seen_at', staleAfter);

  if (error) throw error;
  const live = data ?? [];
  if (!model) return live.length > 0;
  return live.some((w) => (w.models ?? []).includes(model));
}

/**
 * 60 seconds — four missed 15-second beats, so a GC pause or one slow write never
 * flips the UI. This number appears in exactly three places and they must agree:
 * here, `sweep_ai_jobs()`, and `ai_workers.last_seen_at`'s column comment.
 */
export const WORKER_STALE_AFTER_MS = 60_000;
