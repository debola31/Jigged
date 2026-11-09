import { describe, it, expect } from 'vitest';

import { claudeInstallLink, mcpServerUrl } from '@/lib/mcp/connectLinks';

describe('connect links', () => {
  it('builds the server URL from the origin, with or without a trailing slash', () => {
    expect(mcpServerUrl('https://jigged.app')).toBe('https://jigged.app/mcp');
    expect(mcpServerUrl('https://jigged.app/')).toBe('https://jigged.app/mcp');
  });

  it("builds Claude's documented install link, with the server URL percent-encoded", () => {
    expect(claudeInstallLink('https://jigged.app/mcp')).toBe(
      'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Jigged&connectorUrl=https%3A%2F%2Fjigged.app%2Fmcp',
    );
  });
});
