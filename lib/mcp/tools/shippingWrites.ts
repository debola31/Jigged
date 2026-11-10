import { z } from 'zod';

import {
  outsideReceiptCaption,
  outsideReceiptConsequence,
  outsideSendCaption,
  outsideSendConsequence,
} from '@/components/operations/operationMath';
import { carrierAccountMismatch } from '@/components/shipments/shipmentMath';
import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import { addressOf, companyLink } from '@/lib/mcp/tools/shared';
import {
  FREIGHT_TERMS,
  SHIPPING_METHODS,
  outsideShipmentOutput,
  outsideStatus,
  shipmentOutput,
} from '@/lib/mcp/tools/shipping';
import { getSupabase } from '@/lib/supabase';
import { toCreditStatus } from '@/types/customer';
import { toBillToParty, type CustomerCarrierAccount } from '@/types/customerCarrierAccount';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';
import {
  CARRIER_OPTIONS,
  FREIGHT_TERMS_METHODS,
  toFreightTerms,
  type CreateShipmentPayload,
  type ShipmentWithRelations,
} from '@/types/shipment';
import { billableCarrierAccounts } from '@/utils/customerCarrierAccountsAccess';
import {
  createOutsideShipment,
  getOpenOutsideShipments,
  getOutsideShipmentById,
  getOutsideSummariesForPart,
  outstandingOn,
  receiveOutsideOperation,
  receiveOutsideShipment,
  resolveVendorShipTo,
  roundQty,
  voidOutsideShipment,
} from '@/utils/outsideShipmentsAccess';
import {
  createShipment,
  getJobPartShipmentSummaries,
  getShipmentById,
  resolveFreightLine,
  voidShipment,
} from '@/utils/shipmentsAccess';

/**
 * Shipping write tools: packing slips to customers, and parts out to (and back from) vendors for
 * outside processing. Each one runs the access function the job page runs, with the arguments its
 * dialog passes, and refuses what the page would not offer:
 *
 *   create_shipment        ShipmentForm (CreateShipmentModal)  → createShipment
 *   void_shipment          PackingSlipPreviewDialog's Void     → voidShipment
 *   send_outside           SendToVendorDialog (OperationsPanel) → createOutsideShipment
 *   receive_outside        ReceiveFromVendorDialog (OperationsPanel, OutsideWorkDrawer)
 *                                                               → receiveOutsideShipment, or
 *                                                                 receiveOutsideOperation when no
 *                                                                 slip is open
 *   void_outside_shipment  OutsideShipmentPreviewDialog's Void → voidOutsideShipment
 *
 * None of these is admin-only in the app: the job page, its Shipments menu, the operation card
 * and both preview dialogs carry no role check, so every office role may use them.
 *
 * The page's warnings (over-shipping, a credit hold, a carrier that differs from the billed
 * account, over-sending, over-receiving) never block there, so they never block here: they come
 * back in `warnings`.
 *
 * WHO shipped, sent or received is never returned (the surveillance guardrail); the outputs are
 * the read tools' shipment shapes.
 */

const NAME_THE_JOB = 'Give a job_id or a job_number.';

const jobRef = {
  job_id: z.guid().optional().describe('The job, by id.'),
  job_number: z.string().optional().describe('The job, by its number, when you have no id.'),
};

const warningsOutput = z
  .array(z.string())
  .describe('What the app would have warned about. None of it stopped the change.');

/** Today's date in UTC (YYYY-MM-DD). The server has no shop time zone to go by. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

interface JobState {
  id: string;
  job_number: string;
  deleted_at: string | null;
  production_status: string;
  fulfillment_status: string;
}

/**
 * The job by id (a by-id read, so an archived job is found and then refused by the caller) or by
 * number among live jobs, as the read tools find it. Always within this company.
 */
