import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import { RefusalError, type CompanyToolEnv } from '@/lib/mcp/defineTool';
import { canonicalUnit, IMPORT_TOOLS, importRecords, previewImport } from '@/lib/mcp/tools/imports';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), registerScopedClientResolver: () => {} }));

/**
 * preview_import and import_records, run directly against a stubbed backend (the real
 * callBackend, so the request and the zod parse are both exercised). What matters: the body is
 * the one the Import page sends (identity mappings, skip_conflicts, pricing_columns for parts),
 * plus `dry_run`; parts carry resolved units so the route never asks Jigged's AI; the answer is
 * read through zod into counts, skipped rows and a link; and the refusals happen before any call.
 */

const env: CompanyToolEnv = {
  caller: { token: 'oauth-token', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  origin: 'https://jigged.app',
  link: (path) => `https://jigged.app${path}`,
};

const fetchMock = vi.fn();

/** A fresh response per call: a body can be read only once. */
function reply(status: number, body: unknown) {
  return () =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

/** The last request: its URL and parsed JSON body. */
function sent(): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, body: JSON.parse(init.body) };
}

const answer = (extra: Record<string, unknown> = {}) => ({
  success: true,
  dry_run: true,
  imported_count: 0,
  updated_count: 0,
  skipped_count: 0,
  errors: [],
  skipped_rows: [],
  ...extra,
});

