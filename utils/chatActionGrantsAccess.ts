import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';

/**
 * Jigged chat's "Always allow" grants: the actions a person lets the chat take for them
 * without asking first. Per person, per action, per company (public.chat_action_grants,
 * migration 20261110021756).
 *
 * The backend creates a grant -- in the same request that runs the change the person
 * clicked "Always allow" on -- so this module only lists and revokes. Revoking is archive:
 * `deleted_at` is set, and allowing the action again later revives the row. RLS scopes
 * both to the signed-in person's own grants.
 */

export interface ChatActionGrant {
  id: string;
  /** The MCP tool the grant covers, e.g. create_quote. */
  tool_name: string;
  created_at: string;
}

/** The person's live grants in a company, oldest first. */
export async function listChatActionGrants(companyId: string): Promise<ChatActionGrant[]> {
  const { data, error } = await getSupabase()
    .from('chat_action_grants')
    .select('id, tool_name, created_at')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) throw toFriendlyError(error, { fallback: 'Failed to load your allowed actions.' });
  return data ?? [];
}

/** Stop allowing one action: the chat asks first again from the next change. */
export async function revokeChatActionGrant(grantId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('chat_action_grants')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', grantId);
  if (error) throw toFriendlyError(error, { fallback: 'Failed to turn that action off.' });
}

/** "create_quote" -> "Create quote": the tool name read as words. */
export function actionLabel(toolName: string): string {
  const words = toolName.replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : toolName;
}