async function findJob(
  args: { job_id?: string; job_number?: string },
  env: CompanyToolEnv,
): Promise<{ job: JobState } | { message: string }> {
  const number = args.job_number?.trim();
  if (!args.job_id && !number) return { message: NAME_THE_JOB };
  let query = getSupabase()
    .from('jobs')
    .select('id, job_number, deleted_at, production_status, fulfillment_status')
    .eq('company_id', env.company.id);
  query = args.job_id ? query.eq('id', args.job_id) : query.eq('job_number', number ?? '').is('deleted_at', null);
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

/**
 * The job page disables shipping and the operation card on a cancelled job, and archived jobs
 * are out of every list the app works from. `outcome` finishes the sentence: "nothing was shipped".
 */
function closedJobRefusal(job: JobState, outcome: string): string | null {
  if (job.deleted_at) return `Job ${job.job_number} is archived in Jigged, so ${outcome}.`;
  if (job.production_status === 'cancelled') {
    return `Job ${job.job_number} is cancelled, so ${outcome}. It can be reopened in Jigged.`;
  }
  return null;
}

function formatQty(n: number): string {
  return String(roundQty(n));
}

// ---------------------------------------------------------------------------
// Packing slips
// ---------------------------------------------------------------------------

/** UPS / FedEx / USPS in the form's own spelling; anything else is the form's "Other", as typed. */
function canonicalCarrier(value: string): string | null {
  const typed = value.trim();
  if (!typed) return null;
  return CARRIER_OPTIONS.find((c) => c.toLowerCase() === typed.toLowerCase()) ?? typed;
}

function addressLabel(a: {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}): string {
  const street = [a.address_line1, a.address_line2].filter(Boolean).join(', ') || '(no street)';
  const place = [a.city, a.state, a.postal_code].filter(Boolean).join(' ');
  return place ? `${street}, ${place}` : street;
}

/** The read tools' shipment shape, from the hydrated slip `getShipmentById` returns. */
function shipmentRecord(
  s: ShipmentWithRelations,
  jobNumber: string | null,
  env: CompanyToolEnv,
): z.infer<typeof shipmentOutput> {
  const items = (s.shipment_line_items ?? []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    shipment_id: s.id,
    packing_slip_number: s.packing_slip_number,
    job_id: s.job_id,
    job_number: jobNumber ?? items.find((li) => li.job_part?.job)?.job_part?.job?.job_number ?? null,
    customer_id: s.customer_id,
    customer_name: s.customer_name,
    ship_date: s.ship_date,
    shipping_method: s.shipping_method,
    carrier: s.carrier,
    freight_terms: s.freight_terms,
    ship_to: addressOf(s.ship_to_address),
    lines: items.map((li) => ({
      part_id: li.job_part?.part?.id ?? null,
      part_name: li.job_part?.part?.part_name ?? 'Unknown part',
      quantity: Number(li.quantity),
    })),
    voided: s.voided_at !== null,
    voided_at: s.voided_at,
    url: companyLink(env, `/jobs/${s.job_id}`),
  };
}

/** What ShipmentForm loads for a job: its customer, the customer's addresses and carrier accounts, its parts. */
async function loadShipContext(jobId: string) {
  const { data, error } = await getSupabase()
    .from('jobs')
    .select(
      `freight_terms, customer_carrier_account_id,
       customer:customers (
         id, name, credit_status,
         addresses:customer_addresses (
           id, address_line1, address_line2, city, state, postal_code, default_billing, default_shipping
         ),
         carrier_accounts:customer_carrier_accounts (
           id, company_id, customer_id, carrier, bill_to_party, account_number, account_postal_code,
           account_country_code, notes, created_at, updated_at, deleted_at
         )
       ),
       job_parts ( id, sequence, quantity, parts ( part_name ) )`,
    )
    .eq('id', jobId)
    .single();
  if (error) throw error;
  return data;
}

const lineInput = z.object({
  job_part_id: z.guid().describe('A job_part_id from get_job.'),
  quantity: z.number().positive().describe('Pieces of that part in this box.'),
});

export const createShipmentTool = defineCompanyTool({
  name: 'create_shipment',
  title: 'Ship parts on a job',
  description:
    'Creates a packing slip: records that finished parts on one job left the shop for its ' +
    'customer, which moves the job toward partially or fully shipped. Takes the job (by id or ' +
    'number), the parts and quantities in the box, the shipping method, the carrier when the ' +
    'method is `shipment` (defaults to the carrier of the customer account the freight bills ' +
    'to), who pays the freight (defaults to what the job, else the customer, says), the ship ' +
    'date (defaults to today) and the ship-to address (defaults to the customer\'s default ' +
    'shipping address, else its billing one). Jigged assigns the packing slip number. Shipping ' +
    'more than is left, or to a customer on credit hold, is allowed and comes back in ' +
    '`warnings`. Returns the new packing slip.',
  access: 'write',
  input: {
    ...jobRef,
    lines: z.array(lineInput).min(1).max(100).describe('Each job part in the box, once, with its quantity.'),
    shipping_method: z
      .enum(SHIPPING_METHODS)
      .describe(
        'How it leaves: customer_pickup, personal_delivery (the shop delivers), shipment (on a ' +
          'carrier), dropship, or restock.',
      ),
    carrier: z
      .string()
      .max(100)
      .optional()
      .describe('For a `shipment` only: UPS, FedEx, USPS, or another carrier\'s name.'),
    freight_terms: z
      .enum(FREIGHT_TERMS)
      .optional()
      .describe(
        'Who pays the freight, for `shipment` and `dropship` only: prepaid (the shop pays), ' +
          'collect (the customer\'s account), third_party, or customer_arranged (they collect it).',
      ),
    ship_date: z.iso.date().optional().describe('The day it leaves (YYYY-MM-DD). Defaults to today (UTC).'),
    shipping_address_id: z
      .guid()
      .optional()
      .describe('One of the customer\'s addresses, when not the default. This tool lists the choices when one is needed.'),
  },
  output: { ...shipmentOutput.shape, warnings: warningsOutput },
  run: async (args, env) => {
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job } = found;
    const closed = closedJobRefusal(job, 'nothing was shipped');
    if (closed) return { ok: false, message: closed };
    if (job.fulfillment_status === 'fully_shipped') {
      return { ok: false, message: `Job ${job.job_number} is already fully shipped, so nothing was shipped.` };
    }

    const context = await loadShipContext(job.id);
    const customer = context.customer;
    if (!customer) {
      return { ok: false, message: `Job ${job.job_number} has no customer, so there is nobody to ship to.` };
    }
    const parts = (context.job_parts ?? []).slice().sort((a, b) => a.sequence - b.sequence);
    if (parts.length === 0) return { ok: false, message: `Job ${job.job_number} has no parts to ship.` };
    const partName = (p: (typeof parts)[number]) => p.parts?.part_name ?? 'Part';

    // ---- the lines --------------------------------------------------------
    const seen = new Set<string>();
    for (const line of args.lines) {
      const part = parts.find((p) => p.id === line.job_part_id);
      if (!part) {
        const choices = parts.map((p) => `${partName(p)} (job_part_id ${p.id})`).join('; ');
        return { ok: false, message: `That job part isn't on job ${job.job_number}. Its parts: ${choices}.` };
      }
      if (seen.has(part.id)) {
        return { ok: false, message: `List each part once: ${partName(part)} appears twice.` };
      }
      seen.add(part.id);
    }

    // ---- method, carrier and freight, as the form resolves them ------------
    const method = args.shipping_method;
    const freightApplies = FREIGHT_TERMS_METHODS.includes(method);
    if (args.carrier !== undefined && method !== 'shipment') {
      return { ok: false, message: 'A carrier is recorded only when the shipping method is `shipment`.' };
    }
    if (args.freight_terms !== undefined && !freightApplies) {
      return {
        ok: false,
        message: 'Freight terms apply only when the parts go on a carrier: shipping method `shipment` or `dropship`.',
      };
    }
    const accounts: CustomerCarrierAccount[] = billableCarrierAccounts(
      (customer.carrier_accounts ?? []).map((a) => ({ ...a, bill_to_party: toBillToParty(a.bill_to_party) })),
      context.customer_carrier_account_id,
    );
    // The job's instruction (what the PO said) beats the customer's standing arrangement.
    const freight = resolveFreightLine({
      jobFreightTerms: toFreightTerms(context.freight_terms),
      jobCarrierAccountId: context.customer_carrier_account_id,
      customerAccounts: accounts,
    });
    let carrier: string | null = null;
    if (method === 'shipment') {
      // The form seeds the carrier from the account the freight bills to; a typed one wins.
      const seeded = freight.account ? canonicalCarrier(freight.account.carrier) : null;
      carrier = args.carrier !== undefined ? canonicalCarrier(args.carrier) : seeded;
      if (!carrier) {
        return { ok: false, message: 'Name the carrier for a shipment: UPS, FedEx, USPS, or another carrier\'s name.' };
      }
    }

    // ---- ship-to: default shipping, else default billing, as the form preselects ----
    const addresses = customer.addresses ?? [];
    const choices = addresses.map((a) => `${addressLabel(a)} (shipping_address_id ${a.id})`).join('; ');
    let address: (typeof addresses)[number] | null;
    if (args.shipping_address_id) {
      address = addresses.find((a) => a.id === args.shipping_address_id) ?? null;
      if (!address) {
        return {
          ok: false,
          message: addresses.length
            ? `That address isn't one of ${customer.name}'s. Its addresses: ${choices}.`
            : `${customer.name} has no address in Jigged to ship to. Add one on the customer first.`,
        };
      }
    } else {
      address = addresses.find((a) => a.default_shipping) ?? addresses.find((a) => a.default_billing) ?? null;
      if (!address) {
        return {
          ok: false,
          message: addresses.length
            ? `${customer.name} has no default shipping address. Choose one with shipping_address_id: ${choices}.`
            : `${customer.name} has no address in Jigged to ship to. Add one on the customer first.`,
        };
      }
    }

    // ---- what the form would warn about, never block on ---------------------
    const warnings: string[] = [];
    if (toCreditStatus(customer.credit_status) === 'hold') warnings.push(`${customer.name} is on credit hold.`);
    const summaries = new Map((await getJobPartShipmentSummaries(job.id)).map((s) => [s.job_part_id, s]));
    for (const line of args.lines) {
      const part = parts.find((p) => p.id === line.job_part_id);
      const remaining = summaries.get(line.job_part_id)?.qty_remaining ?? Number(part?.quantity ?? 0);
      if (part && line.quantity > remaining) {
        warnings.push(
          `${partName(part)} (job ${job.job_number}): shipping ${formatQty(line.quantity)} exceeds remaining ${formatQty(remaining)}.`,
        );
      }
    }
    if (freightApplies && freight.requiresChoice && !freight.account) {
      warnings.push(
        `${customer.name} has more than one carrier account and the job names none, so this shipment records no freight account.`,
      );
    }
    if (freightApplies && carrier && freight.account) {
      const mismatch = carrierAccountMismatch(carrier, freight.account.carrier);
      if (mismatch) warnings.push(mismatch);
    }

    // ---- the form's payload -------------------------------------------------
    const order = new Map(parts.map((p) => [p.id, p.sequence]));
    const payload: CreateShipmentPayload = {
      customer_id: customer.id,
      shipping_address_id: address.id,
      one_time_address: null,
      ship_date: args.ship_date ?? todayUtc(),
      carrier,
      shipping_method: method,
      freight_terms: freightApplies ? (args.freight_terms ?? freight.terms) : null,
      customer_carrier_account_id: freightApplies ? (freight.account?.id ?? null) : null,
      line_items: args.lines
        .slice()
        .sort((a, b) => (order.get(a.job_part_id) ?? 0) - (order.get(b.job_part_id) ?? 0))
        .map((l) => ({ job_part_id: l.job_part_id, quantity: l.quantity })),
    };
    const { shipmentId } = await createShipment(env.company.id, payload);
    const shipment = await getShipmentById(shipmentId);
    return { ok: true, data: { ...shipmentRecord(shipment, job.job_number, env), warnings } };
  },
});

