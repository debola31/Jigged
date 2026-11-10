import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import { findJob, getJob } from '@/lib/mcp/tools/jobs';
import { companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { isValidQuantityValue } from '@/lib/quantityInput';
import { getSupabase } from '@/lib/supabase';
import {
  getJobLifecycleStage,
  isOutsideOperation,
  type JobOperation,
  type JobPartWithRelations,
  type JobWithRelations,
  type OperationStatus,
  type ProductionStatus,
} from '@/types/job';
import type { FreightTerms } from '@/types/shipment';
import {
  cancelJob,
  completeJobOperation,
  createJobFromPurchaseOrder,
  getJobWithRelations,
  reopenJob,
  undoJobOperation,
  updateJobAddressContact,
  updateJobDetails,
  updateJobPartPrice,
  updateJobPartQuantity,
} from '@/utils/jobsAccess';
import { CompletionConflictError, getOperationCompletionSummaries } from '@/utils/operationCompletionsAccess';
import { getOperationActuals } from '@/utils/operationIntervalsAccess';
import { addJobNote } from '@/utils/operatorAccess';
import { getJobPartInvoiceSummaries } from '@/utils/quickbooksAccess';
import { escapeIlikePattern } from '@/utils/searchFilter';
import { getJobPartShipmentSummaries } from '@/utils/shipmentsAccess';

/**
 * The job write tools. Each one calls the access function the job page (or the jobs list's
 * Accept Purchase Order modal) calls, with the arguments that UI passes, and refuses up front
 * what that UI would not let a person submit:
 *
 *   create_job              AcceptPurchaseOrderModal  -> createJobFromPurchaseOrder
 *   update_job              JobEditForm               -> updateJobDetails, updateJobAddressContact,
 *                                                        updateJobPartQuantity, updateJobPartPrice
 *   cancel_job, reopen_job  the job page's Cancel / Reopen buttons -> cancelJob, reopenJob
 *   complete_job_operation  OperationsPanel's Mark Complete dialog -> completeJobOperation
 *   undo_job_operation      OperationCard's Undo                   -> undoJobOperation
 *   add_job_note            JobActivityComposer                    -> addJobNote
 *
 * Lookups the UI does with a picker (customer, part, address, contact, carrier account) are
 * typed, company-scoped reads here, matched by the names and first lines the read tools return.
 *
 * No job surface is admin-only (no AdminGuard, no role check on the page, the dialogs or the
 * Sidebar entry), so none of these is either.
 *
 * TIMERS. Mark Complete is the office's untimed path: `completeJobOperation` records the work as
 * done in the office and discards any timer running on the step, because the office cannot state
 * a finish time it did not witness (docs/modules/jobs.md, "Mark Complete is the untimed path").
 * The dialog warns BEFORE the click; here that warning is a refusal until the caller passes
 * `discard_running_timer`. These tools never start, stop or edit a timer themselves, and nothing
 * they return names a person (docs/modules/operator-view.md, surveillance guardrail).
 */

const FREIGHT_TERMS = ['prepaid', 'collect', 'third_party', 'customer_arranged'] as const satisfies readonly FreightTerms[];
const OPERATION_STATUSES = ['pending', 'in_progress', 'completed', 'sent'] as const satisfies readonly OperationStatus[];
const PRODUCTION_STATUSES = [
  'not_started',
  'in_progress',
  'completed',
  'cancelled',
] as const satisfies readonly ProductionStatus[];

const jobRef = {
  job_id: z.guid().optional().describe('The job, by id.'),
  job_number: z.string().optional().describe('The job, by its number, when you have no id.'),
};

const partRef = {
  job_part_id: z.guid().optional().describe('The part on the job, by its job_part_id from get_job.'),
  part_name: z.string().optional().describe('The part on the job, by part number.'),
};

/** Case and spacing do not matter when matching what a person typed against saved values. */
function norm(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The app stores a cleared text field as NULL ('' -> null), and so does this. */
function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function customerNameOf(job: JobWithRelations): string {
  return job.customers?.name ?? job.customer_name ?? 'The customer';
}

function partNameOf(part: JobPartWithRelations): string {
  return part.parts?.part_name ?? 'that part';
}

function stepLabel(op: JobOperation): string {
  return `Op ${op.sequence} · ${op.operation_name}`;
}

/** The job's own get_job record, after a write. */
async function readBack(jobId: string, env: CompanyToolEnv) {
  return getJob.run({ job_id: jobId }, env);
}

/** One part of a job, named by job_part_id or part number; the only part when the job has one. */
function pickPart(
  job: JobWithRelations,
  ref: { job_part_id?: string; part_name?: string },
): { part: JobPartWithRelations } | { message: string } {
  const parts = job.job_parts ?? [];
  if (ref.job_part_id) {
    const part = parts.find((p) => p.id === ref.job_part_id);
    return part ? { part } : { message: `${job.job_number} has no part with that job_part_id.` };
  }
  const name = ref.part_name?.trim();
  if (name) {
    const matches = parts.filter((p) => norm(p.parts?.part_name) === norm(name));
    if (matches.length === 1) return { part: matches[0] };
    if (matches.length === 0) return { message: `${job.job_number} has no part ${name}.` };
    return { message: `${job.job_number} carries ${name} more than once. Give the job_part_id from get_job.` };
  }
  if (parts.length === 1) return { part: parts[0] };
  if (parts.length === 0) return { message: `${job.job_number} has no parts.` };
  return { message: `${job.job_number} has ${parts.length} parts. Say which with job_part_id or part_name.` };
}

// ─── create_job ──────────────────────────────────────────────────────────────────────────────

/**
 * The earliest date that is "today" anywhere on Earth right now (UTC-12). The Accept Purchase
 * Order modal refuses a due date before the person's own today, read from their browser; this
 * server has no browser clock and runs in UTC, which is already tomorrow for the Americas every
 * evening. Comparing against the furthest-behind zone accepts every shop's today and still
 * catches the wrong-year entry the check exists for. `toISOString()` is the UTC date of the
 * shifted instant, which is the point here (lib/localDate.ts warns against it for the local date).
 */
function earliestTodayAnywhere(now = Date.now()): string {
  return new Date(now - 12 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The customer for a new job. The modal picks from a list of the company's customers; an
 * archived one is refused because pickers leave archived records out (CLAUDE.md, "Deletion is
 * archive"). Customer names are unique per company ignoring case (customers_company_name_ci_unique),
 * so a name finds at most one.
 */
async function findCustomerForJob(
  args: { customer_id?: string; customer_name?: string },
  env: CompanyToolEnv,
): Promise<{ id: string } | { message: string }> {
  const name = args.customer_name?.trim();
  if (!args.customer_id && !name) return { message: 'Give a customer_id or a customer_name.' };
  const query = getSupabase().from('customers').select('id, name, deleted_at').eq('company_id', env.company.id);
  const { data, error } = await (args.customer_id
    ? query.eq('id', args.customer_id)
    : query.ilike('name', escapeIlikePattern(name ?? ''))
  )
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      message: args.customer_id
        ? `There is no customer with that id in ${env.company.name}.`
        : `There is no customer named ${name} in ${env.company.name}.`,
    };
  }
  if (data.deleted_at !== null) {
    return { message: `${data.name} is archived in ${env.company.name}, so a new job can't be created for it.` };
  }
  return { id: data.id };
}

/**
 * A part for a new job line. The modal's part picker (searchPartsForSelect) offers live parts
 * only. By name, a live exact-case match beats a case-only one; an archived namesake is reported
 * rather than used.
 */
async function findPartForJob(
  line: { part_id?: string; part_name?: string },
  env: CompanyToolEnv,
): Promise<{ id: string } | { message: string }> {
  const archived = (partName: string) => ({
    message: `${partName} is archived in ${env.company.name}, so it can't go on a new job.`,
  });
  if (line.part_id) {
    const { data, error } = await getSupabase()
      .from('parts')
      .select('id, part_name, deleted_at')
      .eq('company_id', env.company.id)
      .eq('id', line.part_id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { message: `There is no part with id ${line.part_id} in ${env.company.name}.` };
    return data.deleted_at === null ? { id: data.id } : archived(data.part_name);
  }
  const name = line.part_name?.trim();
  if (!name) return { message: 'Give each line a part_id or a part_name.' };
  const { data, error } = await getSupabase()
    .from('parts')
    .select('id, part_name, deleted_at')
    .eq('company_id', env.company.id)
    .ilike('part_name', escapeIlikePattern(name))
    .limit(20);
  if (error) throw error;
  const rows = data ?? [];
  const live = rows.filter((r) => r.deleted_at === null);
  const match = live.find((r) => r.part_name === name) ?? live[0];
  if (match) return { id: match.id };
  if (rows.length > 0) return archived(rows[0].part_name);
  return { message: `There is no part named ${name} in ${env.company.name}.` };
}

export const createJob = defineCompanyTool({
  name: 'create_job',
  title: 'Create a job from a customer PO',
  description:
    'Creates a job directly from a customer purchase order, with no quote: the customer, the ' +
    'PO number, a due date (today or later), and one or more existing parts, each with a ' +
    'whole-number quantity and the agreed unit price. Each made part\'s routing is copied onto ' +
    'the job as its steps, so a made part needs a routing first; a bought part goes on with no ' +
    'steps, ready to ship. Bill-to, ship-to and contact start from the customer\'s defaults. ' +
    'Returns the new job as get_job does. The PO\'s PDF is attached in Jigged.',
  access: 'write',
  idempotent: false,
  input: {
    customer_id: z.guid().optional().describe('The customer, by id.'),
    customer_name: z.string().optional().describe('The customer, by exact name (case does not matter).'),
    customer_po_number: z.string().describe('The customer\'s PO number. Required.'),
    due_date: z.iso.date().describe('The promised ship date, YYYY-MM-DD; today or later.'),
    lines: z
      .array(
        z.object({
          part_id: z.guid().optional().describe('The part, by id.'),
          part_name: z.string().optional().describe('The part, by part number.'),
          quantity: z.number().int().positive().describe('Whole units ordered.'),
          unit_price: z.number().min(0).describe('The agreed price per unit, from the PO. Zero for a no-charge line.'),
        }),
      )
      .min(1)
      .describe('One line per part; each part once.'),
  },
  output: getJob.output,
  run: async (args, env) => {
    const poNumber = args.customer_po_number.trim();
    if (!poNumber) return { ok: false, message: 'A customer PO number is required to create a job.' };
    if (args.due_date < earliestTodayAnywhere()) {
      return { ok: false, message: `The due date ${args.due_date} is in the past. Give today or a later date.` };
    }

    const customer = await findCustomerForJob(args, env);
    if ('message' in customer) return { ok: false, message: customer.message };

    const lines: Array<{ part_id: string; quantity: number; unit_price: number }> = [];
    for (const line of args.lines) {
      const part = await findPartForJob(line, env);
      if ('message' in part) return { ok: false, message: part.message };
      if (lines.some((l) => l.part_id === part.id)) {
        return { ok: false, message: 'Each part can appear only once. Combine duplicates into a single quantity.' };
      }
      lines.push({ part_id: part.id, quantity: line.quantity, unit_price: line.unit_price });
    }

    const created = await createJobFromPurchaseOrder(env.company.id, {
      customer_id: customer.id,
      customer_po_number: poNumber,
      due_date: args.due_date,
      lines,
    });
    return readBack(created.job_id, env);
  },
});

// ─── update_job ──────────────────────────────────────────────────────────────────────────────

const addressPick = z.object({
  address_line1: z.string().describe('The first line of one of the customer\'s saved addresses, as get_customer lists it.'),
  city: z.string().optional().describe('Its city, when two saved addresses share a first line.'),
  postal_code: z.string().optional().describe('Its postal code, when the first line and city are not enough.'),
});

type AddressPick = z.infer<typeof addressPick>;

/** One of the job's customer's saved addresses: the list the edit form's address pickers offer. */
function pickAddress(job: JobWithRelations, pick: AddressPick): { id: string } | { message: string } {
  const customer = customerNameOf(job);
  const matches = (job.customers?.addresses ?? []).filter(
    (a) =>
      norm(a.address_line1) === norm(pick.address_line1) &&
      (pick.city === undefined || norm(a.city) === norm(pick.city)) &&
      (pick.postal_code === undefined || norm(a.postal_code) === norm(pick.postal_code)),
  );
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) {
    return {
      message:
        `${customer} has no saved address matching ${pick.address_line1}. ` +
        'A job ships and bills to the customer\'s saved addresses; add it on the customer in Jigged first.',
    };
  }
  return {
    message: `${customer} has ${matches.length} saved addresses matching ${pick.address_line1}. Give the city or postal_code too.`,
  };
}

/**
 * One of the customer's contacts. Archived people leave the edit form's picker, except one this
 * job already names, so a contact leaving the customer doesn't silently blank the job.
 */
function pickContact(
  job: JobWithRelations,
  pick: { name: string; email?: string },
): { id: string } | { message: string } {
  const customer = customerNameOf(job);
  const matches = (job.customers?.customer_contacts ?? [])
    .filter((c) => c.deleted_at === null || c.id === job.contact_id)
    .filter((c) => norm(c.name) === norm(pick.name) && (pick.email === undefined || norm(c.email) === norm(pick.email)));
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) {
    return { message: `${customer} has no contact named ${pick.name}. Add the contact on the customer in Jigged first.` };
  }
  return { message: `${customer} has ${matches.length} contacts named ${pick.name}. Give the email too.` };
}

/** One of the customer's carrier accounts, with the same archived rule as contacts. */
function pickCarrierAccount(
  job: JobWithRelations,
  pick: { carrier: string; account_number?: string },
): { id: string } | { message: string } {
  const customer = customerNameOf(job);
  const matches = (job.customers?.carrier_accounts ?? [])
    .filter((a) => a.deleted_at === null || a.id === job.customer_carrier_account_id)
    .filter(
      (a) =>
        norm(a.carrier) === norm(pick.carrier) &&
        (pick.account_number === undefined || norm(a.account_number) === norm(pick.account_number)),
    );
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) {
    return {
      message: `${customer} has no ${pick.carrier} account${pick.account_number ? ` ${pick.account_number}` : ''} on file. Add it on the customer in Jigged first.`,
    };
  }
  return { message: `${customer} has ${matches.length} ${pick.carrier} accounts. Give the account_number too.` };
}

interface PartEdit {
  part: JobPartWithRelations;
  quantity?: number;
  unitPrice?: number;
}

export const updateJob = defineCompanyTool({
  name: 'update_job',
  title: 'Update a job',
  description:
    'Changes a job as its Edit screen does. Details: due date, customer PO number, ship via, ' +
    'shipping instructions, freight terms, the customer\'s carrier account, ship-to and bill-to ' +
    '(from the customer\'s saved addresses) and the contact (from the customer\'s contacts). Per ' +
    'part: the order quantity or the unit price. A quantity can rise at any time but not drop ' +
    'below what has shipped or been invoiced, and it keeps the agreed unit price; a part\'s price ' +
    'is locked once any of it is invoiced; a cancelled part does not change. Only the fields ' +
    'given change. Returns the job as get_job does, with the list of what changed.',
  access: 'write',
  idempotent: true,
  input: {
    ...jobRef,
    due_date: z.iso.date().nullable().optional().describe('YYYY-MM-DD; null clears it.'),
    customer_po_number: z.string().nullable().optional().describe('null or empty clears it.'),
    ship_via: z.string().nullable().optional().describe('The carrier and service in the PO\'s words, e.g. UPS Ground; null clears it.'),
    shipping_instructions: z.string().nullable().optional().describe('Anything the shipper needs to honour; null clears it.'),
    freight_terms: z
      .enum(FREIGHT_TERMS)
      .nullable()
      .optional()
      .describe(
        'Who pays freight, as the PO states it: prepaid (the shop pays), collect (on the customer\'s ' +
          'account), third_party, customer_arranged (they collect it). null: not stated, so the ' +
          'customer\'s standing arrangement applies when it ships.',
      ),
    carrier_account: z
      .object({
        carrier: z.string(),
        account_number: z.string().optional().describe('When the customer has more than one account with that carrier.'),
      })
      .nullable()
      .optional()
      .describe('One of the customer\'s carrier accounts, to bill freight to; null for none.'),
    ship_to: addressPick.optional().describe('Ship to one of the customer\'s saved addresses.'),
    bill_to: addressPick.optional().describe('Bill to one of the customer\'s saved addresses.'),
    contact: z
      .object({
        name: z.string(),
        email: z.string().optional().describe('When two contacts share the name.'),
      })
      .nullable()
      .optional()
      .describe('One of the customer\'s contacts; null for none.'),
    parts: z
      .array(
        z.object({
          ...partRef,
          quantity: z.number().positive().optional().describe('The new order quantity; up to 4 decimal places.'),
          unit_price: z.number().min(0).optional().describe('The new price per unit; zero for no charge.'),
        }),
      )
      .min(1)
      .optional()
      .describe('Quantity or price changes, one entry per part. A one-part job needs no part named.'),
  },
  output: {
    ...getJob.output,
    changed: z.array(z.string()).describe('What this call changed.'),
  },
  run: async (args, env) => {
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job } = found;
    const parts = job.job_parts ?? [];
    // The job page offers Edit only on a job with parts.
    if (parts.length === 0) return { ok: false, message: `${job.job_number} has no parts, so it can't be edited in Jigged.` };

    const changed: string[] = [];

    const details: { customer_po_number?: string | null; due_date?: string | null } = {};
    if (args.due_date !== undefined && args.due_date !== job.due_date) {
      details.due_date = args.due_date;
      changed.push('due_date');
    }
    if (args.customer_po_number !== undefined) {
      const po = blankToNull(args.customer_po_number);
      if (po !== job.customer_po_number) {
        details.customer_po_number = po;
        changed.push('customer_po_number');
      }
    }

    const shipping: Parameters<typeof updateJobAddressContact>[2] = {};
    if (args.ship_via !== undefined) {
      const shipVia = blankToNull(args.ship_via);
      if (shipVia !== job.ship_via) {
        shipping.ship_via = shipVia;
        changed.push('ship_via');
      }
    }
    if (args.shipping_instructions !== undefined) {
      const instructions = blankToNull(args.shipping_instructions);
      if (instructions !== job.shipping_instructions) {
        shipping.shipping_instructions = instructions;
        changed.push('shipping_instructions');
      }
    }
    if (args.freight_terms !== undefined && args.freight_terms !== job.freight_terms) {
      shipping.freight_terms = args.freight_terms;
      changed.push('freight_terms');
    }
    if (args.carrier_account !== undefined) {
      let accountId: string | null = null;
      if (args.carrier_account !== null) {
        const account = pickCarrierAccount(job, args.carrier_account);
        if ('message' in account) return { ok: false, message: account.message };
        accountId = account.id;
      }
      if (accountId !== job.customer_carrier_account_id) {
        shipping.customer_carrier_account_id = accountId;
        changed.push('carrier_account');
      }
    }
    if (args.ship_to !== undefined) {
      const address = pickAddress(job, args.ship_to);
      if ('message' in address) return { ok: false, message: address.message };
      if (address.id !== job.shipping_address_id) {
        shipping.shipping_address_id = address.id;
        changed.push('ship_to');
      }
    }
    if (args.bill_to !== undefined) {
      const address = pickAddress(job, args.bill_to);
      if ('message' in address) return { ok: false, message: address.message };
      if (address.id !== job.billing_address_id) {
        shipping.billing_address_id = address.id;
        changed.push('bill_to');
      }
    }
    if (args.contact !== undefined) {
      let contactId: string | null = null;
      if (args.contact !== null) {
        const contact = pickContact(job, args.contact);
        if ('message' in contact) return { ok: false, message: contact.message };
        contactId = contact.id;
      }
      if (contactId !== job.contact_id) {
        shipping.contact_id = contactId;
        changed.push('contact');
      }
    }

    // Part edits, validated in full before anything is written: the edit form will not Save
    // while any line is invalid, so one bad line here changes nothing at all.
    const edits: PartEdit[] = [];
    for (const line of args.parts ?? []) {
      const picked = pickPart(job, line);
      if ('message' in picked) return { ok: false, message: picked.message };
      const { part } = picked;
      const name = partNameOf(part);
      if (edits.some((e) => e.part.id === part.id)) {
        return { ok: false, message: `${name} is listed twice. Give each part once.` };
      }
      if (line.quantity === undefined && line.unit_price === undefined) {
        return { ok: false, message: `Give a quantity or a unit_price for ${name}.` };
      }
      if (part.production_status === 'cancelled') {
        return { ok: false, message: `${name} is cancelled on ${job.job_number}, so its quantity and price can't be changed.` };
      }
      if (line.quantity !== undefined && !isValidQuantityValue(line.quantity)) {
        return { ok: false, message: 'A quantity can have at most 4 decimal places.' };
      }
      const edit: PartEdit = { part };
      if (line.quantity !== undefined && line.quantity !== Number(part.quantity)) edit.quantity = line.quantity;
      if (line.unit_price !== undefined && line.unit_price !== part.unit_price) edit.unitPrice = line.unit_price;
      if (edit.quantity !== undefined || edit.unitPrice !== undefined) edits.push(edit);
    }

    if (edits.length > 0) {
      const [shipped, invoiced] = await Promise.all([
        getJobPartShipmentSummaries(job.id),
        getJobPartInvoiceSummaries(job.id),
      ]);
      for (const edit of edits) {
        const name = partNameOf(edit.part);
        const qtyShipped = shipped.find((s) => s.job_part_id === edit.part.id)?.qty_shipped ?? 0;
        const qtyInvoiced = invoiced.find((s) => s.job_part_id === edit.part.id)?.qty_invoiced ?? 0;
        const floor = Math.max(qtyShipped, qtyInvoiced);
        if (edit.quantity !== undefined && edit.quantity < floor) {
          return {
            ok: false,
            message:
              qtyInvoiced > qtyShipped
                ? `${name}: ${qtyInvoiced} have already been invoiced, so the quantity can't go below that. Credit or void that invoice in QuickBooks first.`
                : `${name}: ${qtyShipped} have already shipped, so the quantity can't go below that. Void a packing slip first to ship fewer.`,
          };
        }
        if (edit.unitPrice !== undefined && qtyInvoiced > 0) {
          return {
            ok: false,
            message: `${name} has been invoiced, so its price is locked. Credit or reissue the invoice in QuickBooks to change what was billed.`,
          };
        }
        if (edit.quantity !== undefined) changed.push(`${name} quantity`);
        if (edit.unitPrice !== undefined) changed.push(`${name} unit_price`);
      }
    }

    if (changed.length === 0) {
      const askedForSomething = Object.entries(args).some(
        ([key, value]) => key !== 'job_id' && key !== 'job_number' && value !== undefined,
      );
      return {
        ok: false,
        message: askedForSomething
          ? `${job.job_number} already has those values, so nothing was changed.`
          : 'Name something to change: a detail of the job, or a part\'s quantity or unit_price.',
      };
    }

    // The edit form's Save order: details, then addresses and freight, then per part the
    // quantity before the price (a quantity edit keeps the agreed price; a price edit then sets it).
    if (Object.keys(details).length > 0) await updateJobDetails(job.id, env.company.id, details);
    if (Object.keys(shipping).length > 0) await updateJobAddressContact(job.id, env.company.id, shipping);
    for (const edit of edits) {
      if (edit.quantity !== undefined) await updateJobPartQuantity(edit.part.id, edit.quantity);
      if (edit.unitPrice !== undefined) await updateJobPartPrice(edit.part.id, edit.unitPrice);
    }

    const after = await readBack(job.id, env);
    if (!after.ok) return after;
    return { ok: true, data: { ...after.data, changed } };
  },
});

