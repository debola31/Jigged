import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  applyCreditStatusChange,
  hasChanged,
  normalizeSnapshot,
} from '@/components/customers/customerFieldEditing';
import { resolveCountryName, resolveSubdivisionName, subdivisionsForCountry } from '@/lib/geo';
import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv } from '@/lib/mcp/defineTool';
import { findCustomer } from '@/lib/mcp/tools/customers';
import { addressOutput, companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';
import { isValidEmail, isValidPhone, isValidPostalCode } from '@/lib/validators';
import {
  EMPTY_CUSTOMER_ADDRESS,
  EMPTY_CUSTOMER_FORM,
  customerToFormData,
  type Customer,
  type CustomerAddress,
  type CustomerAddressFormData,
  type CustomerCreditStatus,
  type CustomerFormData,
  type CustomerWithRelations,
} from '@/types/customer';
import {
  EMPTY_CUSTOMER_CONTACT_FORM,
  customerContactToFormData,
  type CustomerContact,
  type CustomerContactFormData,
  type CustomerContactRole,
} from '@/types/customerContact';
import { PAYMENT_TERM_PRESETS } from '@/types/quote';
import { addCustomPaymentTerm, getCustomPaymentTerms } from '@/utils/companyAccess';
import { checkCustomerNameExists, createCustomer, updateCustomer } from '@/utils/customerAccess';
import {
  createCustomerAddress,
  getAddressesForCustomer,
  updateCustomerAddress,
} from '@/utils/customerAddressesAccess';
import {
  createCustomerContact,
  getContactsForCustomer,
  setBillingDefaultContact,
  updateCustomerContact,
} from '@/utils/customerContactsAccess';
import { escapeIlikePattern } from '@/utils/searchFilter';

/**
 * Customer write tools: what the New Customer form, the customer page's in-place fields, its
 * Contact modal and its Address form do, through the same access functions with the same
 * arguments. None of it is admin-only in the app: the Customers page, its form and its detail page
 * are open to every office user (Sidebar has no `adminOnly` on them; no AdminGuard).
 *
 * The contact and address helpers below are exported for vendorsWrites.ts, whose forms are the
 * same shape with one default flag instead of two.
 */

const CREDIT_STATUSES = ['open', 'hold'] as const satisfies readonly CustomerCreditStatus[];

const CONTACT_ROLES = [
  'buyer',
  'accounts_payable',
  'engineering',
  'quality',
  'shipping_receiving',
  'other',
] as const satisfies readonly CustomerContactRole[];

// ---------------------------------------------------------------------------
// Shared with vendorsWrites.ts: contact and address input, checked the way the forms check them
// ---------------------------------------------------------------------------

/** What a contact form validates, whichever party the contact belongs to. */
interface ContactText {
  name: string;
  role: string;
  role_label: string;
  email: string;
  phone: string;
  is_primary: boolean;
}

/**
 * The sentence the Contact modal would show, or null when it would save. Same rules as
 * CustomerContactModal / VendorContactModal / the create forms' Initial Contact: a name, a
 * role_label for `other`, and email and phone well-formed when given.
 */
export function contactProblem(form: ContactText): string | null {
  if (!form.name.trim()) return 'A contact needs a name.';
  if (form.role === 'other' && !form.role_label.trim()) return 'Give a role_label when the role is other.';
  if (form.email.trim() && !isValidEmail(form.email)) return `${form.email.trim()} is not a valid email address.`;
  if (form.phone.trim() && !isValidPhone(form.phone)) {
    return `${form.phone.trim()} is not a valid phone number: it needs 7 to 15 digits.`;
  }
  return null;
}

/** A contact as the access layer stores it (its formDataToInsert), for "did anything change?". */
function storedContact(form: ContactText) {
  return {
    name: form.name.trim(),
    role: form.role,
    role_label: form.role === 'other' ? form.role_label.trim() : '',
    email: form.email.trim(),
    phone: form.phone.trim(),
    is_primary: form.is_primary,
  };
}

export function contactChanged(a: ContactText, b: ContactText): boolean {
  const x = storedContact(a);
  const y = storedContact(b);
  return (Object.keys(x) as Array<keyof typeof x>).some((k) => x[k] !== y[k]);
}

/** The text a contact tool takes, besides its role and the party it belongs to. */
export interface ContactTextInput {
  name?: string;
  role_label?: string;
  email?: string;
  phone?: string;
  is_primary?: boolean;
}

/** `current` with whatever the call gave laid over it. */
export function withContactInput<F extends ContactText>(current: F, given: ContactTextInput & { role?: F['role'] }): F {
  return {
    ...current,
    name: given.name ?? current.name,
    role: given.role ?? current.role,
    role_label: given.role_label ?? current.role_label,
    email: given.email ?? current.email,
    phone: given.phone ?? current.phone,
    is_primary: given.is_primary ?? current.is_primary,
  };
}

export const contactTextInput = {
  name: z.string().optional().describe("The contact's name. Required when adding."),
  role_label: z.string().optional().describe('The role in words; required when role is `other`.'),
  email: z.string().optional().describe('Email address. An empty string clears it.'),
  phone: z.string().optional().describe('Phone number, 7 to 15 digits with any separators. An empty string clears it.'),
};

/** The address fields both parties' address forms share. */
export interface AddressText {
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  attention_to: string;
}

export type AddressTextInput = Partial<AddressText>;

export const addressTextInput = {
  address_line1: z.string().optional().describe('Street address. An empty string clears any address field.'),
  address_line2: z.string().optional().describe('Suite, unit, building.'),
  city: z.string().optional(),
  state: z
    .string()
    .optional()
    .describe('State or province. For the US and Canada a name or postal abbreviation (Ohio or OH), stored as the name.'),
  postal_code: z.string().optional().describe('ZIP or postal code, checked against the country for the US and Canada.'),
  country: z
    .string()
    .optional()
    .describe('Country name or two-letter code, stored as the name. A new address is in the USA unless given.'),
  attention_to: z.string().optional().describe('The ATTN line printed above the address on packing slips.'),
};

/**
 * `current` with the call's address fields laid over it, the way the address forms commit them:
 * the country and (for the US and Canada) the state resolved to the names the pickers store, an
 * unrecognised one refused as the pickers refuse it, and the postal code checked against the
 * country on every save, as the forms check it.
 */
export function settleAddress(
  current: AddressText,
  given: AddressTextInput,
): { ok: true; text: AddressText } | { ok: false; message: string } {
  const text: AddressText = {
    address_line1: given.address_line1?.trim() ?? current.address_line1,
    address_line2: given.address_line2?.trim() ?? current.address_line2,
    city: given.city?.trim() ?? current.city,
    state: current.state,
    postal_code: given.postal_code?.trim() ?? current.postal_code,
    country: current.country,
    attention_to: given.attention_to?.trim() ?? current.attention_to,
  };
  if (given.country !== undefined) {
    const raw = given.country.trim();
    const name = raw ? resolveCountryName(raw) : '';
    if (name === null) return { ok: false, message: `${raw} is not a country Jigged recognises. Give its name or two-letter code.` };
    text.country = name;
  }
  if (given.state !== undefined) {
    const raw = given.state.trim();
    if (raw && subdivisionsForCountry(text.country)) {
      const name = resolveSubdivisionName(text.country, raw);
      if (!name) {
        const country = resolveCountryName(text.country) ?? text.country;
        return { ok: false, message: `${raw} is not a state or province of ${country}.` };
      }
      text.state = name;
    } else {
      text.state = raw;
    }
  }
  if (!isValidPostalCode(text.country, text.postal_code)) {
    const country = resolveCountryName(text.country) ?? text.country;
    return { ok: false, message: `${text.postal_code} is not a valid postal code for ${country}.` };
  }
  return { ok: true, text };
}

/** Whether a new address says anything at all. */
export function addressHasContent(text: AddressText): boolean {
  return [text.address_line1, text.address_line2, text.city, text.state, text.postal_code, text.attention_to].some(
    (v) => v.trim() !== '',
  );
}

export const EMPTY_ADDRESS_MESSAGE = 'Give at least one line of the address.';

/** The address as the form holds it (CustomerAddressForm / vendorAddressToFormData). */
export function addressTextOf(a: {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  attention_to: string | null;
}): AddressText {
  return {
    address_line1: a.address_line1 ?? '',
    address_line2: a.address_line2 ?? '',
    city: a.city ?? '',
    state: a.state ?? '',
    postal_code: a.postal_code ?? '',
    country: a.country ?? 'USA',
    attention_to: a.attention_to ?? '',
  };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const creditStatusInput = z
  .enum(CREDIT_STATUSES)
  .describe('`hold` puts the customer on credit hold: a warning when someone quotes or ships to them, nothing blocked.');

const customerOutput = {
  customer_id: z.string(),
  name: z.string(),
  payment_terms: z.string().nullable().describe('Standing payment terms, copied onto new quotes.'),
  credit_status: z.enum(CREDIT_STATUSES),
  credit_hold_note: z.string().nullable(),
  url: urlOutput,
};

const HOLD_NOTE_NEEDS_HOLD = 'A credit hold note can only be set while the customer is on credit hold.';

export const createCustomerTool = defineCompanyTool({
  name: 'create_customer',
  title: 'Create a customer',
  description:
    'Creates a customer in a Jigged company, as the New Customer form does: its name, standing ' +
    'payment terms, credit status and, optionally, one primary contact. Addresses are added ' +
    'afterwards with save_customer_address. Reusing the name of an archived customer brings that ' +
    'customer back instead of making a second one: payment terms given here are applied, its ' +
    'credit status and history are kept. Returns the customer and a link to its page.',
  access: 'write',
  idempotent: false,
  input: {
    name: z.string().min(1).describe("The customer's company name. Unique in the company, ignoring case."),
    payment_terms: z.string().optional().describe('Standing payment terms, such as Net 30, copied onto new quotes.'),
    credit_status: creditStatusInput.optional().describe('Defaults to open.'),
    credit_hold_note: z.string().optional().describe('Why the customer is on hold. Only with credit_status `hold`.'),
    primary_contact: z
      .object({
        ...contactTextInput,
        name: z.string().min(1).describe("The contact's name."),
        role: z.enum(CONTACT_ROLES).optional().describe('Defaults to buyer.'),
      })
      .optional()
      .describe('One person at the customer, saved as its primary contact.'),
  },
  output: {
    ...customerOutput,
    primary_contact: z
      .object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable() })
      .nullable()
      .describe('The contact this call added: null when none was given, or when the customer was brought back.'),
    revived: z
      .boolean()
      .describe(
        'True when this brought back an archived customer of the same name rather than adding one. Its ' +
          'credit status and hold note stay as they were, and no contact is added; save_customer_contact adds one.',
      ),
  },
  run: async (args, env) => {
    const name = args.name.trim();
    if (!name) return { ok: false, message: 'A customer needs a name.' };
    const creditStatus = args.credit_status ?? 'open';
    const holdNote = args.credit_hold_note?.trim() ?? '';
    if (holdNote && creditStatus !== 'hold') return { ok: false, message: HOLD_NOTE_NEEDS_HOLD };

    let contact: CustomerContactFormData | undefined;
    if (args.primary_contact) {
      contact = withContactInput({ ...EMPTY_CUSTOMER_CONTACT_FORM, is_primary: true }, args.primary_contact);
      const problem = contactProblem(contact);
      if (problem) return { ok: false, message: problem };
    }

    // The form's own check: a LIVE customer of this name blocks; an archived one does not.
    if (await checkCustomerNameExists(env.company.id, name, undefined)) {
      return { ok: false, message: `A customer named ${name} already exists in ${env.company.name}.` };
    }
    const revived = await hasArchivedCustomerNamed(name, env);

    const formData: CustomerFormData = {
      ...EMPTY_CUSTOMER_FORM,
      name,
      default_payment_terms: args.payment_terms ?? '',
      credit_status: creditStatus,
      credit_hold_note: holdNote,
    };
    const customer = await createCustomer(env.company.id, formData, contact);
    // createCustomer returns from its revive path before inserting the initial contact (the form
    // drops it the same way), so a revived customer has no new contact to report.
    const added = revived ? undefined : contact;
    return {
      ok: true,
      data: {
        ...customerData(customer, env),
        primary_contact: added
          ? { name: added.name.trim(), email: added.email.trim() || null, phone: added.phone.trim() || null }
          : null,
        revived,
      },
    };
  },
});

