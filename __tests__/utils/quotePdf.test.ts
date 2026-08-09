import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks so they're set up before imports resolve.
const { jsPDFCtor, autoTableFn } = vi.hoisted(() => {
  const saveMock = vi.fn();
  const textMock = vi.fn();
  const lineMock = vi.fn();
  const rectMock = vi.fn();
  const splitTextMock = vi.fn().mockReturnValue(['wrapped']);
  const addPageMock = vi.fn();
  const setPageMock = vi.fn();
  const getNumberOfPagesMock = vi.fn().mockReturnValue(1);

  const docInstance = {
    internal: {
      pageSize: {
        getWidth: () => 612,
        getHeight: () => 792,
      },
    },
    setFont: vi.fn(),
    setFontSize: vi.fn(),
    setTextColor: vi.fn(),
    setDrawColor: vi.fn(),
    setLineWidth: vi.fn(),
    setFillColor: vi.fn(),
    text: textMock,
    line: lineMock,
    rect: rectMock,
    splitTextToSize: splitTextMock,
    save: saveMock,
    addPage: addPageMock,
    setPage: setPageMock,
    getNumberOfPages: getNumberOfPagesMock,
    getTextWidth: vi.fn().mockReturnValue(50),
    lastAutoTable: { finalY: 400 },
  };

  const jsPDFCtor = vi.fn().mockImplementation(function () {
    return docInstance;
  });
  const autoTableFn = vi.fn();

  return { jsPDFCtor, autoTableFn };
});

vi.mock('jspdf', () => ({
  jsPDF: jsPDFCtor,
}));

vi.mock('jspdf-autotable', () => ({
  default: autoTableFn,
}));

vi.mock('@/utils/partPricingTiersAccess', () => ({
  getTiersForPart: vi.fn().mockResolvedValue([]),
  getTiersWithComputedPrices: vi.fn().mockResolvedValue([]),
}));

import { generateQuotePdf, quotePdfFilename } from '@/utils/quotePdf';
import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';

const baseQuote: QuoteWithRelations = {
  id: 'quote-1',
  company_id: 'company-1',
  quote_number: 'Q000123',
  customer_id: 'customer-1',
  customer_po_number: 'CUST-PO-555',
  billing_address_id: 'addr-1',
  shipping_address_id: 'addr-1',
  contact_id: 'contact-1',
  lead_time_text: '14 days',
  payment_terms: null,
  expiration_date: '2099-12-31',
  status: 'active',
  status_changed_at: null,
  converted_at: null,
  created_by: null,
  created_at: '2026-04-16T10:00:00Z',
  updated_at: '2026-04-16T10:00:00Z',
  // Document Snapshot Standard: the PDF renders these frozen snapshots, not the
  // live customers/addresses join below (which now only feeds the edit form).
  customer_name: 'Acme Machining',
  bill_to_address: {
    address_line1: '500 Industrial Ave',
    address_line2: null,
    city: 'Detroit',
    state: 'MI',
    postal_code: '48201',
    country: 'USA',
    attention_to: null,
  },
  ship_to_address: {
    address_line1: '500 Industrial Ave',
    address_line2: null,
    city: 'Detroit',
    state: 'MI',
    postal_code: '48201',
    country: 'USA',
    attention_to: null,
  },
  contact_snapshot: { name: 'Jane Smith', email: 'jane@acme.example', phone: '555-0123' },
  customers: {
    id: 'customer-1',
    name: 'Acme Machining',
    website: null,
    customer_contacts: [
      {
        id: 'contact-1',
        name: 'Jane Smith',
        role: 'buyer',
        email: 'jane@acme.example',
        phone: '555-0123',
        is_primary: true,
      },
    ],
    addresses: [
      {
        id: 'addr-1',
        address_line1: '500 Industrial Ave',
        address_line2: null,
        city: 'Detroit',
        state: 'MI',
        postal_code: '48201',
        country: 'USA',
        default_billing: true,
        default_shipping: true,
        attention_to: null,
      },
    ],
  },
  line_items: [
    {
      id: 'li-1',
      quote_id: 'quote-1',
      company_id: 'company-1',
      part_id: 'part-1',
      source_tier_id: null,
      sequence: 10,
      quantity: 10,
      unit_price: 70,
      total_price: 700,
      markup_percent: 40,
      base_cost_per_unit: 50,
      is_quote_override: false,
      created_at: '2026-04-16T10:00:00Z',
      parts: {
        id: 'part-1',
        part_name: 'BRKT-001',
        description: 'Steel bracket, 3/16"',
        primary_unit: 'each',
      },
    },
  ],
  jobs: [],
  quote_attachments: [],
  created_by_member: null,
};

