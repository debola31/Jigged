import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool } from '@/lib/mcp/defineTool';
import { BAD_CURSOR_MESSAGE, companyLink, pageInput, pageOutput, paginate, urlOutput } from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';
import { getAllWorkCenters } from '@/utils/workCentersAccess';

/**
 * Work centers: the shop's in-house machines, cells and stations. Outside processes are vendor
 * services, owned by a vendor, and are not work centers (types/workCenter.ts).
 */

/**
 * Work center id → routing steps on this company's live parts that run there: the
 * `work_center_usage` RPC, which ranks the routing editor's station picker.
 *
 * Called directly rather than through `getWorkCenterUsage`, which turns an error into an empty
 * map so the picker can fall back to name order. Here an empty map would report every work
 * center as used by no routing steps: a confident wrong answer, where a failed read should say
 * it failed.
 */
async function routingStepCounts(companyId: string): Promise<Map<string, number>> {
  const { data, error } = await getSupabase().rpc('work_center_usage', { p_company_id: companyId });
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.work_center_id, Number(row.uses)]));
}

const workCenterSummary = z.object({
  work_center_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  labor_rate_per_hour: z
    .number()
    .nullable()
    .describe('The hourly labour rate its routing steps are costed at, unless a step sets its own.'),
  make: z.string().nullable(),
  model: z.string().nullable(),
  routing_steps: z
    .number()
    .describe(
      'How many routing steps on the company\'s live parts run at this work center: how widely it ' +
        'is routed, not its current workload or queue.',
    ),
  url: urlOutput,
});

export const listWorkCenters = defineCompanyTool({
  name: 'list_work_centers',
  title: 'List work centers',
  description:
    'Lists a Jigged company\'s work centers: its in-house machines, cells and stations. Outside ' +
    'processes are vendor services and are not listed. Each has its hourly labour rate, make and ' +
    'model when recorded, and how many routing steps on live parts run there (a measure of how ' +
    'widely it is routed, not of current workload). Search matches the name. Sorted by name, or ' +
    'by most routing steps when `sort` is `most_routed`. Archived work centers are not listed.',
  access: 'read',
  input: {
    search: z.string().optional().describe('Work center name.'),
    sort: z.enum(['name', 'most_routed']).optional(),
    ...pageInput,
  },
  output: { work_centers: z.array(workCenterSummary), ...pageOutput },
  run: async (args, env) => {
    // getAllWorkCenters filters `deleted_at IS NULL` and sorts by name.
    const [workCenters, steps] = await Promise.all([
      getAllWorkCenters(env.company.id, args.search),
      routingStepCounts(env.company.id),
    ]);
    const rows = workCenters.map((wc) => ({ wc, routingSteps: steps.get(wc.id) ?? 0 }));
    if (args.sort === 'most_routed') {
      rows.sort((a, b) => b.routingSteps - a.routingSteps || a.wc.name.localeCompare(b.wc.name));
    }
    const page = paginate(rows, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    return {
      ok: true,
      data: {
        work_centers: page.items.map(({ wc, routingSteps }) => ({
          work_center_id: wc.id,
          name: wc.name,
          description: wc.description,
          labor_rate_per_hour: wc.labor_rate === null ? null : Number(wc.labor_rate),
          make: wc.make,
          model: wc.model,
          routing_steps: routingSteps,
          url: companyLink(env, `/work-centers/${wc.id}`),
        })),
        total: page.total,
        next_cursor: page.next_cursor,
      },
    };
  },
});

export function registerWorkCenterTools(server: McpServer): void {
  registerCompanyTool(server, listWorkCenters);
}

/** Exported for the catalogue test. */
export const WORK_CENTER_TOOLS = [listWorkCenters];
