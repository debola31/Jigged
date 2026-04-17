import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks so they're set up before imports resolve.
const { jsPDFCtor, autoTableFn, downloadFileMock } = vi.hoisted(() => {
  const saveMock = vi.fn();
  const addImageMock = vi.fn();
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
    addImage: addImageMock,
    text: textMock,
    line: lineMock,
    rect: rectMock,
    splitTextToSize: splitTextMock,
    save: saveMock,
    addPage: addPageMock,
    setPage: setPageMock,
    getNumberOfPages: getNumberOfPagesMock,
    lastAutoTable: { finalY: 400 },
  };

  const jsPDFCtor = vi.fn().mockImplementation(function () {
    return docInstance;
  });
  const autoTableFn = vi.fn();
  const downloadFileMock = vi.fn();

  return { jsPDFCtor, autoTableFn, downloadFileMock };
});

vi.mock('jspdf', () => ({
  jsPDF: jsPDFCtor,
}));

vi.mock('jspdf-autotable', () => ({
  default: autoTableFn,
}));

vi.mock('@/utils/storageHelpers', () => ({
  downloadFileFromStorage: downloadFileMock,
}));

import { generateQuotePdf } from '@/utils/quotePdf';
import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';

const baseQuote: QuoteWithRelations = {
  id: 'quote-1',
  company_id: 'company-1',
  quote_number: 'Q000123',
  customer_id: 'customer-1',
  part_id: 'part-1',
  quantity: 10,
  base_cost: 50,
  markup_percent: 40,
  estimated_labor_cost: null,
  estimated_material_cost: null,
  unit_price: 70,
  total_price: 700,
  lead_time_days: 14,
  expiration_date: '2099-12-31',
  status: 'active',
  status_changed_at: null,
  converted_to_job_id: null,
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
    address_line1: '500 Industrial Ave',
    address_line2: null,
    city: 'Detroit',
    state: 'MI',
    postal_code: '48201',
    country: 'USA',
    website: null,
  },
  parts: {
    id: 'part-1',
    part_name: 'BRKT-001',
    description: 'Steel bracket, 3/16"',
    category_id: null,
  },
  jobs: null,
  quote_attachments: [],
  created_by_member: null,
};

const baseCompany: Company = {
  id: 'company-1',
  name: 'Contour Tool & Machine',
  logo_url: null,
};

describe('generateQuotePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders and saves a PDF with a filename based on the quote number', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    expect(jsPDFCtor).toHaveBeenCalledWith({ unit: 'pt', format: 'letter' });
    expect(autoTableFn).toHaveBeenCalledTimes(1);

    const docInstance = jsPDFCtor.mock.results[0].value;
    expect(docInstance.save).toHaveBeenCalledWith('Quote-Q000123.pdf');
  });

  it('skips the logo gracefully when logo_url is null (no storage fetch)', async () => {
    await generateQuotePdf(baseQuote, { ...baseCompany, logo_url: null });

    expect(downloadFileMock).not.toHaveBeenCalled();
    const docInstance = jsPDFCtor.mock.results[0].value;
    expect(docInstance.addImage).not.toHaveBeenCalled();
  });

  it('survives a storage fetch failure without throwing', async () => {
    downloadFileMock.mockRejectedValueOnce(new Error('Storage down'));

    await expect(
      generateQuotePdf(baseQuote, { ...baseCompany, logo_url: 'company-1/company/logo.png' })
    ).resolves.toBeUndefined();

    const docInstance = jsPDFCtor.mock.results[0].value;
    expect(docInstance.save).toHaveBeenCalled();
  });

  it('renders without a customer (null customers) without throwing', async () => {
    const sparseQuote: QuoteWithRelations = { ...baseQuote, customers: null };

    await expect(generateQuotePdf(sparseQuote, baseCompany)).resolves.toBeUndefined();

    const docInstance = jsPDFCtor.mock.results[0].value;
    expect(docInstance.save).toHaveBeenCalled();
  });

  it('uses parts.description (not a removed quote.description) for the line description', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const call = autoTableFn.mock.calls[0];
    const config = call[1];
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
      parts: { ...baseQuote.parts!, description: null },
    };

    await generateQuotePdf(noDescQuote, baseCompany);

    const call = autoTableFn.mock.calls[0];
    const [, description] = call[1].body[0];
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
      typeof c[0] === 'string' && (c[0] as string).startsWith('THIS QUOTE HAS EXPIRED')
    );
    expect(bannerCall).toBeDefined();
  });

  it('does not render an EXPIRED banner for an active quote with a future expiration', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    const bannerCall = docInstance.text.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).startsWith('THIS QUOTE HAS EXPIRED')
    );
    expect(bannerCall).toBeUndefined();
  });

  it('includes Valid Until and Lead Time in the header meta when present', async () => {
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

  it('renders the FROM block with whatever company contact fields are populated', async () => {
    const filledCompany: Company = {
      ...baseCompany,
      phone: '313-555-0100',
      email: 'sales@contour.example',
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

    expect(rendered).toContain('FROM');
    expect(rendered).toContain('1 Shop Street');
    expect(rendered).toContain('313-555-0100');
    expect(rendered).toContain('sales@contour.example');
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
});