export const voidShipmentTool = defineCompanyTool({
  name: 'void_shipment',
  title: 'Void a packing slip',
  description:
    'Voids a packing slip: it stays on record, marked voided, its number is never reused, and ' +
    'its quantities stop counting as shipped, so the job\'s shipped status steps back. Find the ' +
    'slip by shipment id or packing slip number. Returns the voided slip.',
  access: 'write',
  destructive: true,
  idempotent: true,
  input: {
    shipment_id: z.guid().optional().describe('The shipment, by id.'),
    packing_slip_number: z.string().optional().describe('The packing slip number, e.g. PS-0141-2, when you have no id.'),
  },
  output: shipmentOutput.shape,
  run: async (args, env) => {
    const number = args.packing_slip_number?.trim();
    if (!args.shipment_id && !number) return { ok: false, message: 'Give a shipment_id or a packing_slip_number.' };
    let query = getSupabase()
      .from('shipments')
      .select('id, packing_slip_number, voided_at')
      .eq('company_id', env.company.id);
    query = args.shipment_id ? query.eq('id', args.shipment_id) : query.eq('packing_slip_number', number ?? '');
    const { data: row, error } = await query.limit(1).maybeSingle();
    if (error) throw error;
    if (!row) {
      return {
        ok: false,
        message: args.shipment_id
          ? `There is no shipment with that id in ${env.company.name}.`
          : `There is no packing slip ${number} in ${env.company.name}.`,
      };
    }
    if (row.voided_at) return { ok: false, message: `Packing slip ${row.packing_slip_number} is already voided.` };

    await voidShipment(row.id);
    const shipment = await getShipmentById(row.id);
    return { ok: true, data: shipmentRecord(shipment, null, env) };
  },
});

