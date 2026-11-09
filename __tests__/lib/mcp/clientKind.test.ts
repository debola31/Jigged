import { describe, it, expect } from 'vitest';

import { clientKindOf } from '@/lib/mcp/clientKind';

describe('clientKindOf', () => {
  it.each([
    ['Claude', 'claude'],
    ['claude.ai', 'claude'],
    ['Anthropic Claude Code', 'claude'],
    ['ChatGPT', 'chatgpt'],
    ['OpenAI Connector', 'chatgpt'],
    ['Cursor', 'other'],
    ['', 'other'],
    [null, 'other'],
  ])('%s → %s', (name, kind) => {
    expect(clientKindOf(name)).toBe(kind);
  });
});
