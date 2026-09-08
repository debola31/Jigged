import { getSupabase } from '@/lib/supabase';
import type { ChartConfig } from '@/utils/insightsAccess';

// ============================================================
// Insights conversations — direct Supabase queries under RLS
// ============================================================
//
// A thread is PER USER. The browser creates it here and the row's created_by
// defaults from auth.uid(), so the route (which has no auth of its own) never has
// to be told who is asking; RLS on both tables reads created_by = auth.uid(). The
// browser never writes a message: the trigger on ai_jobs appends the user turn,
// the assistant turn and any summary when a job succeeds, and this file only
// reads them back.

export interface ChatThread {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** A displayed turn. Summary rows are the model's own notes and are never shown. */
export interface ThreadMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  chart_config: ChartConfig | null;
  created_at: string;
}

/** The first question, cut to fit the title column. No model call names a thread. */
export const THREAD_TITLE_MAX = 60;

export function threadTitleFrom(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= THREAD_TITLE_MAX) return trimmed;
  return `${trimmed.slice(0, THREAD_TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * INLINE LITERALS, not shared consts: `getSupabase()` type-checks `.select()`
 * against types/database.ts only when the column list is a literal (see
 * utils/insightsAccess.ts for the longer version of this note).
 */
export async function createThread(companyId: string, title: string): Promise<ChatThread> {
  const { data, error } = await getSupabase()
    .from('ai_chat_threads')
    .insert({ company_id: companyId, title: threadTitleFrom(title) || 'New conversation' })
    .select('id, title, created_at, updated_at')
    .single();

  if (error) throw new Error(`Failed to start a conversation: ${error.message}`);
  return data;
}

/** The caller's recent conversations in this shop, newest first. RLS scopes to the caller. */
export async function listThreads(companyId: string, limit = 10): Promise<ChatThread[]> {
  const { data, error } = await getSupabase()
    .from('ai_chat_threads')
    .select('id, title, created_at, updated_at')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to load conversations: ${error.message}`);
  return data ?? [];
}

/** Archive, never delete: the messages under it are the record of what the AI said. */
export async function archiveThread(threadId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('ai_chat_threads')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', threadId);

  if (error) throw new Error(`Failed to archive the conversation: ${error.message}`);
}

/**
 * Narrow a jsonb chart_config to the app type, or null. The server validated it
 * before it was stored; this guards the read against a shape change rather than
 * asserting through it.
 */
function chartConfigOf(raw: unknown): ChartConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.chart_type !== 'string') return null;
  if (!Array.isArray(candidate.data)) return null;
  if (typeof candidate.x_key !== 'string' || typeof candidate.y_key !== 'string') return null;
  return candidate as unknown as ChartConfig;
}

/**
 * The displayed turns of one thread, oldest first. Summary rows are excluded
 * here rather than in the caller: they are the model's notes to itself.
 */
export async function listThreadMessages(threadId: string): Promise<ThreadMessage[]> {
  const { data, error } = await getSupabase()
    .from('ai_chat_messages')
    .select('id, seq, role, content, chart_config, created_at')
    .eq('thread_id', threadId)
    .in('role', ['user', 'assistant'])
    .order('seq', { ascending: true });

  if (error) throw new Error(`Failed to load the conversation: ${error.message}`);

  const out: ThreadMessage[] = [];
  for (const row of data ?? []) {
    // `role` is text with a CHECK, so it arrives as string; narrow it rather than
    // assert, so a row the CHECK does not know about is dropped, not rendered.
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    out.push({
      id: row.id,
      seq: row.seq,
      role: row.role,
      content: row.content,
      chart_config: chartConfigOf(row.chart_config),
      created_at: row.created_at,
    });
  }
  return out;
}