// ---------------------------------------------------------------------------
// Outside processing
// ---------------------------------------------------------------------------

/** The read tools' outside-shipment shape, from the hydrated slip `getOutsideShipmentById` returns. */
function outsideRecord(s: OutsideShipmentWithRelations, env: CompanyToolEnv): z.infer<typeof outsideShipmentOutput> {
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
    job_number: s.job?.job_number ?? null,
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
    url: companyLink(env, `/jobs/${s.job_id}`),
  };
}

const stepRef = {
  ...jobRef,
  job_part_id: z
    .guid()
    .optional()
    .describe('The part on the job (a job_part_id from get_job). Needed only when the job has more than one part.'),
  operation_sequence: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The outside routing step, by its sequence number in get_job. Needed only when the part has more than one.'),
  operation_name: z
    .string()
    .optional()
    .describe('The outside routing step, by name, when you have no sequence number.'),
};

interface OutsideStep {
  job: JobState;
  part: { id: string; name: string };
  op: {
    id: string;
    sequence: number;
    name: string;
    instructions: string | null;
    vendorId: string | null;
    vendorName: string;
  };
}

function stepLabel(op: { sequence: number; name: string }): string {
  return `step ${op.sequence} (${op.name})`;
}

/**
 * One outside routing step on a job: the part (named, or the only one) and the step among its
 * outside operations (by sequence, by name, or the only one), refusing with the choices.
 */
