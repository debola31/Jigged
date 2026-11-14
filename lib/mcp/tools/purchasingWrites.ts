import { createHash } from 'node:crypto';

import { z } from 'zod';

import { callBackend } from '@/lib/mcp/backend';
import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import { findLocation, indexLocations, type LocationIndex } from '@/lib/mcp/tools/inventory';
import {
  QUICKBOOKS_NOT_CONNECTED,
  QUICKBOOKS_OPERATIONS,
  ROW_TAKEN_OFF,
  andJoin,
  asSentence,
  findJobRef,
  findPartVendorRow,
  findPurchasingPart,
  findPurchasingVendor,
  findVendorPo,
  findVendorRfq,
  loadVendorPo,
  partCostPreviewOutput,
  partCostPreviewRecord,
  partRef,
  partVendorRef,
  partVendorsOutput,
  partVendorsRecord,
  pushBlockers,
  runVendorPoPreflight,
  todayUtc,
  vendorNameRef,
  vendorPoOutput,
  vendorPoRecord,
  vendorPoRef,
  vendorPoUrl,
  vendorRefOutput,
  vendorRfqOutput,
  vendorRfqRecord,
  vendorRfqRef,
  vendorRfqUrl,
  vendorUrl,
  warningsOutput,
  type FoundVendorPo,
  type FoundVendorRfq,
  type VendorPoPreflight,
} from '@/lib/mcp/tools/purchasing';
import { urlOutput } from '@/lib/mcp/tools/shared';
import { planVendorPoReceipt, type ReceiptEntry, type ReceiptLine, type ReceiptRow } from '@/lib/purchasing/poReceipt';
import { defaultOutsideLinePrice, type PriceDefault } from '@/lib/purchasing/priceDefault';
import { planVendorRfqAward } from '@/lib/purchasing/rfqCompare';
import { PART_VENDOR_STATUSES, VENDOR_RFQ_STATUSES } from '@/lib/purchasing/vendorPoStatus';
import { getSupabase } from '@/lib/supabase';
import type { PartVendorChanges } from '@/types/partVendor';
import type {
  OpenOutsideOperation,
  VendorPoDetail,
  VendorPoHeaderChanges,
  VendorPoHeaderInput,
  VendorPoLinePatch,
  VendorPoLineWrite,
  VendorPoNewLineInput,
  VendorPoPriceDefaultInputs,
  VendorPoShipToInput,
} from '@/types/vendorPo';
import type {
  VendorRfqChanges,
  VendorRfqDetail,
  VendorRfqHeaderInput,
  VendorRfqLineInput,
  VendorRfqLinePatch,
  VendorRfqResponseInput,
} from '@/types/vendorRfq';
import { getLocations } from '@/utils/inventoryLocationsAccess';
import { applyPartCostFromVendor, listPartVendors, previewPartCostFromVendor, savePartVendor } from '@/utils/partVendorsAccess';
import { unitNameKey } from '@/utils/purchasingShared';
import {
  closeVendorPoLines,
  createVendorPo,
  getPriceDefaultInputs,
  getVendorPo,
  listOpenOutsideOpsForVendor,
  markVendorPoSent,
  receiveVendorPo,
  reopenVendorPoLines,
  resolveLinePriceDefault,
  updateVendorPo,
  voidVendorPoReceipt,
} from '@/utils/vendorPoAccess';
import {
  awardVendorRfq,
  createVendorRfq,
  getVendorRfq,
  saveVendorRfq,
  saveVendorRfqResponses,
  setVendorRfqInvitationState,
} from '@/utils/vendorRfqAccess';

/**
 * Purchasing, write side: purchase orders TO A VENDOR, receiving against them, a part's approved
 * vendors and price sheets, "Use as part cost", RFQs to vendors, and the QuickBooks push. Every
 * write is the access function the app's own button calls, with the arguments it passes, and every
 * one of those is a single SECURITY DEFINER RPC that refuses operators and a lapsed subscription and
 * scopes every id to its document (supabase/migrations/20261110043800, 20261110043900):
 *
 *   create_vendor_po            VendorPoForm (new)              → createVendorPo
 *   update_vendor_po            VendorPoForm (edit)             → updateVendorPo
 *   mark_vendor_po_sent         the preview's "Mark as sent"    → markVendorPoSent
 *   receive_vendor_po           ReceiveVendorPoDialog           → receiveVendorPo (planVendorPoReceipt's entries)
 *   void_vendor_po_receipt      the Receipts card's Void        → voidVendorPoReceipt
 *   close_vendor_po             Close… (the PO, or lines)       → closeVendorPoLines(id, lineIds ?? 'all')
 *   reopen_vendor_po            Reopen                          → reopenVendorPoLines
 *   save_part_vendor            BuyingTab (add, edit, revive)   → savePartVendor
 *   set_part_cost_from_vendor   UseAsPartCostDialog             → previewPartCostFromVendor, then
 *                                                                 applyPartCostFromVendor(preview.expected)
 *   save_vendor_rfq             RfqForm (new or edit)           → createVendorRfq / saveVendorRfq
 *   mark_vendor_rfq_sent        the RFQ page's Mark sent        → setVendorRfqInvitationState('mark_sent')
 *   record_vendor_rfq_response  RfqResponseEditor               → saveVendorRfqResponses (the whole quote)
 *   award_vendor_rfq            RfqCompareMatrix's award        → awardVendorRfq (by response id)
 *   push_vendor_po_to_quickbooks  the QuickBooks dialog         → backend preflight, then ONE push
 *   verify_vendor_po_push       the dialog's Verify             → backend verify
 *
 * Nothing here is admin-only, as in the app: purchasing is any office user's (founder decision,
 * plan §2); operators are refused by the wrapper and again by every RPC. The records an id names
 * are found in this company first. Writes return the PO (or RFQ) as get_vendor_po (or
 * get_vendor_rfq) reads it, with the app's non-blocking notes in `warnings`.
 *
 * NO TOOL FOR (plan §3.12): the QuickBooks purchasing setup (a one-time admin choice, named in
 * every refusal that needs it); relinking a vendor slip (a rare correction; slips link
 * themselves); duplicate (create_vendor_po covers it). PO numbering has nothing to set: POs number
 * themselves, PO-0001 on.
 */

// ------------------------------------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------------------------------------

type Refusal = { message: string };

const SAVED_BUT_UNREAD =
  'Failed to read the purchase order back, though the change was saved. Check it in Jigged before trying again, so it is not done twice.';

/** The PO after a write, in full. */
async function readBack(poId: string): Promise<VendorPoDetail> {
  const detail = await getVendorPo(poId, { today: todayUtc() });
  if (!detail) throw new Error(SAVED_BUT_UNREAD);
  return detail;
}

/** The PO a write acts on: in this company, not archived, read in full. */
async function loadLivePo(
  args: { vendor_po_id?: string; po_number?: string },
  env: CompanyToolEnv,
): Promise<{ po: FoundVendorPo; detail: VendorPoDetail } | Refusal> {
  const found = await findVendorPo(args, env);
  if ('message' in found) return found;
  if (found.po.deleted_at) return { message: `${found.po.po_number} is archived in Jigged, so nothing was changed.` };
  const detail = await getVendorPo(found.po.id, { today: todayUtc() });
  if (!detail) return { message: `There is no vendor PO with that id in ${env.company.name}.` };
  return { po: found.po, detail };
}

function lineList(detail: VendorPoDetail): string {
  return detail.lines.map((l) => l.lineNumber).join(', ');
}

/** A PO line named by number or id, or the sentence listing the lines it has. */
function findLine(
  detail: VendorPoDetail,
  ref: { line_number?: number; vendor_po_line_id?: string },
): { line: VendorPoDetail['lines'][number] } | Refusal {
  const po = detail.header.poNumber;
  if (ref.line_number === undefined && !ref.vendor_po_line_id) {
    return { message: 'Name each line by line_number or vendor_po_line_id.' };
  }
  const line = ref.vendor_po_line_id
    ? detail.lines.find((l) => l.id === ref.vendor_po_line_id)
    : detail.lines.find((l) => l.lineNumber === ref.line_number);
  if (line) return { line };
  const named = ref.vendor_po_line_id ? 'with that id' : String(ref.line_number);
  return { message: `${po} has no line ${named}. Its lines: ${lineList(detail) || 'none'}.` };
}

const lineNumberOf = (detail: VendorPoDetail, lineId: string): number | null =>
  detail.lines.find((l) => l.id === lineId)?.lineNumber ?? null;

/** In QuickBooks and Jigged has moved on since: the push that brings it level. */
function quickBooksBehind(detail: VendorPoDetail): string | null {
  if (detail.quickbooks.state !== 'out_of_date') return null;
  return `${detail.header.poNumber} has changed since it went to QuickBooks; push_vendor_po_to_quickbooks updates it there.`;
}

const inQuickBooks = (detail: VendorPoDetail): boolean =>
  detail.quickbooks.linkId !== null && (detail.quickbooks.state === 'in_quickbooks' || detail.quickbooks.state === 'out_of_date');

const TBC_WARNING = (what: string) =>
  `${what} has no price yet: it prints as TBC and can't go to QuickBooks until it is priced.`;

/** The PO form's price caption, as warnings: the source of a defaulted price, or TBC. */
function priceWarnings(what: string, price: PriceDefault, typed: boolean): string[] {
  const out: string[] = [];
  if (price.unitPrice === null) out.push(TBC_WARNING(what));
  else if (!typed) out.push(`${what}: ${asSentence(price.caption)}`);
  for (const w of price.warnings) out.push(`${what}: ${asSentence(w)}`);
  return out;
}

const stepName = (op: OpenOutsideOperation): string => `Op ${op.sequence} ${op.operationName}`;

/** "Another unit…": the factor typed for a unit the part does not convert yet, for the price default. */
function withUnitFactor(
  inputs: VendorPoPriceDefaultInputs,
  unit: string | undefined,
  factor: number | undefined,
): VendorPoPriceDefaultInputs {
  const typed = unit?.trim();
  if (!typed || factor === undefined) return inputs;
  if (inputs.conversions.some((c) => unitNameKey(c.from_unit) === unitNameKey(typed))) return inputs;
  return { ...inputs, conversions: [...inputs.conversions, { from_unit: typed, to_primary_factor: factor }] };
}

function noConversion(partName: string, stock: string, unit: string): string {
  return (
    `${partName} is stocked in ${stock} and has no conversion for "${unit}". Give unit_factor ` +
    `(how many ${stock} in one ${unit}), or order in ${stock}.`
  );
}

/** A quantity as plain digits (no exponent), the way the receive dialog's field holds it. */
function plainNumber(n: number): string {
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 });
}

// ------------------------------------------------------------------------------------------------
// New PO lines: the PO form's rules and defaults
// ------------------------------------------------------------------------------------------------

const LINE_KIND_HELP =
  '`part`: a part or material, into stock. `outside_service`: a routing step on a job this vendor ' +
  'does (anodize, plate, heat treat); its quantity is pieces and its work comes back on vendor ' +
  'packing slips. `other`: anything else — maintenance, tooling, freight, a fee.';

