import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv } from '@/lib/mcp/defineTool';
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
import type { CustomerCreditStatus, CustomerWithRelations } from '@/types/customer';
import type { BillToParty } from '@/types/customerCarrierAccount';
import type { CustomerContactRole } from '@/types/customerContact';
import {
  getAllCustomers,
  getCustomerWithRelations,
  pickBillingAddress,
  pickShippingAddress,
} from '@/utils/customerAccess';
import { getAddressesForCustomer } from '@/utils/customerAddressesAccess';
import { getCarrierAccountsForCustomer } from '@/utils/customerCarrierAccountsAccess';
import { getContactsForCustomer } from '@/utils/customerContactsAccess';
import { escapeIlikePattern } from '@/utils/searchFilter';

const CREDIT_STATUSES = ['open', 'hold'] as const satisfies readonly CustomerCreditStatus[];

const CONTACT_ROLES = [
  'buyer',
  'accounts_payable',
  'engineering',
  'quality',
  'shipping_receiving',
  'other',
] as const satisfies readonly CustomerContactRole[];

const BILL_TO_PARTIES = ['recipient', 'third_party'] as const satisfies readonly BillToParty[];

const creditStatusOutput = z
  .enum(CREDIT_STATUSES)
  .describe('`hold`: the office put this customer on credit hold. It warns; nothing is blocked.');

const contactOutput = z.object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable() });

const customerSummary = z.object({
  customer_id: z.string(),
  name: z.string(),
  payment_terms: z.string().nullable().describe('The customer\'s standing payment terms, copied onto new quotes.'),
  credit_status: creditStatusOutput,
  primary_contact: contactOutput.nullable(),
  url: urlOutput,
});

type CustomerSummary = z.infer<typeof customerSummary>;

function summarise(customer: CustomerWithRelations, env: CompanyToolEnv): CustomerSummary {
  const primary = customer.primary_contact;
  return {
    customer_id: customer.id,
    name: customer.name,
    payment_terms: customer.default_payment_terms,
    credit_status: customer.credit_status,
    primary_contact: primary ? { name: primary.name, email: primary.email, phone: primary.phone } : null,
    url: companyLink(env, `/customers/${customer.id}`),
  };
}

