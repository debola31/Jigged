import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { previewVendorPoPushTool } from '@/lib/mcp/tools/purchasing';
import { pushVendorPoToQuickBooksTool, verifyVendorPoPushTool } from '@/lib/mcp/tools/purchasingWrites';

import {
  CO,
  LINK_ID,
  PO_ID,
  TODAY,
  VENDOR_ID,
  envAs,
  expectContract,
  kit,
  poDetail,
  poQuickBooks,
  poUrl,
} from './purchasingTestKit';

/**
 * The QuickBooks tools for a purchase order to a vendor (plan §3.11, §5.4; QB1–QB10 from the
 * assistant's side). They reach QuickBooks only through the FastAPI routes the PO page's
 * QuickBooks dialog calls (api/routes/quickbooks_purchasing_routes.py): preflight, then ONE push
 * whose body carries only the vendor decision — the server mints every request id — and verify.
 * The PO is found in this company before its id goes anywhere.
 */

vi.mock('@/lib/supabase', async () => (await import('./purchasingTestKit')).kit.supabaseModule());
vi.mock('@/utils/vendorPoAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorPoAccess')>()),
  ...(await import('./purchasingTestKit')).kit.wrap(['getVendorPo']),
}));
vi.mock('@/lib/mcp/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp/backend')>()),
  ...(await import('./purchasingTestKit')).kit.wrap(['callBackend']),
}));

const env = envAs('user');
const PREFLIGHT = `/api/quickbooks/${CO}/vendor-pos/${PO_ID}/preflight`;
const PUSH = `/api/quickbooks/${CO}/vendor-pos/${PO_ID}/push`;
const VERIFY = `/api/quickbooks/${CO}/vendor-po-links/${LINK_ID}/verify`;

/** Each backend path answers with what `answers` holds, parsed by the schema the tool passed. */
const answers = new Map<string, unknown>();
const posted = (path: string) =>
  kit.calls('callBackend').filter((c) => c[1] === path).map((c) => (c[3] as { body?: unknown } | undefined)?.body);

function preflight(o: Record<string, unknown> = {}, vendor: Record<string, unknown> = {}) {
  return {
    connected: true,
    provider: 'qbo',
    has_deep_links: true,
    operation: 'create',
    blocked: null,
    refusal: null,
    setup_missing: [],
    vendor: {
      status: 'mapped',
      qb_vendor_id: '58',
      candidates: [],
      jigged_vendor_id: VENDOR_ID,
      jigged_name: 'Acme Metals',
      name_problem: null,
      ...vendor,
    },
    link: null,
    warnings: [],
    ...o,
  };
}