const newLineInput = z.object({
  kind: z.enum(['part', 'outside_service', 'other']).describe(LINE_KIND_HELP),
  part_id: z.guid().optional().describe('Part lines: the part, by id. Outside lines: narrows the step to this part on the job.'),
  part_name: z.string().optional().describe('The part, by its exact part name, when you have no id.'),
  job_id: z.guid().optional().describe('The job, by id. Required for an outside-service line; links a part or other line to a job.'),
  job_number: z.string().optional().describe('The job, by its number, when you have no id.'),
  job_part_id: z
    .guid()
    .optional()
    .describe('The part on the job (a job_part_id from get_job): which one, for an outside line on a job with several.'),
  operation_sequence: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Outside lines: the routing step by its sequence number, when the job has more than one this vendor does.'),
  work_center_id: z.guid().optional().describe('Other lines: the machine it is for (a work_center_id).'),
  description: z.string().max(2000).optional().describe('Required on an other line. Defaults to the part or the step.'),
  vendor_part_number: z.string().max(64).optional().describe("Defaults to the vendor's part number on the part's vendor list."),
  quantity: z
    .number()
    .positive()
    .optional()
    .describe('In `unit`. Required, except an outside line defaults to what the step still has to send.'),
  unit: z
    .string()
    .max(40)
    .optional()
    .describe("Part lines: the unit it is bought in. Defaults to the vendor's sheet unit, else the last one ordered, else the stock unit."),
  unit_factor: z
    .number()
    .positive()
    .optional()
    .describe("A unit the part does not convert yet: how many of the part's stock unit are in one `unit`. It is saved on the part."),
  unit_price: z
    .number()
    .min(0)
    .nullable()
    .optional()
    .describe('Per `unit`. Leave it out for the default price (the price sheet, Last PO price, then the cost estimate); null for to be confirmed (TBC).'),
  need_by_on: z.iso.date().optional().describe('YYYY-MM-DD. Defaults to the PO\'s need-by date.'),
  promised_on: z.iso.date().optional().describe("The vendor's promised date (part and other lines). Internal: never printed."),
  cert_required: z.boolean().optional().describe('The vendor must send a cert (mill cert, CoC).'),
  expects_receipt: z.boolean().optional().describe('Other lines: false for freight or a fee, which never arrives to receive.'),
});

type NewLineSpec = z.infer<typeof newLineInput>;

interface LineContext {
  env: CompanyToolEnv;
  vendor: { id: string; name: string };
  today: string;
  /** "Line" on a new PO; "New line" when adding to a PO that already has a line 1. */
  noun: string;
}

async function findWorkCenter(
  id: string,
  env: CompanyToolEnv,
): Promise<{ workCenter: { id: string; name: string; deleted_at: string | null } } | Refusal> {
  const { data, error } = await getSupabase()
    .from('work_centers')
    .select('id, name, deleted_at')
    .eq('company_id', env.company.id)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? { workCenter: data } : { message: `There is no work center with that id in ${env.company.name}.` };
}

/**
 * New lines, the way the PO form builds them: a part line's unit and price from the price default
 * (lib/purchasing/priceDefault.ts through the access layer); an outside line from the form's
 * outside-step picker (`listOpenOutsideOpsForVendor`: the step, what it still has to send, its
 * price); an other line as typed. Refused with the sentence the form or the RPC would give.
 */
async function buildNewLines(
  specs: readonly NewLineSpec[],
  ctx: LineContext,
): Promise<{ lines: VendorPoNewLineInput[]; warnings: string[] } | Refusal> {
  const { env, vendor } = ctx;
  const lines: VendorPoNewLineInput[] = [];
  const warnings: string[] = [];
  const inputsByPart = new Map<string, VendorPoPriceDefaultInputs>();
  let openOps: OpenOutsideOperation[] | null = null;
  const outsideSteps = async (): Promise<OpenOutsideOperation[]> =>
    (openOps ??= await listOpenOutsideOpsForVendor(env.company.id, vendor.id));

  for (const [index, spec] of specs.entries()) {
    const label = `${ctx.noun} ${index + 1}`;
    const jobFound = await findJobRef(spec, env);
    if ('message' in jobFound) return jobFound;
    const job = jobFound.job;
    if (job?.deleted_at) return { message: `Job ${job.job_number} is archived in Jigged, so it can't go on a PO.` };

    if (spec.kind === 'part') {
      if (!spec.part_id && !spec.part_name?.trim()) return { message: `${label} is a part line: give part_id or part_name.` };
      const found = await findPurchasingPart(spec, env);
      if ('message' in found) return found;
      const part = found.part;
      if (part.deleted_at) return { message: `${part.part_name} is archived in Jigged, so it can't go on a PO.` };
      if (spec.quantity === undefined) return { message: `${label} needs a quantity.` };

      let inputs = inputsByPart.get(part.id);
      if (!inputs) {
        inputs = await getPriceDefaultInputs(env.company.id, vendor.id, part.id);
        inputsByPart.set(part.id, inputs);
      }
      const resolved = resolveLinePriceDefault(withUnitFactor(inputs, spec.unit, spec.unit_factor), {
        quantity: spec.quantity,
        unit: spec.unit,
        today: ctx.today,
        ...(spec.unit_price !== undefined ? { typedPrice: spec.unit_price } : {}),
      });
      const stock = part.primary_unit ?? inputs.stockUnit ?? 'its stock unit';
      if (resolved.basis.kind === 'incomparable') {
        return { message: noConversion(part.part_name, stock, spec.unit?.trim() || resolved.unit || 'that unit') };
      }
      const what = `${label} (${part.part_name})`;
      if (resolved.notice?.tone === 'blocked') return { message: `${what}: ${resolved.notice.text}` };
      warnings.push(...priceWarnings(what, resolved.price, spec.unit_price !== undefined));
      if (resolved.notice) warnings.push(`${what}: ${resolved.notice.text}`);
      lines.push({
        lineKind: 'part',
        partId: part.id,
        jobId: job?.id,
        jobPartId: spec.job_part_id,
        description: spec.description,
        vendorPartNumber: spec.vendor_part_number,
        quantity: spec.quantity,
        unit: resolved.unit ?? undefined,
        unitFactor: spec.unit_factor,
        unitPrice: resolved.price.unitPrice,
        priceSource: resolved.price.priceSource,
        needByOn: spec.need_by_on,
        promisedOn: spec.promised_on,
        certRequired: spec.cert_required,
      });
      continue;
    }

    if (spec.kind === 'outside_service') {
      if (!job) {
        return {
          message: `${label} is an outside-service line: give the job (job_id or job_number) whose step ${vendor.name} does.`,
        };
      }
      let partId: string | null = null;
      if (spec.part_id || spec.part_name?.trim()) {
        const found = await findPurchasingPart(spec, env);
        if ('message' in found) return found;
        partId = found.part.id;
      }
      const steps = (await outsideSteps()).filter(
        (op) =>
          op.jobId === job.id &&
          (!spec.job_part_id || op.jobPartId === spec.job_part_id) &&
          (!partId || op.partId === partId),
      );
      const list = steps.map(stepName).join(', ');
      let op: OpenOutsideOperation | undefined;
      if (spec.operation_sequence !== undefined) {
        op = steps.find((s) => s.sequence === spec.operation_sequence);
        if (!op) {
          return {
            message:
              `Job ${job.job_number} has no unfinished outside step ${spec.operation_sequence} that ${vendor.name} does.` +
              (steps.length > 0 ? ` Its steps for ${vendor.name}: ${list}.` : ''),
          };
        }
      } else if (steps.length === 1) {
        op = steps[0];
      } else if (steps.length === 0) {
        return { message: `Job ${job.job_number} has no unfinished outside step that ${vendor.name} does.` };
      } else {
        return {
          message: `Job ${job.job_number} has more than one outside step that ${vendor.name} does: ${list}. Name one with operation_sequence.`,
        };
      }
      if (op.openLine) {
        return {
          message:
            `Op ${op.sequence} on ${job.job_number} is already on ${op.openLine.poNumber} line ${op.openLine.lineNumber} ` +
            `to ${vendor.name}. Change that line with update_vendor_po instead.`,
        };
      }
      const quantity = spec.quantity ?? (op.leftToSendQuantity > 0 ? op.leftToSendQuantity : undefined);
      if (quantity === undefined) {
        return {
          message: `Nothing is left to send on Op ${op.sequence} of ${job.job_number}, so give the quantity for ${label.toLowerCase()}.`,
        };
      }
      const price =
        spec.unit_price !== undefined
          ? defaultOutsideLinePrice({
              vendorName: vendor.name,
              serviceName: op.serviceName,
              vendorServicePrice: op.vendorServicePrice,
              frozenOperationPrice: op.frozenOperationPrice,
              typedPrice: spec.unit_price,
            })
          : op.priceDefault;
      warnings.push(...priceWarnings(`${label} (${stepName(op)} on ${job.job_number})`, price, spec.unit_price !== undefined));
      lines.push({
        lineKind: 'outside_service',
        jobOperationId: op.jobOperationId,
        description: spec.description,
        quantity,
        unit: spec.unit,
        unitPrice: price.unitPrice,
        priceSource: price.priceSource,
        needByOn: spec.need_by_on,
        promisedOn: spec.promised_on,
        certRequired: spec.cert_required,
      });
      continue;
    }

    // other
    const description = spec.description?.trim();
    if (!description) return { message: `${label} is an Other line: give its description.` };
    if (spec.quantity === undefined) return { message: `${label} needs a quantity.` };
    if (spec.work_center_id) {
      const wc = await findWorkCenter(spec.work_center_id, env);
      if ('message' in wc) return wc;
      if (wc.workCenter.deleted_at) return { message: `${wc.workCenter.name} is archived in Jigged, so it can't go on a PO.` };
    }
    const unitPrice = spec.unit_price ?? null;
    if (unitPrice === null) warnings.push(TBC_WARNING(`${label} (${description})`));
    if (job) {
      // The PO form's leak prompt: an other line for a step this vendor does would not follow the slips.
      const steps = (await outsideSteps()).filter((op) => op.jobId === job.id);
      if (steps.length > 0) {
        warnings.push(
          `${label} is an Other line on ${job.job_number}, which has an outside step ${vendor.name} does ` +
            `(${steps.map(stepName).join(', ')}). An outside-service line would follow the vendor slips.`,
        );
      }
    }
    lines.push({
      lineKind: 'other',
      description,
      jobId: job?.id,
      jobPartId: spec.job_part_id,
      workCenterId: spec.work_center_id,
      vendorPartNumber: spec.vendor_part_number,
      quantity: spec.quantity,
      unit: spec.unit,
      unitPrice,
      priceSource: unitPrice === null ? null : 'manual',
      needByOn: spec.need_by_on,
      promisedOn: spec.promised_on,
      certRequired: spec.cert_required,
      expectsReceipt: spec.expects_receipt,
    });
  }
  return { lines, warnings };
}

const shipToInput = z.object({
  kind: z.enum(['shop', 'vendor', 'customer']).describe('Our shop; another vendor (a drop-ship to the plater); or a customer.'),
  vendor_id: z.guid().optional().describe('kind vendor: the vendor it ships to.'),
  customer_id: z.guid().optional().describe('kind customer: the customer it ships to.'),
  address_id: z.guid().optional().describe("That vendor's or customer's address. Defaults to its default address."),
});