export const listCustomers = defineCompanyTool({
  name: 'list_customers',
  title: 'List customers',
  description:
    'Lists customers in a Jigged company, by name. Search matches part of the name. Each ' +
    'customer has its standing payment terms, credit status and primary contact.',
  access: 'read',
  input: {
    search: z.string().optional().describe('Part of the customer\'s name.'),
    ...pageInput,
  },
  output: { customers: z.array(customerSummary), ...pageOutput },
  run: async (args, env) => {
    // getAllCustomers leaves archived customers out and sorts by name.
    const customers = await getAllCustomers(env.company.id, args.search ?? '', 'name', 'asc');
    const page = paginate(customers, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    return {
      ok: true,
      data: {
        customers: page.items.map((c) => summarise(c, env)),
        total: page.total,
        next_cursor: page.next_cursor,
      },
    };
  },
});

const customerAddressOutput = addressOutput.extend({
  default_billing: z.boolean(),
  default_shipping: z.boolean(),
});

const customerDetail = {
  customer_id: z.string(),
  name: z.string(),
  archived: z.boolean().describe('Deleted in Jigged, so it no longer appears in lists.'),
  payment_terms: z.string().nullable().describe('Standing payment terms, copied onto new quotes.'),
  credit_status: creditStatusOutput,
  credit_hold_note: z.string().nullable().describe('Why the customer is (or was last) on hold.'),
  quotes_count: z.number(),
  jobs_count: z.number(),
  contacts: z.array(
    z.object({
      contact_id: z.string().describe('What save_customer_contact takes to change this contact.'),
      name: z.string(),
      role: z.enum(CONTACT_ROLES),
      role_label: z.string().nullable().describe('The role in words, when role is `other`.'),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      is_primary: z.boolean(),
      is_billing_default: z.boolean().describe('Invoices go to this person.'),
    }),
  ),
  addresses: z.array(
    customerAddressOutput.extend({
      address_id: z.string().describe('What save_customer_address takes to change this address.'),
    }),
  ),
  bill_to: addressOutput.nullable().describe('Where new quotes and jobs bill to, or null when that is ambiguous.'),
  ship_to: addressOutput
    .nullable()
    .describe('Where new quotes and jobs ship to: the default shipping address, else the billing one.'),
  carrier_accounts: z.array(
    z.object({
      carrier: z.string(),
      bill_to_party: z.enum(BILL_TO_PARTIES).describe('`recipient`: bill the receiver; `third_party`: bill a third party.'),
      account_number: z.string().nullable(),
      account_postal_code: z.string().nullable(),
      account_country_code: z.string(),
      notes: z.string().nullable(),
    }),
  ),
  created_at: z.string().nullable(),
  url: urlOutput,
};

const NAME_THE_CUSTOMER = 'Give a customer_id or a name.';

/**
 * The customer a tool names by id or by name, or a sentence saying it isn't there. A by-id read:
 * an archived customer is found and says so. Names are unique per company ignoring case and
 * surrounding space (customers_company_name_ci_unique), archived ones included, so a name finds
 * at most one.
 */
export async function findCustomer(
  args: { customer_id?: string; name?: string },
  env: CompanyToolEnv,
): Promise<{ customer: CustomerWithRelations } | { message: string }> {
  let customerId = args.customer_id;
  const name = args.name?.trim();
  if (!customerId && name) {
    const { data, error } = await getSupabase()
      .from('customers')
      .select('id')
      .eq('company_id', env.company.id)
      .ilike('name', escapeIlikePattern(name))
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { message: `There is no customer named ${name} in ${env.company.name}.` };
    customerId = data.id;
  }
  if (!customerId) return { message: NAME_THE_CUSTOMER };
  const customer = await getCustomerWithRelations(customerId);
  // The read isn't company-filtered (RLS scopes it to every company the person is in), so a
  // customer of another of their companies is checked out here.
  if (!customer || customer.company_id !== env.company.id) {
    return { message: `There is no customer with that id in ${env.company.name}.` };
  }
  return { customer };
}

export const getCustomer = defineCompanyTool({
  name: 'get_customer',
  title: 'Get a customer',
  description:
    'Returns one customer in full: standing payment terms, credit status and hold note, how many ' +
    'quotes and jobs it has, its contacts, its addresses with the default bill-to and ship-to, ' +
    'and its own carrier accounts for freight. Find a customer by id or by exact name.',
  access: 'read',
  input: {
    customer_id: z.guid().optional().describe('The customer, by id.'),
    name: z.string().optional().describe('The customer\'s exact name (case does not matter), when you have no id.'),
  },
  output: customerDetail,
  run: async (args, env) => {
    const found = await findCustomer(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { customer } = found;
    const [contacts, addresses, carrierAccounts] = await Promise.all([
      getContactsForCustomer(customer.id),
      getAddressesForCustomer(customer.id),
      getCarrierAccountsForCustomer(customer.id),
    ]);
    return {
      ok: true,
      data: {
        customer_id: customer.id,
        name: customer.name,
        archived: customer.deleted_at !== null,
        payment_terms: customer.default_payment_terms,
        credit_status: customer.credit_status,
        credit_hold_note: customer.credit_hold_note,
        quotes_count: customer.quotes_count,
        jobs_count: customer.jobs_count,
        contacts: contacts.map((c) => ({
          contact_id: c.id,
          name: c.name,
          role: c.role,
          role_label: c.role_label,
          email: c.email,
          phone: c.phone,
          is_primary: c.is_primary,
          is_billing_default: c.is_billing_default,
        })),
        addresses: addresses.map((a) => ({
          address_id: a.id,
          address_line1: a.address_line1,
          address_line2: a.address_line2,
          city: a.city,
          state: a.state,
          postal_code: a.postal_code,
          country: a.country,
          attention_to: a.attention_to,
          default_billing: a.default_billing,
          default_shipping: a.default_shipping,
        })),
        bill_to: addressOf(pickBillingAddress({ addresses })),
        ship_to: addressOf(pickShippingAddress({ addresses })),
        carrier_accounts: carrierAccounts.map((acct) => ({
          carrier: acct.carrier,
          bill_to_party: acct.bill_to_party,
          account_number: acct.account_number,
          account_postal_code: acct.account_postal_code,
          account_country_code: acct.account_country_code,
          notes: acct.notes,
        })),
        created_at: customer.created_at,
        url: companyLink(env, `/customers/${customer.id}`),
      },
    };
  },
});

export function registerCustomerTools(server: McpServer): void {
  registerCompanyTool(server, listCustomers);
  registerCompanyTool(server, getCustomer);
}

/** Exported for the catalogue test. */
export const CUSTOMER_TOOLS = [listCustomers, getCustomer];
