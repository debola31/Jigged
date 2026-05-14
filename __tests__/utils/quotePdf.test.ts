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
}));

import { generateQuotePdf } from '@/utils/quotePdf';
import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';

const baseQuote: QuoteWithRelations = {
  id: 'quote-1',
  company_id: 'company-1',
  quote_number: 'Q000123',
  customer_id: 'customer-1',
  lead_time_days: 14,
  expiration_date: '2099-12-31',
  status: 'active',
  status_changed_at: null,
  converted_at: null,
  legacy_quote_number: null,
  created_by: null,
  created_at: '2026-04-16T10:00:00Z',
  updated_at: '2026-04-16T10:00:00Z',
  customers: {
    id: 'customer-1',
    name: 'Acme Machining',
    contact_name: 'Jane Smith',
    contact_email: 'jane@acme.example',
    contact_phone: '555-0123',
    website: null,
    addresses: [
      {
        id: 'addr-1',
        address_line1: '500 Industrial Ave',
        address_line2: null,
        city: 'Detroit',
        state: 'MI',
        postal_code: '48201',
        country: 'USA',
        is_billing: true,
        is_shipping: true,
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
      },
    },
  ],
  jobs: [],
  quote_attachments: [],
  created_by_member: null,
};

const baseCompany: Company = {
  id: 'company-1',
  name: 'Contour Tool & Machine',
};

describe('generateQuotePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders and saves a PDF with a filename based on the quote number', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    expect(jsPDFCtor).toHaveBeenCalledWith({ unit: 'pt', format: 'letter' });
    // One main line items table + zero tier sub-tables (no tiers loaded).
    expect(autoTableFn).toHaveBeenCalled();

    const docInstance = jsPDFCtor.mock.results[0].value;
    expect(docInstance.save).toHaveBeenCalledWith('Quote-Q000123.pdf');
  });

  it('renders without a customer (null customers) without throwing', async () => {
    const sparseQuote: QuoteWithRelations = { ...baseQuote, customers: null };

    await expect(generateQuotePdf(sparseQuote, baseCompany)).resolves.toBeUndefined();

    const docInstance = jsPDFCtor.mock.results[0].value;
    expect(docInstance.save).toHaveBeenCalled();
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
      lead_time_days: null,
    };

    await generateQuotePdf(barebonesQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const metaTexts = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(metaTexts.some((t: string) => t.startsWith('Valid Until:'))).toBe(false);
    expect(metaTexts.some((t: string) => t.startsWith('Lead Time:'))).toBe(false);
  });

  it('renders the company shop block (top-left) with name + address + phone', async () => {
    const filledCompany: Company = {
      ...baseCompany,
      phone: '313-555-0100',
      email: 'sales@contour.example',
      website: 'https://contour.example',
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

    expect(rendered).toContain('Contour Tool & Machine');
    expect(rendered).toContain('1 Shop Street');
    expect(rendered).toContain('313-555-0100');
    // Email and website are intentionally suppressed in the printable header.
    expect(rendered).not.toContain('sales@contour.example');
    expect(rendered).not.toContain('https://contour.example');
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
    expect(rendered).toContain('BILL TO');
  });

  it('renders the static ACCEPTANCE block (signature, PO#)', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).toContain('ACCEPTANCE');
    expect(rendered).toContain('Signature');
    expect(rendered).toContain('PO #');
    expect(rendered).toContain('Date');
  });

  it('renders a CREATED BY block (left of BILL TO) when creator is known', async () => {
    const quoteWithCreator: QuoteWithRelations = {
      ...baseQuote,
      created_by: 'user-1',
      created_by_member: { user_id: 'user-1', name: 'Johnny T', email: 'johnny@example.com' },
    };

    await generateQuotePdf(quoteWithCreator, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).toContain('CREATED BY');
    expect(rendered).toContain('Johnny T');
    expect(rendered).toContain('johnny@example.com');
  });

  it('omits the CREATED BY label when there is no creator on the quote', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered).not.toContain('CREATED BY');
    // BILL TO is still rendered.
    expect(rendered).toContain('BILL TO');
  });

  it('renders a separate Pricing Tiers section for multi-tier parts', async () => {
    const tierMockModule = await import('@/utils/partPricingTiersAccess');
    const getTiersMock = vi.mocked(tierMockModule.getTiersForPart);
    getTiersMock.mockResolvedValueOnce([
      {
        id: 't1', part_id: 'part-1', company_id: 'company-1', sequence: 1, quantity: 1,
        markup_percent: 40, unit_price: 70,
        created_at: '', updated_at: '',
      },
      {
        id: 't10', part_id: 'part-1', company_id: 'company-1', sequence: 2, quantity: 10,
        markup_percent: 40, unit_price: 65,
        created_at: '', updated_at: '',
      },
    ]);

    const quoteWithTier: QuoteWithRelations = {
      ...baseQuote,
      line_items: [
        { ...baseQuote.line_items![0], source_tier_id: 't10' },
      ],
    };

    await generateQuotePdf(quoteWithTier, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    // Section header is drawn outside autoTable
    expect(rendered.some((t: string) => t.includes('PRICING TIERS'))).toBe(true);

    // The tier sub-table is rendered as the SECOND autoTable call
    expect(autoTableFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    const tierCall = autoTableFn.mock.calls[1];
    const tierBody = tierCall[1].body;
    // Each row shape: [marker, qty, "{price} each", caption]
    const rowFor10 = tierBody.find((r: string[]) => r[1] === '10');
    expect(rowFor10).toBeDefined();
    expect(rowFor10[2]).toMatch(/each$/);
    expect(rowFor10[0]).toBe('>');

    getTiersMock.mockReset();
  });

  it('does not render a Pricing Tiers section for an overridden line', async () => {
    const overrideQuote: QuoteWithRelations = {
      ...baseQuote,
      line_items: [{ ...baseQuote.line_items![0], is_quote_override: true }],
    };

    await generateQuotePdf(overrideQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const rendered = docInstance.text.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((t: unknown): t is string => typeof t === 'string');

    expect(rendered.some((t: string) => t.includes('PRICING TIERS'))).toBe(false);
  });
});
