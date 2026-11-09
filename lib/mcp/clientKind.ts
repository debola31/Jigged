/**
 * Which assistant an OAuth client is, for analytics only.
 *
 * The name comes from the client's own dynamic registration, so it is a claim, not an identity:
 * anyone can register a client called "Claude". That is fine for counting connections by
 * assistant and never fine for a security decision. The consent page shows the redirect host
 * beside the name for exactly that reason.
 */
export type ClientKind = 'claude' | 'chatgpt' | 'other';

export function clientKindOf(name: string | null | undefined): ClientKind {
  const n = (name ?? '').toLowerCase();
  if (n.includes('claude') || n.includes('anthropic')) return 'claude';
  if (n.includes('chatgpt') || n.includes('openai')) return 'chatgpt';
  return 'other';
}
