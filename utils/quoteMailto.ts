import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';

/**
 * Build a `mailto:` URL that opens the user's own mail client pre-filled with
 * the quote recipient, subject, and body. Replaces the previous Resend-backed
 * server send: the email now leaves from the salesperson's mailbox, so replies
 * and a sent-copy come for free. The quote PDF can't ride along (mailto carries
 * no attachments) — the user attaches it from the PDF preview if needed.
 *
 * Subject/body are percent-encoded (encodeURIComponent → spaces as %20, which
 * mail clients render correctly; URLSearchParams' '+' encoding would show
 * literal pluses). The recipient is a single address and is left unencoded.
 */
export function buildQuoteMailto(quote: QuoteWithRelations, company: Company): string {
  const to = pickPrimaryContact(quote)?.email ?? '';
  const subject = defaultSubject(quote.quote_number, company.name);
  const body = defaultBody(quote, company, quote.created_by_member?.name ?? '');
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function defaultSubject(quoteNumber: string | null, companyName: string): string {
  const num = quoteNumber ?? 'Quote';
  return `Quote ${num} from ${companyName}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Pick the customer's primary contact from the joined customer_contacts list.
 * Mirrors the helper in utils/quotePdf.ts — same primary-row resolution rule.
 */
function pickPrimaryContact(quote: QuoteWithRelations) {
  const contacts = quote.customers?.customer_contacts ?? [];
  return contacts.find((c) => c.is_primary) ?? null;
}

function defaultBody(quote: QuoteWithRelations, company: Company, senderName: string): string {
  const primary = pickPrimaryContact(quote);
  const contactName = primary?.name || quote.customers?.name || 'there';
  const quoteNumber = quote.quote_number ?? 'attached';
  const expiry = quote.expiration_date
    ? ` The prices are valid until ${formatDate(quote.expiration_date)}.`
    : '';
  const signOff = senderName || company.name;
  return [
    `Hi ${contactName},`,
    '',
    `Please find attached Quote ${quoteNumber} for your recent inquiry.${expiry}`,
    'Let me know if you have any questions, or reply with a PO to accept.',
    '',
    'Thanks,',
    signOff,
  ].join('\n');
}
