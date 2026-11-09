import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import {
  BILLING_BLOCKED_MESSAGE,
  UNEXPECTED_ERROR_MESSAGE,
  defineCompanyTool,
  registerCompanyTool,
} from '@/lib/mcp/defineTool';
import type { CompanyInScope } from '@/lib/mcp/company';

/**
 * The wrapper every Jigged MCP tool runs through. Each test is one guard: who may call, in which
 * company, under which company settings, how often, and what the person is told when it fails.
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

const mockCapture = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException: (...a: unknown[]) => mockCapture(...a) }));

const COMPANY_ID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';

const ACME: CompanyInScope = {
  id: COMPANY_ID,
  name: 'Acme Machining',
  role: 'admin',
  isDemo: false,
  governingCompanyId: COMPANY_ID,
  settings: null,
};

const AUTH_INFO = {
  token: 'oauth-token',
  clientId: 'client-9',
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  extra: { userId: 'user-1', email: 'owner@shop.test' },
};

type Callback = (args: unknown, ctx: unknown) => Promise<{
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}>;

interface Registered {
  name: string;
  config: { inputSchema: z.ZodType; annotations: Record<string, unknown> };
  cb: Callback;
}

function register(tool: Parameters<typeof registerCompanyTool>[1]): Registered {
  let captured: Registered | undefined;
  const server = {
    registerTool: (name: string, config: Registered['config'], cb: Callback) => {
      captured = { name, config, cb };
    },
  };
  registerCompanyTool(server as unknown as Parameters<typeof registerCompanyTool>[0], tool);
  if (!captured) throw new Error('tool was not registered');
  return captured;
}

const ctx = (authInfo: unknown = AUTH_INFO) => ({
  http: { authInfo, req: { url: 'https://jigged.test/mcp' } },
  mcpReq: { envelope: { 'io.modelcontextprotocol/clientInfo': { name: 'Claude', version: '1' } } },
});

const run = vi.fn();

const readTool = defineCompanyTool({
  name: 'count_widgets',
  title: 'Count widgets',
  description: 'Counts widgets.',
  input: { colour: z.string() },
  output: { count: z.number() },
  access: 'read',
  run: (args, env) => run(args, env),
});

const writeTool = defineCompanyTool({
  name: 'archive_widget',
  title: 'Archive widget',
  description: 'Archives a widget.',
  input: { widget_id: z.string() },
  output: { archived: z.boolean() },
  access: 'write',
  destructive: true,
  run: (args, env) => run(args, env),
});

describe('registerCompanyTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue({ ok: true, company: ACME });
    mockRateLimit.mockResolvedValue(null);
    mockRecord.mockResolvedValue(undefined);
    mockRunAsCaller.mockImplementation((_caller: unknown, fn: () => Promise<unknown>) => fn());
    run.mockResolvedValue({ ok: true, data: { count: 3 } });
  });

  it('adds company_id to every tool input and states every hint explicitly', () => {
    const read = register(readTool);
    expect(read.config.inputSchema.safeParse({ colour: 'red', company_id: COMPANY_ID }).success).toBe(true);
    expect(read.config.inputSchema.safeParse({ colour: 'red' }).success).toBe(false);
    expect(read.config.annotations).toEqual({
      title: 'Count widgets',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(register(writeTool).config.annotations).toEqual({
      title: 'Archive widget',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('runs the tool as the caller, in the resolved company, and logs the call', async () => {
    const { cb } = register(readTool);
    const res = await cb({ colour: 'red', company_id: COMPANY_ID }, ctx());

    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), COMPANY_ID);
    // The tool sees its own fields; the company arrives resolved, not as a raw id.
    expect(run).toHaveBeenCalledWith({ colour: 'red' }, expect.objectContaining({ company: ACME }));
    expect(run.mock.calls[0][1].link('/dashboard/x')).toBe('https://jigged.test/dashboard/x');
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ count: 3 });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        userId: 'user-1',
        clientId: 'client-9',
        clientName: 'Claude',
        tool: 'count_widgets',
        isWrite: false,
        outcome: 'ok',
      }),
    );
  });

  it('refuses a company the caller cannot use, and logs the refusal without a company', async () => {
    mockResolve.mockResolvedValue({ ok: false, message: 'No such company for you.' });
    const res = await register(readTool).cb({ colour: 'red', company_id: COMPANY_ID }, ctx());
    expect(res).toEqual({ content: [{ type: 'text', text: 'No such company for you.' }], isError: true });
    expect(run).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ companyId: null, outcome: 'refused' }));
  });

  it('refuses every call when the company has turned assistants off', async () => {
    mockResolve.mockResolvedValue({
      ok: true,
      company: { ...ACME, settings: { features: { ai_assistants: false } } },
    });
    const res = await register(readTool).cb({ colour: 'red', company_id: COMPANY_ID }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/turned off AI assistant access/);
    expect(run).not.toHaveBeenCalled();
  });

  it('read-only assistants may still read, but not write', async () => {
    mockResolve.mockResolvedValue({
      ok: true,
      company: { ...ACME, settings: { features: { ai_assistant_writes: false } } },
    });
    const read = await register(readTool).cb({ colour: 'red', company_id: COMPANY_ID }, ctx());
    expect(read.isError).toBeFalsy();

    run.mockClear();
    const write = await register(writeTool).cb({ widget_id: 'w-1', company_id: COMPANY_ID }, ctx());
    expect(write.isError).toBe(true);
    expect(write.content[0].text).toMatch(/read-only there, so nothing was changed/);
    expect(run).not.toHaveBeenCalled();
  });

  it('stops at the rate limit before running anything', async () => {
    mockRateLimit.mockResolvedValue('Too many, wait a minute.');
    const res = await register(writeTool).cb({ widget_id: 'w-1', company_id: COMPANY_ID }, ctx());
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, isWrite: true, placeName: 'Acme Machining' }),
    );
    expect(res.content[0].text).toBe('Too many, wait a minute.');
    expect(run).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'rate_limited' }));
  });

  it("passes on the tool's own refusal as an error the person can read", async () => {
    run.mockResolvedValue({ ok: false, message: 'There is no widget w-9.' });
    const res = await register(writeTool).cb({ widget_id: 'w-9', company_id: COMPANY_ID }, ctx());
    expect(res).toEqual({ content: [{ type: 'text', text: 'There is no widget w-9.' }], isError: true });
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused' }));
  });

  it('names a lapsed subscription instead of reporting a failure', async () => {
    run.mockRejectedValue({ code: '42501', message: 'new row violates row-level security policy "billing_gate_insert"' });
    const res = await register(writeTool).cb({ widget_id: 'w-1', company_id: COMPANY_ID }, ctx());
    expect(res.content[0].text).toBe(BILLING_BLOCKED_MESSAGE);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused' }));
  });

  it('reports an unexpected failure to Sentry and tells the person in a sentence', async () => {
    run.mockRejectedValue(new Error('connection reset'));
    const res = await register(readTool).cb({ colour: 'red', company_id: COMPANY_ID }, ctx());
    expect(res).toEqual({ content: [{ type: 'text', text: UNEXPECTED_ERROR_MESSAGE }], isError: true });
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('never runs without a caller', async () => {
    const res = await register(readTool).cb({ colour: 'red', company_id: COMPANY_ID }, ctx(null));
    expect(res.isError).toBe(true);
    expect(mockRunAsCaller).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
