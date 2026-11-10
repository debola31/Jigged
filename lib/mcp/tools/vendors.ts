import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import {
  BAD_CURSOR_MESSAGE,
  MAX_PAGE,
  addressOf,
  addressOutput,
  companyLink,
  pageInput,
  pageOutput,
  paginate,
  urlOutput,
} from '@/lib/mcp/tools/shared';
import { getSupabase } from '@/lib/supabase';
import type { VendorWithPrimaryContact } from '@/types/vendor';
import type { VendorContactRole } from '@/types/vendorContact';
import type { VendorService } from '@/types/vendorService';
import { getAddressesForVendor } from '@/utils/vendorAddressesAccess';
import { getContactsForVendor } from '@/utils/vendorContactsAccess';
import { getVendorServicesForCompany, getVendorServicesForVendor } from '@/utils/vendorServicesAccess';
import { getAllVendorsWithPrimaryContact, getPartsByPreferredVendor } from '@/utils/vendorsAccess';
import { escapeIlikePattern } from '@/utils/searchFilter';

const CONTACT_ROLES = [
  'sales',
  'accounts_payable',
  'quality',
  'engineering',
  'shipping_receiving',
  'customer_service',
  'other',
] as const satisfies readonly VendorContactRole[];

/** How many of the parts that name a vendor preferred get_vendor lists. */
const PREFERRED_PARTS_CAP = MAX_PAGE;

const serviceOutput = z.object({
  service_id: z.string(),
  name: z.string().describe('The process the vendor performs, such as Anodize.'),
  unit_price: z.number().nullable().describe('Price per piece; null when not set.'),
});

const contactOutput = z.object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable() });

const vendorSummary = z.object({
  vendor_id: z.string(),
  name: z.string(),
  services: z.array(serviceOutput),
  primary_contact: contactOutput.nullable(),
  default_address: addressOutput.nullable(),
  url: urlOutput,
});

type VendorSummary = z.infer<typeof vendorSummary>;
type ServiceOut = z.infer<typeof serviceOutput>;

const serviceOf = (s: VendorService): ServiceOut => ({ service_id: s.id, name: s.name, unit_price: s.unit_price });

function summarise(vendor: VendorWithPrimaryContact, services: VendorService[], env: CompanyToolEnv): VendorSummary {
  const primary = vendor.primary_contact;
  return {
    vendor_id: vendor.id,
    name: vendor.name,
    services: services.map(serviceOf),
    primary_contact: primary ? { name: primary.name, email: primary.email, phone: primary.phone } : null,
    default_address: addressOf(vendor.default_address),
    url: companyLink(env, `/vendors/${vendor.id}`),
  };
}

