import { getSupabase } from '@/lib/supabase';
import { API_BASE_URL } from '@/lib/api';

/**
 * Frontend access layer for the QuickBooks integration.
 *
 * All calls go through the FastAPI backend (never PostgREST directly): the OAuth
 * secrets and tokens live in a service-role-only table, and the browser only ever
 * learns connection status / resolution data via these endpoints.
 */

/** Which accounting system a company is connected to. A company connects exactly
 *  one — enforced in the database by assert_single_accounting_provider(). */
export type QuickBooksProvider = 'qbo' | 'qbd';

export interface QuickBooksStatus {
  connected: boolean;
  reconnect_required?: boolean;
  realm_id?: string | null;
  environment?: string | null;
  qb_company_name?: string | null;
  connected_at?: string | null;
}

/** Structured `detail.code` values the backend returns, so surfaces can branch on
 *  a stable identifier instead of string-matching a message. */
export const QB_ERROR = {
  /** The shop PC is off, asleep, or QuickBooks is closed. A WARNING with a retry,
   *  never a failure — nothing is broken and the connection is still set up. */
  desktopUnreachable: 'qbd_offline',
  /** A create whose outcome we could not confirm. Needs a human to verify, and
   *  must never be auto-retried. */
  desktopVerify: 'qbd_verify',
  /** This job holds an unconfirmed invoice, so a new one is refused. */
  desktopBlocked: 'qbd_blocked_unverified',
} as const;

/** True when QuickBooks Desktop simply is not reachable right now.
 *
 *  Every surface uses this to choose warning-with-retry over error. A shop PC
 *  being switched off is the expected path, not a defect — which is also why this
 *  module reports nothing to Sentry. */
export function isQuickBooksUnreachable(err: unknown): boolean {
  return err instanceof QuickBooksError && err.code === QB_ERROR.desktopUnreachable;
}

/** True when an invoice's fate is unknown and a human must check QuickBooks. */
export function isQuickBooksUnverified(err: unknown): boolean {
  return (
    err instanceof QuickBooksError &&
    (err.code === QB_ERROR.desktopVerify || err.code === QB_ERROR.desktopBlocked)
  );
}

export interface CustomerCandidate {
  qb_id: string;
  display_name: string | null;
}

export type CustomerResolutionStatus = 'mapped' | 'exact_match' | 'candidates' | 'unmatched';

export interface PreflightCustomer {
  status: CustomerResolutionStatus;
  qb_customer_id: string | null;
  candidates: CustomerCandidate[];
  jigged_customer_id: string;
  jigged_name: string;
}

/**
 * Per-part billing context for the invoice quantity picker. `qty_invoiceable`
 * is the hard cap = ordered − already-invoiced (invoicing isn't gated on shipping —
 * a packing slip is a document, not a delivery). `qty_shipped` drives the picker's
 * default and a soft "more than shipped" nudge, not the cap.
 */
export interface BillablePart {
  job_part_id: string;
  part_name: string;
  description: string | null;
  unit_price: number | null;
  qty_ordered: number;
  qty_shipped: number;
  qty_invoiced: number;
  qty_invoiceable: number;
  production_status: string | null;
}

export interface PreflightResult {
  connected: boolean;
  provider?: QuickBooksProvider;
  /** False for QuickBooks Desktop. The push dialog uses this to decide whether to
   *  pre-open a browser tab: opening one for a provider with no web app flashes an
   *  empty window and closes it seconds later. */
  has_deep_links?: boolean;
  /** Set when this job holds an invoice whose fate is unconfirmed, so Create is
   *  refused. Surfaced here so the dialog can explain it rather than letting the
   *  user click and take a 409. */
  blocked?: { code: string; link_id: string } | null;
  customer?: PreflightCustomer;
  parts?: BillablePart[];
}

export interface PushCustomerDecision {
  action: 'use_existing' | 'create';
  qb_customer_id?: string;
}

export interface PushResult {
  qb_invoice_id?: string;
  doc_number?: string | null;
  url?: string | null;
  already_existed?: boolean;
  in_progress?: boolean;
}

