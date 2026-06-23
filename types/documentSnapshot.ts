/**
 * Document Snapshot Standard — shared snapshot shapes.
 *
 * Transactional documents (quotes, jobs, shipments) freeze the customer/address/
 * contact block they render onto their own row, so editing or deleting the master
 * record never rewrites a historical quote/packing slip. See docs/architecture.md
 * "Document Snapshot Standard". These shapes match the jsonb the DB triggers write
 * (snapshot_document_party / snapshot_shipment_party).
 */

/** Frozen copy of a customer_addresses row's printable fields. */
export interface AddressSnapshot {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  attention_to: string | null;
}

/** Frozen copy of a customer_contacts row's printable fields. */
export interface ContactSnapshot {
  name: string | null;
  email: string | null;
  phone: string | null;
}
