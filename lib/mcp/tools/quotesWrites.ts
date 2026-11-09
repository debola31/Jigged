import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { readQuoteValidityDays } from '@/lib/companyDefaults';
import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolResult } from '@/lib/mcp/defineTool';
import { findQuote, getQuote, quoteDetail } from '@/lib/mcp/tools/quotes';
import { companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';
import type { CustomerWithRelations } from '@/types/customer';
import type { ComputedPartPricingTier } from '@/types/partPricing';
import {
  MAX_QUOTE_CUSTOMER_NOTE_LENGTH,
  defaultExpirationDate,
  isQuoteExpired,
  quoteToFormData,
  type QuoteFormData,
  type QuoteFormPartBlock,
  type QuoteLineItem,
  type QuoteLineOverride,
  type QuoteWithRelations,
} from '@/types/quote';
import { getCompany, getCompanyDefaultPaymentTerms } from '@/utils/companyAccess';
import {
  getCustomerWithRelations,
  pickBillingAddress,
  pickPaymentTerms,
  pickPrimaryContact,
  pickShippingAddress,
} from '@/utils/customerAccess';
import { getTiersWithComputedPrices } from '@/utils/partPricingTiersAccess';
import { resolveTier } from '@/utils/quotePricingResolver';
import {
  convertQuoteToJobs,
  createQuote,
  detectQuoteLineDrift,
  expireQuote,
  getQuoteConversionState,
  repriceQuoteDriftedLinesToCurrent,
  updateQuote,
} from '@/utils/quotesAccess';
import { escapeIlikePattern } from '@/utils/searchFilter';

/**
 * The quote write tools. Each one is a screen in the app, and calls the access function that
 * screen calls with the arguments it passes:
 *
 *   create_quote            New Quote (QuoteForm, mode "create")         createQuote
 *   update_quote            Edit on the quote page (QuoteForm, "edit")   updateQuote
 *   add_quote_line          the same form, a part or a quantity added    updateQuote
 *   update_quote_line       the same form, one row's qty / price / lead  updateQuote
 *   reprice_quote_line      "Update prices to current" on the quote page repriceQuoteDriftedLinesToCurrent
 *                           (or the form's per-line "Update to current price" for some lines)
 *   expire_quote            expireQuote (no button in the app today; the access function is the rule)
 *   convert_quote_to_jobs   the Convert to Job dialog                    convertQuoteToJobs
 *
 * The form's own checks are repeated here because the form, not updateQuote, enforces them: a
 * lead time and payment terms on every quote, one line per quantity of a part, and a price for
 * every line (the part's tier, or one typed). A typed price equal to the tier price is not a
 * custom price, exactly as the form decides it.
 *
 * Expired is not a lock; converted is. Opening Edit on an expired quote pre-fills a fresh expiry
 * date (the company's quote-validity window), so saving reactivates it — and so does any edit
 * made here. An archived quote is not changed at all.
 *
 * Quotes are not admin-only: every office user creates, edits and converts them in the app.
 */

/** A refusal decided in this file. `refusing` turns it into `{ ok: false, message }`. */
class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

async function refusing<T>(work: () => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, message: err.message };
    throw err;
  }
}

const quoteInput = {
  quote_id: z.guid().optional().describe('The quote, by id.'),
  quote_number: z.string().optional().describe('The quote, by its number (Q-0141), when you have no id.'),
};

const partInput = {
  part_id: z.guid().optional().describe('The part, by id.'),
  part_name: z.string().optional().describe('The part, by its part number, when you have no id.'),
};

const quantityInput = z.number().positive();
const priceInput = z.number().nonnegative();
const leadTimeInput = z.string().trim();
const noteInput = z.string().trim().max(MAX_QUOTE_CUSTOMER_NOTE_LENGTH);

/** The quote a write names, found the way get_quote finds it, and not archived. */
async function quoteToChange(
  args: { quote_id?: string; quote_number?: string },
  env: CompanyToolEnv,
): Promise<QuoteWithRelations> {
  const found = await findQuote(args, env);
  if ('message' in found) refuse(found.message);
  if (found.archived) refuse(`Quote ${found.quote.quote_number} is archived in Jigged, so it can't be changed.`);
  return found.quote;
}

/** Converting is the only hard lock on a quote (isQuoteEditable in utils/quotesAccess.ts). */
function refuseIfConverted(quote: QuoteWithRelations): void {
  if (quote.converted_at) {
    refuse(
      `Quote ${quote.quote_number} has been converted to a job and can no longer be edited. ` +
        'Change the job instead.',
    );
  }
}

const linesOf = (quote: QuoteWithRelations): QuoteLineItem[] =>
  [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence);

const partLabel = (li: QuoteLineItem): string => li.parts?.part_name ?? 'That part';

/**
 * What the Edit form starts from: the quote as it stands (quoteToFormData), with the quote page's
 * one pre-fill. An expired quote opens with a fresh expiry date from the company's validity
 * window, so saving reactivates it. An undated quote stays undated (quoteToFormData would date it).
 */
