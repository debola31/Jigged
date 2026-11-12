import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import {
  BAD_CURSOR_MESSAGE,
  addressOf,
  addressOutput,
  companyLink,
  pageInput,
  pageOutput,
  paginate,
  urlOutput,
} from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';
import type { FreightTerms, Shipment, ShippingMethod } from '@/types/shipment';
import {
  getOutsideShipmentsForJob,
  listOutsideShipmentsForCompany,
  outsideShipmentPoNumber,
  outstandingOn,
  roundQty,
} from '@/utils/outsideShipmentsAccess';
import { getShipmentsForJob, listShipmentsForCompany } from '@/utils/shipmentsAccess';

/**
 * Shipping tools: packing slips to customers, and parts out at a vendor for outside processing.
 *
 * Who packed, shipped or received anything is deliberately absent (`created_by`, `voided_by`,
 * `closed_by`, a receipt's `received_by`): the surveillance guardrail. Shipments carry no
 * `deleted_at` of their own (they are voided, never archived), so a list drops the ones whose
 * job is archived, the way the dashboard and the outside-shipments register do.
 */

export const SHIPPING_METHODS = [
  'customer_pickup',
  'personal_delivery',
  'shipment',
  'dropship',
  'restock',
] as const satisfies readonly ShippingMethod[];

export const FREIGHT_TERMS = ['prepaid', 'collect', 'third_party', 'customer_arranged'] as const satisfies readonly FreightTerms[];

const jobFilter = {
  job_id: z.guid().optional().describe('Only this job, by id.'),
  job_number: z.string().optional().describe('Only this job, by its number, when you have no id.'),
};

/** The job a list is narrowed to, or a sentence saying it isn't there. Archived jobs are not. */
async function jobInScope(
  args: { job_id?: string; job_number?: string },
  env: CompanyToolEnv,
): Promise<{ job: { id: string; job_number: string } | null } | { message: string }> {
  const number = args.job_number?.trim();
  if (!args.job_id && !number) return { job: null };
  let query = getSupabase()
    .from('jobs')
    .select('id, job_number')
    .eq('company_id', env.company.id)
    .is('deleted_at', null);
  query = args.job_id ? query.eq('id', args.job_id) : query.eq('job_number', number ?? '');
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      message: args.job_id
        ? `There is no job with that id in ${env.company.name}.`
        : `There is no job ${number} in ${env.company.name}.`,
    };
  }
  return { job: data };
}

/** Ids of this company's archived jobs, whose shipments stay out of every list. */
async function archivedJobIds(companyId: string): Promise<Set<string>> {
  const BATCH = 1000;
  const ids = new Set<string>();
  for (let offset = 0; ; offset += BATCH) {
    const { data, error } = await getSupabase()
      .from('jobs')
      .select('id')
      .eq('company_id', companyId)
      .not('deleted_at', 'is', null)
      .order('id')
      .range(offset, offset + BATCH - 1);
    if (error) throw error;
    for (const row of data ?? []) ids.add(row.id);
    if ((data?.length ?? 0) < BATCH) return ids;
  }
}

/** Job numbers and packed lines for one page of shipments: two small reads, never one per row. */
async function hydrateShipments(rows: Shipment[]): Promise<{
  jobNumbers: Map<string, string>;
  lines: Map<string, Array<{ part_id: string | null; part_name: string; quantity: number }>>;
}> {
  const jobNumbers = new Map<string, string>();
  const lines = new Map<string, Array<{ part_id: string | null; part_name: string; quantity: number }>>();
  if (rows.length === 0) return { jobNumbers, lines };
  const supabase = getSupabase();
  const [jobs, items] = await Promise.all([
    supabase.from('jobs').select('id, job_number').in('id', [...new Set(rows.map((r) => r.job_id))]),
    supabase
      .from('shipment_line_items')
      .select('shipment_id, quantity, job_part:job_parts(part:parts(id, part_name))')
      .in(
        'shipment_id',
        rows.map((r) => r.id),
      )
      .order('created_at'),
  ]);
  if (jobs.error) throw jobs.error;
  if (items.error) throw items.error;
  for (const j of jobs.data ?? []) jobNumbers.set(j.id, j.job_number);
  for (const li of items.data ?? []) {
    const list = lines.get(li.shipment_id) ?? [];
    list.push({
      part_id: li.job_part?.part?.id ?? null,
      part_name: li.job_part?.part?.part_name ?? 'Unknown part',
      quantity: Number(li.quantity),
    });
    lines.set(li.shipment_id, list);
  }
  return { jobNumbers, lines };
}