beforeEach(() => {
  kit.reset();
  answers.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T18:00:00Z`));
  kit.answer('vendor_purchase_orders', { id: PO_ID, po_number: 'PO-1042', deleted_at: null });
  kit.fn('getVendorPo').mockResolvedValue(poDetail());
  kit.fn('callBackend').mockImplementation(async (_env: unknown, path: string, schema: { parse: (v: unknown) => unknown }) => {
    if (!answers.has(path)) throw new Error(`no answer for ${path}`);
    return schema.parse(answers.get(path));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('preview_vendor_po_push', () => {
  it('asks the backend what a push would do, and reports it without sending anything', async () => {
    answers.set(
      PREFLIGHT,
      preflight({
        operation: 'update',
        link: {
          id: LINK_ID,
          status: 'created',
          operation: 'create',
          last_failure: null,
          qb_po_id: '177',
          qb_doc_number: 'PO-1042',
          qb_url: 'https://app.qbo.intuit.com/app/purchaseorder?txnId=177',
          qb_closed: false,
          pushed_revision: 0,
          out_of_date: true,
        },
        warnings: ["QuickBooks Online can't close single lines, so line 2 stays open there until the whole PO is closed."],
      }),
    );
    const res = await previewVendorPoPushTool.run({ po_number: 'PO-1042' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(posted(PREFLIGHT)).toEqual([{}]);
    expect(posted(PUSH)).toEqual([]);
    expect(kit.companyScopedBefore('callBackend')).toBe(true);
    expect(res.data).toEqual({
      vendor_po_id: PO_ID,
      po_number: 'PO-1042',
      quickbooks_connected: true,
      quickbooks: 'online',
      operation: 'update',
      blocked_by_unconfirmed_attempt: false,
      vendor: {
        vendor_id: VENDOR_ID,
        name: 'Acme Metals',
        match: 'linked',
        quickbooks_vendor_id: '58',
        candidates: [],
        on_push: 'use_linked',
        name_problem: null,
      },
      setup_missing: [],
      in_quickbooks: {
        number: 'PO-1042',
        quickbooks_url: 'https://app.qbo.intuit.com/app/purchaseorder?txnId=177',
        closed_in_quickbooks: false,
        out_of_date: true,
      },
      missing: [],
      warnings: ["QuickBooks Online can't close single lines, so line 2 stays open there until the whole PO is closed."],
      url: poUrl(),
    });
    expectContract(previewVendorPoPushTool, res.data);
  });

  it('says what stops a push: no connection, an unconfirmed attempt, the PO itself, the setup, a vendor to choose', async () => {
    answers.set(PREFLIGHT, { connected: false });
    const off = await previewVendorPoPushTool.run({ vendor_po_id: PO_ID }, env);
    expect(off).toMatchObject({
      ok: true,
      data: { quickbooks_connected: false, quickbooks: null, operation: null, vendor: null, missing: [expect.stringMatching(/^QuickBooks isn't connected/)] },
    });

    answers.set(
      PREFLIGHT,
      preflight(
        {
          provider: 'qbd',
          blocked: { code: 'qbd_blocked_unverified', link_id: LINK_ID, message: 'An earlier send of PO-1042 could not be confirmed.' },
          refusal: { code: 'vendor_po_line_unpriced', message: 'Line 2 of PO-1042 has no price yet.' },
          setup_missing: ['item:part', 'ap_account'],
        },
        {
          status: 'candidates',
          qb_vendor_id: null,
          candidates: [
            { qb_id: '7', display_name: 'Acme Metals Inc' },
            { qb_id: '9', display_name: null },
          ],
        },
      ),
    );
    const res = await previewVendorPoPushTool.run({ vendor_po_id: PO_ID }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.quickbooks).toBe('desktop');
    expect(res.data.blocked_by_unconfirmed_attempt).toBe(true);
    expect(res.data.vendor).toMatchObject({
      match: 'candidates',
      on_push: 'choose',
      candidates: [
        { quickbooks_vendor_id: '7', name: 'Acme Metals Inc' },
        { quickbooks_vendor_id: '9', name: null },
      ],
    });
    expect(res.data.setup_missing).toEqual([
      'the QuickBooks item for parts and material',
      'the accounts-payable account',
    ]);
    expect(res.data.missing).toEqual([
      'An earlier send of PO-1042 could not be confirmed.',
      'Line 2 of PO-1042 has no price yet.',
      'Finish the QuickBooks purchasing setup first: choose the QuickBooks item for parts and material and the accounts-payable account in Settings → QuickBooks → Purchasing. An admin can do it.',
      'QuickBooks has several vendors that could be Acme Metals; the push needs one chosen (quickbooks_vendor_id) or a new one created (create_quickbooks_vendor).',
    ]);
  });

  it('says so when the PO is not in this company', async () => {
    kit.answer('vendor_purchase_orders', null);
    expect(await previewVendorPoPushTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'There is no vendor PO with that id in Acme Machining.',
    });
    expect(kit.calls('callBackend')).toEqual([]);
  });
});

describe('push_vendor_po_to_quickbooks', () => {
  it("pushes with no request id and the vendor decided as the dialog decides it, then reads the PO back", async () => {
    answers.set(PREFLIGHT, preflight());
    answers.set(PUSH, {
      operation: 'create',
      qb_po_id: '177',
      doc_number: '1043',
      url: 'https://app.qbo.intuit.com/app/purchaseorder?txnId=177',
      already_existed: false,
      already_up_to_date: false,
      warnings: ["QuickBooks numbered it 1043; Jigged's number is PO-1042."],
      link_id: LINK_ID,
    });
    kit.fn('getVendorPo').mockResolvedValue(poDetail({ quickbooks: poQuickBooks({ state: 'in_quickbooks', linkId: LINK_ID, linkStatus: 'created', provider: 'qbo', docNumber: '1043' }) }));
    const res = await pushVendorPoToQuickBooksTool.run({ po_number: 'PO-1042' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(posted(PUSH)).toEqual([{}]);
    expect(kit.calls('getVendorPo')).toEqual([[PO_ID, { today: TODAY }]]);
    expect(res.data).toMatchObject({
      vendor_po_id: PO_ID,
      quickbooks_operation: 'create',
      quickbooks_number: '1043',
      already_up_to_date: false,
      already_existed: false,
      quickbooks_url: 'https://app.qbo.intuit.com/app/purchaseorder?txnId=177',
      warnings: ["QuickBooks numbered it 1043; Jigged's number is PO-1042."],
      quickbooks: { state: 'in_quickbooks', number: '1043' },
      url: poUrl(),
    });
    expectContract(pushVendorPoToQuickBooksTool, res.data);
  });

  it('links a chosen QuickBooks vendor, creates one on request, and never guesses among similar names', async () => {
    answers.set(PUSH, { operation: 'create', qb_po_id: '1', doc_number: 'PO-1042', url: null, already_existed: false, already_up_to_date: false, warnings: [] });
    const candidates = preflight({}, { status: 'candidates', qb_vendor_id: null, candidates: [{ qb_id: '7', display_name: 'Acme Metals Inc' }, { qb_id: '9', display_name: 'Acme Metal' }] });
    answers.set(PREFLIGHT, candidates);

    expect(await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message:
        'QuickBooks has several vendors that could be Acme Metals, so nothing was sent. Choose one with ' +
        'quickbooks_vendor_id (Acme Metals Inc (quickbooks_vendor_id 7); Acme Metal (quickbooks_vendor_id 9)), ' +
        'or create_quickbooks_vendor to create a new one.',
    });
    expect(await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID, quickbooks_vendor_id: '8' }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^That QuickBooks vendor isn't one of the matches for Acme Metals/),
    });
    expect(await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID, quickbooks_vendor_id: '7', create_quickbooks_vendor: true }, env)).toEqual({
      ok: false,
      message: 'Give quickbooks_vendor_id or create_quickbooks_vendor, not both.',
    });
    expect(posted(PUSH)).toEqual([]);

    await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID, quickbooks_vendor_id: '9' }, env);
    await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID, create_quickbooks_vendor: true }, env);
    answers.set(PREFLIGHT, preflight({}, { status: 'unmatched', qb_vendor_id: null }));
    await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID }, env);
    answers.set(PREFLIGHT, preflight({}, { status: 'exact_match', qb_vendor_id: '7', candidates: [{ qb_id: '7', display_name: 'Acme Metals' }] }));
    await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID }, env);
    expect(posted(PUSH)).toEqual([
      { vendor: { action: 'use_existing', qb_vendor_id: '9' } },
      { vendor: { action: 'create' } },
      {},
      {},
    ]);

    answers.set(PREFLIGHT, preflight());
    expect(await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID, create_quickbooks_vendor: true }, env)).toEqual({
      ok: false,
      message: 'Acme Metals is already linked to a QuickBooks vendor, and Jigged sends its POs to that one. Nothing was sent.',
    });
  });

  it("refuses with the backend's own sentence what stops a push, and says when another send is running", async () => {
    answers.set(PREFLIGHT, { connected: false });
    expect(await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^QuickBooks isn't connected/),
    });
    answers.set(PREFLIGHT, preflight({ refusal: { code: 'vendor_po_draft', message: "PO-1042 hasn't been sent to the vendor yet." } }));
    expect(await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: "PO-1042 hasn't been sent to the vendor yet.",
    });
    answers.set(PREFLIGHT, preflight({ blocked: { code: 'qbd_blocked_unverified', link_id: LINK_ID, message: 'An earlier send of PO-1042 could not be confirmed.' } }));
    expect(await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'An earlier send of PO-1042 could not be confirmed. Check it in QuickBooks, then settle it with verify_vendor_po_push.',
    });
    expect(posted(PUSH)).toEqual([]);

    answers.set(PREFLIGHT, preflight());
    answers.set(PUSH, { in_progress: true });
    expect(await pushVendorPoToQuickBooksTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'PO-1042 is already being sent to QuickBooks. Check it in a moment.',
    });
  });
});

describe('verify_vendor_po_push', () => {
  it('settles an unconfirmed attempt through the backend, and reads the PO back', async () => {
    kit.fn('getVendorPo').mockResolvedValue(
      poDetail({ quickbooks: poQuickBooks({ state: 'needs_checking', linkId: LINK_ID, linkStatus: 'needs_verification', provider: 'qbd' }) }),
    );
    answers.set(VERIFY, { outcome: 'adopted', qb_po_id: '88', doc_number: 'PO-1042', url: null });
    const res = await verifyVendorPoPushTool.run({ po_number: 'PO-1042' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(posted(VERIFY)).toEqual([{}]);
    expect(kit.companyScopedBefore('getVendorPo')).toBe(true);
    expect(res.data).toMatchObject({ outcome: 'adopted', quickbooks_number: 'PO-1042', url: poUrl() });
    expectContract(verifyVendorPoPushTool, res.data);
  });

  it('refuses a PO with nothing to settle, and says when the attempt is still running', async () => {
    expect(await verifyVendorPoPushTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'PO-1042 has no unconfirmed QuickBooks attempt.',
    });
    expect(kit.calls('callBackend')).toEqual([]);

    kit.fn('getVendorPo').mockResolvedValue(
      poDetail({ quickbooks: poQuickBooks({ state: 'pending', linkId: LINK_ID, linkStatus: 'pending', provider: 'qbd' }) }),
    );
    answers.set(VERIFY, { outcome: 'in_progress' });
    expect(await verifyVendorPoPushTool.run({ vendor_po_id: PO_ID }, env)).toEqual({
      ok: false,
      message: 'The QuickBooks attempt for PO-1042 is still running. Check it in a moment.',
    });
  });
});