async function editForm(quote: QuoteWithRelations, env: CompanyToolEnv): Promise<QuoteFormData> {
  const form = quoteToFormData(quote);
  form.expiration_date = quote.expiration_date ?? '';
  if (isQuoteExpired(quote)) {
    form.expiration_date = defaultExpirationDate(readQuoteValidityDays(await getCompany(env.company.id)));
  }
  return form;
}

/** The checks QuoteForm makes before it lets an edit be saved (its `validationError`). */
function checkSavable(form: QuoteFormData, quoteNumber: string): void {
  if (!form.customer_id) refuse(`Quote ${quoteNumber} has no customer. Pick one on the quote in Jigged first.`);
  if (form.lead_time_text.trim() === '') {
    refuse(`Quote ${quoteNumber} has no lead time, and Jigged saves a quote only with one. Set its lead_time with update_quote.`);
  }
  if (form.payment_terms.trim() === '') {
    refuse(
      `Quote ${quoteNumber} has no payment terms, and Jigged saves a quote only with them. ` +
        'Set its payment_terms with update_quote.',
    );
  }
}

/** The Edit form's save: the whole form, and the drift lines the person chose to update. */
async function saveEdit(
  quote: QuoteWithRelations,
  form: QuoteFormData,
  env: CompanyToolEnv,
  acceptDriftLineItemIds: string[] = [],
): Promise<ToolResult<z.infer<z.ZodObject<typeof quoteDetail>>>> {
  checkSavable(form, quote.quote_number);
  await updateQuote(quote.id, form, { acceptDriftLineItemIds });
  return getQuote.run({ quote_id: quote.id }, env);
}

const cents = (n: number): number => Math.round(n * 100);

/**
 * The override a typed price becomes, as QuoteForm decides it: one only when the price differs
 * from what the part's tier ladder charges at this quantity (to the cent). With no price typed,
 * the tier must price the line, or the form won't save.
 */
function priceFor(
  typed: number | null,
  tiers: ComputedPartPricingTier[],
  quantity: number,
  partName: string,
): QuoteLineOverride | undefined {
  const resolved = resolveTier(tiers, quantity);
  if (typed === null) {
    if (!resolved) {
      refuse(
        `${partName} has no priced tiers, so Jigged has no price for it. Add tiers on the part page, ` +
          'or give a unit_price.',
      );
    }
    return undefined;
  }
  if (resolved && cents(typed) === cents(resolved.unit_price)) return undefined;
  return { unit_price: typed, markup_percent: null };
}

interface PartRef {
  id: string;
  part_name: string;
  deleted_at: string | null;
}

/**
 * The part a write names, in this company. A live part beats an archived one of the same name,
 * and exact case beats a case-only match (the rule get_part uses).
 */
async function findPart(args: { part_id?: string; part_name?: string }, env: CompanyToolEnv): Promise<PartRef> {
  if (args.part_id) {
    const { data, error } = await getSupabase()
      .from('parts')
      .select('id, part_name, deleted_at')
      .eq('company_id', env.company.id)
      .eq('id', args.part_id)
      .maybeSingle();
    if (error) throw error;
    if (!data) refuse(`There is no part with that id in ${env.company.name}.`);
    return data;
  }
  const name = args.part_name?.trim();
  if (!name) refuse('Give a part_id or a part_name.');
  const { data, error } = await getSupabase()
    .from('parts')
    .select('id, part_name, deleted_at')
    .eq('company_id', env.company.id)
    .ilike('part_name', escapeIlikePattern(name))
    .limit(20);
  if (error) throw error;
  const rank = (p: PartRef): number => (p.deleted_at === null ? 0 : 2) + (p.part_name === name ? 0 : 1);
  const best = (data ?? []).slice().sort((a, b) => rank(a) - rank(b))[0];
  if (!best) refuse(`There is no part named ${name} in ${env.company.name}.`);
  return best;
}

/** The customer a new quote is for. The form's picker lists live customers only. */
async function findCustomer(
  args: { customer_id?: string; customer_name?: string },
  env: CompanyToolEnv,
): Promise<CustomerWithRelations> {
  let customerId = args.customer_id;
  const name = args.customer_name?.trim();
  if (!customerId && name) {
    const { data, error } = await getSupabase()
      .from('customers')
      .select('id')
      .eq('company_id', env.company.id)
      .ilike('name', escapeIlikePattern(name))
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) refuse(`There is no customer named ${name} in ${env.company.name}.`);
    customerId = data.id;
  }
  if (!customerId) refuse('Give a customer_id or a customer_name.');
  const customer = await getCustomerWithRelations(customerId);
  if (!customer || customer.company_id !== env.company.id) {
    refuse(`There is no customer with that id in ${env.company.name}.`);
  }
  if (customer.deleted_at) refuse(`${customer.name} is archived in Jigged, so it can't be quoted.`);
  return customer;
}

function ownAddress(customer: CustomerWithRelations, addressId: string): string {
  if (!customer.addresses.some((a) => a.id === addressId)) {
    refuse(`That address isn't one of ${customer.name}'s.`);
  }
  return addressId;
}

