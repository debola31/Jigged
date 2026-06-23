import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';

export interface QuoteMailtoOptions {
  /** Recipient addresses. Defaults to the customer's primary contact email. */
  to?: string[];
  /** CC addresses. Omitted when empty. */
  cc?: string[];
  /** Override the default subject (e.g. the user edited it in the dialog). */
  subject?: string;
  /** Override the default body. */
  body?: string;
}

/**
 * Build a `mailto:` URL that opens the user's own mail client pre-filled with
 * the quote recipients, subject, and body. The email leaves from the
 * salesperson's mailbox, so replies and a sent-copy come for free. The quote
 * PDF can't ride along (mailto carries no attachments) — the QuoteEmailDialog
 * downloads the PDF alongside opening this URL and reminds the user to attach it.
 *
 * Subject/body/cc are percent-encoded (encodeURIComponent → spaces as %20,
 * which mail clients render correctly; URLSearchParams' '+' encoding would show
 * literal pluses). The `to` recipients are comma-joined and left unencoded
 * (the mailto spec's address-list form).
 */
export function buildQuoteMailto(
  quote: QuoteWithRelations,
  company: Company,
  opts: QuoteMailtoOptions = {},
): string {
  const toList =
    opts.to && opts.to.length > 0
      ? opts.to
      : ([pickPrimaryContact(quote)?.email].filter(Boolean) as string[]);
  const subject = opts.subject ?? defaultSubject(quote.quote_number, company.name);
  const body = opts.body ?? defaultBody(quote, company, quote.created_by_member?.name ?? '');

  const query: string[] = [];
  if (opts.cc && opts.cc.length > 0) {
    query.push(`cc=${encodeURIComponent(opts.cc.join(','))}`);
  }
  query.push(`subject=${encodeURIComponent(subject)}`);
  query.push(`body=${encodeURIComponent(body)}`);

  return `mailto:${toList.join(',')}?${query.join('&')}`;
}

export function defaultSubject(quoteNumber: string | null, companyName: string): string {
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
export function pickPrimaryContact(quote: QuoteWithRelations) {
  const contacts = quote.customers?.customer_contacts ?? [];
  return contacts.find((c) => c.is_primary) ?? null;
}

export function defaultBody(quote: QuoteWithRelations, company: Company, senderName: string): string {
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
