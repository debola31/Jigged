import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks so they're set up before imports resolve.
const { jsPDFCtor, autoTableFn, downloadFileMock } = vi.hoisted(() => {
  const saveMock = vi.fn();
  const addImageMock = vi.fn();
  const textMock = vi.fn();
  const lineMock = vi.fn();
  const splitTextMock = vi.fn().mockReturnValue(['wrapped']);

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
    addImage: addImageMock,
    text: textMock,
    line: lineMock,
    splitTextToSize: splitTextMock,
    save: saveMock,
    lastAutoTable: { finalY: 400 },
  };

  // Use a regular function so `new jsPDF(...)` can invoke it as a constructor.
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
  description: 'First article — rush order',
  quantity: 10,
  base_cost: 50,
  markup_percent: 40,
  estimated_labor_cost: null,
  estimated_material_cost: null,
  unit_price: 70,
  total_price: 700,
  status: 'pending_approval',
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

  it('skips the notes section when description is empty', async () => {
    const noNotesQuote: QuoteWithRelations = { ...baseQuote, description: '' };

    await generateQuotePdf(noNotesQuote, baseCompany);

    const docInstance = jsPDFCtor.mock.results[0].value;
    expect(docInstance.splitTextToSize).not.toHaveBeenCalled();
  });

  it('feeds the line-item row to autoTable with part, qty, and formatted prices', async () => {
    await generateQuotePdf(baseQuote, baseCompany);

    const call = autoTableFn.mock.calls[0];
    const config = call[1];
    expect(config.body).toHaveLength(1);
    const [part, description, qty, unitPrice, total] = config.body[0];
    expect(part).toBe('BRKT-001');
    expect(description).toBe('First article — rush order');
    expect(qty).toBe('10');
    expect(unitPrice).toContain('$70');
    expect(total).toContain('$700');
  });
});