/** A live contact of the customer; the contact a quote already names stays choosable. */
function ownContact(customer: CustomerWithRelations, contactId: string, current?: string): string {
  const contact = customer.customer_contacts.find((c) => c.id === contactId);
  if (!contact) refuse(`That contact isn't one of ${customer.name}'s.`);
  if (contact.deleted_at !== null && contact.id !== current) refuse(`${contact.name} is archived in Jigged.`);
  return contactId;
}

const warningsOutput = z
  .array(z.string())
  .describe('Things the app would warn about: a customer on credit hold, an expired quote.');

// ─── create_quote ──────────────────────────────────────────────────────────────────────────────

const newLineInput = z.object({
  ...partInput,
  quantity: quantityInput.describe('The quantity quoted. A part quoted at several quantities is a price-options quote.'),
  unit_price: priceInput
    .optional()
    .describe("A price per unit for this line. The part's tier price at this quantity when left out."),
  lead_time: leadTimeInput
    .optional()
    .describe("This part's own lead time, when it differs from the quote's. Every quantity of one part shares it."),
});

export const createQuoteTool = defineCompanyTool({
  name: 'create_quote',
  title: 'Create a quote',
  description:
    'Creates a quote for a customer, as New Quote in Jigged does. Each line is a part at a quantity, ' +
    "priced from the part's tiers unless a unit price is given. Payment terms default to the " +
    "customer's standing terms, then the shop default; billing and shipping address and contact " +
    "default to the customer's; the expiry date defaults to the company's quote-validity window. " +
    'Returns the new quote as get_quote does, with any warning the app would show.',
  access: 'write',
  idempotent: false,
  input: {
    customer_id: z.guid().optional().describe('The customer, by id.'),
    customer_name: z.string().optional().describe('The customer, by name, when you have no id.'),
    lines: z.array(newLineInput).min(1).max(100).describe('The parts quoted, one entry per part and quantity.'),
    lead_time: leadTimeInput.min(1).describe('The lead time printed on the quote, as free text ("2–3 weeks").'),
    payment_terms: z.string().trim().min(1).optional().describe('Payment terms ("Net 30").'),
    expiration_date: z.iso.date().optional().describe('The date the quote is valid until (YYYY-MM-DD).'),
    customer_note: noteInput.optional().describe('A note to the customer, printed on the quote below the total.'),
    contact_id: z.guid().optional().describe("One of the customer's contacts. Their primary contact when left out."),
    billing_address_id: z.guid().optional().describe("One of the customer's addresses to bill to."),
    shipping_address_id: z.guid().optional().describe("One of the customer's addresses to ship to."),
  },
  output: { ...quoteDetail, warnings: warningsOutput },
  run: (args, env) =>
    refusing(async () => {
      const customer = await findCustomer(args, env);

      // Group the lines by part, first seen first, as the form's part blocks do: one block per
      // part, one row per quantity, one lead time per block.
      const blocks = new Map<string, { part: PartRef; rows: Array<z.infer<typeof newLineInput>>; leadTime: string }>();
      for (const line of args.lines) {
        const part = await findPart(line, env);
        if (part.deleted_at) refuse(`${part.part_name} is archived in Jigged, so it can't be quoted.`);
        const block = blocks.get(part.id) ?? { part, rows: [], leadTime: '' };
        if (block.rows.some((r) => r.quantity === line.quantity)) {
          refuse(`${part.part_name} is listed twice at ${line.quantity}. Each quantity can appear only once per part.`);
        }
        const lead = line.lead_time ?? '';
        if (lead !== '' && block.leadTime !== '' && lead !== block.leadTime) {
          refuse(`${part.part_name} has two lead times. Every quantity of one part shares its lead time.`);
        }
        if (lead !== '') block.leadTime = lead;
        block.rows.push(line);
        blocks.set(part.id, block);
      }

      const parts: QuoteFormPartBlock[] = [];
      for (const { part, rows, leadTime } of blocks.values()) {
        const tiers = await getTiersWithComputedPrices(part.id);
        for (const row of rows) {
          const entry: QuoteFormPartBlock = { part_id: part.id, order_quantity: row.quantity };
          if (leadTime !== '') entry.lead_time_text = leadTime;
          const override = priceFor(row.unit_price ?? null, tiers, row.quantity, part.part_name);
          if (override) entry.override = override;
          parts.push(entry);
        }
      }

      // The customer's defaults, as picking them in the form fills them (handleCustomerChange).
      const defaultBilling = pickBillingAddress(customer)?.id ?? '';
      const defaultShipping = pickShippingAddress(customer)?.id ?? '';
      const billing = args.billing_address_id ? ownAddress(customer, args.billing_address_id) : defaultBilling;
      // "Shipping same as billing" is on when the customer's defaults agree; a billing pick then
      // carries the shipping address with it.
      const shipping = args.shipping_address_id
        ? ownAddress(customer, args.shipping_address_id)
        : defaultShipping === defaultBilling
          ? billing
          : defaultShipping;
      const contact = args.contact_id
        ? ownContact(customer, args.contact_id)
        : (pickPrimaryContact(customer.customer_contacts)?.id ?? '');
      const paymentTerms =
        args.payment_terms ??
        pickPaymentTerms(customer) ??
        // Best-effort, as in the form: without a shop default the terms start blank.
        (await getCompanyDefaultPaymentTerms(env.company.id).catch(() => null));
      if (!paymentTerms) {
        refuse(`${customer.name} has no standing payment terms and the shop has no default. Give payment_terms.`);
      }
      const expirationDate =
        args.expiration_date ?? defaultExpirationDate(readQuoteValidityDays(await getCompany(env.company.id)));

      const { quote } = await createQuote(env.company.id, {
        customer_id: customer.id,
        contact_id: contact,
        billing_address_id: billing,
        shipping_address_id: shipping,
        parts,
        lead_time_text: args.lead_time,
        payment_terms: paymentTerms,
        customer_note: args.customer_note ?? '',
        expiration_date: expirationDate,
      });

      const detail = await getQuote.run({ quote_id: quote.id }, env);
      if (!detail.ok) return detail;
      // Warns, never gates: the form shows the hold and lets the quote be written.
      const warnings =
        customer.credit_status === 'hold'
          ? [`${customer.name} is on credit hold.${customer.credit_hold_note ? ` ${customer.credit_hold_note}` : ''}`]
          : [];
      return { ok: true, data: { ...detail.data, warnings } };
    }),
});