export const listVendors = defineCompanyTool({
  name: 'list_vendors',
  title: 'List vendors',
  description:
    'Lists vendors (suppliers and outside processors) in a Jigged company, by name. Search ' +
    'matches part of the name or the city of one of its addresses. Each vendor has the outside ' +
    'services it performs with their prices, its primary contact and its default address.',
  access: 'read',
  input: {
    search: z.string().optional().describe('Part of the vendor\'s name, or a city.'),
    ...pageInput,
  },
  output: { vendors: z.array(vendorSummary), ...pageOutput },
  run: async (args, env) => {
    // Both reads leave archived vendors and services out.
    const [vendors, services] = await Promise.all([
      getAllVendorsWithPrimaryContact(env.company.id, args.search ?? '', 'name', 'asc'),
      getVendorServicesForCompany(env.company.id),
    ]);
    const page = paginate(vendors, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    const byVendor = new Map<string, VendorService[]>();
    for (const s of services) byVendor.set(s.vendor_id, [...(byVendor.get(s.vendor_id) ?? []), s]);
    return {
      ok: true,
      data: {
        vendors: page.items.map((v) => summarise(v, byVendor.get(v.id) ?? [], env)),
        total: page.total,
        next_cursor: page.next_cursor,
      },
    };
  },
});

const vendorDetail = {
  vendor_id: z.string(),
  name: z.string(),
  archived: z.boolean().describe('Deleted in Jigged, so it no longer appears in lists.'),
  contacts: z.array(
    z.object({
      contact_id: z.string().describe('What save_vendor_contact takes to change this contact.'),
      name: z.string(),
      role: z.enum(CONTACT_ROLES),
      role_label: z.string().nullable().describe('The role in words, when role is `other`.'),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      is_primary: z.boolean(),
    }),
  ),
  addresses: z.array(
    addressOutput.extend({
      address_id: z.string().describe('What save_vendor_address takes to change this address.'),
      is_default: z.boolean(),
    }),
  ),
  services: z.array(serviceOutput.extend({ description: z.string().nullable() })),
  preferred_parts: z
    .array(z.object({ part_id: z.string(), part_name: z.string(), unit: z.string().nullable(), url: urlOutput }))
    .describe(`Parts that name this vendor their preferred supplier, by name; at most ${PREFERRED_PARTS_CAP}.`),
  preferred_parts_total: z.number().describe('How many parts name this vendor preferred, across all of them.'),
  created_at: z.string(),
  url: urlOutput,
};

const NAME_THE_VENDOR = 'Give a vendor_id or a name.';

interface FoundVendor {
  id: string;
  name: string;
  created_at: string;
  deleted_at: string | null;
}

/**
 * The vendor a tool names by id or by name, or a sentence saying it isn't there. A by-id read:
 * an archived vendor is found and says so. Names are unique per company (vendors_unique_per_company,
 * archived ones included), so a name finds at most one. Read here rather than through getVendor,
 * which neither scopes to the company nor carries `deleted_at`, and a vendor row is only this.
 */
export async function findVendor(
  args: { vendor_id?: string; name?: string },
  env: CompanyToolEnv,
): Promise<{ vendor: FoundVendor } | { message: string }> {
  const name = args.name?.trim();
  if (!args.vendor_id && !name) return { message: NAME_THE_VENDOR };
  const lookup = getSupabase()
    .from('vendors')
    .select('id, name, created_at, deleted_at')
    .eq('company_id', env.company.id);
  const { data, error } = await (args.vendor_id
    ? lookup.eq('id', args.vendor_id)
    : lookup.ilike('name', escapeIlikePattern(name ?? ''))
  )
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      message: args.vendor_id
        ? `There is no vendor with that id in ${env.company.name}.`
        : `There is no vendor named ${name} in ${env.company.name}.`,
    };
  }
  return { vendor: data };
}

export const getVendor = defineCompanyTool({
  name: 'get_vendor',
  title: 'Get a vendor',
  description:
    'Returns one vendor in full: its contacts, addresses, the outside services it performs with ' +
    'their prices, and the parts that name it their preferred supplier. Find a vendor by id or ' +
    'by exact name.',
  access: 'read',
  input: {
    vendor_id: z.guid().optional().describe('The vendor, by id.'),
    name: z.string().optional().describe('The vendor\'s exact name (case does not matter), when you have no id.'),
  },
  output: vendorDetail,
  run: async (args, env) => {
    const found = await findVendor(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { vendor } = found;
    const [contacts, addresses, services, parts] = await Promise.all([
      getContactsForVendor(vendor.id),
      getAddressesForVendor(vendor.id),
      getVendorServicesForVendor(vendor.id),
      getPartsByPreferredVendor(vendor.id),
    ]);
    return {
      ok: true,
      data: {
        vendor_id: vendor.id,
        name: vendor.name,
        archived: vendor.deleted_at !== null,
        contacts: contacts.map((c) => ({
          contact_id: c.id,
          name: c.name,
          role: c.role,
          role_label: c.role_label,
          email: c.email,
          phone: c.phone,
          is_primary: c.is_primary,
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
          is_default: a.is_default,
        })),
        services: services.map((s) => ({ ...serviceOf(s), description: s.description })),
        preferred_parts: parts.slice(0, PREFERRED_PARTS_CAP).map((p) => ({
          part_id: p.id,
          part_name: p.part_name,
          unit: p.primary_unit,
          url: companyLink(env, `/parts/${p.id}`),
        })),
        preferred_parts_total: parts.length,
        created_at: vendor.created_at,
        url: companyLink(env, `/vendors/${vendor.id}`),
      },
    };
  },
});

export function registerVendorTools(server: ToolTarget): void {
  registerCompanyTool(server, listVendors);
  registerCompanyTool(server, getVendor);
}

/** Exported for the catalogue test. */
export const VENDOR_TOOLS = [listVendors, getVendor];
