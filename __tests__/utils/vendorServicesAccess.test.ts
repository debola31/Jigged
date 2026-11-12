/**
 * Vendor services — access layer.
 *
 * What earns its keep here is CLAUDE.md's archive rule applied to a CHILD. A service belongs to its
 * vendor, so a list or a picker leaves out a live service whose vendor is archived, exactly as it
 * leaves out an archived service: the routing step picker offered them until 2026-11-12. The
 * vendor's own page and the by-id read do not — an archived vendor's page still shows what it
 * offered, and a routing or job holding a service keeps resolving.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { stub } from './purchasingTestStub';

vi.mock('@/lib/supabase', async () => {
  const { stub: s } = await import('./purchasingTestStub');
  return { getSupabase: () => s.client };
});

import {
  getVendorService,
  getVendorServicesForCompany,
  getVendorServicesForRouting,
  getVendorServicesForVendor,
} from '@/utils/vendorServicesAccess';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stub.reset();
});

/** The one select string a read sent to `vendor_services`. */
function selectSent(): string {
  const [select] = stub.callsOf('vendor_services', 'select')[0] as [string];
  return select;
}

describe('getVendorServicesForRouting — the routing step picker', () => {
  it("offers a live service of a live vendor only: its own deleted_at and its vendor's, through an inner join", async () => {
    await getVendorServicesForRouting('co-1');

    // `!inner`, or the vendor filter would blank the embed and keep the service.
    expect(selectSent()).toContain('vendor:vendors!inner(');
    expect(stub.callsOf('vendor_services', 'eq')).toEqual([['company_id', 'co-1']]);
    expect(stub.callsOf('vendor_services', 'is')).toEqual([
      ['deleted_at', null],
      ['vendor.deleted_at', null],
    ]);
    expect(stub.writes()).toEqual([]);
  });

  it('carries the vendor name to group by and the price as a number', async () => {
    stub.queue('vendor_services', {
      data: [
        { id: 'vs-1', name: 'Anodize', unit_price: '4.5000', vendor_id: 'v-1', vendor: { name: 'PerformCoat', deleted_at: null } },
        { id: 'vs-2', name: 'Passivate', unit_price: null, vendor_id: 'v-2', vendor: { name: 'Great Lakes', deleted_at: null } },
      ],
    });

    await expect(getVendorServicesForRouting('co-1')).resolves.toEqual([
      { id: 'vs-1', name: 'Anodize', unit_price: 4.5, vendor_id: 'v-1', vendor_name: 'PerformCoat' },
      { id: 'vs-2', name: 'Passivate', unit_price: null, vendor_id: 'v-2', vendor_name: 'Great Lakes' },
    ]);
  });

  it('throws on a failed read, never an empty picker', async () => {
    stub.queue('vendor_services', { error: { message: 'boom' } });
    await expect(getVendorServicesForRouting('co-1')).rejects.toMatchObject({ message: 'boom' });
  });
});

describe('getVendorServicesForCompany — every live service, for the Vendors list', () => {
  it('lists a live service of a live vendor only, and hands back the service without the join', async () => {
    const service = {
      id: 'vs-1',
      company_id: 'co-1',
      vendor_id: 'v-1',
      name: 'Anodize',
      description: null,
      unit_price: 4.5,
      created_at: 'c',
      updated_at: 'u',
    };
    stub.queue('vendor_services', { data: [{ ...service, vendor: { deleted_at: null } }] });

    await expect(getVendorServicesForCompany('co-1')).resolves.toEqual([service]);
    expect(selectSent()).toContain('vendor:vendors!inner(');
    expect(stub.callsOf('vendor_services', 'eq')).toEqual([['company_id', 'co-1']]);
    expect(stub.callsOf('vendor_services', 'is')).toEqual([
      ['deleted_at', null],
      ['vendor.deleted_at', null],
    ]);
  });
});

describe('the vendor page and the by-id read keep resolving what an archived vendor offered', () => {
  it("filters only the service's own deleted_at on the vendor page, and nothing by id", async () => {
    await getVendorServicesForVendor('v-archived');
    expect(selectSent()).not.toContain('vendors');
    expect(stub.callsOf('vendor_services', 'eq')).toEqual([['vendor_id', 'v-archived']]);
    expect(stub.callsOf('vendor_services', 'is')).toEqual([['deleted_at', null]]);

    stub.reset();
    stub.queue('vendor_services', { data: [{ id: 'vs-1' }] });
    await getVendorService('vs-1');
    expect(selectSent()).not.toContain('vendors');
    expect(stub.callsOf('vendor_services', 'is')).toEqual([]);
  });
});
