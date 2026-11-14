import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '../../test-utils';
import type { VendorPoDetail } from '@/types/vendorPo';
import type * as QuickBooksAccess from '@/utils/quickbooksAccess';
import type {
  VendorPoPushPreflight,
  VendorPoPushResult,
  VendorPoQuickBooksLink,
} from '@/utils/quickbooksAccess';

/**
 * Sending a vendor PO to QuickBooks (plan §3.11, §5.3; criteria QB1 and QB6).
 *
 * The rule these pin first is QB1: nothing reaches QuickBooks until the person opens the dialog
 * from its button. The PO page mounts this dialog closed, so a request on mount would be a
 * QuickBooks call (a Conductor round trip to the shop's PC, for Desktop) on every page view.
 * One test therefore keeps the REAL access function and spies on `fetch`, so it is the network
 * that proves it, not a mock.
 */

const qb = vi.hoisted(() => ({
  preflightVendorPoPush: vi.fn(),
  pushVendorPo: vi.fn(),
  verifyVendorPoLink: vi.fn(),
}));
// Everything else (QuickBooksError, QB_ERROR, the classifiers) stays real, so the dialog's
// classification is exercised against the same code the browser runs.
vi.mock('@/utils/quickbooksAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof QuickBooksAccess>()),
  ...qb,
}));

const getVendorPo = vi.hoisted(() => vi.fn());
vi.mock('@/utils/vendorPoAccess', () => ({ getVendorPo }));

const role = vi.hoisted(() => ({
  current: { role: 'admin' as 'admin' | 'user' | 'operator' | null, isAdmin: true, loading: false },
}));
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => role.current }));

const capture = vi.hoisted(() => vi.fn());
vi.mock('posthog-js', () => ({ default: { capture } }));

// The real access layer reads the session for its Authorization header.
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } }, error: null }),
    },
  }),
}));

import { SendVendorPoToQuickBooksDialog } from '@/components/purchasing/SendVendorPoToQuickBooksDialog';
import { QuickBooksError } from '@/utils/quickbooksAccess';

// ── fixtures ──────────────────────────────────────────────────────────────

function preflight(over: Partial<VendorPoPushPreflight> = {}): VendorPoPushPreflight {
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
      qb_vendor_id: 'qv-1',
      candidates: [],
      jigged_vendor_id: 'v-1',
      jigged_name: 'Acme Anodizing',
      name_problem: null,
    },
    link: null,
    warnings: [],
    ...over,
  };
}

function link(over: Partial<VendorPoQuickBooksLink> = {}): VendorPoQuickBooksLink {
  return {
    id: 'link-1',
    status: 'created',
    operation: 'create',
    last_failure: null,
    qb_po_id: '88',
    qb_doc_number: 'PO-1042',
    qb_url: 'https://app.qbo.intuit.com/app/purchaseorder?txnId=88',
    qb_closed: false,
    pushed_revision: 1,
    out_of_date: true,
    ...over,
  };
}

/** Only the fields the dialog reads; the rest of the detail is the PO page's business. */
function poDetail(
  over: { revision?: number; prices?: (number | null)[] } = {},
): VendorPoDetail {
  const prices = over.prices ?? [12.5, 3];
  const lines = prices.map((unitPrice, i) => ({ lineNumber: i + 1, unitPrice }));
  return {
    header: { id: 'po-1', poNumber: 'PO-1042', revision: over.revision ?? 0, vendorName: 'Acme Anodizing' },
    summary: { lineCount: lines.length },
    lines,
  } as VendorPoDetail;
}

function refusal(code: string, message: string, details: Record<string, unknown> = {}) {
  return new QuickBooksError(message, 409, code, { code, message, ...details });
}