async function findOutsideStep(
  args: { job_id?: string; job_number?: string; job_part_id?: string; operation_sequence?: number; operation_name?: string },
  env: CompanyToolEnv,
  outcome: string,
): Promise<{ step: OutsideStep } | { message: string }> {
  const found = await findJob(args, env);
  if ('message' in found) return found;
  const { job } = found;
  const closed = closedJobRefusal(job, outcome);
  if (closed) return { message: closed };

  const { data, error } = await getSupabase()
    .from('job_parts')
    .select(
      `id, sequence, parts ( part_name ),
       job_operations (
         id, sequence, operation_name, vendor_service_id, instructions,
         vendor_service:vendor_services ( name, vendor:vendors ( id, name ) )
       )`,
    )
    .eq('job_id', job.id)
    .order('sequence');
  if (error) throw error;
  const parts = data ?? [];
  const partName = (p: (typeof parts)[number]) => p.parts?.part_name ?? 'Part';

  let part: (typeof parts)[number] | undefined;
  if (args.job_part_id) {
    part = parts.find((p) => p.id === args.job_part_id);
  } else if (parts.length === 1) {
    part = parts[0];
  }
  if (!part) {
    if (parts.length === 0) return { message: `Job ${job.job_number} has no parts.` };
    const choices = parts.map((p) => `${partName(p)} (job_part_id ${p.id})`).join('; ');
    return {
      message: args.job_part_id
        ? `That job part isn't on job ${job.job_number}. Its parts: ${choices}.`
        : `Job ${job.job_number} has more than one part. Name one with job_part_id: ${choices}.`,
    };
  }

  const ops = (part.job_operations ?? []).slice().sort((a, b) => a.sequence - b.sequence);
  const outside = ops.filter((o) => o.vendor_service_id !== null);
  const name = args.operation_name?.trim().toLowerCase();
  let op: (typeof ops)[number] | undefined;
  if (args.operation_sequence !== undefined) {
    op = ops.find((o) => o.sequence === args.operation_sequence);
  } else if (name) {
    const named = outside.filter((o) => o.operation_name.trim().toLowerCase() === name);
    if (named.length > 1) {
      const list = named.map((o) => stepLabel({ sequence: o.sequence, name: o.operation_name })).join(', ');
      return { message: `${partName(part)} has more than one step named that: ${list}. Name it by operation_sequence.` };
    }
    op = named[0] ?? ops.find((o) => o.operation_name.trim().toLowerCase() === name);
  } else if (outside.length === 1) {
    op = outside[0];
  }
  const outsideList = outside.map((o) => stepLabel({ sequence: o.sequence, name: o.operation_name })).join(', ');
  if (!op) {
    if (outside.length === 0) {
      return { message: `${partName(part)} on job ${job.job_number} has no outside processing steps.` };
    }
    return {
      message:
        args.operation_sequence !== undefined || name
          ? `${partName(part)} on job ${job.job_number} has no such step. Its outside steps: ${outsideList}.`
          : `${partName(part)} on job ${job.job_number} has more than one outside step. Name one with operation_sequence: ${outsideList}.`,
    };
  }
  if (op.vendor_service_id === null) {
    return {
      message: `${stepLabel({ sequence: op.sequence, name: op.operation_name })} is done in-house, so nothing goes to a vendor for it.`,
    };
  }
  return {
    step: {
      job,
      part: { id: part.id, name: partName(part) },
      op: {
        id: op.id,
        sequence: op.sequence,
        name: op.operation_name,
        instructions: op.instructions,
        vendorId: op.vendor_service?.vendor?.id ?? null,
        vendorName: op.vendor_service?.vendor?.name ?? 'the vendor',
      },
    },
  };
}

