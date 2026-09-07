/**
 * Shared helpers for transactional emails sent from Edge Functions (team-invites,
 * team password-reset, …). Centralizes the two values that must stay identical
 * across every Resend sender so they can't drift.
 */

/**
 * Canonical, request-independent base URL for links and images embedded in
 * outbound emails. Deliberately NOT derived from the request origin
 * (getOriginUrl) — an admin sending mail from a Vercel preview must not mint an
 * email that points at an ephemeral preview URL that gets torn down. Set the
 * SITE_URL secret per environment (the staging URL on staging).
 *
 * The default must always name the host Vercel serves as primary — currently the
 * apex (#695). In an email a redirect is not free: Outlook commonly declines to
 * follow one when loading a remote image, so while this default named the host
 * that 307s, our logo rendered as a broken box on exactly the message that most
 * needs to look legitimate (#722), and the same mismatch cost five days of
 * Stripe webhooks. **The `SITE_URL` secret overrides this in every deployed
 * environment, so changing the line below is not enough** — the secret has to
 * move too, and it is set outside this repo.
 */
export function getEmailBaseUrl(): string {
  return Deno.env.get('SITE_URL') ?? 'https://jigged.app';
}

/**
 * The From address for transactional email. Single env-configurable value so the
 * sender is a one-line switch later. Domain stays jigged.app; hello@ is a live
 * Google Workspace alias, so replies reach a real inbox (unlike noreply@).
 */
export function getEmailFrom(): string {
  return Deno.env.get('JIGGED_FROM_EMAIL') ?? 'Jigged <hello@jigged.app>';
}