// ─── cancel_job / reopen_job ─────────────────────────────────────────────────────────────────

export const cancelJobTool = defineCompanyTool({
  name: 'cancel_job',
  title: 'Cancel a job',
  description:
    'Cancels a job: every part on it is marked cancelled, and its steps, quantities and prices ' +
    'can no longer be changed. Only a job that is neither complete nor already cancelled. ' +
    'reopen_job reverses it. Returns the job as get_job does.',
  access: 'write',
  destructive: true,
  idempotent: true,
  input: jobRef,
  output: getJob.output,
  run: async (args, env) => {
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job } = found;
    if (job.production_status === 'cancelled') return { ok: false, message: `${job.job_number} is already cancelled.` };
    if (job.production_status === 'completed') {
      return { ok: false, message: `${job.job_number} is complete, so it can't be cancelled.` };
    }
    await cancelJob(job.id);
    return readBack(job.id, env);
  },
});

export const reopenJobTool = defineCompanyTool({
  name: 'reopen_job',
  title: 'Reopen a cancelled job',
  description:
    'Reopens a cancelled job: each part goes back to not started, in progress or complete ' +
    'according to the steps already recorded on it. Returns the job as get_job does.',
  access: 'write',
  idempotent: true,
  input: jobRef,
  output: getJob.output,
  run: async (args, env) => {
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job } = found;
    if (job.production_status !== 'cancelled') {
      return { ok: false, message: `${job.job_number} isn't cancelled, so there is nothing to reopen.` };
    }
    await reopenJob(job.id);
    return readBack(job.id, env);
  },
});