const baseCompany: Company = {
  id: 'company-1',
  name: 'Acme Precision Machining',
};

describe('generateQuotePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the jsPDF doc without saving (caller decides what to do)', async () => {
    const doc = await generateQuotePdf(baseQuote, baseCompany);

    expect(jsPDFCtor).toHaveBeenCalledWith({ unit: 'pt', format: 'letter' });
    // One main line items table + zero tier sub-tables (no tiers loaded).
    expect(autoTableFn).toHaveBeenCalled();

    const docInstance = jsPDFCtor.mock.results[0].value;
    expect(doc).toBe(docInstance);
    // Saving is the caller's responsibility now.
    expect(docInstance.save).not.toHaveBeenCalled();
  });

  it('renders without a customer (null customers) without throwing', async () => {
    const sparseQuote: QuoteWithRelations = { ...baseQuote, customers: null };

    const doc = await generateQuotePdf(sparseQuote, baseCompany);
    expect(doc).toBeDefined();
  });

  it('renders the line items table with Part / Description / Order qty / Unit price / Total', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const headCall = autoTableFn.mock.calls[0];
    const config = headCall[1];
    expect(config.head).toEqual([
      ['Part', 'Description', 'Order qty', 'Unit price', 'Total'],
    ]);
    const [part, description, qty, unitPrice, total] = config.body[0];
    expect(part).toBe('BRKT-001');
    expect(description).toBe('Steel bracket, 3/16"');
    expect(qty).toBe('10');
    expect(unitPrice).toContain('$70');
    expect(total).toContain('$700');
  });

  it('labels a fractional quantity with the part unit (e.g. "0.32 in") for non-count parts', async () => {
    const lengthQuote: QuoteWithRelations = {
      ...baseQuote,
      line_items: [
        {
          ...baseQuote.line_items![0],
          quantity: 0.32,
          parts: {
            ...baseQuote.line_items![0].parts!,
            part_name: 'BAR-STOCK',
            primary_unit: 'inches',
          },
        },
      ],
    };

    await generateQuotePdf(lengthQuote, baseCompany);

    const config = autoTableFn.mock.calls[0][1];
    const [, , qty] = config.body[0];
    expect(qty).toBe('0.32 in');
  });

  it('leaves the description cell blank when parts.description is null', async () => {
    const noDescQuote: QuoteWithRelations = {
      ...baseQuote,
      line_items: [
        {
          ...baseQuote.line_items![0],
          parts: { ...baseQuote.line_items![0].parts!, description: null },
        },
      ],
    };

    await generateQuotePdf(noDescQuote, baseCompany);

    const headCall = autoTableFn.mock.calls[0];
    const [, description] = headCall[1].body[0];
    expect(description).toBe('');
  });

  it('renders an EXPIRED banner when the quote is past its expiration date', async () => {
    const expiredQuote: QuoteWithRelations = {
      ...baseQuote,
      expiration_date: '2020-01-01',
    };

    await generateQuotePdf(expiredQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const bannerCall = docInstance.text.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).startsWith('THIS QUOTE HAS EXPIRED'),
    );
    expect(bannerCall).toBeDefined();
  });

  it('does not render an EXPIRED banner for an active quote with a future expiration', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const bannerCall = docInstance.text.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).startsWith('THIS QUOTE HAS EXPIRED'),
    );
    expect(bannerCall).toBeUndefined();
  });

  it('includes Valid Until and Lead Time in the stacked header meta when present', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const metaTexts = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(metaTexts.some((t: string) => t.startsWith('Valid Until:'))).toBe(true);
    expect(metaTexts.some((t: string) => t === 'Lead Time: 14 days ARO')).toBe(true);
  });

  it('omits Valid Until / Lead Time rows when fields are null', async () => {
    const barebonesQuote: QuoteWithRelations = {
      ...baseQuote,
      expiration_date: null,
      lead_time_text: null,
    };

    await generateQuotePdf(barebonesQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const metaTexts = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(metaTexts.some((t: string) => t.startsWith('Valid Until:'))).toBe(false);
    expect(metaTexts.some((t: string) => t.startsWith('Lead Time:'))).toBe(false);
  });

  it('shows lead time per item (in the description cell) and drops the header row when items differ', async () => {
    const quote: QuoteWithRelations = {
      ...baseQuote,
      line_items: [
        {
          ...baseQuote.line_items![0],
          id: 'li-1',
          part_id: 'part-1',
          sequence: 10,
          lead_time_text: '2–3 weeks',
          parts: { ...baseQuote.line_items![0].parts!, id: 'part-1', part_name: 'BRKT-001' },
        },
        {
          ...baseQuote.line_items![0],
          id: 'li-2',
          part_id: 'part-2',
          sequence: 20,
          lead_time_text: '3–4 weeks',
          parts: {
            ...baseQuote.line_items![0].parts!,
            id: 'part-2',
            part_name: 'HSNG-002',
            description: 'Housing',
          },
        },
      ],
    };

    await generateQuotePdf(quote, baseCompany);

    // The single quote-level lead-time meta row is suppressed…
    const docInstance = jsPDFCtor.mock.results[0].value;
    const metaTexts = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');
    expect(metaTexts.some((t: string) => t.startsWith('Lead Time:'))).toBe(false);

    // …and each item's lead time appears in the line-items table instead.
    const config = autoTableFn.mock.calls[0][1];
    const bodyText = JSON.stringify(config.body);
    expect(bodyText).toContain('Lead time: 2–3 weeks');
    expect(bodyText).toContain('Lead time: 3–4 weeks');
  });

  it('renders the company shop block (top-left) with name + address + phone', async () => {
    const filledCompany: Company = {
      ...baseCompany,
      phone: '313-555-0100',
      email: 'sales@acmeprecision.example',
      website: 'https://acmeprecision.example',
      address_line1: '1 Shop Street',
      city: 'Detroit',
      state: 'MI',
      postal_code: '48201',
    };

    await generateQuotePdf(baseQuote, filledCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).toContain('Acme Precision Machining');
    expect(rendered).toContain('1 Shop Street');
    expect(rendered).toContain('313-555-0100');
    // Email and website are intentionally suppressed in the printable header.
    expect(rendered).not.toContain('sales@acmeprecision.example');
    expect(rendered).not.toContain('https://acmeprecision.example');
  });

  it('combines short address_line1 + address_line2 onto a single line', async () => {
    const c: Company = {
      ...baseCompany,
      address_line1: '500 Industrial Ave',
      address_line2: 'Suite 4',
    };

    await generateQuotePdf(baseQuote, c);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).toContain('500 Industrial Ave, Suite 4');
    // Stand-alone "Suite 4" line is NOT rendered separately.
    expect(rendered).not.toContain('Suite 4');
  });

  it('falls back to two stacked address lines when combined would be too long', async () => {
    const c: Company = {
      ...baseCompany,
      address_line1: '1234 Very Long Industrial Boulevard Avenue',
      address_line2: 'Building C, Suite 1500-A',
    };

    await generateQuotePdf(baseQuote, c);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).toContain('1234 Very Long Industrial Boulevard Avenue');
    expect(rendered).toContain('Building C, Suite 1500-A');
  });

  it('does not render a FROM section label (replaced by top-left shop header)', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).not.toContain('FROM');
    // BILL TO / SHIPPING ADDRESS are not rendered — the quote PDF shows a
    // CUSTOMER block (customer name + billing address) only.
    expect(rendered).not.toContain('BILL TO');
    expect(rendered).not.toContain('SHIPPING ADDRESS');
    expect(rendered).toContain('CUSTOMER');
  });

  it('does not render the billing address attention_to (Attn:) line in the CUSTOMER block', async () => {
    const quoteWithAttn: QuoteWithRelations = {
      ...baseQuote,
      bill_to_address: { ...baseQuote.bill_to_address!, attention_to: 'Receiving Dept' },
    };

    await generateQuotePdf(quoteWithAttn, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).toContain('CUSTOMER');
    expect(rendered).not.toContain('Attn: Receiving Dept');
    expect(rendered.some((t) => t.includes('Receiving Dept'))).toBe(false);
  });

  it('renders the customer block from the frozen snapshot, surviving address deletion (FK nulled)', async () => {
    // Simulate an address deleted after the quote was issued: ON DELETE SET NULL
    // nulls billing_address_id and strips it from the live customers join, but
    // the snapshot persists and is what the PDF must render.
    const afterDelete: QuoteWithRelations = {
      ...baseQuote,
      billing_address_id: null,
      shipping_address_id: null,
      customers: { ...baseQuote.customers!, addresses: [] },
    };

    await generateQuotePdf(afterDelete, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).toContain('Acme Machining');
    expect(rendered).toContain('500 Industrial Ave');
    expect(rendered.some((t) => t.includes('Detroit'))).toBe(true);
    // Contact snapshot still renders too.
    expect(rendered).toContain('Jane Smith');
  });

  it('no longer renders an ACCEPTANCE block (acceptance is by returning a PO)', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).not.toContain('ACCEPTANCE');
    // The old acceptance sentence (wrapped via splitTextToSize) is gone too.
    const splitInputs = docInstance.splitTextToSize.mock.calls.map((c: unknown[]) => c[0]);
    expect(
      splitInputs.some(
        (t: unknown) => typeof t === 'string' && t.includes('purchase order referencing quote'),
      ),
    ).toBe(false);
  });

  it('renders a "Prepared by" line (not a CREATED BY column) when the creator is known', async () => {
    const quoteWithCreator: QuoteWithRelations = {
      ...baseQuote,
      created_by: 'user-1',
      created_by_member: { user_id: 'user-1', name: 'Sam T', email: 'sam@example.com' },
    };

    await generateQuotePdf(quoteWithCreator, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    // "Created by" is no longer a top column — it's a "Prepared by" footer line
    // that replaced the old "Generated <date> · <company>" footer text.
    expect(rendered).not.toContain('CREATED BY');
    expect(rendered).toContain('Prepared by Sam T · sam@example.com');
    expect(rendered.some((t) => t.startsWith('Generated'))).toBe(false);
  });

  /**
   * **A quote carries no `Generated … with jigged.app` line, unlike the packing slip and the job
   * traveler.** Those two are internal-to-the-transaction paperwork; a quote is a commercial offer
   * the shop puts its own name to, and the tool it was drafted in is not a party to it. Asserted
   * rather than assumed, because the natural way to add attribution "everywhere" is a loop over the
   * generators, and this is the one that must stay out.
   */
  it('never names the tool it was drafted in', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered.some((t) => t.includes('jigged.app'))).toBe(false);
    expect(rendered.some((t) => t.startsWith('Generated'))).toBe(false);
  });

  it('omits the "Prepared by" line when there is no creator on the quote', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).not.toContain('CREATED BY');
    expect(rendered.some((t) => t.startsWith('Prepared by'))).toBe(false);
    // The CUSTOMER block is still rendered.
    expect(rendered).toContain('CUSTOMER');
  });

  it('renders a SHIP TO column only when the shipping address differs from billing', async () => {
    // Base quote: billing and shipping point at the same address → no SHIP TO.
    await generateQuotePdf(baseQuote, baseCompany);
    let docInstance = jsPDFCtor.mock.results[0].value;
    let rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');
    expect(rendered).not.toContain('SHIP TO');

    vi.clearAllMocks();

    // Distinct shipping-address snapshot → SHIP TO column with its lines. The
    // PDF reads the frozen ship_to_address snapshot (compared by value against
    // bill_to_address), not the live address book.
    const twoAddr: QuoteWithRelations = {
      ...baseQuote,
      shipping_address_id: 'addr-2',
      ship_to_address: {
        address_line1: '99 Dock Road',
        address_line2: null,
        city: 'Toledo',
        state: 'OH',
        postal_code: '43601',
        country: 'USA',
        attention_to: null,
      },
    };
    await generateQuotePdf(twoAddr, baseCompany);
    docInstance = jsPDFCtor.mock.results[0].value;
    rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');
    expect(rendered).toContain('SHIP TO');
    expect(rendered).toContain('99 Dock Road');
  });

  it('renders ONE table with the part spanning its quantity rows (no grand total) for an options quote', async () => {
    // Two quantities for the SAME part → a price-options quote.
    const optionsQuote: QuoteWithRelations = {
      ...baseQuote,
      line_items: [
        { ...baseQuote.line_items![0], id: 'li-1', sequence: 10, quantity: 5, unit_price: 80, total_price: 400 },
        { ...baseQuote.line_items![0], id: 'li-2', sequence: 20, quantity: 25, unit_price: 60, total_price: 1500 },
      ],
    };

    await generateQuotePdf(optionsQuote, baseCompany);

    // A single unified table (firm-style head) — NOT separate per-part tables.
    expect(autoTableFn).toHaveBeenCalledTimes(1);
    const config = autoTableFn.mock.calls[0][1];
    expect(config.head).toEqual([['Part', 'Description', 'Order qty', 'Unit price', 'Total']]);

    // Two body rows; the part name + description span both quantities (rowSpan
    // on the first row), and the first row also carries the first quantity.
    expect(config.body).toHaveLength(2);
    expect(config.body[0][0]).toMatchObject({ content: 'BRKT-001', rowSpan: 2 });
    expect(config.body[0][2]).toBe('5'); // [part, desc, qty, unit, total]
    expect(config.body[1][0]).toBe('25'); // continuation row: [qty, unit, total]

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    // No grand-total "Total" line is drawn for a price-options quote.
    expect(rendered.some((t: string) => t === 'Total')).toBe(false);
  });
});

describe('quotePdfFilename', () => {
  it('formats as Quote-{quote_number}.pdf', () => {
    expect(quotePdfFilename(baseQuote)).toBe('Quote-Q000123.pdf');
  });
});
