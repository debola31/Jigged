import { z } from 'zod';

import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import {
  EMPTY_ADDRESS_MESSAGE,
  addressHasContent,
  addressTextInput,
  addressTextOf,
  contactChanged,
  contactProblem,
  contactTextInput,
  settleAddress,
  withContactInput,
} from '@/lib/mcp/tools/customersWrites';
import { addressOutput, companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { findVendor } from '@/lib/mcp/tools/vendors';
import { getSupabase } from '@/lib/supabase';
import { EMPTY_VENDOR_ADDRESS_FORM, type VendorAddress, type VendorAddressFormData } from '@/types/vendor';
import {
  EMPTY_VENDOR_CONTACT_FORM,
  vendorContactToFormData,
  type VendorContact,
  type VendorContactFormData,
  type VendorContactRole,
} from '@/types/vendorContact';
import { createVendorAddress, getAddressesForVendor, updateVendorAddress } from '@/utils/vendorAddressesAccess';
import { createVendorContact, getContactsForVendor, updateVendorContact } from '@/utils/vendorContactsAccess';
import { checkVendorNameExists, createVendor, updateVendor } from '@/utils/vendorsAccess';

/**
 * Vendor write tools: what VendorForm (create), the vendor page's inline rename, its Contact modal
 * and its Address form do, through the same access functions with the same arguments. None of it
 * is admin-only in the app: the Vendors pages are open to every office user (Sidebar has no
 * `adminOnly` on them; no AdminGuard).
 *
 * A vendor row is its name and nothing else: addresses, contacts and outside services each live in
 * their own table. Services are not written here.
 */

const CONTACT_ROLES = [
  'sales',
  'accounts_payable',
  'quality',
  'engineering',
  'shipping_receiving',
  'customer_service',
  'other',
] as const satisfies readonly VendorContactRole[];

type FoundVendor = Extract<Awaited<ReturnType<typeof findVendor>>, { vendor: unknown }>['vendor'];

const vendorLink = (env: CompanyToolEnv, vendorId: string) => companyLink(env, `/vendors/${vendorId}`);

export const createVendorTool = defineCompanyTool({
  name: 'create_vendor',
  title: 'Create a vendor',
  description:
    'Creates a vendor (a supplier or outside processor) in a Jigged company, as the New Vendor ' +
    'form does: its name and, optionally, one primary contact. Addresses are added afterwards ' +
    'with save_vendor_address. Reusing the exact name of an archived vendor brings that vendor ' +
    'back instead of making a second one. Returns the vendor and a link to its page.',
  access: 'write',
  idempotent: false,
  input: {
    name: z.string().min(1).describe("The vendor's name. Unique in the company."),
    primary_contact: z
      .object({
        ...contactTextInput,
        name: z.string().min(1).describe("The contact's name."),
        role: z.enum(CONTACT_ROLES).optional().describe('Defaults to sales.'),
      })
      .optional()
      .describe('One person at the vendor, saved as its primary contact.'),
  },
  output: {
    vendor_id: z.string(),
    name: z.string(),
    primary_contact: z.object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable() }).nullable(),
    revived: z.boolean().describe('True when this brought back an archived vendor of the same name rather than adding one.'),
    url: urlOutput,
  },
  run: async (args, env) => {
    const name = args.name.trim();
    if (!name) return { ok: false, message: 'A vendor needs a name.' };

    let contact: VendorContactFormData | undefined;
    if (args.primary_contact) {
      contact = withContactInput({ ...EMPTY_VENDOR_CONTACT_FORM, is_primary: true }, args.primary_contact);
      const problem = contactProblem(contact);
      if (problem) return { ok: false, message: problem };
    }

    // VendorForm's own check: a LIVE vendor of this name blocks; an archived one does not.
    if (await checkVendorNameExists(env.company.id, name, undefined)) {
      return { ok: false, message: `A vendor named ${name} already exists in ${env.company.name}.` };
    }
    const revived = await hasArchivedVendorNamed(name, env);

    const vendor = await createVendor(env.company.id, { name }, contact);
    return {
      ok: true,
      data: {
        vendor_id: vendor.id,
        name: vendor.name,
        primary_contact: contact
          ? { name: contact.name.trim(), email: contact.email.trim() || null, phone: contact.phone.trim() || null }
          : null,
        revived,
        url: vendorLink(env, vendor.id),
      },
    };
  },
});

/**
 * createVendor revives an archived vendor only on an exact-name collision: vendors_unique_per_company
 * is case-sensitive, and reviveArchivedVendorByName matches with `.eq`.
 */
