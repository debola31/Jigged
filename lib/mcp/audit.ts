import { createClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';

import type { Database } from '@/types/database';
import { toError } from '@/lib/supabaseErrors';

/**
 * The AI-assistant call log (`mcp_tool_calls`) and the rate limit that counts it.
 *
 * Both run as service role: the table has RLS on and no policies, so an assistant's own token can
 * neither read what it did nor forge a row. An in-memory limiter would not hold on serverless,
 * where every instance has its own memory; counting the table does, the same pattern AI Insights
 * uses with `ai_jobs`.
 *
 * Neither ever fails a call. A log row that cannot be written, or a count that cannot be read, is
 * reported to Sentry and the call goes ahead: the limit protects against runaway loops, not
 * against a person, and refusing every call because the log is down would turn a logging fault
 * into an outage.
 */

/** Per-minute limits, the plan's starting point. Tune here. */
export const RATE_LIMITS = {
  /** Every call in one company (a demo counts as its own company). */
  companyCallsPerMinute: 120,
  /** Calls that change data, in one company. */
  companyWritesPerMinute: 30,
  /** Calls that name no company (list_my_companies), per person. */
  accountCallsPerMinute: 60,
} as const;

export type CallOutcome = 'ok' | 'refused' | 'rate_limited' | 'error';

export interface CallRecord {
  companyId: string | null;
  userId: string;
  clientId: string;
  clientName: string | null;
  tool: string;
  isWrite: boolean;
  outcome: CallOutcome;
  durationMs: number;
}

let client: ReturnType<typeof createClient<Database>> | null = null;

function serviceClient() {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase service credentials are not configured');
  client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  Sentry.instrumentSupabaseClient(client);
  return client;
}

/**
 * The sentence to refuse with when this call would go over a limit, or null to go ahead.
 *
 * `placeName` is how the refusal names the company ("in Acme Machining").
 */
export async function rateLimitRefusal(scope: {
  companyId: string | null;
  userId: string;
  isWrite: boolean;
  placeName?: string;
}): Promise<string | null> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const cap = scope.companyId ? RATE_LIMITS.companyCallsPerMinute : RATE_LIMITS.accountCallsPerMinute;
  try {
    const base = serviceClient().from('mcp_tool_calls').select('is_write').gte('created_at', since);
    const scoped = scope.companyId
      ? base.eq('company_id', scope.companyId)
      : base.eq('user_id', scope.userId).is('company_id', null);
    // Reading cap + 1 rows answers both questions: more than `cap` means over, and below that
    // every row in the window was read, so the write count is exact.
    const { data, error } = await scoped.limit(cap + 1);
    if (error) throw error;
    const rows = data ?? [];
    const where = scope.placeName ? ` in ${scope.placeName}` : '';
    if (rows.length > cap) {
      return `Assistants have made more than ${cap} requests${where} in the last minute. Wait a minute and try again.`;
    }
    if (scope.companyId && scope.isWrite) {
      const writes = rows.filter((r) => r.is_write).length;
      if (writes >= RATE_LIMITS.companyWritesPerMinute) {
        return `Assistants have made ${RATE_LIMITS.companyWritesPerMinute} changes${where} in the last minute, the most allowed. Wait a minute and try again; nothing was changed.`;
      }
    }
    return null;
  } catch (err) {
    Sentry.captureException(toError(err), { tags: { mcp: 'rate_limit' } });
    return null;
  }
}

/** Append one row to the call log. Never throws. */
export async function recordCall(row: CallRecord): Promise<void> {
  try {
    const { error } = await serviceClient().from('mcp_tool_calls').insert({
      company_id: row.companyId,
      user_id: row.userId,
      client_id: row.clientId.slice(0, 200),
      client_name: row.clientName?.trim() ? row.clientName.trim().slice(0, 200) : null,
      tool: row.tool,
      is_write: row.isWrite,
      outcome: row.outcome,
      duration_ms: Math.max(0, Math.round(row.durationMs)),
    });
    if (error) throw error;
  } catch (err) {
    Sentry.captureException(toError(err), { tags: { mcp: 'audit' } });
  }
}
