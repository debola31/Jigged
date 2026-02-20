export interface Customer {
  id: string;
  company_id: string;
  name: string;
  website: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string;
  created_at: string;
  updated_at: string;
}

export interface CustomerFormData {
  name: string;
  website: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

export type CustomerFilter = 'all' | 'active' | 'inactive';

export interface CustomerWithRelations extends Customer {
  quotes_count: number;
  jobs_count: number;
}

export interface CustomerImportRow {
  name: string;
  [key: string]: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

export const EMPTY_CUSTOMER_FORM: CustomerFormData = {
  name: '',
  website: '',
  contact_name: '',
  contact_phone: '',
  contact_email: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: 'USA',
};

export function customerToFormData(customer: Customer): CustomerFormData {
  return {
    name: customer.name,
    website: customer.website || '',
    contact_name: customer.contact_name || '',
    contact_phone: customer.contact_phone || '',
    contact_email: customer.contact_email || '',
    address_line1: customer.address_line1 || '',
    address_line2: customer.address_line2 || '',
    city: customer.city || '',
    state: customer.state || '',
    postal_code: customer.postal_code || '',
    country: customer.country || 'USA',
  };
}