// ─── update_quote ──────────────────────────────────────────────────────────────────────────────

export const updateQuoteTool = defineCompanyTool({
  name: 'update_quote',
  title: 'Update a quote',
  description:
    "Changes a quote's header as Edit on the quote page does: payment terms, lead time, expiry " +
    'date, the note to the customer, the contact, and the billing and shipping addresses. Lines ' +
    'are left as they are. A converted quote is locked. Editing an expired quote gives it a fresh ' +
    "expiry date from the company's quote-validity window, which reactivates it, unless an " +
    'expiration_date is given. Returns the quote as get_quote does.',
  access: 'write',
  idempotent: true,
  input: {
    ...quoteInput,
    payment_terms: z.string().trim().min(1).optional().describe('Payment terms ("Net 30").'),
    lead_time: leadTimeInput.min(1).optional().describe('The lead time printed on the quote, as free text.'),
    expiration_date: z.iso
      .date()
      .nullable()
      .optional()
      .describe('The date the quote is valid until (YYYY-MM-DD); null for no expiry.'),
    customer_note: noteInput.nullable().optional().describe('The note to the customer; null or empty removes it.'),
    contact_id: z.guid().nullable().optional().describe("One of the customer's contacts; null for none."),
    billing_address_id: z.guid().optional().describe("One of the customer's addresses to bill to."),
    shipping_address_id: z.guid().optional().describe("One of the customer's addresses to ship to."),
  },
  output: quoteDetail,
  run: (args, env) =>
    refusing(async () => {
      const quote = await quoteToChange(args, env);
      refuseIfConverted(quote);
      const fields = [
        args.payment_terms,
        args.lead_time,
        args.expiration_date,
        args.customer_note,
        args.contact_id,
        args.billing_address_id,
        args.shipping_address_id,
      ];
      if (fields.every((f) => f === undefined)) {
        refuse(
          'Nothing to change. Give payment_terms, lead_time, expiration_date, customer_note, contact_id, ' +
            'billing_address_id or shipping_address_id.',
        );
      }

      const form = await editForm(quote, env);
      if (args.payment_terms !== undefined) form.payment_terms = args.payment_terms;
      if (args.lead_time !== undefined) form.lead_time_text = args.lead_time;
      if (args.expiration_date !== undefined) form.expiration_date = args.expiration_date ?? '';
      if (args.customer_note !== undefined) form.customer_note = args.customer_note ?? '';

      if (args.contact_id !== undefined || args.billing_address_id || args.shipping_address_id) {
        if (!quote.customer_id) refuse(`Quote ${quote.quote_number} has no customer to take a contact or address from.`);
        const customer = await getCustomerWithRelations(quote.customer_id);
        if (!customer) refuse(`The customer on quote ${quote.quote_number} could not be found.`);
        if (args.contact_id !== undefined) {
          form.contact_id = args.contact_id === null ? '' : ownContact(customer, args.contact_id, quote.contact_id ?? undefined);
        }
        if (args.billing_address_id) {
          // The form's "shipping same as billing" is on when the two are the same address; a new
          // billing address then carries the shipping address with it.
          const sameAsBilling = form.shipping_address_id === form.billing_address_id;
          form.billing_address_id = ownAddress(customer, args.billing_address_id);
          if (sameAsBilling && !args.shipping_address_id) form.shipping_address_id = form.billing_address_id;
        }
        if (args.shipping_address_id) form.shipping_address_id = ownAddress(customer, args.shipping_address_id);
      }

      return saveEdit(quote, form, env);
    }),
});

// ─── add_quote_line ────────────────────────────────────────────────────────────────────────────