export const shipmentOutput = z.object({
  shipment_id: z.string(),
  packing_slip_number: z.string(),
  job_id: z.string(),
  job_number: z.string().nullable(),
  customer_id: z.string(),
  customer_name: z.string().nullable().describe('As printed on the packing slip.'),
  ship_date: z.string().describe('The day it left (YYYY-MM-DD).'),
  shipping_method: z
    .enum(SHIPPING_METHODS)
    .nullable()
    .describe('How it left: picked up, delivered by the shop, on a carrier, drop-shipped, or restocked.'),
  carrier: z.string().nullable().describe('Set when it went on a carrier: UPS, FedEx, USPS or another name.'),
  freight_terms: z.enum(FREIGHT_TERMS).nullable().describe('Who pays the freight.'),
  ship_to: addressOutput.nullable(),
  lines: z.array(z.object({ part_id: z.string().nullable(), part_name: z.string(), quantity: z.number() })),
  voided: z.boolean().describe('A voided slip shipped nothing; its quantities do not count.'),
  voided_at: z.string().nullable(),
  url: urlOutput.describe('The job\'s page in Jigged, where its packing slips are.'),
});

export const listShipments = defineCompanyTool({
  name: 'list_shipments',
  title: 'List shipments',
  description:
    'Lists packing slips: shipments of finished parts to customers, newest ship date first. ' +
    'Filters: a job (by id or number), a customer, a ship-date window, and whether to include ' +
    'voided slips (left out unless asked). Each shipment has its packing slip number, job, ' +
    'customer, ship date, how it went (method, carrier, freight terms), ship-to address and the ' +
    'parts and quantities packed. Jigged records no tracking numbers. Without a job filter the ' +
    'list covers the company\'s 1,000 most recent shipments.',
  access: 'read',
  input: {
    ...jobFilter,
    customer_id: z.guid().optional().describe('Only this customer\'s shipments.'),
    shipped_from: z.iso.date().optional().describe('Only shipments on or after this date (YYYY-MM-DD).'),
    shipped_to: z.iso.date().optional().describe('Only shipments on or before this date (YYYY-MM-DD).'),
    include_voided: z.boolean().optional().describe('Include voided packing slips. Defaults to false.'),
    ...pageInput,
  },
  output: { shipments: z.array(shipmentOutput), ...pageOutput },
  run: async (args, env) => {
    const scoped = await jobInScope(args, env);
    if ('message' in scoped) return { ok: false, message: scoped.message };
    const includeVoided = args.include_voided ?? false;

    let rows: Shipment[];
    if (scoped.job) {
      // One job's slips, uncapped. RLS scopes the read; the job was found in this company.
      rows = (await getShipmentsForJob(scoped.job.id))
        .filter((s) => !args.customer_id || s.customer_id === args.customer_id)
        .filter((s) => !args.shipped_from || s.ship_date >= args.shipped_from)
        .filter((s) => !args.shipped_to || s.ship_date <= args.shipped_to)
        .filter((s) => includeVoided || s.voided_at === null);
    } else {
      const [all, archived] = await Promise.all([
        listShipmentsForCompany(env.company.id, {
          customerId: args.customer_id,
          startDate: args.shipped_from,
          endDate: args.shipped_to,
          voided: includeVoided ? undefined : false,
        }),
        archivedJobIds(env.company.id),
      ]);
      rows = all.filter((s) => !archived.has(s.job_id));
    }

    const page = paginate(rows, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    const { jobNumbers, lines } = await hydrateShipments(page.items);
    return {
      ok: true,
      data: {
        shipments: page.items.map((s) => ({
          shipment_id: s.id,
          packing_slip_number: s.packing_slip_number,
          job_id: s.job_id,
          job_number: jobNumbers.get(s.job_id) ?? null,
          customer_id: s.customer_id,
          customer_name: s.customer_name,
          ship_date: s.ship_date,
          shipping_method: s.shipping_method,
          carrier: s.carrier,
          freight_terms: s.freight_terms,
          ship_to: addressOf(s.ship_to_address),
          lines: lines.get(s.id) ?? [],
          voided: s.voided_at !== null,
          voided_at: s.voided_at,
          url: companyLink(env, `/jobs/${s.job_id}`),
        })),
        total: page.total,
        next_cursor: page.next_cursor,
      },
    };
  },
});

const OUTSIDE_STATUSES = ['open', 'received', 'closed'] as const;

export const outsideShipmentOutput = z.object({
  outside_shipment_id: z.string(),
  slip_number: z.string().describe('The vendor packing slip that travelled with the parts.'),
  vendor_id: z.string(),
  vendor_name: z.string(),
  service: z.string().describe('The outside process, e.g. anodize or heat treat.'),
  job_id: z.string(),
  job_number: z.string().nullable(),
  part_id: z.string().nullable(),
  part_name: z.string(),
  operation: z.string().nullable().describe('The routing step this send belongs to.'),
  status: z
    .enum(OUTSIDE_STATUSES)
    .describe(
      '`open`: some is still at the vendor. `received`: everything came back. `closed`: the shop ' +
        'closed the slip short, so nothing more is expected.',
    ),
  quantity_sent: z.number(),
  quantity_received: z.number().describe('Good pieces back from the vendor.'),
  quantity_outstanding: z.number().describe('Still at the vendor; 0 once the slip is closed.'),
  sent_at: z.string(),
  expected_back: z.string().nullable().describe('The date the vendor committed to (YYYY-MM-DD), if any.'),
  carrier: z.string().nullable(),
  notes: z.string().nullable(),
  po_number: z
    .string()
    .nullable()
    .describe('The purchase order to a vendor this slip ships against (an outside-service line on it), if any. Never a customer PO.'),
  url: urlOutput.describe('The job\'s page in Jigged.'),
});

export function outsideStatus(s: OutsideShipmentWithRelations): (typeof OUTSIDE_STATUSES)[number] {
  if (s.closed_at) return 'closed';
  return outstandingOn(s) > 0 ? 'open' : 'received';
}

export const listOutsideShipments = defineCompanyTool({
  name: 'list_outside_shipments',
  title: 'List outside processing sends',
  description:
    'Lists parts sent to vendors for outside processing (plating, heat treat, anodize and the ' +
    'like). Without `open_only: false` it returns only sends with pieces still at the vendor. ' +
    'Filters: vendor and job (by id or number). Each send has its vendor, service, job, part, ' +
    'routing step, quantities sent, received and outstanding, the date sent and the date the ' +
    'vendor committed to return it. Voided sends are left out, and so are cancelled jobs\' sends ' +
    'unless that job is named. Newest send first. Without a job filter it reads the company\'s ' +
    '1,000 most recent sends. A send on a purchase order to a vendor names that PO.',
  access: 'read',
  input: {
    open_only: z.boolean().optional().describe('Only sends with pieces still at the vendor. Defaults to true.'),
    vendor_id: z.guid().optional().describe('Only this vendor\'s sends.'),
    ...jobFilter,
    ...pageInput,
  },
  output: { outside_shipments: z.array(outsideShipmentOutput), ...pageOutput },
  run: async (args, env) => {
    const scoped = await jobInScope(args, env);
    if ('message' in scoped) return { ok: false, message: scoped.message };
    const openOnly = args.open_only ?? true;

    let rows: OutsideShipmentWithRelations[];
    if (scoped.job) {
      // Every send on one job, voided ones included by the access function, so drop them here.
      rows = (await getOutsideShipmentsForJob(scoped.job.id)).filter((s) => s.voided_at === null);
      if (args.vendor_id) rows = rows.filter((s) => s.vendor_id === args.vendor_id);
      if (openOnly) rows = rows.filter((s) => outstandingOn(s) > 0);
    } else {
      rows = await listOutsideShipmentsForCompany(env.company.id, { vendorId: args.vendor_id, openOnly });
    }

    const page = paginate(rows, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    return {
      ok: true,
      data: {
        outside_shipments: page.items.map((s) => {
          const received = roundQty(
            (s.receipts ?? []).filter((r) => !r.voided_at).reduce((n, r) => n + Number(r.quantity_good), 0),
          );
          return {
            outside_shipment_id: s.id,
            slip_number: s.slip_number,
            vendor_id: s.vendor_id,
            vendor_name: s.vendor_name,
            service: s.service_name,
            job_id: s.job_id,
            job_number: s.job?.job_number ?? scoped.job?.job_number ?? null,
            part_id: s.job_part?.part?.id ?? null,
            part_name: s.job_part?.part?.part_name ?? 'Unknown part',
            operation: s.job_operation?.operation_name ?? null,
            status: outsideStatus(s),
            quantity_sent: Number(s.quantity),
            quantity_received: received,
            quantity_outstanding: outstandingOn(s),
            sent_at: s.shipped_at,
            expected_back: s.due_back_on,
            carrier: s.carrier,
            notes: s.notes,
            po_number: outsideShipmentPoNumber(s),
            url: companyLink(env, `/jobs/${s.job_id}`),
          };
        }),
        total: page.total,
        next_cursor: page.next_cursor,
      },
    };
  },
});

export function registerShippingTools(server: ToolTarget): void {
  registerCompanyTool(server, listShipments);
  registerCompanyTool(server, listOutsideShipments);
}

/** Exported for the catalogue test. */
export const SHIPPING_TOOLS = [listShipments, listOutsideShipments];
