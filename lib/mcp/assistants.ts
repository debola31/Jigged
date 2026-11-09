/**
 * Which assistants may be connected to Jigged: decided by where the sign-in sends the code back.
 *
 * WHY THIS EXISTS. Supabase's OAuth server has open dynamic client registration (Claude and
 * ChatGPT need it), so anyone can register a client named "Claude" or "Jigged Support" and email a
 * shop owner an authorize link. An approved token carries the owner's full rights and works
 * directly against the database, not only through `/mcp`; Supabase does not bind tokens to a
 * resource. The client's NAME is self-declared and proves nothing. The REDIRECT URI is where the
 * code goes, and a phisher has to receive it on a host they control, so the consent page approves
 * only redirects to the hosts below. An attacker cannot approve on a victim's behalf: approval
 * needs the victim's own signed-in session, on this page.
 *
 * Loopback redirects are allowed for local tools (Claude Code, Cursor, MCP Inspector): a code
 * delivered to the person's own machine is of no use to someone elsewhere.
 *
 * Adding an assistant is one line here. Keep it to hosts the assistant's own docs name as its
 * OAuth callback.
 */
const ASSISTANT_REDIRECT_HOSTS = new Set([
  'claude.ai', // Claude: https://claude.ai/api/mcp/auth_callback
  'claude.com',
  'chatgpt.com', // ChatGPT: https://chatgpt.com/connector_platform_oauth_redirect, /connector/oauth/{id}
  'vscode.dev', // VS Code (GitHub Copilot) web redirect
  'insiders.vscode.dev',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isKnownAssistantRedirect(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) return url.protocol === 'http:' || url.protocol === 'https:';
  return url.protocol === 'https:' && ASSISTANT_REDIRECT_HOSTS.has(url.hostname);
}
