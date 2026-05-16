/**
 * Append-only audit logger for authentication-adjacent admin actions.
 *
 * Writes are best-effort and MUST NOT throw — an audit failure must not
 * break the user-facing flow. Errors are logged via console.error so they
 * appear in the Supabase function logs.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type AuthAuditOutcome = 'success' | 'forbidden' | 'failed';

export interface AuthAuditEntry {
  actor_user_id?: string | null;
  target_user_id?: string | null;
  company_id?: string | null;
  event_type: string;
  outcome: AuthAuditOutcome;
  error_detail?: string | null;
}

export async function writeAuthAudit(
  supabase: SupabaseClient,
  entry: AuthAuditEntry,
): Promise<void> {
  try {
    const { error } = await supabase.from('auth_audit_log').insert({
      actor_user_id: entry.actor_user_id ?? null,
      target_user_id: entry.target_user_id ?? null,
      company_id: entry.company_id ?? null,
      event_type: entry.event_type,
      outcome: entry.outcome,
      error_detail: entry.error_detail ?? null,
    });
    if (error) {
      console.error('writeAuthAudit insert failed:', error.message, entry);
    }
  } catch (e) {
    console.error('writeAuthAudit threw:', e, entry);
  }
}