describe('preview_import', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('MCP_GATEWAY_KEY', 'gateway-key');
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the Import page's body as a dry run and reports what would happen", async () => {
    fetchMock.mockImplementation(
      reply(
        200,
        answer({
          imported_count: 1,
          updated_count: 1,
          skipped_count: 1,
          skipped_rows: [{ row_number: 3, type: 'missing_name', field: 'name', reason: 'Customer name is required' }],
          errors: [{ row_number: 2, reason: 'Could not attach the address', data: { name: 'Bolt Works' } }],
        }),
      ),
    );
    const res = await previewImport.run(
      {
        entity: 'customers',
        rows: [{ name: 'Acme Corp', postal_code: 48201 }, { name: 'Bolt Works', contact_name: null }, { city: 'Flint' }],
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);

    const { url, body } = sent();
    expect(url).toBe('https://jigged.app/api/customers/import/execute');
    expect(body).toEqual({
      company_id: 'co-1',
      mappings: { name: 'name', postal_code: 'postal_code', contact_name: 'contact_name', city: 'city' },
      rows: [{ name: 'Acme Corp', postal_code: '48201' }, { name: 'Bolt Works', contact_name: '' }, { city: 'Flint' }],
      skip_conflicts: true,
      dry_run: true,
    });

    expect(res.data).toEqual({
      entity: 'customers',
      saved: false,
      rows_received: 3,
      created: 1,
      updated: 1,
      skipped: 1,
      skipped_rows: [{ row: 3, problem: 'missing_name', field: 'name', reason: 'Customer name is required' }],
      failed_rows: [{ row: 2, reason: 'Could not attach the address' }],
      routings_created: null,
      contacts_created: null,
      quantities_not_recorded: null,
      url: 'https://jigged.app/dashboard/co-1/customers',
    });
  });

  it('reports rows that name records Jigged does not have as skipped, with the reason', async () => {
    fetchMock.mockImplementation(
      reply(
        200,
        answer({
          skipped_count: 1,
          skipped_rows: [
            { row_number: 1, type: 'unknown_vendor', reason: "Vendor 'Nobody Inc' not found. Import vendors first." },
          ],
        }),
      ),
    );
    const res = await previewImport.run(
      { entity: 'vendor_services', rows: [{ vendor_name: 'Nobody Inc', service_name: 'Anodize' }] },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(sent().url).toBe('https://jigged.app/api/vendor-services/import/execute');
    expect(res.data.skipped_rows).toEqual([
      { row: 1, problem: 'unknown_vendor', field: null, reason: "Vendor 'Nobody Inc' not found. Import vendors first." },
    ]);
    expect(res.data.url).toBe('https://jigged.app/dashboard/co-1/vendors');
  });

  it('refuses a field the entity does not take, naming it and its rows, before calling Jigged', async () => {
    const res = await previewImport.run(
      { entity: 'customers', rows: [{ name: 'Acme', phone: '555' }, { name: 'Bolt', phone: '556', fax: '1' }] },
      env,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/phone \(rows 1, 2\), fax \(row 2\)/);
    expect(res.message).toMatch(/Nothing was checked/);
    expect(res.message).toMatch(/contact_phone/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves parts' units up front, so the route never asks Jigged's AI", async () => {
    fetchMock.mockImplementation(
      reply(200, answer({ quantity_skipped_already_placed: ['BRK-100'], imported_count: 2, updated_count: 1 })),
    );
    const res = await previewImport.run(
      {
        entity: 'parts',
        rows: [
          { part_name: 'BRK-100', primary_unit: 'EA', quantity: 10, location_name: 'Shelf A' },
          { part_name: 'OIL', primary_unit: 'ml' },
          { part_name: 'TUBE', primary_unit: 'Feet' },
          { part_name: 'BAR-1', primary_unit: 'furlongs' },
          { part_name: 'NUT' },
        ],
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    const { url, body } = sent();
    expect(url).toBe('https://jigged.app/api/parts/import/execute');
    expect(body.pricing_columns).toEqual([]);
    // Rows 4 and 5 have no unit Jigged reads: left out, so the route reports them, not the AI.
    expect(body.uom_resolutions).toEqual({ '1': 'each', '2': 'milliliters', '3': 'feet' });
    expect(res.data.quantities_not_recorded).toEqual(['BRK-100']);
    expect(res.data.created).toBe(2);
  });

  it('refuses parts when no row has a unit Jigged recognises, rather than send none', async () => {
    const res = await previewImport.run(
      { entity: 'parts', rows: [{ part_name: 'A', primary_unit: 'furlongs' }, { part_name: 'B' }] },
      env,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/primary_unit/);
    expect(res.message).toMatch(/pieces/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("numbers each part's routing steps in row order when no row has a step number", async () => {
    fetchMock.mockImplementation(
      reply(200, answer({ imported_count: undefined, imported_routings_count: 1, imported_operations_count: 3 })),
    );
    const res = await previewImport.run(
      {
        entity: 'routings',
        rows: [
          { part_name: 'BRK-100', work_center_name: 'Haas VF-2' },
          { part_name: 'PIN-7', work_center_name: 'Haas VF-2' },
          { part_name: 'brk-100', work_center_name: 'Anodize' },
        ],
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    const { body } = sent();
    expect((body.rows as Array<Record<string, string>>).map((r) => r.sequence)).toEqual(['1', '1', '2']);
    expect(body.mappings).toMatchObject({ sequence: 'sequence' });
    expect(res.data).toMatchObject({ created: 3, routings_created: 1, contacts_created: null });
  });

  it('leaves step numbers alone when the rows carry them', async () => {
    fetchMock.mockImplementation(reply(200, answer({ imported_routings_count: 0, imported_operations_count: 1 })));
    await previewImport.run(
      {
        entity: 'routings',
        rows: [
          { part_name: 'BRK-100', sequence: 20 },
          { part_name: 'BRK-100', work_center_name: 'Haas VF-2' },
        ],
      },
      env,
    );
    expect((sent().body.rows as Array<Record<string, string>>).map((r) => r.sequence)).toEqual(['20', undefined]);
  });

  it('fails loudly when Jigged answers a preview as a real run', async () => {
    fetchMock.mockImplementation(reply(200, answer({ dry_run: false })));
    await expect(previewImport.run({ entity: 'work_centers', rows: [{ name: 'Lathe' }] }, env)).rejects.toThrow(
      /dry_run/,
    );
  });

  it('takes 1 to 500 rows', () => {
    const rows = previewImport.input.rows;
    expect(rows.safeParse([]).success).toBe(false);
    expect(rows.safeParse(Array.from({ length: 500 }, () => ({ name: 'x' }))).success).toBe(true);
    expect(rows.safeParse(Array.from({ length: 501 }, () => ({ name: 'x' }))).success).toBe(false);
    expect(rows.safeParse([{ name: true }]).success).toBe(false);
  });
});

describe('import_records', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('MCP_GATEWAY_KEY', 'gateway-key');
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('writes through the same route for any office user, and says it saved', async () => {
    fetchMock.mockImplementation(
      reply(200, answer({ dry_run: false, imported_count: 1, updated_count: 1, contacts_imported_count: 1 })),
    );
    const res = await importRecords.run(
      {
        entity: 'vendors',
        rows: [
          { name: 'Great Lakes Plating' },
          { name: 'Apex Anodize', primary_contact_name: 'Lee', primary_contact_role: 'quality' },
        ],
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    const { url, body } = sent();
    expect(url).toBe('https://jigged.app/api/vendors/import/execute');
    expect(body).toMatchObject({ company_id: 'co-1', skip_conflicts: true, dry_run: false });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'x-jigged-mcp': 'gateway-key',
    });
    expect(res.data).toMatchObject({ saved: true, created: 1, updated: 1, contacts_created: 1 });
    expect(res.data.url).toBe('https://jigged.app/dashboard/co-1/vendors');
  });

  it("passes the backend's refusal through as written: a lapsed company", async () => {
    fetchMock.mockImplementation(
      reply(403, {
        detail: "Your shop's subscription isn't active, so nothing was saved. An admin can start one in Settings.",
      }),
    );
    const call = importRecords.run({ entity: 'bom', rows: [{ parent_part_name: 'A', child_part_name: 'B' }] }, env);
    await expect(call).rejects.toBeInstanceOf(RefusalError);
    await expect(
      importRecords.run({ entity: 'bom', rows: [{ parent_part_name: 'A', child_part_name: 'B' }] }, env),
    ).rejects.toThrow(/subscription isn't active/);
  });

  it('refuses unknown fields before writing anything', async () => {
    const res = await importRecords.run({ entity: 'work_centers', rows: [{ name: 'Lathe', vendor: 'X' }] }, env);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/Nothing was imported/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the import tools', () => {
  it('are a read preview and a destructive, repeatable write', () => {
    expect(previewImport).toMatchObject({ access: 'read' });
    expect(importRecords).toMatchObject({ access: 'write', destructive: true, idempotent: true });
    expect(IMPORT_TOOLS).toEqual([previewImport, importRecords]);
  });

  it('describe every entity and its required fields in the input schema', () => {
    const rows = previewImport.input.rows.description ?? '';
    for (const line of ['customers: name*', 'vendors: name*', 'parts: part_name*', 'bom: parent_part_name*']) {
      expect(rows).toContain(line);
    }
    expect(rows).toMatch(/primary_unit\* \(Unit of measure: pounds/);
  });

  it('return a link and no person against the work', () => {
    const output = z.toJSONSchema(z.object(previewImport.output), { io: 'output' });
    const names = JSON.stringify(output);
    expect(names).toContain('"url"');
    expect(names).not.toMatch(/_by"|"author|"operator|"user_id"|"user_name"/);
  });
});

describe('canonicalUnit', () => {
  it('reads units the way the parts route does', () => {
    expect(canonicalUnit('pieces')).toBe('pieces');
    expect(canonicalUnit(' LBS ')).toBe('pounds');
    expect(canonicalUnit('L')).toBe('liters');
    expect(canonicalUnit('l')).toBe('liters');
    expect(canonicalUnit('mL')).toBe('milliliters');
    expect(canonicalUnit('Sq Ft')).toBe('square feet');
    expect(canonicalUnit('hours')).toBeNull(); // in the picker, not in the importer's canonical set
    expect(canonicalUnit('')).toBeNull();
  });
});
