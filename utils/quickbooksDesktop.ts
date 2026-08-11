import { API_BASE_URL } from '@/lib/api';
import { authHeader, QuickBooksError } from '@/utils/quickbooksAccess';

/**
 * QuickBooks Desktop connection lifecycle and customer mapping.
 *
 * A companion to quickbooksAccess.ts, not a replacement. The INVOICE calls
 * (preflight, push, verify, the link reads) stay there and are provider-agnostic
 * by design — the job page must never learn which accounting system a shop uses.
 * Only setup differs, so only setup lives here.
 *
 * Auth and error parsing are imported rather than re-implemented: those are the
 * two things that must never diverge between the two base paths.
 */

async function qbdRequest<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = { ...(await authHeader()) };
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }

  const response = await fetch(`${API_BASE_URL}/api/quickbooks-desktop${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const rawDetail = (err as { detail?: unknown }).detail;
    let message = `QuickBooks Desktop request failed (${response.status})`;
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

export interface DesktopLink {
  auth_flow_url: string;
  end_user_id: string;
  expires_at: string | null;
}

export interface DesktopStatus {
  connected: boolean;
  /** True only once a Web Connector request has actually SUCCEEDED.
   *
   *  Not the same as "a connection record exists": Conductor creates that the
   *  moment the auth flow starts, so a shop that downloaded the .qwc and stopped
   *  would otherwise read as set up. */
  linked: boolean;
  qb_company_name: string | null;
  last_successful_request_at: string | null;
  /** The admin has not chosen which income account invoices post to. The first
   *  push is refused until they do — a wrong revenue account is invisible until
   *  month end. */
  needs_income_account: boolean;
}

export interface DesktopHealth {
  ok: boolean;
  code: string | null;
  message: string | null;
}

export interface DesktopCustomer {
  qb_id: string;
  /** `Parent:Child` for sub-customers — what we display. */
  full_name: string | null;
  /** Leaf name, subject to QuickBooks' 41-character cap — what we match on. */
  name: string | null;
  company_name: string | null;
}

export interface DesktopCustomerPage {
  customers: DesktopCustomer[];
  next_cursor: string | null;
}

export interface DesktopIncomeAccount {
  id: string;
  full_name: string | null;
}

/** Begin setup: returns a link the shop must open ON THE COMPUTER RUNNING
 *  QUICKBOOKS. There is no redirect back to Jigged, so nothing about this call
 *  marks the connection live — only a successful Web Connector request does. */
export function startQuickBooksDesktopConnect(companyId: string): Promise<DesktopLink> {
  return qbdRequest<DesktopLink>(`/${companyId}/connect`, { method: 'POST', body: {} });
}

/** Safe to poll while a setup link is outstanding: it reads Jigged's own row and
 *  only asks Conductor while still waiting to learn the flow finished. */
export function getQuickBooksDesktopStatus(companyId: string): Promise<DesktopStatus> {
  return qbdRequest<DesktopStatus>(`/${companyId}/status`);
}

/** An explicit "Test connection". Round-trips to the shop PC, so it is a user
 *  action — never a mount, never a poll. Returns ok:false rather than throwing
 *  when the PC is unreachable, because "couldn't check" is not "not connected". */
export function testQuickBooksDesktop(companyId: string): Promise<DesktopHealth> {
  return qbdRequest<DesktopHealth>(`/${companyId}/health`, { method: 'POST', body: {} });
}

export function disconnectQuickBooksDesktop(companyId: string): Promise<void> {
  return qbdRequest(`/${companyId}/disconnect`, { method: 'POST', body: {} });
}

export function listQuickBooksDesktopAccounts(
  companyId: string,
): Promise<{ accounts: DesktopIncomeAccount[] }> {
  return qbdRequest(`/${companyId}/accounts`);
}

export function setQuickBooksDesktopIncomeAccount(
  companyId: string,
  incomeAccountId: string,
): Promise<void> {
  return qbdRequest(`/${companyId}/income-account`, {
    method: 'POST',
    body: { income_account_id: incomeAccountId },
  });
}

/** One page of QuickBooks customers. Explicitly requested by a click, never on
 *  mount: this is a Web Connector round trip against a PC that may be off. */
export function listQuickBooksDesktopCustomers(
  companyId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<DesktopCustomerPage> {
  const params = new URLSearchParams();
  if (opts?.cursor) params.set('cursor', opts.cursor);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return qbdRequest<DesktopCustomerPage>(`/${companyId}/customers${qs ? `?${qs}` : ''}`);
}

export interface CustomerLinkChange {
  customer_id: string;
  /** Null unlinks. */
  qb_customer_id: string | null;
  qb_display_name?: string | null;
}

export function saveQuickBooksCustomerLinks(
  companyId: string,
  links: CustomerLinkChange[],
): Promise<{ linked: number; unlinked: number }> {
  return qbdRequest(`/${companyId}/customer-map`, { method: 'POST', body: { links } });
}

export function refreshQuickBooksDesktopTerms(
  companyId: string,
): Promise<{ terms: number }> {
  return qbdRequest(`/${companyId}/terms/refresh`, { method: 'POST', body: {} });
}

export interface CustomerLinkRow {
  customerId: string;
  qbCustomerId: string;
  qbDisplayName: string | null;
}

/** Existing links, read straight through PostgREST under RLS.
 *
 *  quickbooks_customer_map is member-readable (writes are service-role only), so
 *  this needs no backend round trip and is safe on mount — unlike the QuickBooks
 *  customer list above. */
export async function listQuickBooksCustomerLinks(
  companyId: string,
): Promise<CustomerLinkRow[]> {
  const { getSupabase } = await import('@/lib/supabase');
  const { data, error } = await getSupabase()
    .from('quickbooks_customer_map')
    .select('customer_id, qb_customer_id, qb_display_name')
    .eq('company_id', companyId);
  if (error) throw new Error('Failed to load customer links.');
  return (data ?? []).map((r) => ({
    customerId: r.customer_id,
    qbCustomerId: r.qb_customer_id,
    qbDisplayName: r.qb_display_name,
  }));
}
