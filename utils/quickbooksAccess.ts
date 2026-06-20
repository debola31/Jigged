import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { API_BASE_URL } from '@/lib/api';

/**
 * Frontend access layer for the QuickBooks integration.
 *
 * All calls go through the FastAPI backend (never PostgREST directly): the OAuth
 * secrets and tokens live in a service-role-only table, and the browser only ever
 * learns connection status / resolution data via these endpoints.
 */

export interface QuickBooksStatus {
  connected: boolean;
  reconnect_required?: boolean;
  realm_id?: string | null;
  environment?: string | null;
  qb_company_name?: string | null;
  connected_at?: string | null;
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

export interface PreflightLine {
  part_name: string;
  quantity: number;
  unit_price: number | null;
  amount: number;
}

export interface PreflightResult {
  connected: boolean;
  already_pushed?: boolean;
  invoice_url?: string | null;
  customer?: PreflightCustomer;
  lines_preview?: PreflightLine[];
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
  url: string;
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

async function authHeader(): Promise<Record<string, string>> {
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

export function preflightQuotePush(
  companyId: string,
  quoteId: string,
): Promise<PreflightResult> {
  return qbRequest<PreflightResult>(`/${companyId}/quotes/${quoteId}/preflight`, {
    method: 'POST',
    body: {},
  });
}

export function pushQuoteToQuickBooks(
  companyId: string,
  quoteId: string,
  customer: PushCustomerDecision,
): Promise<PushResult> {
  return qbRequest<PushResult>(`/${companyId}/quotes/${quoteId}/invoice`, {
    method: 'POST',
    body: { customer },
  });
}

/**
 * The created QuickBooks invoice for a quote, if any — read directly from the
 * member-readable link table (no backend round-trip) to show a "View in
 * QuickBooks" deep link on the quote page.
 */
export async function getQuickBooksInvoiceLink(
  companyId: string,
  quoteId: string,
): Promise<QuickBooksInvoiceLink | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('quickbooks_invoice_links')
    .select('qb_invoice_id, qb_invoice_doc_number, qb_invoice_url')
    .eq('company_id', companyId)
    .eq('quote_id', quoteId)
    .eq('status', 'created')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.qb_invoice_url) return null;
  return {
    invoiceId: data.qb_invoice_id,
    docNumber: data.qb_invoice_doc_number,
    url: data.qb_invoice_url,
  };
}
