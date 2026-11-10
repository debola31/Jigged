/**
 * Which assistant an OAuth client is, for analytics only.
 *
 * The name comes from the client's own dynamic registration, so it is a claim, not an identity:
 * anyone can register a client called "Claude". That is fine for counting connections by
 * assistant and never fine for a security decision. The consent page shows the redirect host
 * beside the name for exactly that reason.
 */
export type ClientKind = 'claude' | 'chatgpt' | 'jigged_chat' | 'other';

export function clientKindOf(name: string | null | undefined): ClientKind {
  const n = (name ?? '').toLowerCase();
  // Jigged's own chat, calling the same tools from the dashboard (app/chat-tools). Set by our
  // server (CHAT_CLIENT_NAME in lib/mcp/auth.ts), never by a client, so an exact match.
  if (n === 'jigged chat') return 'jigged_chat';
  if (n.includes('claude') || n.includes('anthropic')) return 'claude';
  if (n.includes('chatgpt') || n.includes('openai')) return 'chatgpt';
  return 'other';
}
