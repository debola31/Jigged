import {
  CLIENT_INFO_META_KEY,
  type CallToolResult,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { callerOf, type McpCaller } from '@/lib/mcp/auth';
import { recordCall, rateLimitRefusal, type CallOutcome } from '@/lib/mcp/audit';
import { assistantAccessRefusal, resolveCompany, type CompanyInScope } from '@/lib/mcp/company';
import { runAsCaller } from '@/lib/mcp/requestClient';
import { isBillingWriteBlocked, toError } from '@/lib/supabaseErrors';

/**
 * Every Jigged MCP tool is declared through this file, and every call runs through one wrapper.
 * A tool says what it does; the wrapper decides whether it may run:
 *
 *   1. who is calling      the OAuth token's user (withMcpAuth has already verified it)
 *   2. which company       membership and an office role there; a demo resolves through its
 *                          real company (lib/mcp/company.ts)
 *   3. the company's say   `ai_assistants` off refuses everything; `ai_assistant_writes` off
 *                          refuses writes
 *   4. how fast            the per-minute limits in lib/mcp/audit.ts
 *   5. the call itself     inside `runAsCaller`, so the access layer runs as this person under
 *                          RLS and the billing gate, exactly as in their browser
 *   6. what happened       one `mcp_tool_calls` row per call, refusals included
 *
 * Errors come back as a sentence with `isError: true`, never a protocol failure, so the assistant
 * can tell the person what went wrong. Unexpected ones also go to Sentry.
 *
 * Annotations are explicit on every tool, `false` included: the ChatGPT directory requires
 * `readOnlyHint`, `destructiveHint` and `openWorldHint` to be set, and Claude prompts before a
 * destructive one.
 */

export type ToolAccess = 'read' | 'write';

/** What a tool's own code returns. A refusal is the tool's decision (no such job, wrong state). */
export type ToolResult<T> = { ok: true; data: T; text?: string } | { ok: false; message: string };

export interface ToolEnv {
  caller: McpCaller;
  /** An absolute link into the app for `path` (`/dashboard/...`), or null when unknown. */
  link: (path: string) => string | null;
}

export interface CompanyToolEnv extends ToolEnv {
  company: CompanyInScope;
}

interface ToolMeta<O extends z.ZodRawShape> {
  /** snake_case, at most 64 characters. */
  name: string;
  title: string;
  /** What the tool does and returns. Never how the assistant should behave. */
  description: string;
  output: O;
  access: ToolAccess;
  /** Archives, voids, cancels, conversions, anything a person would want to confirm. */
  destructive?: boolean;
  /** Calling it twice with the same input leaves the same state. Reads always are. */
  idempotent?: boolean;
  /** Reaches outside Jigged (QuickBooks). */
  openWorld?: boolean;
}

/** The input every company tool shares, added by the wrapper. */
export const companyIdInput = z
  .uuid()
  .describe('The company to work in: a company_id from list_my_companies, or the company_id of one of its demos.');


export interface CompanyTool<I extends z.ZodRawShape, O extends z.ZodRawShape> extends ToolMeta<O> {
  scope: 'company';
  input: I;
  /** `args` are the tool's own fields; the company it acts in is `env.company`. */
  run: (args: z.infer<z.ZodObject<I>>, env: CompanyToolEnv) => Promise<ToolResult<z.infer<z.ZodObject<O>>>>;
}

export interface AccountTool<O extends z.ZodRawShape> extends ToolMeta<O> {
  scope: 'account';
  run: (env: ToolEnv) => Promise<ToolResult<z.infer<z.ZodObject<O>>>>;
}

export function defineCompanyTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(
  spec: Omit<CompanyTool<I, O>, 'scope'>,
): CompanyTool<I, O> {
  return { ...spec, scope: 'company' };
}

/** A tool that acts in no company. There is one: list_my_companies. */
export function defineAccountTool<O extends z.ZodRawShape>(spec: Omit<AccountTool<O>, 'scope'>): AccountTool<O> {
  return { ...spec, scope: 'account' };
}

export const BILLING_BLOCKED_MESSAGE =
  "This company's Jigged subscription isn't active, so it is read-only and nothing was changed. " +
  'An admin can update billing in Jigged under Settings.';

export const UNEXPECTED_ERROR_MESSAGE =
  "Jigged couldn't finish that just now. Try again in a moment; if it keeps happening, contact Jigged support.";

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function successResult(data: Record<string, unknown>, text?: string): CallToolResult {
  return { content: [{ type: 'text', text: text ?? JSON.stringify(data) }], structuredContent: data };
}

function annotationsOf(meta: ToolMeta<z.ZodRawShape>) {
  const readOnly = meta.access === 'read';
  return {
    title: meta.title,
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && Boolean(meta.destructive),
    idempotentHint: readOnly || Boolean(meta.idempotent),
    openWorldHint: Boolean(meta.openWorld),
  };
}

/** The public origin the assistant called, for deep links back into the app. */
function originOf(ctx: ServerContext): string | null {
  const url = ctx.http?.req?.url;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The name the client reported in this request, when it sent one. Clients on the 2026-07-28
 * protocol carry it in every request's `_meta` envelope; older clients sent it once, at
 * initialize, which a stateless server never sees again. The SDK types the envelope as `{}`, so
 * it is read as untyped data.
 */
function clientNameOf(ctx: ServerContext): string | null {
  const envelope: unknown = ctx.mcpReq.envelope;
  if (!isRecord(envelope)) return null;
  const info = envelope[CLIENT_INFO_META_KEY];
  return isRecord(info) && typeof info.name === 'string' ? info.name : null;
}

interface CallFrame {
  caller: McpCaller;
  clientName: string | null;
  tool: string;
  isWrite: boolean;
  started: number;
  companyId: string | null;
}

async function finish(frame: CallFrame, outcome: CallOutcome, result: CallToolResult): Promise<CallToolResult> {
  await recordCall({
    companyId: frame.companyId,
    userId: frame.caller.userId,
    clientId: frame.caller.clientId,
    clientName: frame.clientName,
    tool: frame.tool,
    isWrite: frame.isWrite,
    outcome,
    durationMs: Date.now() - frame.started,
  });
  return result;
}

async function failure(frame: CallFrame, err: unknown): Promise<CallToolResult> {
  if (isBillingWriteBlocked(err)) return finish(frame, 'refused', errorResult(BILLING_BLOCKED_MESSAGE));
  Sentry.captureException(toError(err), { tags: { mcp_tool: frame.tool } });
  return finish(frame, 'error', errorResult(UNEXPECTED_ERROR_MESSAGE));
}

async function settle<T extends Record<string, unknown>>(
  frame: CallFrame,
  result: ToolResult<T>,
): Promise<CallToolResult> {
  return result.ok
    ? finish(frame, 'ok', successResult(result.data, result.text))
    : finish(frame, 'refused', errorResult(result.message));
}

export function registerCompanyTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(
  server: McpServer,
  tool: CompanyTool<I, O>,
): void {
  const ownInput = z.object(tool.input);
  const inputSchema = z.object({ ...tool.input, company_id: companyIdInput });
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema,
      outputSchema: z.object(tool.output),
      annotations: annotationsOf(tool),
    },
    async (args, ctx) => {
      const caller = callerOf(ctx.http?.authInfo);
      // withMcpAuth({ required: true }) refuses an unauthenticated request before any tool runs.
      // This stays because a tool that ran without a caller would run as `anon`.
      if (!caller) return errorResult('You are not signed in to Jigged.');
      const frame: CallFrame = {
        caller,
        clientName: clientNameOf(ctx),
        tool: tool.name,
        isWrite: tool.access === 'write',
        started: Date.now(),
        companyId: null,
      };
      const origin = originOf(ctx);
      // The SDK has validated `args` against `inputSchema` already. Parsing again splits them
      // into the company and the tool's own fields, each with its real type, which the SDK's
      // generic callback signature loses. `z.object` strips `company_id` from the second.
      const raw: unknown = args;
      const companyId = companyIdInput.parse(isRecord(raw) ? raw.company_id : undefined);
      const input = ownInput.parse(raw);
      return runAsCaller(caller, async () => {
        try {
          const resolved = await resolveCompany(caller, companyId);
          if (!resolved.ok) return finish(frame, 'refused', errorResult(resolved.message));
          const company = resolved.company;
          frame.companyId = company.id;

          const refusal = assistantAccessRefusal(company, frame.isWrite);
          if (refusal) return finish(frame, 'refused', errorResult(refusal));

          const limited = await rateLimitRefusal({
            companyId: company.id,
            userId: caller.userId,
            isWrite: frame.isWrite,
            placeName: company.name,
          });
          if (limited) return finish(frame, 'rate_limited', errorResult(limited));

          const result = await tool.run(input, {
            caller,
            company,
            link: (path) => (origin ? `${origin}${path}` : null),
          });
          return settle(frame, result);
        } catch (err) {
          return failure(frame, err);
        }
      });
    },
  );
}

export function registerAccountTool<O extends z.ZodRawShape>(server: McpServer, tool: AccountTool<O>): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: z.object({}),
      outputSchema: z.object(tool.output),
      annotations: annotationsOf(tool),
    },
    async (_args, ctx) => {
      const caller = callerOf(ctx.http?.authInfo);
      if (!caller) return errorResult('You are not signed in to Jigged.');
      const frame: CallFrame = {
        caller,
        clientName: clientNameOf(ctx),
        tool: tool.name,
        isWrite: tool.access === 'write',
        started: Date.now(),
        companyId: null,
      };
      const origin = originOf(ctx);
      return runAsCaller(caller, async () => {
        try {
          const limited = await rateLimitRefusal({ companyId: null, userId: caller.userId, isWrite: frame.isWrite });
          if (limited) return finish(frame, 'rate_limited', errorResult(limited));
          const result = await tool.run({ caller, link: (path) => (origin ? `${origin}${path}` : null) });
          return settle(frame, result);
        } catch (err) {
          return failure(frame, err);
        }
      });
    },
  );
}