/** A promise we control, so the in-flight state can actually be observed. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const onClose = vi.fn();
const onPushed = vi.fn();

function renderDialog(open = true) {
  return render(
    <SendVendorPoToQuickBooksDialog
      open={open}
      companyId="c1"
      poId="po-1"
      onClose={onClose}
      onPushed={onPushed}
    />,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  role.current = { role: 'admin', isAdmin: true, loading: false };
  qb.preflightVendorPoPush.mockResolvedValue(preflight());
  getVendorPo.mockResolvedValue(poDetail());
});

// ── QB1: no request until the dialog opens ───────────────────────────────

describe('SendVendorPoToQuickBooksDialog — nothing reaches QuickBooks before it opens', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes no /api/quickbooks request while closed, and one preflight when opened', async () => {
    const actual = await vi.importActual<typeof QuickBooksAccess>('@/utils/quickbooksAccess');
    qb.preflightVendorPoPush.mockImplementation(actual.preflightVendorPoPush);
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(preflight()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const quickBooksCalls = () =>
      fetchSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes('/api/quickbooks'));

    const view = renderDialog(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(quickBooksCalls()).toEqual([]);
    expect(getVendorPo).not.toHaveBeenCalled();

    view.rerender(
      <SendVendorPoToQuickBooksDialog open companyId="c1" poId="po-1" onClose={onClose} onPushed={onPushed} />,
    );

    await waitFor(() => expect(quickBooksCalls()).toHaveLength(1));
    const [url, init] = quickBooksCalls()[0] as [string, RequestInit];
    expect(url).toContain('/api/quickbooks/c1/vendor-pos/po-1/preflight');
    expect(init.method).toBe('POST');
    // Preflight never sends, and nothing else asks QuickBooks on open.
    expect(await screen.findByRole('button', { name: 'Send to QuickBooks' })).toBeEnabled();
    expect(quickBooksCalls()).toHaveLength(1);
  });

  it('runs the preflight on open, once, for this PO', async () => {
    renderDialog();
    await screen.findByRole('button', { name: 'Send to QuickBooks' });
    expect(qb.preflightVendorPoPush).toHaveBeenCalledTimes(1);
    expect(qb.preflightVendorPoPush).toHaveBeenCalledWith('c1', 'po-1');
    expect(qb.pushVendorPo).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Send PO-1042 to QuickBooks' })).toBeInTheDocument();
  });
});

// ── QB6: which QuickBooks vendor it goes to ──────────────────────────────

describe('SendVendorPoToQuickBooksDialog — the vendor', () => {
  const user = userEvent.setup();

  it('sends a mapped vendor without asking', async () => {
    qb.pushVendorPo.mockResolvedValue({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    renderDialog();

    expect(await screen.findByText(/already linked to a vendor in QuickBooks/i)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send to QuickBooks' }));

    await waitFor(() => expect(qb.pushVendorPo).toHaveBeenCalledWith('c1', 'po-1', undefined));
  });

  it('links an exact name match without asking, by its QuickBooks id', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(
      preflight({
        vendor: {
          status: 'exact_match',
          qb_vendor_id: 'qv-7',
          candidates: [{ qb_id: 'qv-7', display_name: 'Acme Anodizing' }],
          jigged_vendor_id: 'v-1',
          jigged_name: 'Acme Anodizing',
          name_problem: null,
        },
      }),
    );
    qb.pushVendorPo.mockResolvedValue({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    renderDialog();

    expect(await screen.findByText(/matches a vendor in QuickBooks/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send to QuickBooks' }));

    await waitFor(() =>
      expect(qb.pushVendorPo).toHaveBeenCalledWith('c1', 'po-1', {
        action: 'use_existing',
        qb_vendor_id: 'qv-7',
      }),
    );
  });

  it('offers similar names as choices, plus Create, and sends nothing until one is chosen', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(
      preflight({
        vendor: {
          status: 'candidates',
          qb_vendor_id: null,
          candidates: [
            { qb_id: 'qv-2', display_name: 'Acme Anodizing Inc.' },
            { qb_id: 'qv-3', display_name: 'Acme Anodizing & Plating' },
          ],
          jigged_vendor_id: 'v-1',
          jigged_name: 'Acme Anodizing',
          name_problem: null,
        },
      }),
    );
    qb.pushVendorPo.mockResolvedValue({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    renderDialog();

    const choices = await screen.findByRole('radiogroup', { name: /quickbooks vendor/i });
    const radios = within(choices).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    // A similar name is a guess, not a match: nothing is preselected.
    radios.forEach((r) => expect(r).not.toBeChecked());
    expect(within(choices).getByLabelText('Create vendor “Acme Anodizing” in QuickBooks')).toBeInTheDocument();

    const send = screen.getByRole('button', { name: 'Send to QuickBooks' });
    expect(send).toBeDisabled();
    // The reason is on screen, not in a tooltip.
    expect(screen.getByText(/choose which QuickBooks vendor this is/i)).toBeInTheDocument();

    await user.click(within(choices).getByLabelText('Acme Anodizing & Plating'));
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() =>
      expect(qb.pushVendorPo).toHaveBeenCalledWith('c1', 'po-1', {
        action: 'use_existing',
        qb_vendor_id: 'qv-3',
      }),
    );
  });

  it('asks QuickBooks to create the vendor when that is the choice', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(
      preflight({
        vendor: {
          status: 'candidates',
          qb_vendor_id: null,
          candidates: [{ qb_id: 'qv-2', display_name: 'Acme Anodizing Inc.' }],
          jigged_vendor_id: 'v-1',
          jigged_name: 'Acme Anodizing',
          name_problem: null,
        },
      }),
    );
    qb.pushVendorPo.mockResolvedValue({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    renderDialog();

    await user.click(await screen.findByLabelText('Create vendor “Acme Anodizing” in QuickBooks'));
    await user.click(screen.getByRole('button', { name: 'Send to QuickBooks' }));

    await waitFor(() => expect(qb.pushVendorPo).toHaveBeenCalledWith('c1', 'po-1', { action: 'create' }));
    await screen.findByText(/In QuickBooks as PO-1042/);
    expect(capture).toHaveBeenCalledWith('vendor po pushed', expect.objectContaining({ vendor_created: true }));
  });

  it('with no match, says it will create the vendor — and lets the server look again before it does', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(
      preflight({
        vendor: {
          status: 'unmatched',
          qb_vendor_id: null,
          candidates: [],
          jigged_vendor_id: 'v-1',
          jigged_name: 'Acme Anodizing',
          name_problem: null,
        },
      }),
    );
    qb.pushVendorPo.mockResolvedValue({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    renderDialog();

    const create = await screen.findByLabelText('Create vendor “Acme Anodizing” in QuickBooks');
    expect(create).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Send to QuickBooks' }));

    // No vendor body: a preflight lookup that failed also reads "unmatched", and the server's own
    // search is what stops a near-duplicate vendor being created behind a similar name.
    await waitFor(() => expect(qb.pushVendorPo).toHaveBeenCalledWith('c1', 'po-1', undefined));
  });

  it('refuses a name QuickBooks Desktop cannot take, with the reason, and never shortens it', async () => {
    const longName = 'Acme Precision Anodizing and Plating Services of Ohio';
    qb.preflightVendorPoPush.mockResolvedValue(
      preflight({
        provider: 'qbd',
        has_deep_links: false,
        vendor: {
          status: 'unmatched',
          qb_vendor_id: null,
          candidates: [],
          jigged_vendor_id: 'v-1',
          jigged_name: longName,
          name_problem: "it's 52 characters long, and QuickBooks allows 41",
        },
      }),
    );
    renderDialog();

    expect(
      await screen.findByText(
        `QuickBooks can't take the vendor name “${longName}” because it's 52 characters long, and QuickBooks allows 41. Change the vendor's name in Jigged, then send it again.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Create vendor/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to QuickBooks' })).toBeDisabled();
  });

  it('with similar names and a name it cannot take, still lets a match be linked', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(
      preflight({
        provider: 'qbd',
        has_deep_links: false,
        vendor: {
          status: 'candidates',
          qb_vendor_id: null,
          candidates: [{ qb_id: 'qv-2', display_name: 'Acme: Ohio' }],
          jigged_vendor_id: 'v-1',
          jigged_name: 'Acme: Ohio plant',
          name_problem: 'it contains a colon, which QuickBooks reads as a sub-name separator',
        },
      }),
    );
    qb.pushVendorPo.mockResolvedValue({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    renderDialog();

    expect(await screen.findByLabelText('Create vendor “Acme: Ohio plant” in QuickBooks')).toBeDisabled();
    expect(screen.getByText(/because it contains a colon/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Acme: Ohio'));
    await user.click(screen.getByRole('button', { name: 'Send to QuickBooks' }));
    await waitFor(() =>
      expect(qb.pushVendorPo).toHaveBeenCalledWith('c1', 'po-1', { action: 'use_existing', qb_vendor_id: 'qv-2' }),
    );
  });

  it('shows the choice when the send itself finds several vendors', async () => {
    qb.pushVendorPo
      .mockRejectedValueOnce(
        refusal(
          'qb_vendor_choice_required',
          'QuickBooks has more than one vendor with a name like “Acme Anodizing”. Choose which one this is, then send it to QuickBooks again.',
          { candidates: [{ qb_id: 'qv-5', display_name: 'Acme Anodizing (old)' }] },
        ),
      )
      .mockResolvedValueOnce({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    qb.preflightVendorPoPush.mockResolvedValue(
      preflight({
        vendor: {
          status: 'unmatched',
          qb_vendor_id: null,
          candidates: [],
          jigged_vendor_id: 'v-1',
          jigged_name: 'Acme Anodizing',
          name_problem: null,
        },
      }),
    );
    renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Send to QuickBooks' }));
    expect(await screen.findByText(/more than one vendor with a name like/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Acme Anodizing (old)'));
    await user.click(screen.getByRole('button', { name: 'Send to QuickBooks' }));

    await waitFor(() =>
      expect(qb.pushVendorPo).toHaveBeenLastCalledWith('c1', 'po-1', { action: 'use_existing', qb_vendor_id: 'qv-5' }),
    );
  });
});

// ── what stops a send, worded for the person reading it ─────────────────

describe('SendVendorPoToQuickBooksDialog — what has to happen first', () => {
  it('tells an admin where to finish the purchasing setup', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(preflight({ setup_missing: ['item:part', 'item:other'] }));
    renderDialog();

    expect(await screen.findByText(/choose the QuickBooks item for purchases in Settings → QuickBooks → Purchasing/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open settings/i })).toHaveAttribute('href', '/dashboard/c1/settings');
    expect(screen.getByRole('button', { name: 'Send to QuickBooks' })).toBeDisabled();
  });

  it('tells a user to ask an admin, with no link to a page they cannot open', async () => {
    role.current = { role: 'user', isAdmin: false, loading: false };
    qb.preflightVendorPoPush.mockResolvedValue(preflight({ setup_missing: ['item:part', 'ap_account'] }));
    renderDialog();

    expect(await screen.findByText(/Ask an admin to finish the QuickBooks purchasing setup/)).toBeInTheDocument();
    expect(screen.getByText(/the accounts-payable account/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open settings/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to QuickBooks' })).toBeDisabled();
  });

  it("shows the backend's own sentence when the PO isn't ready to go", async () => {
    const sentence =
      "Rev 2 of PO-1042 hasn't gone to Acme Anodizing — send it to them first (Mark as sent on the PO page), so QuickBooks matches what they have.";
    qb.preflightVendorPoPush.mockResolvedValue(
      preflight({ refusal: { code: 'vendor_po_unsent_revision', message: sentence }, vendor: null }),
    );
    renderDialog();

    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to QuickBooks' })).toBeDisabled();
  });

  it('says QuickBooks is not connected, and offers nothing to press but Settings', async () => {
    qb.preflightVendorPoPush.mockResolvedValue({ connected: false });
    renderDialog();

    expect(await screen.findByText(/QuickBooks isn't connected to Jigged yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open settings/i })).toHaveAttribute('href', '/dashboard/c1/settings');
    expect(screen.queryByRole('button', { name: /QuickBooks/ })).not.toBeInTheDocument();
  });

  it('flags a line priced at zero before it goes', async () => {
    getVendorPo.mockResolvedValue(poDetail({ prices: [12.5, 0] }));
    renderDialog();
    expect(await screen.findByText(/Line 2 has a price of 0/)).toBeInTheDocument();
  });
});

// ── the button: what it says, and only it saying it ──────────────────────

describe('SendVendorPoToQuickBooksDialog — the send button', () => {
  const user = userEvent.setup();

  it('reads Update in QuickBooks (Rev N) when QuickBooks has an earlier version', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(preflight({ operation: 'update', link: link() }));
    getVendorPo.mockResolvedValue(poDetail({ revision: 2 }));
    renderDialog();

    expect(await screen.findByRole('button', { name: 'Update in QuickBooks (Rev 2)' })).toBeEnabled();
    expect(screen.getByText(/In QuickBooks as PO-1042/)).toBeInTheDocument();
  });

  it('reads Close in QuickBooks for a PO closed in Jigged', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(preflight({ operation: 'close', link: link() }));
    renderDialog();
    expect(await screen.findByRole('button', { name: 'Close in QuickBooks' })).toBeEnabled();
  });

  it('only the pressed button says it is waiting', async () => {
    const d = deferred<VendorPoPushResult>();
    qb.pushVendorPo.mockReturnValue(d.promise);
    renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Send to QuickBooks' }));

    const sending = await screen.findByRole('button', { name: /sending to quickbooks/i });
    expect(sending).toHaveAttribute('aria-busy', 'true');
    // Cancel can't be used mid-send, but it must not claim to be working.
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    expect(cancel).not.toHaveAttribute('aria-busy');

    d.resolve({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    await screen.findByText(/In QuickBooks as PO-1042/);
  });

  it("names the shop computer while QuickBooks Desktop is working", async () => {
    const d = deferred<VendorPoPushResult>();
    qb.pushVendorPo.mockReturnValue(d.promise);
    qb.preflightVendorPoPush.mockResolvedValue(preflight({ provider: 'qbd', has_deep_links: false }));
    renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Send to QuickBooks' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/shop computer/i);

    d.resolve({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    await waitFor(() => expect(screen.queryByText(/shop computer/i)).not.toBeInTheDocument());
  });

  it('explains "already up to date" and keeps the button', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(preflight({ operation: 'none', link: link({ out_of_date: false }) }));
    getVendorPo.mockResolvedValue(poDetail({ revision: 2 }));
    qb.pushVendorPo.mockResolvedValue({
      operation: 'none',
      already_up_to_date: true,
      already_existed: true,
      doc_number: 'PO-1042',
      url: null,
      warnings: [],
    });
    renderDialog();

    expect(await screen.findByText(/nothing has changed since it was last sent/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Update in QuickBooks (Rev 2)' });
    expect(button).toBeEnabled();

    await user.click(button);
    expect(await screen.findByText('Already up to date in QuickBooks')).toBeInTheDocument();
    expect(capture).toHaveBeenCalledWith(
      'vendor po pushed',
      expect.objectContaining({ operation: 'none', already_up_to_date: true }),
    );
  });
});

// ── after QuickBooks answers ─────────────────────────────────────────────

describe('SendVendorPoToQuickBooksDialog — the outcome', () => {
  const user = userEvent.setup();

  it('shows the QuickBooks number, the link, and every warning; reports once on Done', async () => {
    const result: VendorPoPushResult = {
      operation: 'create',
      qb_po_id: '88',
      doc_number: '1043',
      url: 'https://app.qbo.intuit.com/app/purchaseorder?txnId=88',
      already_existed: false,
      already_up_to_date: false,
      warnings: ["QuickBooks numbered it 1043; Jigged's number is PO-1042."],
      link_id: 'link-1',
    };
    qb.pushVendorPo.mockResolvedValue(result);
    renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Send to QuickBooks' }));

    expect(await screen.findByText(/In QuickBooks as 1043/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open it in quickbooks/i })).toHaveAttribute('href', result.url);
    expect(screen.getByText("QuickBooks numbered it 1043; Jigged's number is PO-1042.")).toBeInTheDocument();
    expect(capture).toHaveBeenCalledWith('vendor po pushed', {
      provider: 'qbo',
      operation: 'create',
      line_count: 2,
      already_up_to_date: false,
      has_deep_link: true,
      vendor_created: false,
    });
    // The page refreshes behind the dialog only once the person has read the result.
    expect(onPushed).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onPushed).toHaveBeenCalledTimes(1);
    expect(onPushed).toHaveBeenCalledWith(result);
    expect(onClose).toHaveBeenCalled();
  });

  it('an unconfirmed send is amber, offers Check again, and verifying adopts it', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(preflight({ provider: 'qbd', has_deep_links: false }));
    qb.pushVendorPo.mockRejectedValue(
      refusal(
        'qbd_verify',
        "We couldn't confirm whether QuickBooks Desktop recorded PO-1042. Look for it in QuickBooks, then use Check again on the PO before sending it again.",
        { link_id: 'link-9' },
      ),
    );
    qb.verifyVendorPoLink.mockResolvedValue({ outcome: 'adopted', qb_po_id: '88', doc_number: 'PO-1042', url: null });
    renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Send to QuickBooks' }));

    const message = await screen.findByText(/couldn't confirm whether QuickBooks Desktop recorded PO-1042/);
    expect(message.closest('.MuiAlert-colorWarning')).not.toBeNull();
    // Never re-sent on its own: the send button waits for the check.
    expect(screen.getByRole('button', { name: 'Send to QuickBooks' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(qb.verifyVendorPoLink).toHaveBeenCalledWith('c1', 'link-9'));
    expect(await screen.findByText(/In QuickBooks as PO-1042/)).toBeInTheDocument();
    expect(capture).toHaveBeenCalledWith('vendor po push verified', { provider: 'qbd', outcome: 'adopted' });
    expect(qb.pushVendorPo).toHaveBeenCalledTimes(1);
  });

  it('a send held for checking on open can be released, then sent', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(
      preflight({
        provider: 'qbd',
        has_deep_links: false,
        vendor: null,
        blocked: {
          code: 'qbd_blocked_unverified',
          link_id: 'link-4',
          message: "An earlier send of PO-1042 to QuickBooks couldn't be confirmed. Use Check again on the PO before sending it again.",
        },
      }),
    );
    qb.verifyVendorPoLink.mockResolvedValue({ outcome: 'released' });
    qb.pushVendorPo.mockResolvedValue({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    renderDialog();

    expect(await screen.findByText(/An earlier send of PO-1042 to QuickBooks couldn't be confirmed/)).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send to QuickBooks' });
    expect(send).toBeDisabled();

    // Only the pressed control speaks while the check runs.
    const d = deferred<{ outcome: 'released' }>();
    qb.verifyVendorPoLink.mockReturnValue(d.promise);
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: /checking quickbooks/i })).toHaveAttribute('aria-busy', 'true');
    expect(send).not.toHaveAttribute('aria-busy');
    d.resolve({ outcome: 'released' });

    expect(await screen.findByText(/QuickBooks doesn't have it/i)).toBeInTheDocument();
    expect(capture).toHaveBeenCalledWith('vendor po push verified', { provider: 'qbd', outcome: 'released' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to QuickBooks' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Send to QuickBooks' }));
    await waitFor(() => expect(qb.pushVendorPo).toHaveBeenCalledTimes(1));
  });

  it('QuickBooks being offline is a warning with a retry, and only the retry spins', async () => {
    qb.preflightVendorPoPush.mockResolvedValue(preflight({ provider: 'qbd', has_deep_links: false }));
    qb.pushVendorPo.mockRejectedValueOnce(
      refusal(
        'qbd_offline',
        "QuickBooks Desktop didn't answer — the QuickBooks computer may be off or asleep, or QuickBooks may be closed. Open QuickBooks on that computer, then try again.",
      ),
    );
    renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Send to QuickBooks' }));
    expect(await screen.findByText("QuickBooks isn't answering right now")).toBeInTheDocument();

    const d = deferred<VendorPoPushResult>();
    qb.pushVendorPo.mockReturnValueOnce(d.promise);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /asking quickbooks/i })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Send to QuickBooks' })).not.toHaveAttribute('aria-busy');

    d.resolve({ operation: 'create', doc_number: 'PO-1042', url: null, warnings: [] });
    expect(await screen.findByText(/In QuickBooks as PO-1042/)).toBeInTheDocument();
    expect(qb.pushVendorPo).toHaveBeenCalledTimes(2);
  });

  it('shows a refusal at send time in its own words, in amber, and counts nothing as sent', async () => {
    const sentence =
      'Line 2 of PO-1042 has already been received or billed in QuickBooks, so it can\'t be removed or cut below 40. Close the line short in Jigged instead, then send it to QuickBooks again.';
    qb.preflightVendorPoPush.mockResolvedValue(preflight({ operation: 'update', link: link() }));
    qb.pushVendorPo.mockRejectedValue(refusal('qb_line_in_use', sentence));
    renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Update in QuickBooks' }));
    const shown = await screen.findByText(sentence);
    expect(shown.closest('.MuiAlert-colorWarning')).not.toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it('never polls: an unconfirmed send waits for Check again, however long it sits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const timedUser = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      qb.preflightVendorPoPush.mockResolvedValue(preflight({ provider: 'qbd', has_deep_links: false }));
      qb.pushVendorPo.mockRejectedValue(
        refusal('qbd_verify', "We couldn't confirm whether QuickBooks Desktop recorded PO-1042.", { link_id: 'link-9' }),
      );
      renderDialog();

      await timedUser.click(await screen.findByRole('button', { name: 'Send to QuickBooks' }));
      await screen.findByText(/couldn't confirm/);
      const before = [
        qb.preflightVendorPoPush.mock.calls.length,
        qb.pushVendorPo.mock.calls.length,
        qb.verifyVendorPoLink.mock.calls.length,
        getVendorPo.mock.calls.length,
      ];

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60_000);
      });

      expect([
        qb.preflightVendorPoPush.mock.calls.length,
        qb.pushVendorPo.mock.calls.length,
        qb.verifyVendorPoLink.mock.calls.length,
        getVendorPo.mock.calls.length,
      ]).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
