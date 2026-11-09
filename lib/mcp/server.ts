import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { callerOf, type McpCaller } from '@/lib/mcp/auth';
import { runAsCaller } from '@/lib/mcp/requestClient';
import { toError } from '@/lib/supabaseErrors';
import { getUserCompanies } from '@/utils/companyAccess';

/**
 * The Jigged MCP server's tools.
 *
 * Milestone 1 registers one, `list_my_companies`, to prove the whole path end to end: an
 * assistant signs the user in through Supabase's OAuth server, presents the token, and the
 * existing access layer answers as that user under RLS. The tool catalogue and the per-call
 * guard (company membership and role, the company's AI-access setting, rate limit, audit) arrive
 * in later milestones. The plan is `docs/modules/ai-assistants.md` once written.
 */

/**
 * Office roles. Operators are refused everywhere on this server. RLS does not tell an operator
 * from an office user (it is membership-only; the split is `AuthGuard`'s redirect), and a chat
 * window is the easiest place to assemble the per-person activity the surveillance guardrail
 * forbids (docs/modules/operator-view.md).
 */
export const OFFICE_ROLES = ['admin', 'user'] as const;
export type OfficeRole = (typeof OFFICE_ROLES)[number];

export function isOfficeRole(role: string | null | undefined): role is OfficeRole {
  return role === 'admin' || role === 'user';
}

function text(message: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) };
}

/** The public origin the assistant called, for deep links back into the app. */
function appOrigin(ctx: ServerContext): string | null {
  const url = ctx.http?.req?.url;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function asCaller(
  ctx: ServerContext,
  fn: (caller: McpCaller) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const caller = callerOf(ctx.http?.authInfo);
  // withMcpAuth({ required: true }) refuses an unauthenticated request before any tool runs, so
  // this is unreachable in practice. It stays, because a tool that ran without a caller would
  // run as `anon`.
  if (!caller) return text('You are not signed in to Jigged.', true);
  return runAsCaller(caller, () => fn(caller));
}

const DemoSchema = z.object({
  company_id: z.string(),
  url: z.string().nullable(),
});

const CompanySchema = z.object({
  company_id: z.string(),
  name: z.string(),
  role: z.enum(OFFICE_ROLES),
  url: z.string().nullable(),
  demo: DemoSchema.nullable(),
});

export function registerJiggedTools(server: McpServer): void {
  server.registerTool(
    'list_my_companies',
    {
      title: 'List my companies',
      description:
        'Lists the Jigged companies you can work in from this assistant, with your role in each ' +
        '(admin or user). Every other Jigged tool takes one of these company ids. A company that ' +
        'has a demo lists it under `demo`: a separate practice copy of that company filled with ' +
        'sample data, whose company_id every tool accepts too. Changes in a demo never reach the ' +
        'real company; setting one up or resetting it is done on the Jigged website. Companies ' +
        'where you are an operator are not listed: operator logins cannot use Jigged from an ' +
        'assistant.',
      inputSchema: z.object({}),
      outputSchema: z.object({ companies: z.array(CompanySchema) }),
      annotations: {
        title: 'List my companies',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, ctx) =>
      asCaller(ctx, async (caller) => {
        let rows;
        try {
          rows = await getUserCompanies(caller.userId);
        } catch (err) {
          Sentry.captureException(toError(err));
          return text("Jigged couldn't load your companies just now. Try again in a moment.", true);
        }
        const origin = appOrigin(ctx);
        const dashboard = (companyId: string) => (origin ? `${origin}/dashboard/${companyId}` : null);
        const companies = rows.flatMap((row) => {
          if (!isOfficeRole(row.role)) return [];
          // The demo belongs to the company: offered exactly when the company is, to the same
          // people. Membership in it is mirrored from the source on entry (sync_demo_access), so
          // the source's role is the one that decides.
          const demoId = row.companies?.demo_company_id ?? null;
          return [
            {
              company_id: row.company_id,
              name: row.companies?.name ?? 'Unnamed company',
              role: row.role,
              url: dashboard(row.company_id),
              demo: demoId ? { company_id: demoId, url: dashboard(demoId) } : null,
            },
          ];
        });
        const structuredContent = { companies };
        if (companies.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text:
                  "You don't have an office role (admin or user) in any Jigged company, so this " +
                  'assistant has nothing it can do for you yet. A company admin can change your role ' +
                  'under Team in Jigged.',
              },
            ],
            structuredContent,
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
      }),
  );
}
