import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import { companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { vendorPoPath, vendorRfqPath } from '@/lib/purchasingRoutes';
import { getSupabase } from '@/lib/supabase';
import { softDeleteCustomer } from '@/utils/customerAccess';
import { deleteJob } from '@/utils/jobsAccess';
import { archivePartVendor } from '@/utils/partVendorsAccess';
import { deletePart } from '@/utils/partsAccess';
import { deleteQuote } from '@/utils/quotesAccess';
import { archiveVendorPo, getVendorPoArchiveImpact } from '@/utils/vendorPoAccess';
import { setVendorRfqState } from '@/utils/vendorRfqAccess';
import { deleteVendor } from '@/utils/vendorsAccess';
import { deleteWorkCenter } from '@/utils/workCentersAccess';

/**
 * archive_record: the app's "Delete" for the user-facing records an assistant can name. Each one
 * is the function that record's own page calls from its Delete button, and every one of them only
 * stamps `deleted_at` (parts through the archive_parts RPC, which also drops the part from other
 * parts' bills of materials so their cost recomputes; the purchasing three through their RPCs).
 * Nothing is erased and nothing is blocked by references; an invoiced or shipped job archives like
 * any other (CLAUDE.md).
 *
 *   customer     softDeleteCustomer   customers/[customerId] page, and the Customers list
 *   vendor       deleteVendor         vendors/[vendorId] page (the list uses bulkDeleteVendors)
 *   part         deletePart           PartWorkspace (the list uses bulkDeleteParts; same RPC)
 *   quote        deleteQuote          quotes/[quoteId] page, and the Quotes list
 *   job          deleteJob            jobs/[jobId] page
 *   work_center  deleteWorkCenter     work-centers/[workCenterId] page
 *   vendor_po    archiveVendorPo      the PO page (purchasing/orders/[poId]): a purchase order TO A
 *                                     VENDOR. It unlinks the vendor slips of its outside lines and
 *                                     never calls QuickBooks, so one pushed there stays open there;
 *                                     `warnings` says so, from getVendorPoArchiveImpact (the facts
 *                                     behind that page's archive dialog)
 *   vendor_rfq   setVendorRfqState    the RFQ page (purchasing/rfqs/[rfqId]), action 'archive'
 *   part_vendor  archivePartVendor    the part's Buying tab: a vendor taken off the part's approved
 *                                     list (its price sheet is kept; the preferred vendor is
 *                                     cleared if it was this one)
 *
 * None of those buttons is admin-only or gated by the record's state: no AdminGuard, no
 * `isAdmin` check, no status condition on any of them, so any office user may archive here too.
 * What this adds is the refusal the pages never need: a record already archived is left alone,
 * so its original archive time stands.
 *
 * Bringing one back is the access layer's, not this tool's: creating a customer, vendor or work
 * center with an archived one's name revives it; a part's archived namesake is renamed
 * "<name> (archived)" when a new part takes the name; saving the same vendor on a part's list
 * again revives its entry. A purchase order or RFQ is not revived: its number is never reissued.
 */

const ENTITIES = [
  'customer',
  'vendor',
  'part',
  'quote',
  'job',
  'work_center',
  'vendor_po',
  'vendor_rfq',
  'part_vendor',
] as const;
type Entity = (typeof ENTITIES)[number];

interface Target {
  /** The name, or the number for a quote, job, PO or RFQ. */
  label: string;
  archived: boolean;
  /** The record's page, below /dashboard/{company}. */
  path: string;
}

const NOUN: Record<Entity, string> = {
  customer: 'customer',
  vendor: 'vendor',
  part: 'part',
  quote: 'quote',
  job: 'job',
  work_center: 'work center',
  vendor_po: 'vendor PO',
  vendor_rfq: 'RFQ',
  part_vendor: 'approved-vendor entry',
};

/** A purchasing page's path (lib/purchasingRoutes builds every one) below /dashboard/{company}. */
const underCompany = (full: string): string => full.replace(/^\/dashboard\/[^/]+/, '');

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
      return data && { label: data.name, archived: data.deleted_at !== null, path: `/customers/${id}` };
    }
    case 'vendor': {
      const { data, error } = await db.from('vendors').select('name, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.name, archived: data.deleted_at !== null, path: `/vendors/${id}` };
    }
    case 'part': {
      const { data, error } = await db.from('parts').select('part_name, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.part_name, archived: data.deleted_at !== null, path: `/parts/${id}` };
    }
    case 'quote': {
      const { data, error } = await db.from('quotes').select('quote_number, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.quote_number, archived: data.deleted_at !== null, path: `/quotes/${id}` };
    }
    case 'job': {
      const { data, error } = await db.from('jobs').select('job_number, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.job_number, archived: data.deleted_at !== null, path: `/jobs/${id}` };
    }
    case 'work_center': {
      const { data, error } = await db.from('work_centers').select('name, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.name, archived: data.deleted_at !== null, path: `/work-centers/${id}` };
    }
    case 'vendor_po': {
      const { data, error } = await db
        .from('vendor_purchase_orders')
        .select('po_number, deleted_at')
        .eq('company_id', companyId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data && { label: data.po_number, archived: data.deleted_at !== null, path: underCompany(vendorPoPath(companyId, id)) };
    }
    case 'vendor_rfq': {
      const { data, error } = await db.from('vendor_rfqs').select('rfq_number, deleted_at').eq('company_id', companyId).eq('id', id).maybeSingle();
      if (error) throw error;
      return data && { label: data.rfq_number, archived: data.deleted_at !== null, path: underCompany(vendorRfqPath(companyId, id)) };
    }
    case 'part_vendor': {
      const { data, error } = await db
        .from('part_vendors')
        .select('part_id, deleted_at, parts(part_name), vendors(name)')
        .eq('company_id', companyId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        label: `${data.vendors?.name ?? 'The vendor'} for ${data.parts?.part_name ?? 'the part'}`,
        archived: data.deleted_at !== null,
        // The approved vendor list lives on the part's page, on its Buying tab.
        path: `/parts/${data.part_id}`,
      };
    }
  }
}

/**
 * The archive function each record's page calls, with the arguments it passes, and the
 * consequences that page's archive dialog states. None of them blocks: archive never does.
 */
const ARCHIVE: Record<Entity, (id: string, companyId: string, target: Target) => Promise<string[]>> = {
  customer: async (id) => {
    await softDeleteCustomer(id);
    return [];
  },
  vendor: async (id) => {
    await deleteVendor(id);
    return [];
  },
  part: async (id) => {
    await deletePart(id);
    return [];
  },
  quote: async (id, companyId) => {
    await deleteQuote(id, companyId);
    return [];
  },
  job: async (id, companyId) => {
    await deleteJob(id, companyId);
    return [];
  },
  work_center: async (id) => {
    await deleteWorkCenter(id);
    return [];
  },
  vendor_po: async (id, _companyId, target) => {
    // Read first, as the dialog is: what QuickBooks holds is Jigged's own record, never a QuickBooks call.
    const impact = await getVendorPoArchiveImpact(id);
    await archiveVendorPo(id);
    const warnings: string[] = [];
    if (impact.inQuickBooks && !impact.closedInQuickBooks) {
      warnings.push(`${target.label} stays open in QuickBooks; close it there.`);
    }
    if (impact.linkedSlipCount === 1) {
      warnings.push('1 vendor slip that shipped against it is no longer linked to it; it stays on its job.');
    } else if (impact.linkedSlipCount > 1) {
      warnings.push(
        `${impact.linkedSlipCount} vendor slips that shipped against it are no longer linked to it; they stay on their jobs.`,
      );
    }
    return warnings;
  },
  vendor_rfq: async (id) => {
    await setVendorRfqState(id, 'archive');
    return [];
  },
  part_vendor: async (id, _companyId, target) => {
    const result = await archivePartVendor(id);
    if (!result.clearedPreferred) return [];
    const [vendor, part] = target.label.split(' for ');
    return [`${vendor} was ${part}'s preferred vendor, so the part has none now.`];
  },
};

export const archiveRecord = defineCompanyTool({
  name: 'archive_record',
  title: 'Archive a record',
  description:
    'Archives a customer, vendor, part, quote, job, work center, purchase order to a vendor ' +
    "(vendor_po), RFQ to vendors (vendor_rfq) or a vendor's entry on a part's approved vendor list " +
    "(part_vendor) by id: Jigged's Delete. The record leaves every list, search and picker, while " +
    'the records that reference it keep working and its page stays reachable by link. Nothing is ' +
    'erased, and references never block it: an invoiced job archives like any other. Archiving a ' +
    "part also removes it from other parts' bills of materials, so their costs recompute. Archiving " +
    'a purchase order to a vendor unlinks its vendor slips and leaves QuickBooks alone: one sent ' +
    'there stays open there, which `warnings` says. Creating a customer, vendor or work center with ' +
    'the same name later brings it back; a PO or RFQ number is never reused. Returns the record and ' +
    'a link to its page.',
  access: 'write',
  destructive: true,
  idempotent: false,
  input: {
    entity: z.enum(ENTITIES).describe('What kind of record.'),
    id: z
      .guid()
      .describe(
        'The record, by id: a customer_id, vendor_id, part_id, quote_id, job_id, work_center_id, ' +
          'vendor_po_id, vendor_rfq_id or part_vendor_id.',
      ),
  },
  output: {
    entity: z.enum(ENTITIES),
    id: z.string(),
    name_or_number: z.string().describe('The name, or the quote, job, PO or RFQ number.'),
    archived: z.literal(true),
    warnings: z.array(z.string()).describe('What the archive dialog would point out. None of it stopped the archive.'),
    url: urlOutput,
  },
  run: async (args, env) => {
    const noun = NOUN[args.entity];
    const target = await findTarget(args.entity, args.id, env);
    if (!target) return { ok: false, message: `There is no ${noun} with that id in ${env.company.name}.` };
    if (target.archived) {
      return { ok: false, message: `The ${noun} ${target.label} is already archived, so nothing was changed.` };
    }

    const warnings = await ARCHIVE[args.entity](args.id, env.company.id, target);
    return {
      ok: true,
      data: {
        entity: args.entity,
        id: args.id,
        name_or_number: target.label,
        archived: true as const,
        warnings,
        url: companyLink(env, target.path),
      },
    };
  },
});

export function registerArchiveTools(server: ToolTarget): void {
  registerCompanyTool(server, archiveRecord);
}

/** Exported for the catalogue test. */
export const ARCHIVE_TOOLS = [archiveRecord];