// ─── complete_job_operation / undo_job_operation ─────────────────────────────────────────────

const stepRef = {
  ...jobRef,
  ...partRef,
  sequence: z.number().int().positive().optional().describe('The step, by its sequence number from get_job.'),
  operation_name: z.string().optional().describe('The step, by name, when you have no sequence.'),
};

/** One step of a job, ready for an office action, or the sentence saying why not. */
async function findStep(
  args: z.infer<z.ZodObject<typeof stepRef>>,
  env: CompanyToolEnv,
  action: 'record' | 'undo',
): Promise<{ job: JobWithRelations; part: JobPartWithRelations; op: JobOperation } | { message: string }> {
  const found = await findJob(args, env);
  if ('message' in found) return found;
  const { job } = found;
  const picked = pickPart(job, args);
  if ('message' in picked) return picked;
  const { part } = picked;
  const ops = part.job_operations ?? [];

  let op: JobOperation | undefined;
  if (args.sequence !== undefined) {
    op = ops.find((o) => o.sequence === args.sequence);
    if (!op) return { message: `${partNameOf(part)} on ${job.job_number} has no step ${args.sequence}.` };
  } else if (args.operation_name?.trim()) {
    const name = args.operation_name.trim();
    const matches = ops.filter((o) => norm(o.operation_name) === norm(name));
    if (matches.length === 0) return { message: `${partNameOf(part)} on ${job.job_number} has no step named ${name}.` };
    if (matches.length > 1) {
      return { message: `${partNameOf(part)} on ${job.job_number} has ${matches.length} steps named ${name}. Give the sequence.` };
    }
    op = matches[0];
  } else {
    return { message: 'Name the step with a sequence or an operation_name.' };
  }

  // The job page disables every step control on a cancelled job.
  if (job.production_status === 'cancelled') {
    return { message: `${job.job_number} is cancelled, so its steps can't be changed. Reopen it first.` };
  }
  if (isOutsideOperation(op)) {
    const vendor = op.vendor_service?.vendor?.name;
    return {
      message:
        `${stepLabel(op)} is outside work${vendor ? ` at ${vendor}` : ''}. ` +
        (action === 'record'
          ? 'It is sent to the vendor and received back rather than completed.'
          : 'Its sends and receipts are undone one at a time from the step in Jigged.'),
    };
  }
  return { job, part, op };
}

