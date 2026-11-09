/**
 * Who is calling an Edge Function, for functions deployed with `verify_jwt = false`
 * (supabase/config.toml). With that flag off, Supabase checks nothing before the function runs,
 * so a function that uses the service-role client must establish the caller itself, on every
 * route, before it reads or writes anything.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAnonClient } from './supabase.ts';

/**
 * True when the bearer token was issued to an OAuth client: an AI assistant (Claude, ChatGPT)
 * connected through Jigged's MCP server. Those tokens carry a `client_id` claim; a browser
 * session's do not. Team management is never done from an assistant, so these functions refuse
 * them outright. The claim is read without verifying the signature, which is safe only because a
 * token that says it is an assistant's is refused, never trusted.
 */
export function isAssistantToken(authHeader: string): boolean {
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const payload = token.split('.')[1];
  if (!payload) return false;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
    return typeof claims?.client_id === 'string' && claims.client_id.length > 0;
  } catch {
    return false;
  }
}

/** The signed-in person behind the request, or null. Assistant tokens never count as one. */
export async function callerUserId(authHeader: string): Promise<string | null> {
  if (!authHeader || isAssistantToken(authHeader)) return null;
  const { data, error } = await getAnonClient(authHeader).auth.getUser();
  return error || !data?.user ? null : data.user.id;
}

/** True when `userId` is an admin of `companyId`. Read with the service-role client. */
export async function isCompanyAdmin(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('user_company_access')
    .select('role')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  return data?.role === 'admin';
}
