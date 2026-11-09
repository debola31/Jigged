import type { OAuthGrant } from '@supabase/supabase-js';

import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';

/**
 * AI assistants (Claude, ChatGPT, …) connected to Jigged through the MCP server: the person's own
 * connections. There is no per-company switch; any office user may connect one.
 */

/** Every assistant this person has approved, across all their companies. */
export async function listConnectedAssistants(): Promise<OAuthGrant[]> {
  const { data, error } = await getSupabase().auth.oauth.listGrants();
  if (error) throw toFriendlyError(error, { fallback: 'Failed to load your connected assistants.' });
  return data ?? [];
}

/**
 * Disconnect one assistant. Supabase revokes the grant, deletes that assistant's sessions and
 * invalidates its refresh tokens. An access token it already holds stays valid until it expires
 * (an hour at most); the next refresh fails and the assistant asks to connect again.
 */
export async function disconnectAssistant(clientId: string): Promise<void> {
  const { error } = await getSupabase().auth.oauth.revokeGrant({ clientId });
  if (error) throw toFriendlyError(error, { fallback: 'Failed to disconnect that assistant.' });
}
