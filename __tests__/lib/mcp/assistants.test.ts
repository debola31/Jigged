import { describe, it, expect } from 'vitest';

import { isKnownAssistantRedirect } from '@/lib/mcp/assistants';

/**
 * The consent page approves only redirects to assistants Jigged knows. The rest of this file is
 * the phishing shapes that must stay refused.
 */
describe('isKnownAssistantRedirect', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/abc123',
    'https://vscode.dev/redirect',
    'http://localhost:6274/oauth/callback',
    'http://127.0.0.1:53682/callback',
    'http://[::1]:8976/callback',
  ])('accepts %s', (uri) => {
    expect(isKnownAssistantRedirect(uri)).toBe(true);
  });

  it.each([
    ['a look-alike host', 'https://claude.ai.evil.example/callback'],
    ['a subdomain of a look-alike', 'https://chatgpt.com.attacker.io/cb'],
    ['an assistant host over plain http', 'http://claude.ai/api/mcp/auth_callback'],
    ['an unrelated host', 'https://jigged-support.example/callback'],
    ['a custom scheme', 'claude://callback'],
    ['userinfo pretending to be the host', 'https://claude.ai@evil.example/cb'],
    ['garbage', 'not a url'],
  ])('refuses %s', (_label, uri) => {
    expect(isKnownAssistantRedirect(uri)).toBe(false);
  });
});