const stepOutput = {
  job_id: z.string(),
  job_number: z.string(),
  job_part_id: z.string(),
  part_name: z.string(),
  step: z.object({
    sequence: z.number(),
    name: z.string(),
    status: z.enum(OPERATION_STATUSES),
    qty_good: z.number().describe('Good pieces recorded on this step.'),
    order_quantity: z.number(),
    remaining: z.number().describe('Still to record; never below zero.'),
  }),
  part_status: z.enum(PRODUCTION_STATUSES),
  job_stage: getJob.output.stage,
  url: urlOutput,
};

/** Where the step, its part and the job stand after a write, read back from the database. */
async function stepOutcome(jobId: string, partId: string, opId: string, env: CompanyToolEnv) {
  const [job, summaries] = await Promise.all([
    getJobWithRelations(jobId, env.company.id),
    getOperationCompletionSummaries(partId),
  ]);
  const part = job?.job_parts?.find((p) => p.id === partId);
  const op = part?.job_operations?.find((o) => o.id === opId);
  if (!job || !part || !op) throw new Error('The step was updated, but Jigged could not read the job back.');
  const summary = summaries.find((s) => s.job_operation_id === opId);
  const orderQuantity = Number(part.quantity);
  const qtyGood = summary?.qty_good ?? 0;
  return {
    job_id: job.id,
    job_number: job.job_number,
    job_part_id: part.id,
    part_name: partNameOf(part),
    step: {
      sequence: op.sequence,
      name: op.operation_name,
      status: op.status,
      qty_good: qtyGood,
      order_quantity: orderQuantity,
      remaining: summary?.qty_remaining ?? Math.max(0, orderQuantity - qtyGood),
    },
    part_status: part.production_status,
    job_stage: getJobLifecycleStage(job),
    url: companyLink(env, `/jobs/${job.id}?op=${op.id}`),
  };
}

