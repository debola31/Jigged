import { describe, it, expect, afterEach, vi } from 'vitest';

import { GET } from '@/app/.well-known/openai-apps-challenge/route';

/** OpenAI's domain check reads the token as the whole body, so anything else must be absent. */
describe('/.well-known/openai-apps-challenge', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('serves the token as plain text and nothing else', async () => {
    vi.stubEnv('OPENAI_APPS_CHALLENGE', '  tok_abc123  ');
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('tok_abc123');
  });

  it('is a 404 until a token is configured', async () => {
    vi.stubEnv('OPENAI_APPS_CHALLENGE', '');
    expect(GET().status).toBe(404);
  });
});
