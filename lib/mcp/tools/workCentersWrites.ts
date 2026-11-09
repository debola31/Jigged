import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv } from '@/lib/mcp/defineTool';
import { companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';
import { workCenterToFormData, type WorkCenter, type WorkCenterFormData } from '@/types/workCenter';
import { escapeIlikePattern } from '@/utils/searchFilter';
import {
  checkWorkCenterNameExists,
  createWorkCenter as createWorkCenterRow,
  getWorkCenter,
  updateWorkCenter as updateWorkCenterRow,
} from '@/utils/workCentersAccess';

/**
 * Creating and editing work centers, as the work center form does (components/work-centers/
 * WorkCenterForm.tsx): the same `createWorkCenter` / `updateWorkCenter`, the same checks first.
 * Every office user may do this in the app; nothing here is admin-only.
 *
 * A work center is an in-house machine, cell or station. An outside process is a vendor service,
 * set up on the vendor, and not a work center.
 */

/** work_centers_year_built_sane. */
const YEAR_MIN = 1900;
const YEAR_MAX = 2200;

const workCenterOutput = {
  work_center_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  labor_rate_per_hour: z
    .number()
    .nullable()
    .describe('The hourly labour rate its routing steps are costed at, unless a step sets its own.'),
  make: z.string().nullable(),
  model: z.string().nullable(),
  serial_number: z.string().nullable(),
  year_built: z.number().nullable(),
  purchased_on: z.string().nullable().describe('YYYY-MM-DD.'),
  url: urlOutput,
};

type WorkCenterOut = z.infer<z.ZodObject<typeof workCenterOutput>>;

function workCenterOut(wc: WorkCenter, env: CompanyToolEnv): WorkCenterOut {
  return {
    work_center_id: wc.id,
    name: wc.name,
    description: wc.description,
    labor_rate_per_hour: wc.labor_rate === null ? null : Number(wc.labor_rate),
    make: wc.make,
    model: wc.model,
    serial_number: wc.serial_number,
    year_built: wc.year_built,
    purchased_on: wc.purchased_on,
    url: companyLink(env, `/work-centers/${wc.id}`),
  };
}

// The machine details, all optional in the form. Blank or null clears one.
const machineDetailsInput = {
  make: z.string().nullable().optional().describe('Machine make, e.g. Haas. Null or blank clears it.'),
  model: z.string().nullable().optional().describe('Machine model, e.g. VF-2. Null or blank clears it.'),
  serial_number: z.string().nullable().optional().describe('Null or blank clears it.'),
  year_built: z.number().int().min(YEAR_MIN).max(YEAR_MAX).nullable().optional().describe('Null clears it.'),
  purchased_on: z.iso.date().nullable().optional().describe('YYYY-MM-DD. Null clears it.'),
};

const NAME_TAKEN = (name: string, env: CompanyToolEnv): string =>
  `${env.company.name} already has a work center named ${name}. Work center names are unique.`;

// ─── create_work_center ───────────────────────────────────────────────────────────────────────

export const createWorkCenter = defineCompanyTool({
  name: 'create_work_center',
  title: 'Create a work center',
  description:
    'Creates a work center in a Jigged company: an in-house machine, cell or station that routing ' +
    'steps run at, with the hourly labour rate those steps are costed at. Make, model, serial ' +
    'number, year built and purchase date are optional machine details. Reusing the name of an ' +
    'archived work center brings that one back with these values. Outside processes are vendor ' +
    'services, set up on the vendor, not work centers. Returns the work center.',
  access: 'write',
  idempotent: false,
  input: {
    name: z.string().describe('The work center\'s name, unique in the company.'),
    labor_rate_per_hour: z.number().min(0).describe('Hourly labour rate in dollars. Jigged needs it to cost and quote.'),
    description: z.string().optional(),
    ...machineDetailsInput,
  },
  output: workCenterOutput,
  run: async (args, env) => {
    const name = args.name.trim();
    if (!name) return { ok: false, message: 'A work center needs a name.' };
    // The form checks first, so a live duplicate is a sentence rather than a constraint error.
    if (await checkWorkCenterNameExists(env.company.id, name)) return { ok: false, message: NAME_TAKEN(name, env) };
    const form: WorkCenterFormData = {
      name,
      labor_rate: String(args.labor_rate_per_hour),
      description: args.description ?? '',
      make: args.make ?? '',
      model: args.model ?? '',
      serial_number: args.serial_number ?? '',
      year_built: args.year_built == null ? '' : String(args.year_built),
      purchased_on: args.purchased_on ?? '',
    };
    const created = await createWorkCenterRow(env.company.id, form);
    return { ok: true, data: workCenterOut(created, env) };
  },
});

// ─── update_work_center ───────────────────────────────────────────────────────────────────────

interface NameMatch {
  id: string;
  name: string;
  deleted_at: string | null;
}

/** A live work center beats an archived one, and exact case beats a case-only match. */
function bestNameMatch(rows: NameMatch[], name: string): NameMatch | null {
  const rank = (r: NameMatch): number => (r.deleted_at === null ? 0 : 2) + (r.name === name ? 0 : 1);
  return rows.slice().sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/**
 * The work center a tool names, in this company. A by-id or by-name read, so an archived one is
 * found too: its page still opens in the app, and so does its edit form.
 */
async function findWorkCenter(
  args: { work_center_id?: string; work_center_name?: string },
  env: CompanyToolEnv,
): Promise<{ workCenter: WorkCenter; archived: boolean } | { message: string }> {
  let match: { id: string; deleted_at: string | null } | null;
  if (args.work_center_id) {
    const { data, error } = await getSupabase()
      .from('work_centers')
      .select('id, deleted_at')
      .eq('company_id', env.company.id)
      .eq('id', args.work_center_id)
      .maybeSingle();
    if (error) throw error;
    match = data;
    if (!match) return { message: `There is no work center with that id in ${env.company.name}.` };
  } else if (args.work_center_name?.trim()) {
    const name = args.work_center_name.trim();
    const { data, error } = await getSupabase()
      .from('work_centers')
      .select('id, name, deleted_at')
      .eq('company_id', env.company.id)
      .ilike('name', escapeIlikePattern(name))
      .limit(20);
    if (error) throw error;
    match = bestNameMatch(data ?? [], name);
    if (!match) return { message: `There is no work center named ${name} in ${env.company.name}.` };
  } else {
    return { message: 'Give a work_center_id or a work_center_name.' };
  }
  const workCenter = await getWorkCenter(match.id);
  if (!workCenter) return { message: `There is no work center with that id in ${env.company.name}.` };
  return { workCenter, archived: match.deleted_at !== null };
}

const WORK_CENTER_FIELDS = [
  'name',
  'labor_rate_per_hour',
  'description',
  'make',
  'model',
  'serial_number',
  'year_built',
  'purchased_on',
] as const;

type WorkCenterField = (typeof WORK_CENTER_FIELDS)[number];

/** The form's text for an optional field: null or blank clears it, absent keeps it. */
const textOr = (given: string | null | undefined, current: string): string =>
  given === undefined ? current : (given ?? '');

export const updateWorkCenter = defineCompanyTool({
  name: 'update_work_center',
  title: 'Update a work center',
  description:
    'Changes a work center\'s name, hourly labour rate, description or machine details (make, ' +
    'model, serial number, year built, purchase date). Fields left out keep their value; null ' +
    'clears an optional one. A new labour rate re-costs every routing step that runs there ' +
    'without a rate of its own. Find the work center by id or by exact name. Returns the work ' +
    'center and which fields changed.',
  access: 'write',
  idempotent: true,
  input: {
    work_center_id: z.guid().optional().describe('The work center, by id.'),
    work_center_name: z.string().optional().describe('The work center, by its exact name, when you have no id.'),
    name: z.string().optional().describe('A new name for it.'),
    labor_rate_per_hour: z.number().min(0).optional().describe('A new hourly labour rate in dollars.'),
    description: z.string().nullable().optional().describe('Null or blank clears it.'),
    ...machineDetailsInput,
  },
  output: {
    ...workCenterOutput,
    archived: z.boolean().describe('The work center is archived: kept for history, hidden from lists and pickers.'),
    changed: z.array(z.enum(WORK_CENTER_FIELDS)).describe('The fields this call changed; empty when every value was already so.'),
  },
  run: async (args, env) => {
    const given = WORK_CENTER_FIELDS.some((field) => args[field] !== undefined);
    if (!given) {
      return {
        ok: false,
        message: `Give at least one field to change: ${WORK_CENTER_FIELDS.join(', ')}.`,
      };
    }
    const found = await findWorkCenter(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { workCenter, archived } = found;

    // The edit page seeds the form from the saved row; the form writes every field back.
    const current = workCenterToFormData(workCenter);
    const next: WorkCenterFormData = {
      name: current.name,
      labor_rate: args.labor_rate_per_hour === undefined ? current.labor_rate : String(args.labor_rate_per_hour),
      description: textOr(args.description, current.description),
      make: textOr(args.make, current.make),
      model: textOr(args.model, current.model),
      serial_number: textOr(args.serial_number, current.serial_number),
      year_built:
        args.year_built === undefined ? current.year_built : args.year_built === null ? '' : String(args.year_built),
      purchased_on: textOr(args.purchased_on, current.purchased_on),
    };
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) return { ok: false, message: 'A work center\'s name cannot be blank.' };
      if (await checkWorkCenterNameExists(env.company.id, name, workCenter.id)) {
        return { ok: false, message: NAME_TAKEN(name, env) };
      }
      next.name = name;
    }
    if (!next.labor_rate.trim()) {
      // A row saved before the rate became required. The form refuses to save it without one.
      return {
        ok: false,
        message: `${workCenter.name} has no labour rate, and Jigged needs one to save it. Give labor_rate_per_hour too.`,
      };
    }

    // Compared as the access layer will write them: trimmed, blank as null, numbers parsed.
    const blankAsNull = (s: string): string | null => s.trim() || null;
    const numberOrNull = (s: string): number | null => (s.trim() ? Number(s) : null);
    const changed = WORK_CENTER_FIELDS.filter((field: WorkCenterField) => {
      switch (field) {
        case 'name':
          return next.name.trim() !== workCenter.name;
        case 'labor_rate_per_hour':
          return numberOrNull(next.labor_rate) !== (workCenter.labor_rate === null ? null : Number(workCenter.labor_rate));
        case 'year_built':
          return numberOrNull(next.year_built) !== workCenter.year_built;
        case 'purchased_on':
          return (next.purchased_on || null) !== workCenter.purchased_on;
        default:
          return blankAsNull(next[field]) !== workCenter[field];
      }
    });
    if (changed.length === 0) {
      return { ok: true, data: { ...workCenterOut(workCenter, env), archived, changed } };
    }

    const updated = await updateWorkCenterRow(workCenter.id, next);
    return { ok: true, data: { ...workCenterOut(updated, env), archived, changed } };
  },
});

export function registerWorkCenterWriteTools(server: McpServer): void {
  registerCompanyTool(server, createWorkCenter);
  registerCompanyTool(server, updateWorkCenter);
}

/** Exported for the catalogue test. */
export const WORK_CENTER_WRITE_TOOLS = [createWorkCenter, updateWorkCenter];