export const addQuoteLine = defineCompanyTool({
  name: 'add_quote_line',
  title: 'Add a line to a quote',
  description:
    'Adds a part at a quantity to a quote, as the quote edit form does: a new part, or another ' +
    "quantity of a part already on it (a price-options quote). Priced from the part's tiers " +
    'unless a unit price is given. A lead time given applies to every quantity of that part. A ' +
    'converted quote is locked; an expired one is reactivated with a fresh expiry date, as any ' +
    'edit is. Returns the quote as get_quote does.',
  access: 'write',
  idempotent: false,
  input: {
    ...quoteInput,
    ...partInput,
    quantity: quantityInput.describe('The quantity to quote.'),
    unit_price: priceInput.optional().describe("A price per unit. The part's tier price at this quantity when left out."),
    lead_time: leadTimeInput
      .optional()
      .describe("This part's own lead time on the quote, when it differs from the quote's."),
  },
  output: quoteDetail,
  run: (args, env) =>
    refusing(async () => {
      const quote = await quoteToChange(args, env);
      refuseIfConverted(quote);
      const part = await findPart(args, env);
      const siblings = linesOf(quote).filter((li) => li.part_id === part.id);
      if (part.deleted_at && siblings.length === 0) refuse(`${part.part_name} is archived in Jigged, so it can't be quoted.`);
      if (siblings.some((li) => li.quantity === args.quantity)) {
        refuse(
          `${part.part_name} is already quoted at ${args.quantity} on quote ${quote.quote_number}. ` +
            'Each quantity can appear only once per part.',
        );
      }

      const tiers = await getTiersWithComputedPrices(part.id);
      const override = priceFor(args.unit_price ?? null, tiers, args.quantity, part.part_name);

      const form = await editForm(quote, env);
      // The part's block carries one lead time for all its rows: the one given, or the one its
      // existing lines already have.
      const blockLead =
        args.lead_time ?? siblings.map((li) => li.lead_time_text ?? '').find((t) => t.trim() !== '') ?? '';
      if (args.lead_time !== undefined) {
        for (const entry of form.parts) if (entry.part_id === part.id) entry.lead_time_text = args.lead_time;
      }
      const entry: QuoteFormPartBlock = { part_id: part.id, order_quantity: args.quantity };
      if (blockLead.trim() !== '') entry.lead_time_text = blockLead;
      if (override) entry.override = override;
      form.parts.push(entry);

      return saveEdit(quote, form, env);
    }),
});

// ─── update_quote_line ─────────────────────────────────────────────────────────────────────────

function lineToChange(
  quote: QuoteWithRelations,
  args: { line_item_id?: string; part_id?: string; part_name?: string; quoted_quantity?: number },
): QuoteLineItem {
  const lines = linesOf(quote);
  if (args.line_item_id) {
    const line = lines.find((li) => li.id === args.line_item_id);
    if (!line) refuse(`Quote ${quote.quote_number} has no line with that id.`);
    return line;
  }
  const name = args.part_name?.trim().toLowerCase();
  if (!args.part_id && !name) refuse('Give a line_item_id, or the part (part_id or part_name) the line quotes.');
  const forPart = lines.filter((li) =>
    args.part_id ? li.part_id === args.part_id : (li.parts?.part_name ?? '').toLowerCase() === name,
  );
  const label = args.part_name?.trim() || 'That part';
  if (forPart.length === 0) refuse(`${label} isn't on quote ${quote.quote_number}.`);
  const quantities = forPart.map((li) => li.quantity).join(', ');
  if (args.quoted_quantity !== undefined) {
    const line = forPart.find((li) => li.quantity === args.quoted_quantity);
    if (!line) refuse(`${partLabel(forPart[0])} isn't quoted at ${args.quoted_quantity}; it is quoted at ${quantities}.`);
    return line;
  }
  if (forPart.length > 1) {
    refuse(
      `${partLabel(forPart[0])} is quoted at ${quantities} on quote ${quote.quote_number}. ` +
        'Give quoted_quantity or line_item_id to say which line.',
    );
  }
  return forPart[0];
}