/** createCustomer revives an archived namesake (customers_company_name_ci_unique ignores case). */
async function hasArchivedCustomerNamed(name: string, env: CompanyToolEnv): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from('customers')
    .select('id')
    .eq('company_id', env.company.id)
    .ilike('name', escapeIlikePattern(name))
    .not('deleted_at', 'is', null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

function customerData(customer: Customer, env: CompanyToolEnv) {
  return {
    customer_id: customer.id,
    name: customer.name,
    payment_terms: customer.default_payment_terms,
    credit_status: customer.credit_status,
    credit_hold_note: customer.credit_hold_note,
    url: companyLink(env, `/customers/${customer.id}`),
  };
}

/**
 * A standing payment term as the customer page's PaymentTermsPicker commits it. A term the company
 * already offers keeps the offered spelling ("net 30" is the existing "Net 30"), its saved terms
 * first and then the standard ones, which is the picker's own order after QuickBooks. QuickBooks'
 * terms come through the backend and are not consulted here. Anything else is new wording.
 */
async function pickPaymentTerm(raw: string, env: CompanyToolEnv): Promise<{ term: string; isNew: boolean }> {
  const term = raw.trim();
  if (!term) return { term: '', isNew: false };
  const saved = await getCustomPaymentTerms(env.company.id);
  const offered = [...saved, ...PAYMENT_TERM_PRESETS].find((t) => t.trim().toLowerCase() === term.toLowerCase());
  return offered ? { term: offered, isNew: false } : { term, isNew: true };
}

const CHANGEABLE = ['name', 'payment_terms', 'credit_status', 'credit_hold_note'] as const;

export const updateCustomerTool = defineCompanyTool({
  name: 'update_customer',
  title: 'Update a customer',
  description:
    "Changes a customer's own fields, as its page in Jigged does: its name, standing payment terms, " +
    'credit status and credit hold note. Lifting a hold (credit_status `open`) clears the hold ' +
    'note in the same change. Contacts and addresses have their own tools. Find the customer by ' +
    'id or by exact name. Returns the customer, what changed, and a link to its page.',
  access: 'write',
  idempotent: true,
  input: {
    customer_id: z.guid().optional().describe('The customer, by id.'),
    name: z.string().optional().describe("The customer's current exact name (case does not matter), when you have no id."),
    new_name: z.string().optional().describe('Rename the customer. Unique in the company, ignoring case.'),
    payment_terms: z
      .string()
      .optional()
      .describe('Standing payment terms, such as Net 30, copied onto new quotes. An empty string clears them.'),
    credit_status: creditStatusInput.optional(),
    credit_hold_note: z
      .string()
      .optional()
      .describe('Why the customer is on hold; only while the customer is (or is being put) on hold.'),
  },
  output: {
    ...customerOutput,
    changed: z.array(z.enum(CHANGEABLE)).describe('The fields this call changed.'),
  },
  run: async (args, env) => {
    const found = await findCustomer(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { customer } = found;
    // The page renders an archived customer read-only (customerFieldEditing's `readOnly`).
    if (customer.deleted_at !== null) {
      return {
        ok: false,
        message: `${customer.name} is archived, so it can't be edited. Creating a customer with the same name brings it back.`,
      };
    }

    const saved = customerToFormData(customer);
    let next: CustomerFormData = { ...saved };
    if (args.new_name !== undefined) next.name = args.new_name;
    const picked = args.payment_terms !== undefined ? await pickPaymentTerm(args.payment_terms, env) : null;
    if (picked) next.default_payment_terms = picked.term;
    if (args.credit_status !== undefined && args.credit_status !== next.credit_status) {
      next = applyCreditStatusChange(next, args.credit_status);
    }
    if (args.credit_hold_note !== undefined) {
      if (next.credit_status !== 'hold') return { ok: false, message: HOLD_NOTE_NEEDS_HOLD };
      next.credit_hold_note = args.credit_hold_note;
    }

    // The page's persist(): normalise, skip a no-op, require a name, check a new one is free.
    const normalized = normalizeSnapshot(next);
    if (!hasChanged(normalized, saved)) {
      return { ok: false, message: `Nothing to change: ${customer.name} already has those values.` };
    }
    if (!normalized.name) return { ok: false, message: 'A customer needs a name.' };
    if (normalized.name !== saved.name && (await checkCustomerNameExists(env.company.id, normalized.name, customer.id))) {
      return { ok: false, message: `A customer named ${normalized.name} already exists in ${env.company.name}.` };
    }

    const updated = await updateCustomer(customer.id, normalized);
    if (picked?.isNew) {
      // The picker saves new wording to the company's list for reuse, best-effort: a failure
      // there costs a suggestion, never the term on this customer, which is already saved.
      await addCustomPaymentTerm(env.company.id, picked.term).catch(() => undefined);
    }
    const after = customerToFormData(updated);
    const changed = CHANGEABLE.filter((field) => {
      const key = field === 'payment_terms' ? 'default_payment_terms' : field;
      return after[key] !== saved[key];
    });
    return { ok: true, data: { ...customerData(updated, env), changed } };
  },
});

// ---------------------------------------------------------------------------
// Customer contacts
// ---------------------------------------------------------------------------

const contactOutput = {
  contact_id: z.string(),
  customer_id: z.string(),
  customer_name: z.string(),
  name: z.string(),
  role: z.enum(CONTACT_ROLES),
  role_label: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  is_primary: z.boolean().describe('Who the shop calls about the work. At most one per customer.'),
  is_billing_default: z.boolean().describe('Invoices go to this person. At most one per customer.'),
  url: urlOutput,
};

type FoundCustomer = CustomerWithRelations;

/**
 * The customer a contact or address row belongs to, or null when there is no such row in this
 * company. The row read is RLS-scoped to every company the person is in; findCustomer then checks
 * it is this one.
 */
async function ownerOf(
  row: { customer_id: string } | null,
  env: CompanyToolEnv,
): Promise<FoundCustomer | null> {
  if (!row) return null;
  const found = await findCustomer({ customer_id: row.customer_id }, env);
  return 'customer' in found ? found.customer : null;
}

async function contactRow(id: string): Promise<{ customer_id: string } | null> {
  const { data, error } = await getSupabase().from('customer_contacts').select('customer_id').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function addressRow(id: string): Promise<{ customer_id: string } | null> {
  const { data, error } = await getSupabase().from('customer_addresses').select('customer_id').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export const saveCustomerContactTool = defineCompanyTool({
  name: 'save_customer_contact',
  title: 'Add or update a customer contact',
  description:
    "Adds a contact to a customer, or with contact_id changes one, as the customer page's Contact " +
    'dialog does. Making a contact primary, or the billing contact who receives invoices, takes ' +
    'that role from whoever held it, since a customer has at most one of each; setting ' +
    'is_billing_default false leaves the customer with no billing contact. Returns the contact ' +
    "and a link to the customer's page.",
  access: 'write',
  idempotent: false,
  input: {
    contact_id: z.guid().optional().describe('The contact to change. Leave out to add a new contact.'),
    customer_id: z.guid().optional().describe('The customer to add the contact to. Not needed with contact_id.'),
    customer_name: z
      .string()
      .optional()
      .describe("The customer's exact name (case does not matter), when adding and you have no customer_id."),
    ...contactTextInput,
    role: z.enum(CONTACT_ROLES).optional().describe('Their role at the customer. A new contact defaults to buyer.'),
    is_primary: z.boolean().optional().describe('The primary contact. A new contact defaults to false.'),
    is_billing_default: z.boolean().optional().describe('Invoices go to this contact. A new contact defaults to false.'),
  },
  output: contactOutput,
  run: async (args, env) => {
    let customer: FoundCustomer;
    let existing: CustomerContact | undefined;
    if (args.contact_id) {
      const owner = await ownerOf(await contactRow(args.contact_id), env);
      if (!owner) return { ok: false, message: `There is no customer contact with that id in ${env.company.name}.` };
      customer = owner;
      // The Contacts card lists live contacts only; a removed one is added again, not edited.
      existing = (await getContactsForCustomer(customer.id)).find((c) => c.id === args.contact_id);
      if (!existing) {
        return {
          ok: false,
          message: `That contact was removed from ${customer.name}. Add them again to bring them back.`,
        };
      }
    } else {
      if (!args.customer_id && !args.customer_name?.trim()) {
        return { ok: false, message: 'Give a contact_id to change a contact, or a customer_id or customer_name to add one.' };
      }
      const found = await findCustomer({ customer_id: args.customer_id, name: args.customer_name }, env);
      if ('message' in found) return { ok: false, message: found.message };
      customer = found.customer;
    }

    const form = withContactInput(existing ? customerContactToFormData(existing) : EMPTY_CUSTOMER_CONTACT_FORM, args);
    const problem = contactProblem(form);
    if (problem) return { ok: false, message: problem };

    let contactId: string;
    let written: CustomerContact;
    if (existing) {
      const fieldsChanged = contactChanged(form, customerContactToFormData(existing));
      const billingChanged =
        args.is_billing_default !== undefined && args.is_billing_default !== existing.is_billing_default;
      if (!fieldsChanged && !billingChanged) {
        return { ok: false, message: `Nothing to change: ${existing.name} already has those details.` };
      }
      written = fieldsChanged ? await updateCustomerContact(existing.id, form) : existing;
      contactId = existing.id;
      // The page's Invoices toggle: set names this contact, clearing the role takes it from them.
      if (billingChanged) await setBillingDefaultContact(customer.id, args.is_billing_default ? contactId : null);
    } else {
      written = await createCustomerContact(customer.id, form);
      contactId = written.id;
      if (args.is_billing_default) await setBillingDefaultContact(customer.id, contactId);
    }

    // Re-read: the primary and billing roles may have moved since the write returned.
    const contact = (await getContactsForCustomer(customer.id)).find((c) => c.id === contactId) ?? written;
    return {
      ok: true,
      data: {
        contact_id: contact.id,
        customer_id: customer.id,
        customer_name: customer.name,
        name: contact.name,
        role: contact.role,
        role_label: contact.role_label,
        email: contact.email,
        phone: contact.phone,
        is_primary: contact.is_primary,
        is_billing_default: contact.is_billing_default,
        url: companyLink(env, `/customers/${customer.id}`),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Customer addresses
// ---------------------------------------------------------------------------

export const saveCustomerAddressTool = defineCompanyTool({
  name: 'save_customer_address',
  title: 'Add or update a customer address',
  description:
    "Adds an address to a customer, or with address_id changes one, as the customer page's " +
    'Address form does. A customer has at most one default billing and one default shipping ' +
    'address; marking this one either takes the flag from the address that held it. A new ' +
    'address is the default for both unless told otherwise, as in the form. Returns the address ' +
    "and a link to the customer's page.",
  access: 'write',
  idempotent: false,
  input: {
    address_id: z.guid().optional().describe('The address to change. Leave out to add a new address.'),
    customer_id: z.guid().optional().describe('The customer to add the address to. Not needed with address_id.'),
    customer_name: z
      .string()
      .optional()
      .describe("The customer's exact name (case does not matter), when adding and you have no customer_id."),
    ...addressTextInput,
    default_billing: z.boolean().optional().describe('New quotes and jobs bill to this address. A new address defaults to true.'),
    default_shipping: z.boolean().optional().describe('New quotes and jobs ship to this address. A new address defaults to true.'),
  },
  output: {
    address_id: z.string(),
    customer_id: z.string(),
    customer_name: z.string(),
    address: addressOutput,
    default_billing: z.boolean(),
    default_shipping: z.boolean(),
    url: urlOutput,
  },
  run: async (args, env) => {
    let customer: FoundCustomer;
    let existing: CustomerAddress | undefined;
    if (args.address_id) {
      const owner = await ownerOf(await addressRow(args.address_id), env);
      existing = owner ? (await getAddressesForCustomer(owner.id)).find((a) => a.id === args.address_id) : undefined;
      if (!owner || !existing) return { ok: false, message: `There is no customer address with that id in ${env.company.name}.` };
      customer = owner;
    } else {
      if (!args.customer_id && !args.customer_name?.trim()) {
        return { ok: false, message: 'Give an address_id to change an address, or a customer_id or customer_name to add one.' };
      }
      const found = await findCustomer({ customer_id: args.customer_id, name: args.customer_name }, env);
      if ('message' in found) return { ok: false, message: found.message };
      customer = found.customer;
    }

    const current: CustomerAddressFormData = existing
      ? { ...addressTextOf(existing), default_billing: existing.default_billing, default_shipping: existing.default_shipping }
      : { ...EMPTY_CUSTOMER_ADDRESS };
    const settled = settleAddress(current, args);
    if (!settled.ok) return { ok: false, message: settled.message };
    const form: CustomerAddressFormData = {
      ...settled.text,
      default_billing: args.default_billing ?? current.default_billing,
      default_shipping: args.default_shipping ?? current.default_shipping,
    };

    let saved: CustomerAddress;
    if (existing) {
      const unchanged = (Object.keys(form) as Array<keyof CustomerAddressFormData>).every((k) => form[k] === current[k]);
      if (unchanged) return { ok: false, message: 'Nothing to change: the address already has those values.' };
      saved = await updateCustomerAddress(existing.id, customer.id, form);
    } else {
      if (!addressHasContent(form)) return { ok: false, message: EMPTY_ADDRESS_MESSAGE };
      saved = await createCustomerAddress(customer.id, form);
    }
    return {
      ok: true,
      data: {
        address_id: saved.id,
        customer_id: customer.id,
        customer_name: customer.name,
        address: {
          address_line1: saved.address_line1,
          address_line2: saved.address_line2,
          city: saved.city,
          state: saved.state,
          postal_code: saved.postal_code,
          country: saved.country,
          attention_to: saved.attention_to,
        },
        default_billing: saved.default_billing,
        default_shipping: saved.default_shipping,
        url: companyLink(env, `/customers/${customer.id}`),
      },
    };
  },
});

export function registerCustomerWriteTools(server: McpServer): void {
  registerCompanyTool(server, createCustomerTool);
  registerCompanyTool(server, updateCustomerTool);
  registerCompanyTool(server, saveCustomerContactTool);
  registerCompanyTool(server, saveCustomerAddressTool);
}

/** Exported for the catalogue test. */
export const CUSTOMER_WRITE_TOOLS = [createCustomerTool, updateCustomerTool, saveCustomerContactTool, saveCustomerAddressTool];