async function hasArchivedVendorNamed(name: string, env: CompanyToolEnv): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from('vendors')
    .select('id')
    .eq('company_id', env.company.id)
    .eq('name', name)
    .not('deleted_at', 'is', null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

export const updateVendorTool = defineCompanyTool({
  name: 'update_vendor',
  title: 'Rename a vendor',
  description:
    "Renames a vendor, as the vendor page's name editor does; a vendor's name is the only field " +
    'on the vendor itself. Contacts and addresses have their own tools. Find the vendor by id or ' +
    'by exact name. Returns the vendor and a link to its page.',
  access: 'write',
  idempotent: true,
  input: {
    vendor_id: z.guid().optional().describe('The vendor, by id.'),
    name: z.string().optional().describe("The vendor's current exact name (case does not matter), when you have no id."),
    new_name: z.string().describe('The new name. Unique in the company.'),
  },
  output: {
    vendor_id: z.string(),
    name: z.string(),
    previous_name: z.string(),
    url: urlOutput,
  },
  run: async (args, env) => {
    const found = await findVendor(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { vendor } = found;

    // The page's persistName(): a no-op, an empty name and a taken one are each refused.
    const next = args.new_name.trim();
    if (next === vendor.name) return { ok: false, message: `Nothing to change: the vendor is already named ${vendor.name}.` };
    if (!next) return { ok: false, message: 'A vendor needs a name.' };
    if (await checkVendorNameExists(env.company.id, next, vendor.id)) {
      return { ok: false, message: `A vendor named ${next} already exists in ${env.company.name}.` };
    }

    const updated = await updateVendor(vendor.id, { name: next });
    return {
      ok: true,
      data: { vendor_id: updated.id, name: updated.name, previous_name: vendor.name, url: vendorLink(env, updated.id) },
    };
  },
});

/**
 * The vendor a contact or address row belongs to, or null when there is no such row in this
 * company. The row read is RLS-scoped to every company the person is in; findVendor then checks
 * it is this one.
 */
async function ownerOf(row: { vendor_id: string } | null, env: CompanyToolEnv): Promise<FoundVendor | null> {
  if (!row) return null;
  const found = await findVendor({ vendor_id: row.vendor_id }, env);
  return 'vendor' in found ? found.vendor : null;
}

async function contactRow(id: string): Promise<{ vendor_id: string } | null> {
  const { data, error } = await getSupabase().from('vendor_contacts').select('vendor_id').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function addressRow(id: string): Promise<{ vendor_id: string } | null> {
  const { data, error } = await getSupabase().from('vendor_addresses').select('vendor_id').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

/** The vendor a new contact or address goes on, named by id or by name. */
async function vendorToAddTo(
  args: { vendor_id?: string; vendor_name?: string },
  env: CompanyToolEnv,
  what: 'contact' | 'address',
): Promise<{ vendor: FoundVendor } | { message: string }> {
  if (!args.vendor_id && !args.vendor_name?.trim()) {
    return { message: `Give a ${what}_id to change a ${what}, or a vendor_id or vendor_name to add one.` };
  }
  return findVendor({ vendor_id: args.vendor_id, name: args.vendor_name }, env);
}

export const saveVendorContactTool = defineCompanyTool({
  name: 'save_vendor_contact',
  title: 'Add or update a vendor contact',
  description:
    "Adds a contact to a vendor, or with contact_id changes one, as the vendor page's Contact " +
    'dialog does. Making a contact primary takes that role from whoever held it, since a vendor ' +
    "has at most one primary contact. Returns the contact and a link to the vendor's page.",
  access: 'write',
  idempotent: false,
  input: {
    contact_id: z.guid().optional().describe('The contact to change. Leave out to add a new contact.'),
    vendor_id: z.guid().optional().describe('The vendor to add the contact to. Not needed with contact_id.'),
    vendor_name: z
      .string()
      .optional()
      .describe("The vendor's exact name (case does not matter), when adding and you have no vendor_id."),
    ...contactTextInput,
    role: z.enum(CONTACT_ROLES).optional().describe('Their role at the vendor. A new contact defaults to sales.'),
    is_primary: z.boolean().optional().describe('The primary contact. A new contact defaults to false.'),
  },
  output: {
    contact_id: z.string(),
    vendor_id: z.string(),
    vendor_name: z.string(),
    name: z.string(),
    role: z.enum(CONTACT_ROLES),
    role_label: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    is_primary: z.boolean().describe('At most one per vendor.'),
    url: urlOutput,
  },
  run: async (args, env) => {
    let vendor: FoundVendor;
    let existing: VendorContact | undefined;
    if (args.contact_id) {
      const owner = await ownerOf(await contactRow(args.contact_id), env);
      existing = owner ? (await getContactsForVendor(owner.id)).find((c) => c.id === args.contact_id) : undefined;
      if (!owner || !existing) return { ok: false, message: `There is no vendor contact with that id in ${env.company.name}.` };
      vendor = owner;
    } else {
      const found = await vendorToAddTo(args, env, 'contact');
      if ('message' in found) return { ok: false, message: found.message };
      vendor = found.vendor;
    }

    const form = withContactInput(existing ? vendorContactToFormData(existing) : EMPTY_VENDOR_CONTACT_FORM, args);
    const problem = contactProblem(form);
    if (problem) return { ok: false, message: problem };

    let written: VendorContact;
    if (existing) {
      if (!contactChanged(form, vendorContactToFormData(existing))) {
        return { ok: false, message: `Nothing to change: ${existing.name} already has those details.` };
      }
      written = await updateVendorContact(existing.id, form);
    } else {
      written = await createVendorContact(vendor.id, form);
    }
    return {
      ok: true,
      data: {
        contact_id: written.id,
        vendor_id: vendor.id,
        vendor_name: vendor.name,
        name: written.name,
        role: written.role,
        role_label: written.role_label,
        email: written.email,
        phone: written.phone,
        is_primary: written.is_primary,
        url: vendorLink(env, vendor.id),
      },
    };
  },
});

export const saveVendorAddressTool = defineCompanyTool({
  name: 'save_vendor_address',
  title: 'Add or update a vendor address',
  description:
    "Adds an address to a vendor, or with address_id changes one, as the vendor page's Address " +
    'form does. A vendor has one default address: marking this one the default takes the flag ' +
    "from the address that held it, and a vendor's first address becomes the default whatever " +
    "is asked. Returns the address and a link to the vendor's page.",
  access: 'write',
  idempotent: false,
  input: {
    address_id: z.guid().optional().describe('The address to change. Leave out to add a new address.'),
    vendor_id: z.guid().optional().describe('The vendor to add the address to. Not needed with address_id.'),
    vendor_name: z
      .string()
      .optional()
      .describe("The vendor's exact name (case does not matter), when adding and you have no vendor_id."),
    ...addressTextInput,
    is_default: z.boolean().optional().describe("The vendor's default address. A new address defaults to false."),
  },
  output: {
    address_id: z.string(),
    vendor_id: z.string(),
    vendor_name: z.string(),
    address: addressOutput,
    is_default: z.boolean(),
    url: urlOutput,
  },
  run: async (args, env) => {
    let vendor: FoundVendor;
    let existing: VendorAddress | undefined;
    if (args.address_id) {
      const owner = await ownerOf(await addressRow(args.address_id), env);
      existing = owner ? (await getAddressesForVendor(owner.id)).find((a) => a.id === args.address_id) : undefined;
      if (!owner || !existing) return { ok: false, message: `There is no vendor address with that id in ${env.company.name}.` };
      vendor = owner;
    } else {
      const found = await vendorToAddTo(args, env, 'address');
      if ('message' in found) return { ok: false, message: found.message };
      vendor = found.vendor;
    }

    const current: VendorAddressFormData = existing
      ? { ...addressTextOf(existing), is_default: existing.is_default }
      : { ...EMPTY_VENDOR_ADDRESS_FORM };
    const settled = settleAddress(current, args);
    if (!settled.ok) return { ok: false, message: settled.message };
    const form: VendorAddressFormData = { ...settled.text, is_default: args.is_default ?? current.is_default };

    let saved: VendorAddress;
    if (existing) {
      const unchanged = (Object.keys(form) as Array<keyof VendorAddressFormData>).every((k) => form[k] === current[k]);
      if (unchanged) return { ok: false, message: 'Nothing to change: the address already has those values.' };
      saved = await updateVendorAddress(existing.id, vendor.id, form);
    } else {
      if (!addressHasContent(form)) return { ok: false, message: EMPTY_ADDRESS_MESSAGE };
      saved = await createVendorAddress(vendor.id, form);
    }
    return {
      ok: true,
      data: {
        address_id: saved.id,
        vendor_id: vendor.id,
        vendor_name: vendor.name,
        address: {
          address_line1: saved.address_line1,
          address_line2: saved.address_line2,
          city: saved.city,
          state: saved.state,
          postal_code: saved.postal_code,
          country: saved.country,
          attention_to: saved.attention_to,
        },
        is_default: saved.is_default,
        url: vendorLink(env, vendor.id),
      },
    };
  },
});

export function registerVendorWriteTools(server: ToolTarget): void {
  registerCompanyTool(server, createVendorTool);
  registerCompanyTool(server, updateVendorTool);
  registerCompanyTool(server, saveVendorContactTool);
  registerCompanyTool(server, saveVendorAddressTool);
}

/** Exported for the catalogue test. */
export const VENDOR_WRITE_TOOLS = [createVendorTool, updateVendorTool, saveVendorContactTool, saveVendorAddressTool];