export const updateQuoteLine = defineCompanyTool({
  name: 'update_quote_line',
  title: 'Change a quote line',
  description:
    "Changes one line of a quote as the quote edit form does: its quantity (repriced from the " +
    "line's own price breaks as quoted), its unit price (null returns it to the tier price), or " +
    "its part's lead time, which every quantity of that part shares. Name the line by " +
    'line_item_id, or by its part and the quantity quoted. A converted quote is locked; an expired ' +
    'one is reactivated with a fresh expiry date, as any edit is. Returns the quote as get_quote does.',
  access: 'write',
  idempotent: true,
  input: {
    ...quoteInput,
    line_item_id: z.guid().optional().describe('The line, by id (get_quote lists them).'),
    ...partInput,
    quoted_quantity: quantityInput
      .optional()
      .describe('The quantity the line quotes now, to pick it when its part is quoted at several.'),
    quantity: quantityInput.optional().describe('The new quantity.'),
    unit_price: priceInput
      .nullable()
      .optional()
      .describe("A new price per unit; null to drop a custom price and return to the tier price."),
    lead_time: leadTimeInput
      .nullable()
      .optional()
      .describe("The part's own lead time on this quote; null or empty to use the quote's."),
  },
  output: quoteDetail,
  run: (args, env) =>
    refusing(async () => {
      const quote = await quoteToChange(args, env);
      refuseIfConverted(quote);
      const line = lineToChange(quote, args);
      if (args.quantity === undefined && args.unit_price === undefined && args.lead_time === undefined) {
        refuse('Nothing to change. Give quantity, unit_price or lead_time.');
      }
      const quantity = args.quantity ?? line.quantity;
      const siblings = linesOf(quote).filter((li) => li.part_id === line.part_id && li.id !== line.id);
      if (siblings.some((li) => li.quantity === quantity)) {
        refuse(`${partLabel(line)} is already quoted at ${quantity}. Each quantity can appear only once per part.`);
      }

      const form = await editForm(quote, env);
      const entry = form.parts.find((p) => p.line_item_id === line.id);
      if (!entry) refuse(`Quote ${quote.quote_number} has no line with that id.`);
      entry.order_quantity = quantity;

      // The row's price as the form holds it: what was typed now, else the custom price the line
      // already carries; null once cleared. Whether it is "custom" is decided against the tier at
      // the (new) quantity, as the form does.
      const typed =
        args.unit_price === null ? null : (args.unit_price ?? (line.is_quote_override ? line.unit_price : null));
      delete entry.override;
      if (typed !== null) {
        const tiers = await getTiersWithComputedPrices(line.part_id);
        const override = priceFor(typed, tiers, quantity, partLabel(line));
        if (override) entry.override = override;
      }

      if (args.lead_time !== undefined) {
        for (const p of form.parts) if (p.part_id === line.part_id) p.lead_time_text = args.lead_time ?? '';
      }

      return saveEdit(quote, form, env);
    }),
});

// ─── reprice_quote_line ────────────────────────────────────────────────────────────────────────

export const repriceQuoteLine = defineCompanyTool({
  name: 'reprice_quote_line',
  title: 'Update quote prices to current',
  description:
    "Moves quote lines whose part's tier pricing changed since the quote was written to the " +
    'current tier price, rewriting their price snapshot. With no line_item_ids every drifted line ' +
    'moves, as "Update prices to current" on the quote page does; with line_item_ids only those ' +
    'move, as the edit form\'s per-line "Update to current price" does (an expired quote edited ' +
    'that way is reactivated with a fresh expiry date). Lines with a custom price are left alone. ' +
    'A converted quote is locked. Returns the quote as get_quote does, with the lines repriced.',
  access: 'write',
  idempotent: true,
  input: {
    ...quoteInput,
    line_item_ids: z
      .array(z.guid())
      .min(1)
      .max(100)
      .optional()
      .describe('Only these lines (get_quote lists them). Every drifted line when left out.'),
  },
  output: { ...quoteDetail, repriced_line_item_ids: z.array(z.string()).describe('The lines whose price moved.') },
  run: (args, env) =>
    refusing(async () => {
      const quote = await quoteToChange(args, env);
      if (quote.converted_at) {
        refuse(
          `Quote ${quote.quote_number} is converted and can no longer be repriced. Edit prices on the job instead.`,
        );
      }
      const drifted = new Set((await detectQuoteLineDrift(quote.id)).map((d) => d.line_item_id));
      const lines = linesOf(quote);

      let repriced: string[];
      const wanted = args.line_item_ids ? [...new Set(args.line_item_ids)] : null;
      if (wanted) {
        for (const id of wanted) {
          const line = lines.find((li) => li.id === id);
          if (!line) refuse(`Quote ${quote.quote_number} has no line with the id ${id}.`);
          if (line.is_quote_override) {
            refuse(`${partLabel(line)} at ${line.quantity} has a custom price, which repricing leaves alone.`);
          }
          if (!drifted.has(id)) {
            refuse(`${partLabel(line)} at ${line.quantity} already has its part's current tier price.`);
          }
        }
      } else if (drifted.size === 0) {
        refuse(`No line on quote ${quote.quote_number} has a price change since it was written.`);
      }

      if (!wanted || wanted.length === drifted.size) {
        ({ repricedLineItemIds: repriced } = await repriceQuoteDriftedLinesToCurrent(quote.id, env.company.id));
      } else {
        const form = await editForm(quote, env);
        checkSavable(form, quote.quote_number);
        await updateQuote(quote.id, form, { acceptDriftLineItemIds: wanted });
        repriced = wanted;
      }

      const detail = await getQuote.run({ quote_id: quote.id }, env);
      if (!detail.ok) return detail;
      return { ok: true, data: { ...detail.data, repriced_line_item_ids: repriced } };
    }),
});

// ─── expire_quote ──────────────────────────────────────────────────────────────────────────────

