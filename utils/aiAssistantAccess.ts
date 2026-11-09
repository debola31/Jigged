import type { Json } from '@/types/database';
import type { OAuthGrant } from '@supabase/supabase-js';

import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import { getCompany } from '@/utils/companyAccess';

/**
 * AI assistants (Claude, ChatGPT, …) connected to Jigged through the MCP server: the person's own
 * connections, and the company's switches that bound what any assistant may do there.
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

export interface AssistantAccessPatch {
  ai_assistants?: boolean;
  ai_assistant_writes?: boolean;
}

/**
 * Set the company's assistant switches in `settings.features`. Read-modify-write of the whole
 * settings object, the same shape as `updateCompanyDefaults`; RLS lets only a company admin
 * update `companies`. The /mcp tool wrapper reads these from the real company even for calls into
 * its demo, so this is written on the real company only.
 */
export async function setAssistantAccess(companyId: string, patch: AssistantAccessPatch): Promise<void> {
  const company = await getCompany(companyId);
  if (!company) throw new Error('Company not found.');

  const settings = company.settings ?? {};
  const features =
    settings.features && typeof settings.features === 'object' && !Array.isArray(settings.features)
      ? (settings.features as Record<string, unknown>)
      : {};
  const nextSettings = { ...settings, features: { ...features, ...patch } } as Json;

  const { error } = await getSupabase()
    .from('companies')
    .update({ settings: nextSettings, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) throw toFriendlyError(error, { entity: 'settings', fallback: 'Failed to save that setting.' });
}