export const completeJobOperationTool = defineCompanyTool({
  name: 'complete_job_operation',
  title: 'Record work done on a job step',
  description:
    'Records good pieces finished on an in-house routing step of a job, as Mark Complete does ' +
    'on the job page: the step\'s whole remaining quantity unless a quantity is given. It is ' +
    'recorded as done in the office, with no time against it. When a timer is running on the ' +
    'step, recording discards that timer, so no time is recorded against the step; that takes ' +
    'discard_running_timer. Outside (vendor) steps are sent and received instead. Returns the ' +
    'step\'s recorded and remaining quantities and where its part and the job now stand.',
  access: 'write',
  idempotent: false,
  input: {
    ...stepRef,
    quantity_good: z
      .number()
      .positive()
      .optional()
      .describe('Good pieces to record. Defaults to everything still remaining on the step.'),
    discard_running_timer: z
      .boolean()
      .optional()
      .describe('Go ahead when a timer is running on the step, discarding it.'),
  },
  output: {
    ...stepOutput,
    recorded: z.number().describe('Good pieces this call recorded.'),
    discarded_running_timers: z
      .number()
      .describe('Timers that were running on the step and were discarded, so no time is recorded against it.'),
  },
  run: async (args, env) => {
    const found = await findStep(args, env, 'record');
    if ('message' in found) return { ok: false, message: found.message };
    const { job, part, op } = found;
    const label = stepLabel(op);
    if (op.status === 'completed') return { ok: false, message: `${label} is already complete on ${job.job_number}.` };

    const summary = (await getOperationCompletionSummaries(part.id)).find((s) => s.job_operation_id === op.id);
    const target = Number(part.quantity);
    const qtyGood = summary?.qty_good ?? 0;
    const quantity = args.quantity_good ?? summary?.qty_remaining ?? Math.max(0, target - qtyGood);
    if (!(quantity > 0)) {
      return {
        ok: false,
        message: `Nothing remains to record on ${label}: ${qtyGood} of ${target} are recorded. Give quantity_good to record more.`,
      };
    }

    // The Complete dialog warns before the click when a timer is open on the step; this is that
    // warning. The count comes from get_operation_actuals, which carries no operator identity.
    const running = (await getOperationActuals([op.id])).get(op.id)?.open_count ?? 0;
    if (running > 0 && !args.discard_running_timer) {
      return {
        ok: false,
        message:
          `${running === 1 ? 'Someone is timing' : `${running} timers are running on`} ${label} right now. ` +
          `Recording it from here discards ${running === 1 ? 'that timer' : 'those timers'}, so no time is ` +
          'recorded against the step. Nothing was recorded; set discard_running_timer to go ahead.',
      };
    }

    let discarded = 0;
    try {
      const result = await completeJobOperation(op.id, job.id, {
        quantityGood: quantity,
        // What this call read a moment ago. If the floor recorded more since, nothing is written.
        expectedQtyGood: qtyGood,
      });
      discarded = result.discardedRunningTimers ?? 0;
    } catch (err) {
      // Not a failure: first write wins, and retrying would double-count (docs/modules/jobs.md).
      if (err instanceof CompletionConflictError) {
        return {
          ok: false,
          message: `Someone recorded work on ${label} a moment ago, so nothing was recorded. It now has ${err.liveQtyGood} of ${target} good.`,
        };
      }
      throw err;
    }

    const outcome = await stepOutcome(job.id, part.id, op.id, env);
    return { ok: true, data: { ...outcome, recorded: quantity, discarded_running_timers: discarded } };
  },
});