export const expireQuoteTool = defineCompanyTool({
  name: 'expire_quote',
  title: 'Expire a quote',
  description:
    'Marks an open quote as expired before its date, so it no longer counts as open. A converted ' +
    'quote cannot be expired. Editing the quote later with a future expiry date reactivates it. ' +
    'Returns the quote as get_quote does.',
  access: 'write',
  idempotent: true,
  input: quoteInput,
  output: quoteDetail,
  run: (args, env) =>
    refusing(async () => {
      const quote = await quoteToChange(args, env);
      if (quote.converted_at) refuse(`Quote ${quote.quote_number} was converted to a job, so it can't be expired.`);
      if (isQuoteExpired(quote)) {
        refuse(
          `Quote ${quote.quote_number} has already expired${quote.expiration_date ? ` (${quote.expiration_date})` : ''}.`,
        );
      }
      await expireQuote(quote.id, env.company.id);
      return getQuote.run({ quote_id: quote.id }, env);
    }),
});

// ─── convert_quote_to_jobs ─────────────────────────────────────────────────────────────────────

/**
 * The earliest calendar date anywhere right now. The dialog refuses a due date before the
 * person's own today; the server doesn't know their time zone, so it refuses only a date that is
 * past everywhere rather than turn away today's date in a shop UTC has already left behind.
 */