export interface QuickBooksInvoiceLink {
  invoiceId: string | null;
  docNumber: string | null;
  /** Null for QuickBooks Desktop: there is no web app to link an invoice into. */
  url: string | null;
}

/** Error carrying the HTTP status and any structured `detail.code` from the backend. */
export class QuickBooksError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'QuickBooksError';
    this.status = status;
    this.code = code;
  }
}

/** @internal — exported only for utils/quickbooksDesktop.ts, which addresses a
 *  different base path but must not duplicate auth or error parsing. */
export async function authHeader(): Promise<Record<string, string>> {
  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new QuickBooksError('Not signed in.', 401);
  }
  return { Authorization: `Bearer ${session.access_token}` };
}

async function qbRequest<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = { ...(await authHeader()) };
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }

  const response = await fetch(`${API_BASE_URL}/api/quickbooks${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const rawDetail = (err as { detail?: unknown }).detail;
    let message = `QuickBooks request failed (${response.status})`;
    let code: string | undefined;
    if (typeof rawDetail === 'string') {
      message = rawDetail;
    } else if (rawDetail && typeof rawDetail === 'object') {
      const d = rawDetail as { message?: string; code?: string };
      message = d.message ?? message;
      code = d.code;
    }
    throw new QuickBooksError(message, response.status, code);
  }

  return (await response.json()) as T;
}

export function getQuickBooksStatus(companyId: string): Promise<QuickBooksStatus> {
  return qbRequest<QuickBooksStatus>(`/${companyId}/status`);
}

/** Begin OAuth: returns the Intuit consent URL the caller should redirect to. */
export async function startQuickBooksConnect(companyId: string): Promise<string> {
  const result = await qbRequest<{ authorize_url: string }>(`/${companyId}/authorize`, {
    method: 'POST',
    body: {},
  });
  return result.authorize_url;
}

export async function disconnectQuickBooks(companyId: string): Promise<void> {
  await qbRequest(`/${companyId}/disconnect`, { method: 'POST', body: {} });
}

export function preflightJobPush(
  companyId: string,
  jobId: string,
): Promise<PreflightResult> {
  return qbRequest<PreflightResult>(`/${companyId}/jobs/${jobId}/preflight`, {
    method: 'POST',
    body: {},
  });
}

/** One line the user chose to bill on this invoice. */
export interface InvoiceLineSelection {
  job_part_id: string;
  quantity: number;
}

/**
 * Create ONE invoice for a job billing the selected per-part quantities. `requestId`
 * is a client-minted idempotency key (one per dialog open) — a retried submit reuses
 * it so a double-click can't create two QuickBooks invoices. A job may have many
 * invoices; each call creates a distinct one for what has shipped-but-not-yet-invoiced.
 */
export function pushJobToQuickBooks(
  companyId: string,
  jobId: string,
  customer: PushCustomerDecision,
  requestId: string,
  lines: InvoiceLineSelection[],
): Promise<PushResult> {
  return qbRequest<PushResult>(`/${companyId}/jobs/${jobId}/invoice`, {
    method: 'POST',
    body: {
      customer,
      request_id: requestId,
      lines,
      // The browser knows the shop's timezone; the server only knows UTC. Bounded
      // server-side to +/-1 day so this cannot backdate into a closed period.
      // QuickBooks Online derives its own date; Desktop requires one.
      transaction_date: localInvoiceDate(),
    },
  });
}

/** Today, in the BROWSER's timezone, as YYYY-MM-DD. `toISOString()` would be UTC
 *  and would misdate roughly one push in thirty for a US shop working past 4pm
 *  Pacific — a real period-cutoff error, not a cosmetic one. */
function localInvoiceDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Resolve an invoice whose creation could not be confirmed.
 *
 * The ONLY way a blocked job unblocks. Deliberately a human action rather than an
 * automatic retry: Conductor does not deduplicate, and a create aborted mid-flight
 * was verified to still produce an invoice, so retrying blind is how a customer
 * gets billed twice.
 */
export function verifyQuickBooksInvoice(
  companyId: string,
  linkId: string,
): Promise<{ outcome: 'adopted' | 'released'; doc_number?: string | null }> {
  return qbRequest(`/${companyId}/invoices/${linkId}/verify`, {
    method: 'POST',
    body: {},
  });
}

/**
 * The created QuickBooks invoice for a job, if any — read directly from the
 * member-readable link table (no backend round-trip) to show a "View in
 * QuickBooks" deep link on the job page. Invoicing is job-keyed: this works for
 * both quote-sourced and PO-sourced jobs.
 */
export async function getQuickBooksInvoiceLinkForJob(
  companyId: string,
  jobId: string,
): Promise<QuickBooksInvoiceLink | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('quickbooks_invoice_links')
    .select('qb_invoice_id, qb_invoice_doc_number, qb_invoice_url')
    .eq('company_id', companyId)
    .eq('job_id', jobId)
    .eq('status', 'created')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // Keyed on the INVOICE, not on the deep link. QuickBooks Desktop has no web app,
  // so qb_invoice_url is always null there — and the job page uses this result as
  // its delete gate, which would have silently stopped firing for every
  // Desktop-invoiced job.
  if (!data?.qb_invoice_id) return null;
  return {
    invoiceId: data.qb_invoice_id,
    docNumber: data.qb_invoice_doc_number,
    url: data.qb_invoice_url,
  };
}

/** Per-part invoiced quantity (created, non-void invoices) for a job. The
 * Jigged-side truth for "how much of each part is already billed" — mirrors
 * getJobPartShipmentSummaries. Used by the editing gates (invoiced-floor) and the
 * job page's per-part breakdown. */
export interface JobPartInvoiceSummary {
  job_part_id: string;
  qty_ordered: number;
  qty_invoiced: number;
}

export async function getJobPartInvoiceSummaries(
  jobId: string,
): Promise<JobPartInvoiceSummary[]> {
  const supabase = getSupabase();

  const { data: rawParts, error: partsErr } = await supabase
    .from('job_parts')
    .select('id, quantity')
    .eq('job_id', jobId)
    .order('sequence', { ascending: true });
  if (partsErr || !rawParts) {
    console.error('Error fetching job_parts for invoice summary:', partsErr);
    throw new Error('Failed to load job parts.');
  }
  type JobPartRow = { id: string; quantity: number };
  const parts = rawParts as unknown as JobPartRow[];
  if (parts.length === 0) return [];
  const partIds = parts.map((p) => p.id);

  const { data: invoiced, error: invErr } = await supabase
    .from('quickbooks_invoice_line_items')
    .select('job_part_id, quantity, link:quickbooks_invoice_links!inner (status, voided_at)')
    .in('job_part_id', partIds);
  if (invErr) {
    console.error('Error fetching invoice line items:', invErr);
    throw new Error('Failed to load invoiced quantities.');
  }
  type InvRow = {
    job_part_id: string;
    quantity: number;
    link: { status: string; voided_at: string | null } | null;
  };
  const byPart = new Map<string, number>();
  for (const row of (invoiced ?? []) as unknown as InvRow[]) {
    // Only created, non-voided invoices count as billed (mirrors the SQL compute fn).
    if (!row.link || row.link.status !== 'created' || row.link.voided_at !== null) continue;
    byPart.set(row.job_part_id, (byPart.get(row.job_part_id) ?? 0) + Number(row.quantity));
  }

  return parts.map((p) => ({
    job_part_id: p.id,
    qty_ordered: Number(p.quantity),
    qty_invoiced: byPart.get(p.id) ?? 0,
  }));
}

export interface QuickBooksInvoiceLineView {
  jobPartId: string;
  partName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

/** One created invoice for the job's Invoices card. */
export interface QuickBooksInvoiceView {
  id: string;
  invoiceId: string | null;
  docNumber: string | null;
  url: string | null;
  createdAt: string;
  lines: QuickBooksInvoiceLineView[];
  total: number;
}

/** All created (non-void) invoices for a job, newest first, with their per-part
 * lines — replaces the single-invoice assumption of getQuickBooksInvoiceLinkForJob
 * for the job page's Invoices card. Plain member read (RLS), no backend round-trip. */
export async function getQuickBooksInvoiceLinksForJob(
  companyId: string,
  jobId: string,
): Promise<QuickBooksInvoiceView[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('quickbooks_invoice_links')
    .select(
      `id, qb_invoice_id, qb_invoice_doc_number, qb_invoice_url, created_at,
       quickbooks_invoice_line_items (
         job_part_id, quantity, unit_price, total_price,
         job_part:job_parts ( part:parts ( part_name ) )
       )`,
    )
    .eq('company_id', companyId)
    .eq('job_id', jobId)
    .eq('status', 'created')
    .is('voided_at', null)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Error fetching invoices for job:', error);
    throw new Error('Failed to load invoices.');
  }
  type LineRow = {
    job_part_id: string;
    quantity: number;
    unit_price: number;
    total_price: number;
    job_part: { part: { part_name: string } | null } | null;
  };
  type LinkRow = {
    id: string;
    qb_invoice_id: string | null;
    qb_invoice_doc_number: string | null;
    qb_invoice_url: string | null;
    created_at: string;
    quickbooks_invoice_line_items: LineRow[];
  };
  return ((data ?? []) as unknown as LinkRow[]).map((r) => {
    const lines: QuickBooksInvoiceLineView[] = (r.quickbooks_invoice_line_items ?? []).map((li) => ({
      jobPartId: li.job_part_id,
      partName: li.job_part?.part?.part_name ?? 'Part',
      quantity: Number(li.quantity),
      unitPrice: Number(li.unit_price),
      totalPrice: Number(li.total_price),
    }));
    return {
      id: r.id,
      invoiceId: r.qb_invoice_id,
      docNumber: r.qb_invoice_doc_number,
      url: r.qb_invoice_url,
      createdAt: r.created_at,
      lines,
      total: lines.reduce((s, l) => s + l.totalPrice, 0),
    };
  });
}

/**
 * State of the QuickBooks custom field this shop uses for the customer PO
 * number. `configured: false` is the ordinary starting state, not a failure.
 */
export interface QuickBooksPoField {
  configured: boolean;
  field_id: string | null;
  field_name: string | null;
  /** Every enabled sales custom field, so the UI can show which slots are taken. */
  candidates: Array<{ id: string; name: string }>;
  slots_used: number;
}

/**
 * Re-read QuickBooks settings to find the shop's PO custom field.
 *
 * Deliberately a user action, never a mount or push side effect: it is a round
 * trip to Intuit for a value that only changes when a human edits their
 * QuickBooks settings.
 *
 * Jigged cannot create the field — verified live that the REST Preferences
 * write silently no-ops and that the GraphQL Custom Fields API returns 403
 * without a paid partner tier. This is the "I've set it up, look again" button.
 */
export function refreshQuickBooksPoField(companyId: string): Promise<QuickBooksPoField> {
  return qbRequest<QuickBooksPoField>(`/${companyId}/po-field/refresh`, { method: 'POST' });
}

/** A payment term as QuickBooks holds it. `due_days` is null for non-net terms. */
export interface QuickBooksTerm {
  id: string;
  name: string;
  due_days: number | null;
}

/**
 * The connected company's QuickBooks payment terms, for the quote picker.
 *
 * Offering QuickBooks' own terms means the term chosen on a quote already
 * exists on the other side, so `SalesTermRef` resolves against a real entity
 * instead of a string we hope matches.
 *
 * Resolves — never rejects — when QuickBooks is absent or unreachable:
 * `{ connected: false, terms: [] }`. The caller falls back to Jigged's presets.
 * A shop with no QuickBooks must still be able to write a quote, and a term
 * typed here is created in QuickBooks at push time regardless.
 */
export async function listQuickBooksTerms(
  companyId: string,
): Promise<{ connected: boolean; terms: QuickBooksTerm[] }> {
  try {
    return await qbRequest<{ connected: boolean; terms: QuickBooksTerm[] }>(
      `/${companyId}/terms`,
    );
  } catch {
    return { connected: false, terms: [] };
  }
}
