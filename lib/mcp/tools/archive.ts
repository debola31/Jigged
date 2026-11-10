import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import { companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';
import { softDeleteCustomer } from '@/utils/customerAccess';
import { deleteJob } from '@/utils/jobsAccess';
import { deletePart } from '@/utils/partsAccess';
import { deleteQuote } from '@/utils/quotesAccess';
import { deleteVendor } from '@/utils/vendorsAccess';
import { deleteWorkCenter } from '@/utils/workCentersAccess';

/**
 * archive_record: the app's "Delete" for the six user-facing records an assistant can name. Each
 * one is the function that record's own page calls from its Delete button, and every one of them
 * only stamps `deleted_at` (parts through the archive_parts RPC, which also drops the part from
 * other parts' bills of materials so their cost recomputes). Nothing is erased and nothing is
 * blocked by references; an invoiced or shipped job archives like any other (CLAUDE.md).
 *
 *   customer     softDeleteCustomer   customers/[customerId] page, and the Customers list
 *   vendor       deleteVendor         vendors/[vendorId] page (the list uses bulkDeleteVendors)
 *   part         deletePart           PartWorkspace (the list uses bulkDeleteParts; same RPC)
 *   quote        deleteQuote          quotes/[quoteId] page, and the Quotes list
 *   job          deleteJob            jobs/[jobId] page
 *   work_center  deleteWorkCenter     work-centers/[workCenterId] page
 *
 * None of those buttons is admin-only or gated by the record's state: no AdminGuard, no
 * `isAdmin` check, no status condition on any of them, so any office user may archive here too.
 * What this adds is the refusal the pages never need: a record already archived is left alone,
 * so its original archive time stands.
 *
 * Bringing one back is the access layer's, not this tool's: creating a customer, vendor or work
 * center with an archived one's name revives it; a part's archived namesake is renamed
 * "<name> (archived)" when a new part takes the name.
 */

const ENTITIES = ['customer', 'vendor', 'part', 'quote', 'job', 'work_center'] as const;
type Entity = (typeof ENTITIES)[number];

interface Target {
  /** The name, or the number for a quote or job. */
  label: string;
  archived: boolean;
}

const NOUN: Record<Entity, string> = {
  customer: 'customer',
  vendor: 'vendor',
  part: 'part',
  quote: 'quote',
  job: 'job',
  work_center: 'work center',
};

const PATH: Record<Entity, string> = {
  customer: '/customers',
  vendor: '/vendors',
  part: '/parts',
  quote: '/quotes',
  job: '/jobs',
  work_center: '/work-centers',
};

/**
 * The record, in this company, archived or not: a by-id read, so it does not filter `deleted_at`.
 * One typed query per table; the tables name their label differently.
 */
async function findTarget(entity: Entity, id: string, env: CompanyToolEnv): Promise<Target | null> {
  const db = getSupabase();
  const companyId = env.company.id;
  switch (entity) {
    case 'customer': {
      const { data, error } = await db.from('customers').select('name, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.name, archived: data.deleted_at !== null };
    }
    case 'vendor': {
      const { data, error } = await db.from('vendors').select('name, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.name, archived: data.deleted_at !== null };
    }
    case 'part': {
      const { data, error } = await db.from('parts').select('part_name, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.part_name, archived: data.deleted_at !== null };
    }
    case 'quote': {
      const { data, error } = await db.from('quotes').select('quote_number, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.quote_number, archived: data.deleted_at !== null };
    }
    case 'job': {
      const { data, error } = await db.from('jobs').select('job_number, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.job_number, archived: data.deleted_at !== null };
    }
    case 'work_center': {
      const { data, error } = await db.from('work_centers').select('name, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.name, archived: data.deleted_at !== null };
    }
  }
}

/** The archive function each record's page calls, with the arguments it passes. */
const ARCHIVE: Record<Entity, (id: string, companyId: string) => Promise<void>> = {
  customer: (id) => softDeleteCustomer(id),
  vendor: (id) => deleteVendor(id),
  part: (id) => deletePart(id),
  quote: (id, companyId) => deleteQuote(id, companyId),
  job: (id, companyId) => deleteJob(id, companyId),
  work_center: (id) => deleteWorkCenter(id),
};

export const archiveRecord = defineCompanyTool({
  name: 'archive_record',
  title: 'Archive a record',
  description:
    "Archives a customer, vendor, part, quote, job or work center by id: Jigged's Delete. The " +
    'record leaves every list, search and picker, while quotes, jobs, shipments and invoices that ' +
    'reference it keep working and its page stays reachable by link. Nothing is erased, and ' +
    'references never block it: an invoiced job archives like any other. Archiving a part also ' +
    "removes it from other parts' bills of materials, so their costs recompute. Creating a " +
    'customer, vendor or work center with the same name later brings it back. Returns the record ' +
    'and a link to its page.',
  access: 'write',
  destructive: true,
  idempotent: false,
  input: {
    entity: z.enum(ENTITIES).describe('What kind of record.'),
    id: z.guid().describe('The record, by id: a customer_id, vendor_id, part_id, quote_id, job_id or work_center_id.'),
  },
  output: {
    entity: z.enum(ENTITIES),
    id: z.string(),
    name_or_number: z.string().describe('The name, or the quote or job number.'),
    archived: z.literal(true),
    url: urlOutput,
  },
  run: async (args, env) => {
    const noun = NOUN[args.entity];
    const target = await findTarget(args.entity, args.id, env);
    if (!target) return { ok: false, message: `There is no ${noun} with that id in ${env.company.name}.` };
    if (target.archived) {
      return { ok: false, message: `The ${noun} ${target.label} is already archived, so nothing was changed.` };
    }

    await ARCHIVE[args.entity](args.id, env.company.id);
    return {
      ok: true,
      data: {
        entity: args.entity,
        id: args.id,
        name_or_number: target.label,
        archived: true as const,
        url: companyLink(env, `${PATH[args.entity]}/${args.id}`),
      },
    };
  },
});

export function registerArchiveTools(server: ToolTarget): void {
  registerCompanyTool(server, archiveRecord);
}

/** Exported for the catalogue test. */
export const ARCHIVE_TOOLS = [archiveRecord];