export const sendOutside = defineCompanyTool({
  name: 'send_outside',
  title: 'Send parts to a vendor',
  description:
    'Sends a quantity of one job part to the vendor of an outside routing step (anodize, ' +
    'plating, heat treat and the like): creates the vendor packing slip (VPS-…), which marks the ' +
    'step sent. Takes the job, the part and the step (each only when there is more than one), ' +
    'the quantity (defaults to everything the step still has to send), an optional due-back ' +
    'date, and the instructions printed for the vendor (defaults to the routing step\'s own). ' +
    'Ships to the vendor\'s default address, or its only one. Sending more than the step needs is ' +
    'allowed and comes back in `warnings`. Returns the new slip.',
  access: 'write',
  input: {
    ...stepRef,
    quantity: z.number().positive().optional().describe('Pieces going out. Defaults to everything this step still has to send.'),
    due_back_on: z.iso.date().optional().describe('When the vendor should return them (YYYY-MM-DD). Prints on the slip.'),
    instructions: z
      .string()
      .max(2000)
      .optional()
      .describe('Instructions for the vendor, printed on the slip. Defaults to the routing step\'s instructions; "" for none.'),
    vendor_address_id: z
      .guid()
      .optional()
      .describe('Where the parts go, when the vendor has several addresses and none is its default. This tool lists the choices when one is needed.'),
  },
  output: { ...outsideShipmentOutput.shape, warnings: warningsOutput },
  run: async (args, env) => {
    const resolved = await findOutsideStep(args, env, 'nothing was sent');
    if ('message' in resolved) return { ok: false, message: resolved.message };
    const { part, op } = resolved.step;

    const summary = (await getOutsideSummariesForPart(part.id)).find((s) => s.job_operation_id === op.id);
    const toSend = summary?.qty_to_send ?? 0;
    // The operation card offers Send only while something is left to send.
    if (toSend <= 0) {
      return {
        ok: false,
        message:
          `Nothing is left to send for ${stepLabel(op)} on ${part.name}: every piece is at ` +
          `${op.vendorName} or already back.`,
      };
    }
    const quantity = args.quantity ?? toSend;
    if (args.due_back_on && args.due_back_on < todayUtc()) {
      return { ok: false, message: 'The due-back date cannot be before the ship date.' };
    }

    // Ship-to as the dialog resolves it: the default address, else the only one; a vendor with
    // several and no default is asked rather than guessed.
    const warnings: string[] = [];
    let vendorAddressId: string | null = null;
    if (op.vendorId) {
      const shipTo = await resolveVendorShipTo(op.vendorId);
      const list = shipTo.choices.map((c) => `${c.label} (vendor_address_id ${c.id})`).join('; ');
      if (args.vendor_address_id) {
        if (!shipTo.choices.some((c) => c.id === args.vendor_address_id)) {
          return {
            ok: false,
            message: shipTo.choices.length
              ? `That address isn't one of ${op.vendorName}'s. Its addresses: ${list}.`
              : `${op.vendorName} has no address on file in Jigged.`,
          };
        }
        vendorAddressId = args.vendor_address_id;
      } else if (shipTo.requiresChoice) {
        return {
          ok: false,
          message:
            `${op.vendorName} has more than one address and none is marked as the default, so ` +
            `nothing was sent. Choose where the parts go with vendor_address_id: ${list}.`,
        };
      } else {
        vendorAddressId = shipTo.address?.id ?? null;
      }
      if (shipTo.choices.length === 0) {
        warnings.push(`No address on file for ${op.vendorName}. The slip prints without a ship-to block.`);
      }
    }

    const consequence = outsideSendConsequence(quantity, toSend);
    if (consequence.kind === 'over') warnings.push(outsideSendCaption(consequence, op.vendorName));

    const notes =
      args.instructions !== undefined ? args.instructions.trim() || null : op.instructions?.trim() || null;
    const { shipmentId } = await createOutsideShipment({
      jobOperationId: op.id,
      quantity,
      dueBackOn: args.due_back_on ?? null,
      vendorAddressId,
      notes,
    });
    const slip = await getOutsideShipmentById(shipmentId);
    return { ok: true, data: { ...outsideRecord(slip, env), warnings } };
  },
});

