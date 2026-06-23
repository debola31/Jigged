import { describe, it, expect } from 'vitest';
import {
  buildQuoteMailto,
  defaultSubject,
  defaultBody,
  pickPrimaryContact,
} from '@/utils/quoteMailto';
import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';

const company: Company = { id: 'co-1', name: 'Acme Precision' };

const quote = {
  quote_number: 'Q-0007',
  expiration_date: '2099-12-31',
  created_by_member: { user_id: 'u1', name: 'Sam T', email: 'sam@acme.example' },
  customers: {
    name: 'Beta Mfg',
    customer_contacts: [
      { id: 'c1', name: 'Jane Buyer', email: 'jane@beta.example', is_primary: true },
      { id: 'c2', name: 'Bob Backup', email: 'bob@beta.example', is_primary: false },
    ],
  },
} as unknown as QuoteWithRelations;

function parseMailto(url: string) {
  expect(url.startsWith('mailto:')).toBe(true);
  const [, rest] = url.split('mailto:');
  const qIndex = rest.indexOf('?');
  const to = rest.slice(0, qIndex);
  const params = new URLSearchParams(rest.slice(qIndex + 1));
  return { to, params };
}

describe('buildQuoteMailto', () => {
  it('defaults the recipient to the primary contact and fills subject + body', () => {
    const url = buildQuoteMailto(quote, company);
    const { to, params } = parseMailto(url);
    expect(to).toBe('jane@beta.example');
    expect(params.get('subject')).toBe('Quote Q-0007 from Acme Precision');
    expect(params.get('body')).toContain('Hi Jane Buyer,');
    // No cc param when none supplied.
    expect(params.has('cc')).toBe(false);
  });

  it('joins multiple To recipients with commas and adds a Cc param', () => {
    const url = buildQuoteMailto(quote, company, {
      to: ['jane@beta.example', 'bob@beta.example'],
      cc: ['boss@beta.example', 'me@acme.example'],
    });
    const { to, params } = parseMailto(url);
    expect(to).toBe('jane@beta.example,bob@beta.example');
    // URLSearchParams decodes the cc value back to a comma list.
    expect(params.get('cc')).toBe('boss@beta.example,me@acme.example');
  });

  it('uses subject/body overrides when provided and encodes spaces as %20 (not +)', () => {
    const url = buildQuoteMailto(quote, company, {
      to: ['x@y.com'],
      subject: 'Custom subject here',
      body: 'Line one here',
    });
    // %20 encoding keeps mail clients from showing literal "+" for spaces.
    expect(url).toContain('subject=Custom%20subject%20here');
    expect(url).not.toContain('subject=Custom+subject+here');
    const { params } = parseMailto(url);
    expect(params.get('body')).toBe('Line one here');
  });
});

describe('quoteMailto helpers (exported for the email dialog)', () => {
  it('pickPrimaryContact returns the is_primary contact', () => {
    expect(pickPrimaryContact(quote)?.email).toBe('jane@beta.example');
  });

  it('defaultSubject and defaultBody compose the standard message', () => {
    expect(defaultSubject('Q-0007', 'Acme Precision')).toBe('Quote Q-0007 from Acme Precision');
    const body = defaultBody(quote, company, 'Sam T');
    expect(body).toContain('Quote Q-0007');
    expect(body).toContain('reply with a PO to accept');
    expect(body.trimEnd().endsWith('Sam T')).toBe(true);
  });
});