export const undoJobOperationTool = defineCompanyTool({
  name: 'undo_job_operation',
  title: 'Undo the work recorded on a job step',
  description:
    'Undoes everything recorded on an in-house routing step of a job, as the step\'s Undo does ' +
    'on the job page: each recorded completion is voided (kept on record, no longer counted), ' +
    'and the step, its part and the job fall back to what the remaining work says. Returns the ' +
    'step\'s quantities and where its part and the job now stand.',
  access: 'write',
  idempotent: true,
  input: stepRef,
  output: {
    ...stepOutput,
    undone: z.number().describe('Good pieces this call took back.'),
  },
  run: async (args, env) => {
    const found = await findStep(args, env, 'undo');
    if ('message' in found) return { ok: false, message: found.message };
    const { job, part, op } = found;
    const summary = (await getOperationCompletionSummaries(part.id)).find((s) => s.job_operation_id === op.id);
    const qtyGood = summary?.qty_good ?? 0;
    if (!(qtyGood > 0)) {
      return { ok: false, message: `Nothing is recorded on ${stepLabel(op)}, so there is nothing to undo.` };
    }
    await undoJobOperation(op.id);
    const outcome = await stepOutcome(job.id, part.id, op.id, env);
    return { ok: true, data: { ...outcome, undone: qtyGood } };
  },
});