/** A vendor slip of this company, by id or by its VPS- number. */
async function findOutsideSlip(
  args: { outside_shipment_id?: string; slip_number?: string },
  env: CompanyToolEnv,
): Promise<{ slip: { id: string; slip_number: string; voided_at: string | null } } | { message: string } | null> {
  const number = args.slip_number?.trim();
  if (!args.outside_shipment_id && !number) return null;
  let query = getSupabase()
    .from('outside_shipments')
    .select('id, slip_number, voided_at')
    .eq('company_id', env.company.id);
  query = args.outside_shipment_id ? query.eq('id', args.outside_shipment_id) : query.eq('slip_number', number ?? '');
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      message: args.outside_shipment_id
        ? `There is no vendor slip with that id in ${env.company.name}.`
        : `There is no vendor slip ${number} in ${env.company.name}.`,
    };
  }
  return { slip: data };
}

const slipRef = {
  outside_shipment_id: z.guid().optional().describe('The vendor slip, by id (list_outside_shipments has them).'),
  slip_number: z.string().optional().describe('The vendor slip, by its number, e.g. VPS-0141-2.'),
};

export const receiveOutside = defineCompanyTool({
  name: 'receive_outside',
  title: 'Receive parts back from a vendor',
  description:
    'Records parts coming back from outside processing. Name the vendor slip (by id or VPS- ' +
    'number), or the job, part and step, which receives against that step\'s oldest open slip. ' +
    'The quantity defaults to everything still out on the slip. `close_slip` with a smaller ' +
    'quantity, or 0, says nothing more is coming back: the rest is written off and the step ' +
    'stays short. When a step was never sent through Jigged, receiving it also records the send. ' +
    'More back than went out is allowed and comes back in `warnings`. Returns the slip as it ' +
    'stands afterwards.',
  access: 'write',
  input: {
    ...slipRef,
    ...stepRef,
    quantity: z
      .number()
      .min(0)
      .optional()
      .describe('Good pieces back. Defaults to everything still out on the slip; needed when no slip is open.'),
    close_slip: z
      .boolean()
      .optional()
      .describe('Nothing more is coming back on this slip: write off what is still out. Applies only when the quantity is less than that.'),
  },
  output: {
    ...outsideShipmentOutput.shape,
    received: z.number().describe('Good pieces this call recorded.'),
    closed_short: z.boolean().describe('The slip was closed with pieces written off.'),
    send_recorded: z.boolean().describe('No slip was open, so Jigged recorded the send alongside the receipt.'),
    warnings: warningsOutput,
  },
  run: async (args, env) => {
    const named = await findOutsideSlip(args, env);
    if (named && 'message' in named) return { ok: false, message: named.message };

    // Against an open slip, or, when the step has none, against the step itself (the send is
    // recorded alongside, as the dialog says out loud).
    let target: { slip: OutsideShipmentWithRelations } | { operationId: string };
    let vendorName: string;
    if (named) {
      // Against one slip: the Jobs-page drawer, or the operation card with a slip chosen.
      const slip = await getOutsideShipmentById(named.slip.id);
      const found = await findJob({ job_id: slip.job_id }, env);
      if ('message' in found) return { ok: false, message: found.message };
      const closed = closedJobRefusal(found.job, 'nothing was received');
      if (closed) return { ok: false, message: closed };
      if (slip.voided_at) {
        return { ok: false, message: `Slip ${slip.slip_number} was voided, so nothing can be received against it.` };
      }
      if (slip.closed_at) {
        return { ok: false, message: `Slip ${slip.slip_number} was closed, so nothing more is expected back on it.` };
      }
      if (outstandingOn(slip) <= 0) {
        return { ok: false, message: `Everything sent on slip ${slip.slip_number} is already back.` };
      }
      target = { slip };
      vendorName = slip.vendor_name;
    } else {
      if (!args.job_id && !args.job_number?.trim()) {
        return { ok: false, message: 'Give a slip (outside_shipment_id or slip_number), or a job_id or job_number.' };
      }
      const resolved = await findOutsideStep(args, env, 'nothing was received');
      if ('message' in resolved) return { ok: false, message: resolved.message };
      const { part, op } = resolved.step;
      vendorName = op.vendorName;
      const summary = (await getOutsideSummariesForPart(part.id)).find((s) => s.job_operation_id === op.id);
      // The operation card offers Receive while something is at the vendor, or when nothing was
      // ever sent or received (the parts came back with no slip made).
      const canReceive =
        !!summary && (summary.qty_at_vendor > 0 || (summary.qty_sent === 0 && summary.qty_good === 0));
      if (!canReceive) {
        return { ok: false, message: `Nothing from ${stepLabel(op)} on ${part.name} is at ${op.vendorName}.` };
      }
      // The dialog defaults to the oldest open slip: the batch the vendor returns first.
      const open = await getOpenOutsideShipments(op.id);
      target = open[0] ? { slip: await getOutsideShipmentById(open[0].id) } : { operationId: op.id };
    }

    const before = 'slip' in target ? target.slip : null;
    const outstanding = before ? outstandingOn(before) : 0;
    if (!before && args.quantity === undefined) {
      return { ok: false, message: 'No slip is open for that step, so give the quantity that came back.' };
    }
    const good = args.quantity ?? outstanding;
    // The dialog offers the close only when something would be written off.
    const closeShipment = Boolean(args.close_slip) && good < outstanding;
    if (!(good > 0 || closeShipment)) {
      return {
        ok: false,
        message: 'Give how many came back, or close_slip with 0 to write off what is still out.',
      };
    }
    const warnings: string[] = [];
    if (before) {
      const consequence = outsideReceiptConsequence(good, outstanding);
      if (consequence.kind === 'over') warnings.push(outsideReceiptCaption(consequence, vendorName));
    }

    let resultSlipId: string;
    let sendRecorded = false;
    if ('slip' in target) {
      await receiveOutsideShipment(target.slip.id, { quantityGood: good, closeShipment });
      resultSlipId = target.slip.id;
    } else {
      const result = await receiveOutsideOperation(target.operationId, { quantityGood: good, closeShipment });
      resultSlipId = result.shipmentId;
      sendRecorded = result.wasBackfilled;
    }

    const after = await getOutsideShipmentById(resultSlipId);
    return {
      ok: true,
      data: {
        ...outsideRecord(after, env),
        received: good,
        closed_short: closeShipment,
        send_recorded: sendRecorded,
        warnings,
      },
    };
  },
});

