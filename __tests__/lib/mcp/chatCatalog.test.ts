import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import { CHAT_CLIENT_ID, CHAT_CLIENT_NAME, chatCallerFromClaims } from '@/lib/mcp/auth';
import { CHAT_EXCLUDED_TOOLS, chatToolManifest, chatTools } from '@/lib/mcp/chatCatalog';
import { ToolCatalog, defineCompanyTool, registerCompanyTool } from '@/lib/mcp/defineTool';
import type { CompanyInScope } from '@/lib/mcp/company';
import { registerJiggedTools } from '@/lib/mcp/server';

/**
 * Jigged chat's tool list and call path. The point of the catalogue is that it is NOT a second
 * list: these tests hold it to the MCP server's own registrations, and hold a chat call to the
 * same guards and the same audit row.
 */

const mockResolve = vi.fn();
vi.mock('@/lib/mcp/company', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/mcp/company')>()),
  resolveCompany: (...a: unknown[]) => mockResolve(...a),
}));

const mockRateLimit = vi.fn();
const mockRecord = vi.fn();
vi.mock('@/lib/mcp/audit', () => ({
  rateLimitRefusal: (...a: unknown[]) => mockRateLimit(...a),
  recordCall: (...a: unknown[]) => mockRecord(...a),
}));

const mockRunAsCaller = vi.fn();
vi.mock('@/lib/mcp/requestClient', () => ({
  runAsCaller: (caller: unknown, fn: () => Promise<unknown>) => mockRunAsCaller(caller, fn),
}));

vi.mock('@/lib/mcp/telemetry', () => ({ reportToolCall: vi.fn() }));

const COMPANY_ID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
const ACME: CompanyInScope = {
  id: COMPANY_ID,
  name: 'Acme Machining',
  role: 'admin',
  isDemo: false,
  governingCompanyId: COMPANY_ID,
};
const NOW = 1_800_000_000;
const CHAT_CALLER = {
  token: 'session-token',
  clientId: CHAT_CLIENT_ID,
  userId: 'user-1',
  email: 'owner@shop.test',
  expiresAt: NOW + 600,
};

/** Every name the MCP server registers, through a server that only records them. */
function mcpToolNames(): string[] {
  const names: string[] = [];
  const server = { registerTool: (name: string) => void names.push(name) };
  registerJiggedTools(server as unknown as Parameters<typeof registerJiggedTools>[0]);
  return names;
}

describe('the chat catalogue', () => {
  it('is every company tool /mcp offers, minus the two the chat has its own way of doing', () => {
    const expected = mcpToolNames().filter((n) => n !== 'list_my_companies' && !CHAT_EXCLUDED_TOOLS.has(n));
    expect(chatTools().map((t) => t.name)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(40);
  });

  it('never offers the chat a way to choose the company', () => {
    for (const entry of chatToolManifest()) {
      expect(entry.input_schema.type, entry.name).toBe('object');
      expect(Object.keys((entry.input_schema.properties ?? {}) as object), entry.name).not.toContain('company_id');
    }
  });

  it('marks every change as a write, and only a write as destructive', () => {
    const manifest = chatToolManifest();
    expect(new Set(manifest.map((e) => e.name)).size).toBe(manifest.length);
    expect(manifest.some((e) => e.access === 'write')).toBe(true);
    for (const entry of manifest) {
      if (entry.destructive) expect(entry.access, entry.name).toBe('write');
    }
    expect(manifest.find((e) => e.name === 'archive_record')?.destructive).toBe(true);
    expect(manifest.find((e) => e.name === 'list_jobs')?.access).toBe('read');
  });

  it('serialises the same way every time, because the list is part of the cached prompt prefix', () => {
    expect(JSON.stringify(chatToolManifest())).toBe(JSON.stringify(chatToolManifest()));
    expect(JSON.stringify(chatToolManifest())).not.toContain('"$schema"');
  });
});

describe('a chat call', () => {
  const run = vi.fn();
  const tool = defineCompanyTool({
    name: 'archive_widget',
    title: 'Archive widget',
    description: 'Archives a widget.',
    input: { widget_id: z.string() },
    output: { archived: z.boolean() },
    access: 'write',
    destructive: true,
    run: (args, env) => run(args, env),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue({ ok: true, company: ACME });
    mockRateLimit.mockResolvedValue(null);
    mockRecord.mockResolvedValue(undefined);
    mockRunAsCaller.mockImplementation((_caller: unknown, fn: () => Promise<unknown>) => fn());
    run.mockResolvedValue({ ok: true, data: { archived: true } });
  });

  function catalogued() {
    const catalog = new ToolCatalog();
    registerCompanyTool(catalog, tool);
    return catalog.tools[0];
  }

  const invocation = { caller: CHAT_CALLER, clientName: CHAT_CLIENT_NAME, origin: 'https://jigged.test', companyId: COMPANY_ID };

  it('runs through the same guards and writes the same audit row, as Jigged chat', async () => {
    const result = await catalogued().call({ widget_id: 'w-1' }, invocation);
    expect(result.isError).toBeFalsy();
    expect(mockResolve).toHaveBeenCalledWith(CHAT_CALLER, COMPANY_ID);
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID, isWrite: true }));
    expect(run).toHaveBeenCalledWith({ widget_id: 'w-1' }, expect.objectContaining({ company: ACME }));
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      clientId: CHAT_CLIENT_ID, clientName: 'Jigged chat', tool: 'archive_widget', isWrite: true, outcome: 'ok',
    }));
  });

  it('refuses invalid input before anything runs, and says nothing changed', async () => {
    const result = await catalogued().call({ widget_id: 42 }, invocation);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(result.content)).toContain('Nothing was read or changed');
    expect(mockRunAsCaller).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('ignores a company_id the model slips in: the route decides the company', async () => {
    await catalogued().call({ widget_id: 'w-1', company_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, invocation);
    expect(mockResolve).toHaveBeenCalledWith(CHAT_CALLER, COMPANY_ID);
    expect(run).toHaveBeenCalledWith({ widget_id: 'w-1' }, expect.anything());
  });
});

describe('chatCallerFromClaims', () => {
  const browser = { sub: 'user-1', role: 'authenticated', aud: 'authenticated', exp: NOW + 600, email: 'owner@shop.test' };

  it('accepts the person’s own browser session and logs it as Jigged chat', () => {
    expect(chatCallerFromClaims('t', browser, NOW)).toEqual({
      token: 't', clientId: CHAT_CLIENT_ID, userId: 'user-1', email: 'owner@shop.test', expiresAt: NOW + 600,
    });
  });

  it('refuses an AI assistant’s token: its only door is /mcp', () => {
    expect(chatCallerFromClaims('t', { ...browser, client_id: 'claude' }, NOW)).toBeNull();
  });

  it('refuses anonymous, expired and non-authenticated tokens', () => {
    expect(chatCallerFromClaims('t', { ...browser, is_anonymous: true }, NOW)).toBeNull();
    expect(chatCallerFromClaims('t', { ...browser, exp: NOW }, NOW)).toBeNull();
    expect(chatCallerFromClaims('t', { ...browser, role: 'anon' }, NOW)).toBeNull();
    expect(chatCallerFromClaims('t', { ...browser, sub: '' }, NOW)).toBeNull();
  });
});