// ─── add_job_note ────────────────────────────────────────────────────────────────────────────

/**
 * The caller's own membership row in this company, which is the note's author: RLS requires
 * `author_id` to be the caller's row. The composer gets it from getCurrentMember, but that
 * function shares one in-flight lookup per COMPANY, which is safe in a browser and not on a
 * server answering two people of the same company at once: the second caller would be handed the
 * first one's row. So it is read here by the caller's own user id.
 */
async function authorIdFor(env: CompanyToolEnv): Promise<string> {
  const { data, error } = await getSupabase()
    .from('user_company_access')
    .select('id')
    .eq('user_id', env.caller.userId)
    .eq('company_id', env.company.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Jigged couldn't find your membership in ${env.company.name}, so the note was not saved.`);
  return data.id;
}

export const addJobNoteTool = defineCompanyTool({
  name: 'add_job_note',
  title: 'Add a note to a job',
  description:
    'Posts a text note on a job, as the job page\'s activity feed does. It shows in the job\'s ' +
    'feed and on the job on the shop floor. Returns the note.',
  access: 'write',
  idempotent: false,
  input: {
    ...jobRef,
    body: z.string().describe('The note, as text.'),
  },
  output: {
    note_id: z.string(),
    job_id: z.string(),
    job_number: z.string(),
    body: z.string(),
    created_at: z.string(),
    url: urlOutput,
  },
  run: async (args, env) => {
    const body = args.body.trim();
    if (!body) return { ok: false, message: 'A note needs some text.' };
    const found = await findJob(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { job } = found;
    // No opts: a job-level note with no step, exactly what the office composer posts.
    const note = await addJobNote(job.id, env.company.id, await authorIdFor(env), body);
    return {
      ok: true,
      data: {
        note_id: note.id,
        job_id: job.id,
        job_number: job.job_number,
        body: note.body ?? body,
        created_at: note.created_at,
        url: companyLink(env, `/jobs/${job.id}`),
      },
    };
  },
});

export function registerJobWriteTools(server: ToolTarget): void {
  registerCompanyTool(server, createJob);
  registerCompanyTool(server, updateJob);
  registerCompanyTool(server, cancelJobTool);
  registerCompanyTool(server, reopenJobTool);
  registerCompanyTool(server, completeJobOperationTool);
  registerCompanyTool(server, undoJobOperationTool);
  registerCompanyTool(server, addJobNoteTool);
}

/** Exported for the catalogue test. */
export const JOB_WRITE_TOOLS = [
  createJob,
  updateJob,
  cancelJobTool,
  reopenJobTool,
  completeJobOperationTool,
  undoJobOperationTool,
  addJobNoteTool,
];