export const voidOutsideShipmentTool = defineCompanyTool({
  name: 'void_outside_shipment',
  title: 'Void a vendor slip',
  description:
    'Voids a vendor packing slip and everything received against it: it stays on record, ' +
    'marked voided, its number is never reused, and its pieces count as back in the shop, so ' +
    'the routing step steps back. Find the slip by id or VPS- number. Returns the voided slip ' +
    'and how many receipts were voided with it.',
  access: 'write',
  destructive: true,
  idempotent: true,
  input: slipRef,
  output: {
    ...outsideShipmentOutput.shape,
    receipts_voided: z.number().describe('Receipts against this slip that were voided with it.'),
  },
  run: async (args, env) => {
    const found = await findOutsideSlip(args, env);
    if (!found) return { ok: false, message: 'Give an outside_shipment_id or a slip_number.' };
    if ('message' in found) return { ok: false, message: found.message };
    if (found.slip.voided_at) return { ok: false, message: `Slip ${found.slip.slip_number} is already voided.` };

    const { receiptsVoided } = await voidOutsideShipment(found.slip.id);
    const slip = await getOutsideShipmentById(found.slip.id);
    return { ok: true, data: { ...outsideRecord(slip, env), receipts_voided: receiptsVoided } };
  },
});

export function registerShippingWriteTools(server: ToolTarget): void {
  registerCompanyTool(server, createShipmentTool);
  registerCompanyTool(server, voidShipmentTool);
  registerCompanyTool(server, sendOutside);
  registerCompanyTool(server, receiveOutside);
  registerCompanyTool(server, voidOutsideShipmentTool);
}

/** Exported for the catalogue test. */
export const SHIPPING_WRITE_TOOLS = [createShipmentTool, voidShipmentTool, sendOutside, receiveOutside, voidOutsideShipmentTool];
