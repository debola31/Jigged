import { describe, it, expect } from 'vitest';

import { clientKindOf } from '@/lib/mcp/clientKind';

describe('clientKindOf', () => {
  it.each([
    ['Claude', 'claude'],
    ['claude.ai', 'claude'],
    ['Anthropic Claude Code', 'claude'],
    ['ChatGPT', 'chatgpt'],
    ['OpenAI Connector', 'chatgpt'],
    ['Jigged chat', 'jigged_chat'],
    ['Not Jigged chat', 'other'],
    ['Cursor', 'other'],
    ['', 'other'],
    [null, 'other'],
  ])('%s → %s', (name, kind) => {
    expect(clientKindOf(name)).toBe(kind);
  });
});