async function resolveShipTo(
  spec: z.infer<typeof shipToInput>,
  env: CompanyToolEnv,
): Promise<{ shipTo: VendorPoShipToInput } | Refusal> {
  if (spec.kind === 'shop') return { shipTo: { kind: 'shop' } };
  if (spec.kind === 'vendor') {
    if (!spec.vendor_id) return { message: 'A ship-to of kind vendor needs the vendor_id it ships to.' };
    const found = await findPurchasingVendor({ vendor_id: spec.vendor_id }, env);
    if ('message' in found) return found;
    if (found.vendor.deleted_at) return { message: `${found.vendor.name} is archived in Jigged, so the PO can't ship to it.` };
    return { shipTo: { kind: 'vendor', vendorId: found.vendor.id, vendorAddressId: spec.address_id } };
  }
  if (!spec.customer_id) return { message: 'A ship-to of kind customer needs the customer_id it ships to.' };
  const { data, error } = await getSupabase()
    .from('customers')
    .select('id, name, deleted_at')
    .eq('company_id', env.company.id)
    .eq('id', spec.customer_id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { message: `There is no customer with that id in ${env.company.name}.` };
  if (data.deleted_at) return { message: `${data.name} is archived in Jigged, so the PO can't ship to it.` };
  return { shipTo: { kind: 'customer', customerId: data.id, customerAddressId: spec.address_id } };
}

const headerFields = {
  need_by_on: z.iso.date().nullable().optional().describe('When the whole order is needed (YYYY-MM-DD). New lines take it as theirs.'),
  payment_terms: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("e.g. Net 30. A new PO defaults to the vendor's standing terms."),
  ship_via: z.string().max(200).nullable().optional(),
  notes_to_vendor: z.string().max(4000).nullable().optional().describe('Printed on the PO.'),
  internal_notes: z.string().max(4000).nullable().optional().describe('Never printed or sent.'),
  ship_to: shipToInput.optional().describe('Where it ships. Defaults to our shop.'),
};

// ------------------------------------------------------------------------------------------------
// create_vendor_po
// ------------------------------------------------------------------------------------------------

export const createVendorPoTool = defineCompanyTool({
  name: 'create_vendor_po',
  title: 'Create a purchase order to a vendor',
  description:
    "Creates a draft purchase order to a vendor — the shop buying something; a customer's PO is " +
    'create_job. Lines are parts or material (into stock), outside services (a routing step on a job ' +
    'this vendor does) or other purchases (maintenance, tooling, freight). Jigged numbers it, and ' +
    "freezes the vendor's contact, address and terms on it. A part line's unit and price default as the " +
    "PO form's do (the vendor's price sheet, the Last PO price, then the part cost estimate; with no " +
    'price it is to be confirmed); a vendor marked Do not use for a part is refused. Nothing is sent ' +
    'to the vendor: mark_vendor_po_sent records the send once they have the PDF. Returns the PO, and ' +
    'in `warnings` where each defaulted price came from and anything the form would point out.',
  access: 'write',
  input: {
    ...vendorNameRef,
    ordered_on: z.iso.date().optional().describe('The PO date (YYYY-MM-DD). Defaults to today in UTC.'),
    ...headerFields,
    lines: z.array(newLineInput).min(1).max(100).describe('The lines, in order.'),
  },
  output: { ...vendorPoOutput, warnings: warningsOutput },
  run: async (args, env) => {
    const found = await findPurchasingVendor(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const vendor = found.vendor;
    if (vendor.deleted_at) return { ok: false, message: `${vendor.name} is archived in Jigged, so no PO was created.` };

    const header: VendorPoHeaderInput = {};
    if (args.need_by_on !== undefined) header.needByOn = args.need_by_on;
    if (args.payment_terms !== undefined) header.paymentTerms = args.payment_terms;
    if (args.ship_via !== undefined) header.shipVia = args.ship_via;
    if (args.notes_to_vendor !== undefined) header.notesToVendor = args.notes_to_vendor;
    if (args.internal_notes !== undefined) header.internalNotes = args.internal_notes;
    if (args.ship_to) {
      const shipTo = await resolveShipTo(args.ship_to, env);
      if ('message' in shipTo) return { ok: false, message: shipTo.message };
      header.shipTo = shipTo.shipTo;
    }

    const today = todayUtc();
    const built = await buildNewLines(args.lines, { env, vendor, today, noun: 'Line' });
    if ('message' in built) return { ok: false, message: built.message };

    const created = await createVendorPo({
      vendorId: vendor.id,
      orderedOn: args.ordered_on ?? today,
      today,
      header,
      lines: built.lines,
    });
    const after = await readBack(created.id);
    return { ok: true, data: { ...vendorPoRecord(after, env), warnings: built.warnings } };
  },
});

// ------------------------------------------------------------------------------------------------
// update_vendor_po
// ------------------------------------------------------------------------------------------------

const lineChangeInput = z.object({
  line_number: z.number().int().positive().optional().describe('The line, by number.'),
  vendor_po_line_id: z.guid().optional().describe('The line, by id.'),
  remove: z.boolean().optional().describe('Take the line off the PO. Only a line nothing was ever received on.'),
  quantity: z.number().positive().optional().describe('Not below what has already arrived.'),
  unit: z.string().max(40).optional().describe('Part lines, before anything is received.'),
  unit_factor: z.number().positive().optional().describe('A unit the part does not convert yet: stock units in one `unit`.'),
  unit_price: z.number().min(0).nullable().optional().describe('Per unit; null for to be confirmed.'),
  need_by_on: z.iso.date().nullable().optional(),
  promised_on: z.iso.date().nullable().optional().describe('Internal: never printed, never a new revision.'),
  description: z.string().max(2000).optional(),
  vendor_part_number: z.string().max(64).nullable().optional(),
  cert_required: z.boolean().optional(),
  expects_receipt: z.boolean().optional().describe('Other lines only.'),
});

/** Keys that change nothing the vendor sees: all a closed PO takes. */
const INTERNAL_LINE_KEYS = new Set(['line_number', 'vendor_po_line_id', 'promised_on']);

export const updateVendorPoTool = defineCompanyTool({
  name: 'update_vendor_po',
  title: 'Change a purchase order to a vendor',
  description:
    'Changes a purchase order to a vendor in one save, as its edit form does: header fields, changes ' +
    'to lines (quantity, price, dates, description) and removing lines, and adding lines with the ' +
    'same defaults create_vendor_po uses. A line something arrived on cannot be removed (close it ' +
    'short with close_vendor_po) or ordered below what arrived. A closed PO takes only internal notes ' +
    "and promised dates. Once the vendor has a PO, the first change to what they see makes a new " +
    'revision (Rev 1, Rev 2…) on the same number, to be sent to them again; internal notes and ' +
    'promised dates never do. Returns the PO, whether a revision opened, and `warnings`.',
  access: 'write',
  input: {
    ...vendorPoRef,
    ordered_on: z.iso.date().optional().describe('Drafts only.'),
    ...headerFields,
    lines: z.array(lineChangeInput).max(100).optional().describe('Changes to existing lines, each named by line_number or id.'),
    add_lines: z.array(newLineInput).max(100).optional().describe('New lines.'),
  },
  output: {
    ...vendorPoOutput,
    revision_opened: z.boolean().describe('This change made a new revision the vendor has not been sent.'),
    warnings: warningsOutput,
  },
  run: async (args, env) => {
    const changes: VendorPoHeaderChanges = {};
    if (args.ordered_on !== undefined) changes.orderedOn = args.ordered_on;
    if (args.need_by_on !== undefined) changes.needByOn = args.need_by_on;
    if (args.payment_terms !== undefined) changes.paymentTerms = args.payment_terms;
    if (args.ship_via !== undefined) changes.shipVia = args.ship_via;
    if (args.notes_to_vendor !== undefined) changes.notesToVendor = args.notes_to_vendor;
    if (args.internal_notes !== undefined) changes.internalNotes = args.internal_notes;
    const lineChanges = args.lines ?? [];
    const additions = args.add_lines ?? [];
    if (Object.keys(changes).length === 0 && !args.ship_to && lineChanges.length === 0 && additions.length === 0) {
      return { ok: false, message: 'Give something to change: a header field, lines or add_lines.' };
    }

    const loaded = await loadLivePo(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    const { po, detail } = loaded;
    const today = todayUtc();

    if (detail.header.closedAt) {
      const internalOnly =
        Object.keys(changes).every((k) => k === 'internalNotes') &&
        !args.ship_to &&
        additions.length === 0 &&
        lineChanges.every((c) => Object.keys(c).every((k) => INTERNAL_LINE_KEYS.has(k)));
      if (!internalOnly) {
        return { ok: false, message: `${po.po_number} is closed. Reopen it with reopen_vendor_po before changing it.` };
      }
    }
    if (args.ship_to) {
      const shipTo = await resolveShipTo(args.ship_to, env);
      if ('message' in shipTo) return { ok: false, message: shipTo.message };
      changes.shipTo = shipTo.shipTo;
    }

    const patches: VendorPoLineWrite[] = [];
    const removedLineIds: string[] = [];
    for (const change of lineChanges) {
      const found = findLine(detail, change);
      if ('message' in found) return { ok: false, message: found.message };
      const { line } = found;
      if (change.remove) {
        if (!line.removable) {
          return {
            ok: false,
            message: `Line ${line.lineNumber} of ${po.po_number} has receipts, so it can't be removed. Close it short with close_vendor_po instead.`,
          };
        }
        removedLineIds.push(line.id);
        continue;
      }
      if (change.quantity !== undefined && change.quantity < line.receivedQuantity - 1e-9) {
        return {
          ok: false,
          message: `Can't order less than has arrived: ${plainNumber(line.receivedQuantity)} ${line.unit} received on line ${line.lineNumber} of ${po.po_number}.`,
        };
      }
      if (change.unit !== undefined && line.lineKind === 'part' && line.partId) {
        const inputs = await getPriceDefaultInputs(env.company.id, detail.header.vendorId, line.partId);
        const basis = resolveLinePriceDefault(withUnitFactor(inputs, change.unit, change.unit_factor), {
          quantity: change.quantity ?? line.quantity,
          unit: change.unit,
          today,
        }).basis;
        if (basis.kind === 'incomparable') {
          const stock = line.stockUnit ?? inputs.stockUnit ?? 'its stock unit';
          return { ok: false, message: noConversion(line.partName ?? inputs.partName, stock, change.unit.trim()) };
        }
      }
      const patch: VendorPoLinePatch = { id: line.id };
      if (change.quantity !== undefined) patch.quantity = change.quantity;
      if (change.unit !== undefined) patch.unit = change.unit;
      if (change.unit_factor !== undefined) patch.unitFactor = change.unit_factor;
      if (change.unit_price !== undefined) {
        patch.unitPrice = change.unit_price;
        patch.priceSource = change.unit_price === null ? null : 'manual';
      }
      if (change.need_by_on !== undefined) patch.needByOn = change.need_by_on;
      if (change.promised_on !== undefined) patch.promisedOn = change.promised_on;
      if (change.description !== undefined) patch.description = change.description;
      if (change.vendor_part_number !== undefined) patch.vendorPartNumber = change.vendor_part_number;
      if (change.cert_required !== undefined) patch.certRequired = change.cert_required;
      if (change.expects_receipt !== undefined) patch.expectsReceipt = change.expects_receipt;
      patches.push(patch);
    }

    let warnings: string[] = [];
    if (additions.length > 0) {
      const built = await buildNewLines(additions, {
        env,
        vendor: { id: detail.header.vendorId, name: detail.header.vendorName },
        today,
        noun: 'New line',
      });
      if ('message' in built) return { ok: false, message: built.message };
      patches.push(...built.lines);
      warnings = built.warnings;
    }

    const saved = await updateVendorPo(po.id, {
      today,
      changes,
      lines: patches,
      removedLineIds,
      // Exactly as read: the database compares it only when the vendor's copy would change.
      expectedUpdatedAt: detail.header.updatedAt,
    });
    const after = await readBack(po.id);
    if (saved.revisionBumped) {
      warnings.push(
        `${po.po_number} is now Rev ${saved.revision}: send ${detail.header.vendorName} the new PDF and mark it sent with mark_vendor_po_sent.`,
      );
    }
    const behind = quickBooksBehind(after);
    if (behind) warnings.push(behind);
    return { ok: true, data: { ...vendorPoRecord(after, env), revision_opened: saved.revisionBumped, warnings } };
  },
});

// ------------------------------------------------------------------------------------------------
// mark_vendor_po_sent
// ------------------------------------------------------------------------------------------------

export const markVendorPoSentTool = defineCompanyTool({
  name: 'mark_vendor_po_sent',
  title: 'Mark a purchase order to a vendor as sent',
  description:
    "Records that the vendor now has this purchase order to a vendor (its current revision): Jigged " +
    'sends nothing itself — the PDF goes from Jigged by the person\'s own email — so this is the "Mark ' +
    'as sent" that turns a draft into an open order and snapshots exactly what the vendor got. ' +
    "Marking it again records a resend. Returns the PO and the vendor contact's email.",
  access: 'write',
  idempotent: true,
  input: vendorPoRef,
  output: {
    ...vendorPoOutput,
    vendor_email: z.string().nullable().describe("The vendor contact's email on the PO: where the PDF goes."),
    warnings: warningsOutput,
  },
  run: async (args, env) => {
    const loaded = await loadLivePo(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    const { po, detail } = loaded;
    if (detail.header.closedAt) {
      return { ok: false, message: `${po.po_number} is closed. Reopen it with reopen_vendor_po before sending it again.` };
    }
    if (detail.lines.length === 0) return { ok: false, message: `Add at least one line before sending ${po.po_number}.` };

    await markVendorPoSent(po.id, todayUtc());
    const after = await readBack(po.id);
    const warnings: string[] = [];
    if (after.summary.hasUnpricedLines) {
      warnings.push(`${po.po_number} has lines with no price yet: they print as TBC, and it can't go to QuickBooks until they are priced.`);
    }
    const behind = quickBooksBehind(after);
    if (behind) warnings.push(behind);
    return {
      ok: true,
      data: { ...vendorPoRecord(after, env), vendor_email: after.header.vendorContact?.email ?? null, warnings },
    };
  },
});

// ------------------------------------------------------------------------------------------------
// receive_vendor_po
// ------------------------------------------------------------------------------------------------

/**
 * The receipt group id for one delivery: a UUID (the column is `uuid`) from SHA-256 over the
 * company, the PO, the day (UTC), the packing slip and the entries sorted (line, unit, quantity,
 * place, heat, lot, close). The receive dialog mints one per open and reuses it on retry; an
 * assistant has no "open", so a repeat of the same delivery the same day carries the same id and
 * the RPC returns the first result instead of adding the stock twice. RFC 9562 version 8.
 */
export function vendorPoReceiptGroupId(
  companyId: string,
  poId: string,
  entries: readonly ReceiptEntry[],
  packingSlip: string | null,
  day: string,
): string {
  const rows = entries
    .map((e) =>
      JSON.stringify([
        e.line_id,
        e.quantity_unit,
        e.quantity,
        e.location_id ?? '',
        (e.heat_number ?? '').trim().toUpperCase(),
        e.lot_id ?? '',
        e.close_remaining,
      ]),
    )
    .sort();
  const digest = createHash('sha256')
    .update(JSON.stringify(['jigged-mcp-vendor-po-receipt', 1, companyId, poId, day, (packingSlip ?? '').trim(), rows]))
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const receiveLineInput = z.object({
  line_number: z.number().int().positive().optional().describe('The line, by number.'),
  vendor_po_line_id: z.guid().optional().describe('The line, by id.'),
  quantity: z.number().positive().describe('What arrived on this line, exactly as counted.'),
  unit: z
    .enum(['purchase', 'stock'])
    .optional()
    .describe("`purchase` (the line's unit, the default) or `stock` (the part's own unit, e.g. inches of a bar)."),
  location_id: z.guid().optional().describe('Part lines: where the stock went.'),
  location: z.string().optional().describe('Part lines: where it went, by name or path ("Rack A › Shelf 2"), when you have no id.'),
  heat_number: z
    .string()
    .max(100)
    .optional()
    .describe("The mill heat. Recording one on a part that isn't tracked by heat starts tracking it, for good."),
  notes: z.string().max(2000).optional(),
  close_remaining: z
    .boolean()
    .optional()
    .describe('That is everything: close what is still outstanding on this line. Applies only when it comes in short.'),
});

const receivedOutput = z.object({
  receipt_id: z.string(),
  line_number: z.number().nullable(),
  quantity: z.number(),
  unit: z.string(),
  stock_quantity: z.number().nullable(),
  stock_unit: z.string().nullable(),
  location: z.string().nullable(),
  heat_number: z.string().nullable(),
  lot_code: z.string().nullable(),
  started_lot_tracking: z.boolean(),
  over_received: z.boolean(),
});

/** Stock goes in a place with nothing inside it; the database refuses anything else. */
function containerRefusal(locationId: string, places: LocationIndex): string | null {
  const inside = places.childrenOf.get(locationId) ?? [];
  if (inside.length === 0) return null;
  return (
    `${places.pathOf(locationId)} has locations inside it, and stock goes in one of those rather than ` +
    `in it (for example ${places.pathOf(inside[0].id)}).`
  );
}

export const receiveVendorPoTool = defineCompanyTool({
  name: 'receive_vendor_po',
  title: 'Receive against a purchase order to a vendor',
  description:
    'Records one delivery against a purchase order to a vendor, as the receive dialog does, in one ' +
    'step: what arrived on each part or other line, in the purchase unit or the stock unit, a part ' +
    "line's place (it goes into stock there) and heat number, and optionally closing a short line. " +
    "Outside-service lines are not received here: their work comes back on the vendor's packing slip " +
    "(receive_outside). The PO must have been sent. More than ordered is allowed and comes back in " +
    '`warnings`. Repeating the same call on the same day returns the receipt it already recorded ' +
    'instead of receiving twice. Returns the PO, what was received, and `warnings`.',
  access: 'write',
  input: {
    ...vendorPoRef,
    lines: z.array(receiveLineInput).min(1).max(100).describe('One entry per line and place (or heat); a line may appear more than once.'),
    vendor_packing_slip: z.string().max(100).optional().describe("The vendor's packing slip number."),
    notes: z.string().max(2000).optional(),
  },
  output: {
    ...vendorPoOutput,
    received: z.array(receivedOutput),
    closed_line_numbers: z.array(z.number()).describe('Lines this delivery closed short.'),
    already_received: z
      .boolean()
      .describe('This call repeated an earlier one today, and the receipt it recorded was returned rather than a second one.'),
    warnings: warningsOutput,
  },
  run: async (args, env) => {
    const loaded = await loadLivePo(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    const { po, detail } = loaded;
    if (detail.summary.status === 'draft') {
      return {
        ok: false,
        message:
          `${po.po_number} is a draft: it hasn't been sent to ${detail.header.vendorName}, so nothing can be ` +
          'received against it. Mark it sent with mark_vendor_po_sent first.',
      };
    }
    if (detail.header.closedAt) {
      return { ok: false, message: `${po.po_number} is closed. Reopen it with reopen_vendor_po to receive more.` };
    }

    let places: LocationIndex | null = null;
    const rows: ReceiptRow[] = [];
    const closeRemaining = new Set<string>();
    for (const [index, spec] of args.lines.entries()) {
      const found = findLine(detail, spec);
      if ('message' in found) return { ok: false, message: found.message };
      const { line } = found;
      const name = `Line ${line.lineNumber} of ${po.po_number}`;
      if (line.lineKind === 'outside_service') {
        return { ok: false, message: `${name} is an outside-service line: receive it with receive_outside, naming its vendor slip.` };
      }
      if (line.closedAt) return { ok: false, message: `${name} is closed. Reopen it with reopen_vendor_po to receive more.` };
      let locationId: string | null = null;
      if (line.lineKind === 'part') {
        if (!spec.location_id && !spec.location?.trim()) {
          return { ok: false, message: `${name} (${line.partName ?? 'the part'}) needs a location_id or location: where the stock went.` };
        }
        places ??= indexLocations(await getLocations(env.company.id));
        const place = findLocation(spec, places, env);
        if ('message' in place) return { ok: false, message: place.message };
        const container = containerRefusal(place.location.id, places);
        if (container) return { ok: false, message: container };
        locationId = place.location.id;
      } else if (spec.location_id || spec.location?.trim()) {
        return { ok: false, message: `${name} isn't stocked, so it takes no location.` };
      }
      if (spec.close_remaining) closeRemaining.add(line.id);
      rows.push({
        rowKey: String(index),
        lineId: line.id,
        quantity: plainNumber(spec.quantity),
        quantityUnit: spec.unit ?? 'purchase',
        locationId,
        heatNumber: spec.heat_number ?? null,
        lotId: null,
        notes: spec.notes ?? null,
      });
    }

    // The dialog's own planner: the entries exactly as typed, the over and short captions.
    const receiptLines: ReceiptLine[] = detail.lines.map((l) => ({
      lineId: l.id,
      lineNumber: l.lineNumber,
      lineKind: l.lineKind,
      orderedQuantity: l.quantity,
      unit: l.unit,
      stockUnit: l.stockUnit,
      stockFactor: l.stockFactor,
      receivedStockQuantity: l.receivedStockQuantity ?? 0,
      receivedQuantity: l.receivedQuantity,
      closed: l.closedAt !== null,
      jobNumber: l.jobNumber,
    }));
    const plan = planVendorPoReceipt(receiptLines, rows, { closeRemainingLineIds: closeRemaining });
    if (!plan.ok) return { ok: false, message: plan.problems.map((p) => asSentence(p.message)).join(' ') };

    const receiptGroupId = vendorPoReceiptGroupId(env.company.id, po.id, plan.entries, args.vendor_packing_slip ?? null, todayUtc());
    const { count, error } = await getSupabase()
      .from('vendor_purchase_order_receipts')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', env.company.id)
      .eq('receipt_group_id', receiptGroupId);
    if (error) throw error;
    const alreadyReceived = (count ?? 0) > 0;

    const result = await receiveVendorPo(po.id, {
      receiptGroupId,
      entries: plan.entries,
      vendorPackingSlip: args.vendor_packing_slip,
      notes: args.notes,
    });
    const after = await readBack(po.id);

    const byId = new Map(detail.lines.map((l) => [l.id, l] as const));
    const numberOf = (lineId: string) => byId.get(lineId)?.lineNumber ?? lineNumberOf(after, lineId);
    const partOf = (lineId: string) => byId.get(lineId)?.partName ?? 'the part';
    const warnings: string[] = [];
    if (!alreadyReceived) {
      for (const s of plan.lines) {
        if (s.overCaption) warnings.push(`Line ${numberOf(s.lineId)}: ${asSentence(s.overCaption)}`);
      }
      for (const r of result.receipts) {
        if (r.startedTracking && !r.voided) {
          warnings.push(`Line ${numberOf(r.lineId)}: recording heat ${r.heatNumber} started tracking ${partOf(r.lineId)} by heat, for good.`);
        }
      }
      const certs = new Set<string>();
      for (const lot of result.landedLots) {
        const key = `${lot.lineId}|${lot.lotId}`;
        if (!byId.get(lot.lineId)?.certRequired || certs.has(key)) continue;
        certs.add(key);
        warnings.push(
          `Line ${numberOf(lot.lineId)} needs a mill cert: attach it to lot ${lot.lotCode ?? lot.heatNumber} of ${partOf(lot.lineId)} in Jigged.`,
        );
      }
    }

    return {
      ok: true,
      data: {
        ...vendorPoRecord(after, env),
        received: result.receipts.map((r) => ({
          receipt_id: r.receiptId,
          line_number: r.lineNumber ?? numberOf(r.lineId),
          quantity: r.quantity,
          unit: r.unit,
          stock_quantity: r.stockQuantity,
          stock_unit: r.stockUnit,
          location: r.locationName,
          heat_number: r.heatNumber,
          lot_code: r.lotCode,
          started_lot_tracking: r.startedTracking,
          over_received: r.overReceived,
        })),
        closed_line_numbers: result.closedLineIds.map(numberOf).filter((n): n is number => n !== null),
        already_received: alreadyReceived,
        warnings,
      },
    };
  },
});

// ------------------------------------------------------------------------------------------------
// void_vendor_po_receipt
// ------------------------------------------------------------------------------------------------

export const voidVendorPoReceiptTool = defineCompanyTool({
  name: 'void_vendor_po_receipt',
  title: 'Void a receipt on a purchase order to a vendor',
  description:
    'Voids one receipt against a purchase order to a vendor: the stock it added comes back out of its ' +
    'place through the stock ledger, and the line counts as not received again. The receipt stays on ' +
    'record, marked voided. Refused when that stock is no longer there (issued or moved). Lot tracking ' +
    'stays on. Takes a receipt_id from get_vendor_po. Returns the PO.',
  access: 'write',
  destructive: true,
  idempotent: true,
  input: {
    receipt_id: z.guid().describe('The receipt, by id (get_vendor_po lists them).'),
    reason: z.string().max(1000).optional(),
  },
  output: { ...vendorPoOutput, voided_receipt_id: z.string() },
  run: async (args, env) => {
    const { data, error } = await getSupabase()
      .from('vendor_purchase_order_receipts')
      .select('id, vendor_purchase_order_id, voided_at')
      .eq('company_id', env.company.id)
      .eq('id', args.receipt_id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, message: `There is no PO receipt with that id in ${env.company.name}.` };
    if (data.voided_at) return { ok: false, message: 'That receipt is already voided, so nothing was changed.' };

    await voidVendorPoReceipt(data.id, args.reason);
    const after = await readBack(data.vendor_purchase_order_id);
    return { ok: true, data: { ...vendorPoRecord(after, env), voided_receipt_id: data.id } };
  },
});

// ------------------------------------------------------------------------------------------------
// close_vendor_po / reopen_vendor_po
// ------------------------------------------------------------------------------------------------

const lineNumbersInput = z
  .array(z.number().int().positive())
  .min(1)
  .max(100)
  .optional()
  .describe('Only these lines, by number. Leave it out for the whole PO.');

function linesByNumber(detail: VendorPoDetail, numbers: readonly number[]): { lines: VendorPoDetail['lines'] } | Refusal {
  const lines: VendorPoDetail['lines'] = [];
  for (const n of [...new Set(numbers)]) {
    const found = findLine(detail, { line_number: n });
    if ('message' in found) return found;
    lines.push(found.line);
  }
  return { lines };
}

export const closeVendorPoTool = defineCompanyTool({
  name: 'close_vendor_po',
  title: 'Close a purchase order to a vendor',
  description:
    'Closes a purchase order to a vendor, or some of its lines, short: nothing more is expected on ' +
    'them, whatever arrived stays received, and they stop counting as on order. Never a new revision. ' +
    'A draft has nothing to close (archive it instead). A PO in QuickBooks stays open there until it ' +
    'is pushed again, which the `warnings` say. Returns the PO.',
  access: 'write',
  destructive: true,
  idempotent: true,
  input: {
    ...vendorPoRef,
    line_numbers: lineNumbersInput,
    reason: z.string().max(1000).optional().describe('Why, e.g. "Vendor short-shipped; balance cancelled".'),
  },
  output: {
    ...vendorPoOutput,
    closed_line_numbers: z.array(z.number()).describe('The lines this call closed; empty when the whole PO was closed.'),
    warnings: warningsOutput,
  },
  run: async (args, env) => {
    const loaded = await loadLivePo(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    const { po, detail } = loaded;
    if (detail.summary.status === 'draft') {
      return { ok: false, message: `${po.po_number} hasn't been sent, so there is nothing to close. Archive it with archive_record instead.` };
    }
    if (detail.header.closedAt) return { ok: false, message: `${po.po_number} is already closed, so nothing was changed.` };

    let lineIds: string[] | undefined;
    if (args.line_numbers) {
      const named = linesByNumber(detail, args.line_numbers);
      if ('message' in named) return { ok: false, message: named.message };
      const closed = named.lines.find((l) => l.closedAt !== null);
      if (closed) return { ok: false, message: `Line ${closed.lineNumber} of ${po.po_number} is already closed.` };
      lineIds = named.lines.map((l) => l.id);
    }

    const result = await closeVendorPoLines(po.id, lineIds ?? 'all', args.reason);
    const after = await readBack(po.id);
    const warnings: string[] = [];
    if (!lineIds && inQuickBooks(after) && !after.quickbooks.closedInQuickBooks) {
      warnings.push(`${po.po_number} is still open in QuickBooks; push_vendor_po_to_quickbooks closes it there.`);
    } else if (lineIds) {
      const behind = quickBooksBehind(after);
      if (behind) warnings.push(behind);
    }
    return {
      ok: true,
      data: {
        ...vendorPoRecord(after, env),
        closed_line_numbers: result.lineIds.map((id) => lineNumberOf(detail, id)).filter((n): n is number => n !== null),
        warnings,
      },
    };
  },
});

export const reopenVendorPoTool = defineCompanyTool({
  name: 'reopen_vendor_po',
  title: 'Reopen a purchase order to a vendor',
  description:
    'Reopens a closed purchase order to a vendor, or lines of it that were closed short, so more can ' +
    'be received on them. An outside-service line can be open on one PO at a time for its step. A PO ' +
    'closed in QuickBooks stays closed there until it is pushed again. Returns the PO.',
  access: 'write',
  idempotent: true,
  input: { ...vendorPoRef, line_numbers: lineNumbersInput },
  output: {
    ...vendorPoOutput,
    reopened_line_numbers: z.array(z.number()),
    warnings: warningsOutput,
  },
  run: async (args, env) => {
    const loaded = await loadLivePo(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    const { po, detail } = loaded;

    let lineIds: string[] | undefined;
    if (args.line_numbers) {
      const named = linesByNumber(detail, args.line_numbers);
      if ('message' in named) return { ok: false, message: named.message };
      const open = named.lines.find((l) => l.closedAt === null);
      if (open) return { ok: false, message: `Line ${open.lineNumber} of ${po.po_number} isn't closed.` };
      lineIds = named.lines.map((l) => l.id);
    } else if (!detail.header.closedAt) {
      const closedLines = detail.lines.filter((l) => l.closedAt !== null).map((l) => l.lineNumber);
      if (closedLines.length === 0) return { ok: false, message: `${po.po_number} isn't closed, so nothing was changed.` };
      const which = closedLines.length === 1 ? `line ${closedLines[0]} is` : `lines ${closedLines.join(', ')} are`;
      return {
        ok: false,
        message: `${po.po_number} isn't closed as a whole; ${which} closed short. Name them in line_numbers to reopen them.`,
      };
    }

    const result = lineIds ? await reopenVendorPoLines(po.id, lineIds) : await reopenVendorPoLines(po.id, 'all');
    const after = await readBack(po.id);
    const warnings: string[] = [];
    if (!lineIds && after.quickbooks.closedInQuickBooks) {
      warnings.push(`${po.po_number} is still closed in QuickBooks; push_vendor_po_to_quickbooks reopens it there.`);
    } else if (lineIds) {
      const behind = quickBooksBehind(after);
      if (behind) warnings.push(behind);
    }
    return {
      ok: true,
      data: {
        ...vendorPoRecord(after, env),
        reopened_line_numbers: result.lineIds.map((id) => lineNumberOf(detail, id)).filter((n): n is number => n !== null),
        warnings,
      },
    };
  },
});

// ------------------------------------------------------------------------------------------------
// save_part_vendor / set_part_cost_from_vendor
// ------------------------------------------------------------------------------------------------

export const savePartVendorTool = defineCompanyTool({
  name: 'save_part_vendor',
  title: "Save a vendor on a part's approved list",
  description:
    "Adds a vendor to a part's approved vendor list, or changes its entry, as the part's Buying tab " +
    'does: its status (approved, conditional, or disapproved — Do not use, refused on a PO), the ' +
    "vendor's part number, the unit it sells in (a new unit needs purchase_unit_factor), lead time, " +
    'minimum order, the dates its price sheet was quoted and is valid until, and the price sheet: ' +
    'given, `price_breaks` replaces the whole sheet; left out, the sheet is unchanged. A vendor taken ' +
    'off the list before comes back as the same entry. It never changes the part cost: ' +
    'set_part_cost_from_vendor does that. Returns the part\'s vendor list.',
  access: 'write',
  idempotent: true,
  input: {
    ...partRef,
    ...vendorNameRef,
    status: z.enum(PART_VENDOR_STATUSES).optional().describe('`approved` (the default for a new entry), `conditional` or `disapproved`.'),
    status_note: z.string().max(1000).nullable().optional(),
    vendor_part_number: z.string().max(64).nullable().optional(),
    purchase_unit: z.string().max(40).optional().describe('The unit this vendor sells it in; the stock unit when left out on a new entry.'),
    purchase_unit_factor: z
      .number()
      .positive()
      .optional()
      .describe("A unit the part does not convert yet: how many of the part's stock unit are in one purchase_unit."),
    lead_time_days: z.number().int().min(0).max(730).nullable().optional(),
    minimum_order_quantity: z.number().positive().nullable().optional().describe('In purchase units.'),
    quoted_on: z.iso.date().nullable().optional(),
    valid_until: z.iso.date().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    price_breaks: z
      .array(
        z.object({
          min_quantity: z.number().positive().describe('In purchase units.'),
          unit_price: z.number().positive().describe('Per purchase unit.'),
        }),
      )
      .max(50)
      .optional()
      .describe('The whole price sheet, replacing what is there. [] clears it.'),
    make_preferred: z.boolean().optional().describe("Also make this the part's preferred vendor."),
  },
  output: {
    ...partVendorsOutput,
    part_vendor_id: z.string(),
    created: z.boolean(),
    revived: z.boolean().describe('The vendor had been taken off the list; the same entry came back.'),
  },
  run: async (args, env) => {
    const partFound = await findPurchasingPart(args, env);
    if ('message' in partFound) return { ok: false, message: partFound.message };
    const part = partFound.part;
    if (part.deleted_at) return { ok: false, message: `${part.part_name} is archived in Jigged, so nothing was changed.` };
    const vendorFound = await findPurchasingVendor(args, env);
    if ('message' in vendorFound) return { ok: false, message: vendorFound.message };
    const vendor = vendorFound.vendor;
    if (vendor.deleted_at) {
      return { ok: false, message: `${vendor.name} is archived in Jigged, so it can't go on a part's vendor list.` };
    }

    const changes: PartVendorChanges = {};
    if (args.status !== undefined) changes.status = args.status;
    if (args.status_note !== undefined) changes.statusNote = args.status_note;
    if (args.vendor_part_number !== undefined) changes.vendorPartNumber = args.vendor_part_number;
    if (args.purchase_unit !== undefined) changes.purchaseUnit = args.purchase_unit;
    if (args.lead_time_days !== undefined) changes.leadTimeDays = args.lead_time_days;
    if (args.minimum_order_quantity !== undefined) changes.minimumOrderQuantity = args.minimum_order_quantity;
    if (args.quoted_on !== undefined) changes.quotedOn = args.quoted_on;
    if (args.valid_until !== undefined) changes.validUntil = args.valid_until;
    if (args.notes !== undefined) changes.notes = args.notes;

    const saved = await savePartVendor({
      partId: part.id,
      vendorId: vendor.id,
      changes,
      purchaseUnitFactor: args.purchase_unit_factor,
      priceBreaks: args.price_breaks?.map((b) => ({ minQuantity: b.min_quantity, unitPrice: b.unit_price })),
      makePreferred: Boolean(args.make_preferred),
    });
    const list = await listPartVendors(part.id, { today: todayUtc() });
    if (!list) throw new Error("Failed to read the part's vendor list back, though the change was saved.");
    return {
      ok: true,
      data: { ...partVendorsRecord(list, part, env), part_vendor_id: saved.partVendorId, created: saved.created, revived: saved.revived },
    };
  },
});

export const setPartCostFromVendorTool = defineCompanyTool({
  name: 'set_part_cost_from_vendor',
  title: "Use a vendor's price as part cost",
  description:
    'Does "Use as part cost" for a bought part: sets the cost of each of its pricing tiers from one ' +
    "vendor's price sheet (the price per stock unit at that tier's quantity), keeping every tier's " +
    'quantity and markup, so each price moves with its cost; a part with no tiers gets them at 0% ' +
    'markup. Open quotes keep their prices and show "Pricing changed"; parts that use it as material ' +
    're-cost; existing jobs keep their frozen cost. It applies exactly what preview_part_cost_from_vendor ' +
    'shows, and is refused if the part\'s pricing or the sheet changed in between. Returns what was ' +
    'applied.',
  access: 'write',
  destructive: true,
  idempotent: true,
  input: partVendorRef,
  output: {
    ...partCostPreviewOutput,
    updated_tier_count: z.number(),
    inserted_tier_count: z.number(),
  },
  run: async (args, env) => {
    const found = await findPartVendorRow(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    if (found.row.deleted_at) return { ok: false, message: `${ROW_TAKEN_OFF}, so nothing was changed.` };
    const today = todayUtc();
    const preview = await previewPartCostFromVendor(found.row.id, today);
    // The preview exactly as the database returned it: the apply refuses unless it still holds.
    const applied = await applyPartCostFromVendor(found.row.id, today, preview.expected);
    return {
      ok: true,
      data: {
        ...partCostPreviewRecord(preview, env, true),
        updated_tier_count: applied.updatedTierIds.length,
        inserted_tier_count: applied.insertedTierIds.length,
      },
    };
  },
});

// ------------------------------------------------------------------------------------------------
// RFQs
// ------------------------------------------------------------------------------------------------

/** The RFQ a write acts on: in this company, not archived, read in full. */
async function loadLiveRfq(
  args: { vendor_rfq_id?: string; rfq_number?: string },
  env: CompanyToolEnv,
): Promise<{ rfq: FoundVendorRfq; detail: VendorRfqDetail } | Refusal> {
  const found = await findVendorRfq(args, env);
  if ('message' in found) return found;
  if (found.rfq.deleted_at) return { message: `${found.rfq.rfq_number} is archived in Jigged, so nothing was changed.` };
  const detail = await getVendorRfq(found.rfq.id, { today: todayUtc() });
  if (!detail) return { message: `There is no RFQ with that id in ${env.company.name}.` };
  return { rfq: found.rfq, detail };
}

async function readBackRfq(rfqId: string): Promise<VendorRfqDetail> {
  const detail = await getVendorRfq(rfqId, { today: todayUtc() });
  if (!detail) throw new Error('Failed to read the RFQ back, though the change was saved. Check it in Jigged before trying again.');
  return detail;
}

const rfqQuantities = z
  .array(z.number().positive())
  .min(1)
  .max(4)
  .describe('One to four quantities for vendors to price, all in `unit`.');

const rfqLineInput = z.object({
  part_id: z.guid().optional().describe('The part, by id.'),
  part_name: z.string().optional().describe('The part, by exact part name.'),
  description: z.string().max(2000).optional().describe('What to quote, when it is not a part in Jigged.'),
  unit: z.string().max(40).optional().describe("The unit every quote on the line is per. A part line defaults to the part's stock unit."),
  unit_factor: z.number().positive().optional().describe("A unit the part does not convert yet: stock units in one `unit`."),
  quantities: rfqQuantities,
  job_id: z.guid().optional(),
  job_number: z.string().optional(),
  cert_required: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});

const rfqLineChangeInput = z.object({
  line_number: z.number().int().positive().optional(),
  vendor_rfq_line_id: z.guid().optional(),
  remove: z.boolean().optional().describe('Take the line off. Only a line no vendor has quoted.'),
  quantities: rfqQuantities.optional(),
  unit: z.string().max(40).optional(),
  unit_factor: z.number().positive().optional(),
  description: z.string().max(2000).optional(),
  cert_required: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

async function buildRfqLines(
  specs: readonly z.infer<typeof rfqLineInput>[],
  env: CompanyToolEnv,
  noun: string,
): Promise<{ lines: VendorRfqLineInput[] } | Refusal> {
  const lines: VendorRfqLineInput[] = [];
  for (const [index, spec] of specs.entries()) {
    const label = `${noun} ${index + 1}`;
    const hasPart = Boolean(spec.part_id || spec.part_name?.trim());
    if (!hasPart && !spec.description?.trim()) {
      return { message: `${label} needs a part (part_id or part_name) or a description.` };
    }
    let partId: string | undefined;
    if (hasPart) {
      const found = await findPurchasingPart(spec, env);
      if ('message' in found) return found;
      if (found.part.deleted_at) return { message: `${found.part.part_name} is archived in Jigged, so it can't go on an RFQ.` };
      partId = found.part.id;
    }
    const jobFound = await findJobRef(spec, env);
    if ('message' in jobFound) return jobFound;
    if (jobFound.job?.deleted_at) return { message: `Job ${jobFound.job.job_number} is archived in Jigged, so it can't go on an RFQ.` };
    lines.push({
      partId,
      description: spec.description?.trim() || undefined,
      unit: spec.unit,
      unitFactor: spec.unit_factor,
      quantities: spec.quantities,
      jobId: jobFound.job?.id,
      certRequired: spec.cert_required,
      notes: spec.notes,
    });
  }
  return { lines };
}

/** Vendors to invite, every one of them in this company and live. */
async function findInvitedVendors(
  ids: readonly string[],
  env: CompanyToolEnv,
): Promise<{ vendors: Array<{ id: string; name: string }> } | Refusal> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { vendors: [] };
  const { data, error } = await getSupabase()
    .from('vendors')
    .select('id, name, deleted_at')
    .eq('company_id', env.company.id)
    .in('id', unique);
  if (error) throw error;
  const byId = new Map((data ?? []).map((v) => [v.id, v] as const));
  const vendors: Array<{ id: string; name: string }> = [];
  for (const id of unique) {
    const v = byId.get(id);
    if (!v) return { message: `There is no vendor with that id in ${env.company.name}.` };
    if (v.deleted_at) return { message: `${v.name} is archived in Jigged, so it can't be asked for a quote.` };
    vendors.push({ id: v.id, name: v.name });
  }
  return { vendors };
}

const NOT_INVITED = (rfq: string) => `That vendor isn't invited to ${rfq}.`;

export const saveVendorRfqTool = defineCompanyTool({
  name: 'save_vendor_rfq',
  title: 'Save an RFQ to vendors',
  description:
    'Creates a request for quotation to vendors, or changes one, as the RFQ form does. Leave out ' +
    'vendor_rfq_id and rfq_number to create one: its lines (a part, or a description for anything ' +
    'else), each with one unit and up to four quantities to price, and the vendors to invite. Given ' +
    'one, it changes the header, adds lines, changes or removes lines no vendor has quoted, and ' +
    'invites or uninvites vendors. Nothing is sent to the vendors: mark_vendor_rfq_sent records that ' +
    'they have it. Returns the RFQ.',
  access: 'write',
  input: {
    ...vendorRfqRef,
    title: z.string().max(200).nullable().optional(),
    needed_by_on: z.iso.date().nullable().optional(),
    respond_by_on: z.iso.date().nullable().optional().describe('When vendors should answer by.'),
    notes_to_vendors: z.string().max(4000).nullable().optional().describe('Printed on the RFQ.'),
    internal_notes: z.string().max(4000).nullable().optional(),
    lines: z.array(rfqLineInput).max(100).optional().describe('New lines.'),
    line_changes: z.array(rfqLineChangeInput).max(100).optional().describe('Changes to existing lines.'),
    invite_vendor_ids: z.array(z.guid()).max(50).optional(),
    remove_vendor_ids: z.array(z.guid()).max(50).optional().describe('Vendors to uninvite: only ones that have not quoted.'),
  },
  output: { ...vendorRfqOutput, created: z.boolean() },
  run: async (args, env) => {
    const header: VendorRfqHeaderInput = {};
    if (args.title !== undefined) header.title = args.title;
    if (args.needed_by_on !== undefined) header.neededByOn = args.needed_by_on;
    if (args.respond_by_on !== undefined) header.respondByOn = args.respond_by_on;
    if (args.notes_to_vendors !== undefined) header.notesToVendors = args.notes_to_vendors;
    if (args.internal_notes !== undefined) header.internalNotes = args.internal_notes;

    if (!args.vendor_rfq_id && !args.rfq_number?.trim()) {
      if (args.line_changes?.length || args.remove_vendor_ids?.length) {
        return {
          ok: false,
          message: 'line_changes and remove_vendor_ids change an existing RFQ: give its vendor_rfq_id or rfq_number.',
        };
      }
      if (!args.lines?.length) return { ok: false, message: 'Add at least one line to the RFQ.' };
      const built = await buildRfqLines(args.lines, env, 'Line');
      if ('message' in built) return { ok: false, message: built.message };
      const invited = await findInvitedVendors(args.invite_vendor_ids ?? [], env);
      if ('message' in invited) return { ok: false, message: invited.message };
      const created = await createVendorRfq(env.company.id, {
        header,
        lines: built.lines,
        vendorIds: invited.vendors.map((v) => v.id),
      });
      const after = await readBackRfq(created.id);
      return { ok: true, data: { ...vendorRfqRecord(after, env), created: true } };
    }

    const loaded = await loadLiveRfq(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    const { rfq, detail } = loaded;

    const patches: VendorRfqLinePatch[] = [];
    const removedLineIds: string[] = [];
    for (const change of args.line_changes ?? []) {
      if (change.line_number === undefined && !change.vendor_rfq_line_id) {
        return { ok: false, message: 'Name each line by line_number or vendor_rfq_line_id.' };
      }
      const line = change.vendor_rfq_line_id
        ? detail.lines.find((l) => l.id === change.vendor_rfq_line_id)
        : detail.lines.find((l) => l.lineNumber === change.line_number);
      if (!line) {
        return {
          ok: false,
          message: `${rfq.rfq_number} has no line ${change.vendor_rfq_line_id ? 'with that id' : change.line_number}. Its lines: ${detail.lines.map((l) => l.lineNumber).join(', ') || 'none'}.`,
        };
      }
      if (change.remove) {
        removedLineIds.push(line.id);
        continue;
      }
      const patch: VendorRfqLinePatch = { id: line.id };
      if (change.quantities !== undefined) patch.quantities = change.quantities;
      if (change.unit !== undefined) patch.unit = change.unit;
      if (change.unit_factor !== undefined) patch.unitFactor = change.unit_factor;
      if (change.description !== undefined) patch.description = change.description;
      if (change.cert_required !== undefined) patch.certRequired = change.cert_required;
      if (change.notes !== undefined) patch.notes = change.notes;
      patches.push(patch);
    }

    const removedInvitationIds: string[] = [];
    for (const vendorId of new Set(args.remove_vendor_ids ?? [])) {
      const invitation = detail.invitations.find((i) => i.vendorId === vendorId);
      if (!invitation) return { ok: false, message: NOT_INVITED(rfq.rfq_number) };
      removedInvitationIds.push(invitation.id);
    }
    const toInvite = (args.invite_vendor_ids ?? []).filter((id) => !detail.invitations.some((i) => i.vendorId === id));
    const invited = await findInvitedVendors(toInvite, env);
    if ('message' in invited) return { ok: false, message: invited.message };

    const built = await buildRfqLines(args.lines ?? [], env, 'New line');
    if ('message' in built) return { ok: false, message: built.message };

    const changes: VendorRfqChanges = header;
    const nothing =
      Object.keys(changes).length === 0 &&
      patches.length === 0 &&
      removedLineIds.length === 0 &&
      built.lines.length === 0 &&
      invited.vendors.length === 0 &&
      removedInvitationIds.length === 0;
    if (nothing) {
      return { ok: false, message: `Give something to change on ${rfq.rfq_number}: a header field, lines, line_changes or vendors.` };
    }

    await saveVendorRfq(rfq.id, {
      changes,
      lines: [...built.lines, ...patches],
      removedLineIds,
      addVendorIds: invited.vendors.map((v) => v.id),
      removedInvitationIds,
      expectedUpdatedAt: detail.header.updatedAt,
    });
    const after = await readBackRfq(rfq.id);
    return { ok: true, data: { ...vendorRfqRecord(after, env), created: false } };
  },
});

export const markVendorRfqSentTool = defineCompanyTool({
  name: 'mark_vendor_rfq_sent',
  title: 'Mark an RFQ to vendors as sent',
  description:
    'Records that invited vendors now have an RFQ: Jigged sends nothing itself — each vendor\'s RFQ ' +
    "PDF goes by the person's own email — so this is the RFQ page's Mark sent. Without vendor_ids it " +
    'marks every invited vendor not yet sent and not declined. Returns the RFQ and the emails of the ' +
    'contacts it goes to.',
  access: 'write',
  idempotent: true,
  input: {
    ...vendorRfqRef,
    vendor_ids: z.array(z.guid()).min(1).max(50).optional().describe('Only these invited vendors.'),
  },
  output: {
    ...vendorRfqOutput,
    vendor_emails: z.array(
      z.object({ vendor_name: z.string(), contact_name: z.string().nullable(), email: z.string().nullable() }),
    ),
  },
  run: async (args, env) => {
    const loaded = await loadLiveRfq(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    const { rfq, detail } = loaded;
    if (detail.invitations.length === 0) {
      return { ok: false, message: `${rfq.rfq_number} has no vendors invited yet. Invite them with save_vendor_rfq.` };
    }
    let targets = detail.invitations.filter((i) => i.sentAt === null && i.declinedAt === null);
    if (args.vendor_ids) {
      targets = [];
      for (const vendorId of new Set(args.vendor_ids)) {
        const invitation = detail.invitations.find((i) => i.vendorId === vendorId);
        if (!invitation) return { ok: false, message: NOT_INVITED(rfq.rfq_number) };
        targets.push(invitation);
      }
    } else if (targets.length === 0) {
      return { ok: false, message: `Every vendor invited to ${rfq.rfq_number} is already marked sent.` };
    }

    for (const invitation of targets) await setVendorRfqInvitationState(invitation.id, 'mark_sent');
    const after = await readBackRfq(rfq.id);
    return {
      ok: true,
      data: {
        ...vendorRfqRecord(after, env),
        vendor_emails: targets.map((i) => ({
          vendor_name: i.vendorName,
          contact_name: i.vendorContact?.name ?? null,
          email: i.vendorContact?.email ?? null,
        })),
      },
    };
  },
});

const quoteInput = z.object({
  line_number: z.number().int().positive().describe('The RFQ line.'),
  quantity: z.number().positive().describe('One of the quantities the line asks for.'),
  unit_price: z.number().min(0).optional().describe("Per the line's unit."),
  no_bid: z.boolean().optional().describe('The vendor will not quote this.'),
  lead_time_days: z.number().int().min(0).max(730).nullable().optional(),
  minimum_order_quantity: z.number().positive().nullable().optional(),
  valid_until: z.iso.date().nullable().optional(),
  vendor_part_number: z.string().max(64).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const quantityList = (quantities: readonly number[]) => andJoin(quantities.map((q) => plainNumber(q)));

export const recordVendorRfqResponseTool = defineCompanyTool({
  name: 'record_vendor_rfq_response',
  title: "Record a vendor's quote on an RFQ",
  description:
    "Records what one invited vendor quoted on an RFQ, as the RFQ page's quote grid does: for a line " +
    "and one of its quantities, a price per the line's unit (or no bid), lead time, minimum order, " +
    'valid-until date and their part number. Answers the vendor already gave that this call does not ' +
    'mention are kept; a quote already awarded cannot change. Returns the RFQ with its comparison.',
  access: 'write',
  idempotent: true,
  input: {
    ...vendorRfqRef,
    vendor_id: z.guid().optional().describe('The invited vendor, by id.'),
    vendor_name: z.string().optional().describe("The invited vendor's name."),
    quotes: z.array(quoteInput).min(1).max(100),
    vendor_quote_reference: z.string().max(100).nullable().optional().describe("The vendor's own quote number."),
    quoted_on: z.iso.date().nullable().optional(),
  },
  output: vendorRfqOutput,
  run: async (args, env) => {
    const loaded = await loadLiveRfq(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    const { rfq, detail } = loaded;
    if (!args.vendor_id && !args.vendor_name?.trim()) return { ok: false, message: 'Give a vendor_id or a vendor_name.' };
    const wanted = args.vendor_name?.trim().toLowerCase();
    const invitation = detail.invitations.find((i) =>
      args.vendor_id ? i.vendorId === args.vendor_id : i.vendorName.trim().toLowerCase() === wanted,
    );
    if (!invitation) return { ok: false, message: NOT_INVITED(rfq.rfq_number) };
    if (invitation.declinedAt) {
      return {
        ok: false,
        message: `${invitation.vendorName} declined ${rfq.rfq_number}. Undo the decline in Jigged before recording its quote.`,
      };
    }

    const mine = detail.responses.filter((r) => r.invitationId === invitation.id);
    const cell = (lineId: string, quantity: number) => `${lineId}|${quantity}`;
    const merged = new Map<string, VendorRfqResponseInput>();
    for (const r of mine) {
      if (r.awardedAt) continue; // frozen, and kept by the database whatever is sent
      merged.set(cell(r.lineId, r.quantity), {
        lineId: r.lineId,
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        noBid: r.noBid,
        leadTimeDays: r.leadTimeDays,
        minimumOrderQuantity: r.minimumOrderQuantity,
        validUntil: r.validUntil,
        vendorPartNumber: r.vendorPartNumber,
        notes: r.notes,
      });
    }
    for (const q of args.quotes) {
      const line = detail.lines.find((l) => l.lineNumber === q.line_number);
      if (!line) {
        return {
          ok: false,
          message: `${rfq.rfq_number} has no line ${q.line_number}. Its lines: ${detail.lines.map((l) => l.lineNumber).join(', ') || 'none'}.`,
        };
      }
      if (!line.quantities.some((x) => Math.abs(x - q.quantity) < 1e-9)) {
        return {
          ok: false,
          message: `Line ${line.lineNumber} of ${rfq.rfq_number} asks for ${quantityList(line.quantities)}, not ${plainNumber(q.quantity)}.`,
        };
      }
      if (!q.no_bid && q.unit_price === undefined) {
        return {
          ok: false,
          message: `Give a unit_price, or no_bid: true, for line ${line.lineNumber} at ${plainNumber(q.quantity)}.`,
        };
      }
      const quantity = line.quantities.find((x) => Math.abs(x - q.quantity) < 1e-9) ?? q.quantity;
      if (mine.some((r) => r.lineId === line.id && Math.abs(r.quantity - quantity) < 1e-9 && r.awardedAt)) {
        return {
          ok: false,
          message: `Line ${line.lineNumber} at ${plainNumber(quantity)} from ${invitation.vendorName} is already awarded, so its quote can't change.`,
        };
      }
      const prior = merged.get(cell(line.id, quantity));
      const next: VendorRfqResponseInput = { ...(prior ?? { lineId: line.id, quantity }), noBid: Boolean(q.no_bid) };
      if (q.no_bid) next.unitPrice = null;
      else if (q.unit_price !== undefined) next.unitPrice = q.unit_price;
      if (q.lead_time_days !== undefined) next.leadTimeDays = q.lead_time_days;
      if (q.minimum_order_quantity !== undefined) next.minimumOrderQuantity = q.minimum_order_quantity;
      if (q.valid_until !== undefined) next.validUntil = q.valid_until;
      if (q.vendor_part_number !== undefined) next.vendorPartNumber = q.vendor_part_number;
      if (q.notes !== undefined) next.notes = q.notes;
      merged.set(cell(line.id, quantity), next);
    }

    const options: { vendorQuoteReference?: string | null; quotedOn?: string | null } = {};
    if (args.vendor_quote_reference !== undefined) options.vendorQuoteReference = args.vendor_quote_reference;
    if (args.quoted_on !== undefined) options.quotedOn = args.quoted_on;
    await saveVendorRfqResponses(invitation.id, [...merged.values()], options);
    const after = await readBackRfq(rfq.id);
    return { ok: true, data: vendorRfqRecord(after, env) };
  },
});

export const awardVendorRfqTool = defineCompanyTool({
  name: 'award_vendor_rfq',
  title: 'Award an RFQ to vendors',
  description:
    "Awards an RFQ's quotes, as its compare screen does: one quote per line, by the response ids " +
    'get_vendor_rfq lists in its comparison. In one step it makes a draft purchase order to a vendor ' +
    'for each vendor awarded (lines that were not parts become other lines), priced at the quote. ' +
    "save_to_price_sheets (off unless set) also writes those quotes as each vendor's price sheet for " +
    'the parts awarded. Returns the draft POs.',
  access: 'write',
  destructive: true,
  input: {
    ...vendorRfqRef,
    response_ids: z.array(z.guid()).min(1).max(100).describe('One quote per line, from the comparison.'),
    save_to_price_sheets: z.boolean().optional(),
  },
  output: {
    vendor_rfq_id: z.string(),
    rfq_number: z.string(),
    status: z.enum(VENDOR_RFQ_STATUSES).nullable(),
    vendor_pos: z
      .array(
        z.object({
          vendor_po_id: z.string(),
          po_number: z.string(),
          vendor: vendorRefOutput,
          line_count: z.number(),
          url: urlOutput,
        }),
      )
      .describe('The draft purchase orders to vendors this award made, one per vendor.'),
    saved_to_price_sheets: z.number().describe('Approved-vendor entries whose price sheet was written.'),
    warnings: warningsOutput,
    url: urlOutput,
  },
  run: async (args, env) => {
    const loaded = await loadLiveRfq(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    const { rfq, detail } = loaded;
    const today = todayUtc();
    // The compare screen's own check of the picks: one per line, quoted, not declined, not awarded.
    const plan = planVendorRfqAward(args.response_ids, {
      lines: detail.lines.map((l) => ({
        lineId: l.id,
        lineNumber: l.lineNumber,
        label: l.partName ?? l.description,
        unit: l.unit,
        quantities: l.quantities,
      })),
      vendors: detail.invitations.map((i) => ({
        invitationId: i.id,
        vendorId: i.vendorId,
        vendorName: i.vendorName,
        declined: i.declinedAt !== null,
      })),
      responses: detail.responses.map((r) => ({
        responseId: r.id,
        invitationId: r.invitationId,
        lineId: r.lineId,
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        noBid: r.noBid,
        leadTimeDays: r.leadTimeDays,
        validUntil: r.validUntil,
        awarded: r.awardedAt !== null,
      })),
      today,
    });
    if (plan.problems.length > 0) return { ok: false, message: plan.problems.join(' ') };

    const result = await awardVendorRfq(rfq.id, args.response_ids, {
      saveToPriceSheets: Boolean(args.save_to_price_sheets),
      today,
    });
    return {
      ok: true,
      data: {
        vendor_rfq_id: rfq.id,
        rfq_number: rfq.rfq_number,
        status: result.status,
        vendor_pos: result.purchaseOrders.map((p) => ({
          vendor_po_id: p.id,
          po_number: p.poNumber,
          vendor: { vendor_id: p.vendorId, name: p.vendorName, url: vendorUrl(env, p.vendorId) },
          line_count: p.lineIds.length,
          url: vendorPoUrl(env, p.id),
        })),
        saved_to_price_sheets: result.savedPartVendorIds.length,
        warnings: plan.warnings,
        url: vendorRfqUrl(env, rfq.id),
      },
    };
  },
});

// ------------------------------------------------------------------------------------------------
// QuickBooks
// ------------------------------------------------------------------------------------------------

/** POST /api/quickbooks/{company}/vendor-pos/{po}/push, every shape `push_vendor_po` returns. */
const pushResponse = z.object({
  operation: z.enum(QUICKBOOKS_OPERATIONS).optional(),
  qb_po_id: z.string().nullable().optional(),
  doc_number: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  already_existed: z.boolean().optional(),
  already_up_to_date: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  link_id: z.string().optional(),
  in_progress: z.boolean().optional(),
});

/** POST /api/quickbooks/{company}/vendor-po-links/{link}/verify. */
const verifyResponse = z.object({
  outcome: z.enum(['adopted', 'released', 'in_progress']),
  qb_po_id: z.string().nullable().optional(),
  doc_number: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});

type VendorBody = Record<string, never> | { vendor: { action: 'use_existing'; qb_vendor_id: string } | { action: 'create' } };

/**
 * The vendor step of the dialog: a linked vendor is used; an exact name match is linked by the
 * server itself; with no match the server creates it; similar names are the one case that needs an
 * explicit choice. The body names only that choice — the server mints every request id.
 */
function decideVendor(
  pre: VendorPoPreflight,
  args: { quickbooks_vendor_id?: string; create_quickbooks_vendor?: boolean },
): { body: VendorBody } | Refusal {
  const chosen = args.quickbooks_vendor_id?.trim();
  const create = args.create_quickbooks_vendor === true;
  if (chosen && create) return { message: 'Give quickbooks_vendor_id or create_quickbooks_vendor, not both.' };
  const v = pre.vendor;
  if (!v || v.status === 'mapped') {
    if (create || (chosen && chosen !== v?.qb_vendor_id)) {
      return {
        message: `${v?.jigged_name ?? 'This vendor'} is already linked to a QuickBooks vendor, and Jigged sends its POs to that one. Nothing was sent.`,
      };
    }
    return { body: {} };
  }
  if (create) return { body: { vendor: { action: 'create' } } };
  const list = v.candidates.map((c) => `${c.display_name ?? c.qb_id} (quickbooks_vendor_id ${c.qb_id})`).join('; ');
  if (chosen) {
    if (!v.candidates.some((c) => c.qb_id === chosen)) {
      return {
        message: v.candidates.length
          ? `That QuickBooks vendor isn't one of the matches for ${v.jigged_name}: ${list}.`
          : `QuickBooks has no vendor matching ${v.jigged_name}, so the push can only create one (create_quickbooks_vendor).`,
      };
    }
    return { body: { vendor: { action: 'use_existing', qb_vendor_id: chosen } } };
  }
  if (v.status === 'exact_match' || v.status === 'unmatched') return { body: {} };
  return {
    message:
      `QuickBooks has several vendors that could be ${v.jigged_name}, so nothing was sent. Choose one with ` +
      `quickbooks_vendor_id (${list}), or create_quickbooks_vendor to create a new one.`,
  };
}

export const pushVendorPoToQuickBooksTool = defineCompanyTool({
  name: 'push_vendor_po_to_quickbooks',
  title: 'Send a vendor PO to QuickBooks',
  description:
    'Sends one purchase order to a vendor to QuickBooks (Online or Desktop), as the PO page\'s ' +
    'QuickBooks button does: creates it there the first time, and after that updates, closes or ' +
    'reopens it to match Jigged. It must have been sent to the vendor at its current revision and ' +
    'every line priced. The vendor is matched the way the dialog matches it; similar names need ' +
    'quickbooks_vendor_id or create_quickbooks_vendor. Jigged never creates bills or item receipts: ' +
    'the bookkeeper bills against the PO in QuickBooks. Sending it again with nothing changed calls ' +
    "QuickBooks not at all. Returns the PO, QuickBooks' number for it, and what QuickBooks holds " +
    'differently from the PDF.',
  access: 'write',
  destructive: true,
  idempotent: true,
  openWorld: true,
  input: {
    ...vendorPoRef,
    quickbooks_vendor_id: z
      .string()
      .max(100)
      .optional()
      .describe('Send it to this existing QuickBooks vendor: one of the candidates preview_vendor_po_push lists.'),
    create_quickbooks_vendor: z.boolean().optional().describe('Create the vendor in QuickBooks rather than link an existing one.'),
  },
  output: {
    ...vendorPoOutput,
    quickbooks_operation: z
      .enum(QUICKBOOKS_OPERATIONS)
      .nullable()
      .describe('What the push did; `none`: QuickBooks already held exactly this, so nothing was sent.'),
    quickbooks_number: z.string().nullable(),
    already_up_to_date: z.boolean(),
    already_existed: z.boolean().describe('An earlier send had already landed; it was recorded rather than sent twice.'),
    quickbooks_url: z.string().nullable().describe('The PO in QuickBooks Online. Null for QuickBooks Desktop.'),
    warnings: warningsOutput,
  },
  run: async (args, env) => {
    const found = await findVendorPo(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { po } = found;
    const pre = await runVendorPoPreflight(env, po.id);
    if (!pre.connected) return { ok: false, message: QUICKBOOKS_NOT_CONNECTED };
    if (pre.blocked) {
      return { ok: false, message: `${pre.blocked.message} Check it in QuickBooks, then settle it with verify_vendor_po_push.` };
    }
    if (pre.refusal) return { ok: false, message: pre.refusal.message };
    if (pre.setup_missing?.length) {
      const setup = pushBlockers({ connected: true, setup_missing: pre.setup_missing });
      return { ok: false, message: setup[0] };
    }
    const decided = decideVendor(pre, args);
    if ('message' in decided) return { ok: false, message: decided.message };

    const result = await callBackend(env, `/api/quickbooks/${env.company.id}/vendor-pos/${po.id}/push`, pushResponse, {
      body: decided.body,
    });
    if (result.in_progress) {
      return { ok: false, message: `${po.po_number} is already being sent to QuickBooks. Check it in a moment.` };
    }
    const after = await readBack(po.id);
    return {
      ok: true,
      data: {
        ...vendorPoRecord(after, env),
        quickbooks_operation: result.operation ?? null,
        quickbooks_number: result.doc_number ?? null,
        already_up_to_date: Boolean(result.already_up_to_date),
        already_existed: Boolean(result.already_existed),
        quickbooks_url: result.url ?? null,
        warnings: result.warnings ?? [],
      },
    };
  },
});

export const verifyVendorPoPushTool = defineCompanyTool({
  name: 'verify_vendor_po_push',
  title: 'Settle an unconfirmed QuickBooks send',
  description:
    'Settles a send of a purchase order to a vendor that QuickBooks never confirmed (QuickBooks ' +
    'Desktop went quiet mid-send): Jigged looks for it in QuickBooks once and records it if it ' +
    'landed, or lets the next push try again if it did not. Nothing is retried on its own. Returns ' +
    'the PO and what was found.',
  access: 'write',
  idempotent: true,
  openWorld: true,
  input: vendorPoRef,
  output: {
    ...vendorPoOutput,
    outcome: z
      .enum(['adopted', 'released'])
      .describe('`adopted`: it was in QuickBooks, and is now recorded. `released`: it was not; push_vendor_po_to_quickbooks can send it.'),
    quickbooks_number: z.string().nullable(),
  },
  run: async (args, env) => {
    const loaded = await loadVendorPo(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    const { po, detail } = loaded;
    const link = detail.quickbooks;
    if (!link.linkId || (link.linkStatus !== 'needs_verification' && link.linkStatus !== 'pending')) {
      return { ok: false, message: `${po.po_number} has no unconfirmed QuickBooks attempt.` };
    }
    const result = await callBackend(env, `/api/quickbooks/${env.company.id}/vendor-po-links/${link.linkId}/verify`, verifyResponse, {
      body: {},
    });
    if (result.outcome === 'in_progress') {
      return { ok: false, message: `The QuickBooks attempt for ${po.po_number} is still running. Check it in a moment.` };
    }
    const after = await readBack(po.id);
    return {
      ok: true,
      data: { ...vendorPoRecord(after, env), outcome: result.outcome, quickbooks_number: result.doc_number ?? null },
    };
  },
});

// ------------------------------------------------------------------------------------------------
// Registration
// ------------------------------------------------------------------------------------------------

export function registerPurchasingWriteTools(server: ToolTarget): void {
  registerCompanyTool(server, createVendorPoTool);
  registerCompanyTool(server, updateVendorPoTool);
  registerCompanyTool(server, markVendorPoSentTool);
  registerCompanyTool(server, receiveVendorPoTool);
  registerCompanyTool(server, voidVendorPoReceiptTool);
  registerCompanyTool(server, closeVendorPoTool);
  registerCompanyTool(server, reopenVendorPoTool);
  registerCompanyTool(server, savePartVendorTool);
  registerCompanyTool(server, setPartCostFromVendorTool);
  registerCompanyTool(server, saveVendorRfqTool);
  registerCompanyTool(server, markVendorRfqSentTool);
  registerCompanyTool(server, recordVendorRfqResponseTool);
  registerCompanyTool(server, awardVendorRfqTool);
  registerCompanyTool(server, pushVendorPoToQuickBooksTool);
  registerCompanyTool(server, verifyVendorPoPushTool);
}

/** Exported for the catalogue test. */
export const PURCHASING_WRITE_TOOLS = [
  createVendorPoTool,
  updateVendorPoTool,
  markVendorPoSentTool,
  receiveVendorPoTool,
  voidVendorPoReceiptTool,
  closeVendorPoTool,
  reopenVendorPoTool,
  savePartVendorTool,
  setPartCostFromVendorTool,
  saveVendorRfqTool,
  markVendorRfqSentTool,
  recordVendorRfqResponseTool,
  awardVendorRfqTool,
  pushVendorPoToQuickBooksTool,
  verifyVendorPoPushTool,
];