function earliestToday(): string {
  return new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const convertPartInput = z.object({
  ...partInput,
  quantity: quantityInput
    .optional()
    .describe(
      'The quantity the customer ordered. Defaults to the quoted quantity for a part quoted at one ' +
        'quantity; needed for a part quoted at several.',
    ),
  due_date: z.iso.date().optional().describe("This part's job due date (YYYY-MM-DD). The pass's due_date when left out."),
  use_tier_price: z
    .boolean()
    .optional()
    .describe(
      'For a part quoted at one quantity and ordered at a quantity in another price break: price ' +
        'the job at that break instead of keeping the quoted price. A part quoted at several ' +
        'quantities is priced at the break for the ordered quantity regardless.',
    ),
});

const convertedJobOutput = z.object({
  job_id: z.string(),
  job_number: z.string(),
  part_name: z.string(),
  quantity: z.number(),
  unit_price: z.number().nullable(),
  due_date: z.string(),
  customer_po_number: z.string(),
  url: urlOutput,
});

export const convertQuoteToJobsTool = defineCompanyTool({
  name: 'convert_quote_to_jobs',
  title: 'Convert a quote to jobs',
  description:
    'Turns parts of a quote into jobs under a customer PO, as the Convert to Job dialog does: ' +
    'each part becomes its own job (J-0141, J-0141-2, …) with its routing copied in, at the ' +
    'ordered quantity and due date. Parts already on a job are not converted again; the rest can ' +
    'be converted in later passes under other POs. Converting locks the quote from edits. Returns ' +
    'the jobs created, any part that failed and why, and the parts still not on a job.',
  access: 'write',
  destructive: true,
  idempotent: false,
  input: {
    ...quoteInput,
    customer_po_number: z.string().trim().min(1).describe("The customer's PO number that authorizes these jobs."),
    due_date: z.iso.date().optional().describe('The due date for every job in this pass (YYYY-MM-DD), unless a part gives its own.'),
    parts: z
      .array(convertPartInput)
      .min(1)
      .max(100)
      .optional()
      .describe('The parts this PO covers, one job each. Every part not yet on a job when left out.'),
  },
  output: {
    quote_id: z.string(),
    quote_number: z.string(),
    jobs: z.array(convertedJobOutput).describe('The jobs this pass created.'),
    failures: z
      .array(z.object({ part_name: z.string(), message: z.string(), retryable: z.boolean() }))
      .describe('Parts that did not become a job, and why. A retryable one is still on the quote to convert again.'),
    parts_not_on_a_job: z.array(z.string()).describe('Parts on the quote still not on any job.'),
    warnings: warningsOutput,
    url: urlOutput,
  },
  run: (args, env) =>
    refusing(async () => {
      const quote = await quoteToChange(args, env);
      const n = quote.quote_number;
      const lines = linesOf(quote);
      if (lines.length === 0) refuse(`Quote ${n} has no line items. Add at least one before converting.`);

      // The dialog's view: lines grouped by part, and a part is done once any of its lines is on a
      // live job (a price-options part converts one of its quantities, never two).
      const conversions = await getQuoteConversionState(quote.id);
      const convertedByLine = new Map(conversions.map((c) => [c.line_item_id, c]));
      const groups = new Map<string, { partId: string; name: string; items: QuoteLineItem[] }>();
      for (const li of lines) {
        const group = groups.get(li.part_id) ?? { partId: li.part_id, name: partLabel(li), items: [] };
        group.items.push(li);
        groups.set(li.part_id, group);
      }
      const jobOf = (g: { items: QuoteLineItem[] }) =>
        g.items.map((li) => convertedByLine.get(li.id)).find((c) => c !== undefined);
      const open = [...groups.values()].filter((g) => !jobOf(g));
      if (open.length === 0) refuse(`Every part on quote ${n} is already on a job.`);

      // Left out, the pass covers every open part, as the dialog's all-checked default does.
      type Choice = { group: (typeof open)[number]; request: z.infer<typeof convertPartInput> };
      const chosen: Choice[] = args.parts ? [] : open.map((group) => ({ group, request: {} }));
      for (const request of args.parts ?? []) {
        const name = request.part_name?.trim().toLowerCase();
        if (!request.part_id && !name) refuse('Give a part_id or a part_name for each part to convert.');
        const group = [...groups.values()].find((g) =>
          request.part_id ? g.partId === request.part_id : g.name.toLowerCase() === name,
        );
        if (!group) refuse(`${request.part_name?.trim() || 'That part'} isn't on quote ${n}.`);
        const job = jobOf(group);
        if (job) {
          refuse(
            `${group.name} on quote ${n} is already on job ${job.job_number}` +
              `${job.customer_po_number ? ` (PO ${job.customer_po_number})` : ''}.`,
          );
        }
        if (chosen.some((c) => c.group.partId === group.partId)) refuse(`${group.name} is listed twice.`);
        chosen.push({ group, request });
      }

      const earliest = earliestToday();
      const plans = chosen.map(({ group, request }) => {
        const byQuantity = [...group.items].sort((a, b) => a.quantity - b.quantity);
        const priceOptions = group.items.length > 1;
        if (priceOptions && request.quantity === undefined) {
          refuse(
            `${group.name} is quoted at ${byQuantity.map((li) => li.quantity).join(', ')} on quote ${n}. ` +
              'Give the quantity the customer ordered.',
          );
        }
        const quantity = request.quantity ?? byQuantity[0].quantity;
        // The dialog's base line: the quoted quantity the order matches, else the lowest.
        const base = byQuantity.find((li) => li.quantity === quantity) ?? byQuantity[0];
        const dueDate = request.due_date ?? args.due_date;
        if (!dueDate) refuse(`Give a due_date: the job for ${group.name} needs one.`);
        if (dueDate < earliest) refuse(`The due date for ${group.name}, ${dueDate}, is in the past.`);
        return {
          group,
          base,
          quantity,
          // A price-options part prices at the tier for the ordered quantity: that is what its
          // quoted breaks are. A firm part keeps its price unless asked.
          useTierPrice: priceOptions ? true : Boolean(request.use_tier_price),
          dueDate,
        };
      });

      const result = await convertQuoteToJobs(quote.id, {
        dueDate: args.due_date ?? plans[0].dueDate,
        customerPoNumber: args.customer_po_number,
        selectedLineItemIds: plans.map((p) => p.base.id),
        lineOverrides: Object.fromEntries(
          plans.map((p) => [p.base.id, { quantity: p.quantity, useTierPrice: p.useTierPrice, dueDate: p.dueDate }]),
        ),
      });

      const nameOf = (partId: string): string => groups.get(partId)?.name ?? 'Part';
      const failures = result.failures.map((f) => ({
        part_name: nameOf(f.part_id),
        message: f.message,
        retryable: f.retryable,
      }));
      if (result.jobs.length === 0) {
        refuse(`No job was created from quote ${n}. ${failures.map((f) => `${f.part_name}: ${f.message}`).join(' ')}`);
      }

      const onAJob = new Set([
        ...[...groups.values()].filter((g) => jobOf(g)).map((g) => g.partId),
        ...result.jobs.map((j) => j.part_id),
      ]);
      const warnings = isQuoteExpired(quote)
        ? [`Quote ${n} expired${quote.expiration_date ? ` on ${quote.expiration_date}` : ''}; its prices may no longer be accurate.`]
        : [];
      return {
        ok: true,
        data: {
          quote_id: quote.id,
          quote_number: n,
          jobs: result.jobs.map((j) => ({
            job_id: j.job_id,
            job_number: j.job_number,
            part_name: nameOf(j.part_id),
            quantity: j.quantity,
            unit_price: j.unit_price,
            due_date: j.due_date,
            customer_po_number: args.customer_po_number,
            url: companyLink(env, `/jobs/${j.job_id}`),
          })),
          failures,
          parts_not_on_a_job: [...groups.values()].filter((g) => !onAJob.has(g.partId)).map((g) => g.name),
          warnings,
          url: companyLink(env, `/quotes/${quote.id}`),
        },
      };
    }),
});

export function registerQuoteWriteTools(server: McpServer): void {
  registerCompanyTool(server, createQuoteTool);
  registerCompanyTool(server, updateQuoteTool);
  registerCompanyTool(server, addQuoteLine);
  registerCompanyTool(server, updateQuoteLine);
  registerCompanyTool(server, repriceQuoteLine);
  registerCompanyTool(server, expireQuoteTool);
  registerCompanyTool(server, convertQuoteToJobsTool);
}

/** Exported for the catalogue test. */
export const QUOTE_WRITE_TOOLS = [
  createQuoteTool,
  updateQuoteTool,
  addQuoteLine,
  updateQuoteLine,
  repriceQuoteLine,
  expireQuoteTool,
  convertQuoteToJobsTool,
];
