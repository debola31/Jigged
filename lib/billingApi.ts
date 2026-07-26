/**
 * Thin client for the FastAPI Stripe endpoints. Checkout and Portal return
 * Stripe-hosted URLs; the caller redirects the browser to them (no Stripe.js).
 */
import { getTypedSupabase } from '@/lib/supabase';
import { API_BASE_URL } from '@/lib/api';

async function authToken(): Promise<string> {
  const supabase = getTypedSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.');
  }
  return session.access_token;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const token = await authToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const b = await res.json();
      if (typeof b?.detail === 'string') detail = b.detail;
    } catch {
      /* keep default */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

/** Create a Checkout Session and return its hosted URL. */
export async function startCheckout(companyId: string): Promise<string> {
  const { url } = await postJson<{ url: string }>('/api/stripe/checkout', {
    company_id: companyId,
  });
  return url;
}

/** Create a Customer Portal session and return its hosted URL. */
export async function openBillingPortal(companyId: string): Promise<string> {
  const { url } = await postJson<{ url: string }>('/api/stripe/portal', {
    company_id: companyId,
  });
  return url;
}

/** Reconcile the cache from a completed Checkout Session (success-page fallback). */
export async function syncCheckout(
  companyId: string,
  sessionId: string,
): Promise<{ status: string | null }> {
  return postJson<{ status: string | null }>('/api/stripe/checkout/sync', {
    company_id: companyId,
    session_id: sessionId,
  });
}

/**
 * Refresh the billing cache from Stripe's live state (called when the billing
 * card is viewed) so it's accurate even if a webhook was missed. A no-op server
 * side when the company has no Stripe customer.
 */
export async function reconcileBilling(companyId: string): Promise<{ status: string | null }> {
  return postJson<{ status: string | null }>('/api/stripe/reconcile', {
    company_id: companyId,
  });
}
