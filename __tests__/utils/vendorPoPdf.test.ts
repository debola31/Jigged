import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * THE SUITE MOCKS jsPDF WHOLESALE (the outside-processing slip's pattern), so nothing here can see
 * overflow or real geometry. What survives mocking is ORDER, ARGUMENT VALUES and FONT STATE — and
 * what the document must never print. The PR's manual render check covers the rest (plan §5.6).
 */
/** What autoTable is handed: the one column spec's head and body, and the typed end-of-table hook. */
interface TableOptions {
  head: string[][];
  body: string[][];
  didDrawPage?: (data: { cursor: { x: number; y: number } }) => void;
}

const { jsPDFCtor, autoTableFn, doc, logo } = vi.hoisted(() => {
  const docInstance = {
    internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
    setFont: vi.fn(),
    setFontSize: vi.fn(),
    setTextColor: vi.fn(),
    setDrawColor: vi.fn(),
    setLineWidth: vi.fn(),
    setFillColor: vi.fn(),
    text: vi.fn(),
    line: vi.fn(),
    rect: vi.fn(),
    splitTextToSize: vi.fn().mockReturnValue(['wrapped']),
    save: vi.fn(),
    addPage: vi.fn(),
    setPage: vi.fn(),
    getNumberOfPages: vi.fn().mockReturnValue(1),
    getTextWidth: vi.fn().mockReturnValue(50),
    addImage: vi.fn(),
    getImageProperties: vi.fn().mockReturnValue({ width: 400, height: 100, fileType: 'PNG' }),
  };
  return {
    jsPDFCtor: vi.fn().mockImplementation(function () {
      return docInstance;
    }),
    // The real autoTable reports where it ended through its typed didDrawPage hook; the mock
    // does the same, so the generator never needs `lastAutoTable` (an untyped property).
    autoTableFn: vi.fn((_doc: unknown, options: TableOptions) => {
      options.didDrawPage?.({ cursor: { x: 40, y: 400 } });
    }),
    doc: docInstance,
    logo: { url: null as string | null },
  };
});

vi.mock('jspdf', () => ({ jsPDF: jsPDFCtor }));
vi.mock('jspdf-autotable', () => ({ default: autoTableFn }));
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));
// The logo fetch itself is the slip's business (and tested there); here only its result matters.
vi.mock('@/utils/packingSlipPdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/packingSlipPdf')>()),
  loadLogoAsDataUrl: vi.fn(async () => logo.url),
}));

import { generateVendorPoPdf, vendorPoPdfFilename } from '@/utils/vendorPoPdf';
import type { Company } from '@/utils/companyAccess';
import { draftPoDetail, otherLine, outsideLine, poDetail, poHeader, poLine, poSummary } from '../components/purchasing/vendorPoFixtures';

const company = {
  id: 'co-1',
  name: 'Contour Tool & Machine',
  address_line1: '123 Shop St',
  city: 'Warren',
  state: 'MI',
  postal_code: '48089',
  phone: '(586) 555-0100',
} as Company;

const drawn = () => doc.text.mock.calls.map((c) => String(c[0]));
const table = (): TableOptions => autoTableFn.mock.calls[0][1];
const cells = () => table().body.flat().join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  logo.url = null;
  doc.splitTextToSize.mockImplementation((s: string) => [s]);
  doc.getNumberOfPages.mockReturnValue(1);
});

describe('vendorPoPdfFilename', () => {
  it('names the file after the PO, with the revision only above 0', () => {
    expect(vendorPoPdfFilename('PO-1042', 2)).toBe('PO-1042-rev2.pdf');
    expect(vendorPoPdfFilename('PO-1042', 0)).toBe('PO-1042.pdf');
  });
});

describe('generateVendorPoPdf — the header', () => {
  it('titles the document and prints the number, date, terms and ship via', async () => {
    await generateVendorPoPdf({ po: poDetail(), company, supabase: null });
    const t = drawn();
    expect(t).toContain('PURCHASE ORDER');
    expect(t).toContain('PO #: PO-1042');
    expect(t.some((s) => s.startsWith('Date: '))).toBe(true);
    expect(t).toContain('Terms: Net 30');
    expect(t).toContain('Ship via: UPS Ground');
  });

  it('prints "Rev" only above 0', async () => {
    await generateVendorPoPdf({ po: poDetail(), company, supabase: null });
    expect(drawn().some((s) => s.startsWith('Rev'))).toBe(false);

    vi.clearAllMocks();
    doc.splitTextToSize.mockImplementation((s: string) => [s]);
    await generateVendorPoPdf({ po: poDetail({ header: poHeader({ revision: 2, sentRevision: 2 }) }), company, supabase: null });
    expect(drawn()).toContain('Rev: 2');
  });

  it('measures the meta column before drawing the logo, so the logo gets the space the column already pays for', async () => {
    logo.url = 'data:image/png;base64,AAAA';
    await generateVendorPoPdf({
      po: poDetail({ header: poHeader({ revision: 1, sentRevision: 1 }) }),
      company: { ...company, logo_url: 'logo.png' },
      supabase: null,
    });
    // Six meta lines (PO #, Rev, Date, Need by, Terms, Ship via) at 14pt, from 20pt below the top:
    // the logo plus the shop's lines under it must fit inside that column's height.
    const firstImage = doc.addImage.mock.calls[0];
    expect(firstImage).toBeDefined();
    const top = Number(firstImage[3]);
    const height = Number(firstImage[5]);
    expect(height).toBeGreaterThan(0);
    expect(top + height).toBeLessThanOrEqual(40 + 20 + 6 * 14);
    // And the meta lines were all drawn — none was added after the header was sized.
    expect(drawn()).toContain('Rev: 1');
  });
});

describe('generateVendorPoPdf — banners', () => {
  it('says DRAFT on a PO that was never sent', async () => {
    await generateVendorPoPdf({ po: draftPoDetail(), company, supabase: null });
    expect(drawn().some((s) => s.startsWith('DRAFT'))).toBe(true);
  });

  it('says CLOSED on a closed PO', async () => {
    await generateVendorPoPdf({
      po: poDetail({ header: poHeader({ closedAt: '2026-11-09T12:00:00Z' }), summary: poSummary({ status: 'closed' }) }),
      company,
      supabase: null,
    });
    expect(drawn().some((s) => s.startsWith('CLOSED'))).toBe(true);
    expect(drawn().some((s) => s.startsWith('DRAFT'))).toBe(false);
  });

  it('prints neither on a sent, open PO', async () => {
    await generateVendorPoPdf({ po: poDetail(), company, supabase: null });
    expect(drawn().some((s) => s.startsWith('DRAFT') || s.startsWith('CLOSED'))).toBe(false);
  });
});

describe('generateVendorPoPdf — parties', () => {
  it('prints the vendor and ship-to from the frozen copy on the PO', async () => {
    await generateVendorPoPdf({ po: poDetail(), company, supabase: null });
    const t = drawn();
    expect(t).toContain('VENDOR');
    expect(t).toContain('SHIP TO');
    expect(t).toContain('Acme Steel Supply (frozen)');
    expect(t).toContain('Attn: Jane Buyer');
    expect(t).toContain('100 Mill Rd');
    expect(t).toContain('Contour Tool & Machine');
    expect(t).toContain('Attn: Receiving');
  });

  it('says so when the vendor has no address on file', async () => {
    await generateVendorPoPdf({ po: poDetail({ header: poHeader({ vendorAddress: null }) }), company, supabase: null });
    expect(drawn()).toContain('(No address on file)');
  });
});

describe('generateVendorPoPdf — lines', () => {
  it('drives head and body from one column spec', async () => {
    await generateVendorPoPdf({ po: poDetail(), company, supabase: null });
    const { head, body } = table();
    expect(head[0]).toEqual(['#', 'Item', 'Qty', 'Unit', 'Due', 'Unit price', 'Amount']);
    for (const row of body) expect(row).toHaveLength(head[0].length);
  });

  it('carries the vendor part number, the job, the machine and "Certs required" in the item cell', async () => {
    await generateVendorPoPdf({ po: poDetail(), company, supabase: null });
    const c = cells();
    expect(c).toContain('6061-T6 round bar, 1 in');
    expect(c).toContain('Your part #: AC-6061-1');
    expect(c).toContain('For job J-1042');
    expect(c).toContain('Certs required');
    expect(c).toContain('For machine: Haas VF-2');
  });

  it('prints unit prices to up to 5 decimals, amounts to the cent, and the total', async () => {
    const po = poDetail({
      lines: [
        poLine({ quantity: 1000, unit: 'each', unitPrice: 0.0125, amount: 12.5 }),
        otherLine({ quantity: 1, unitPrice: 1.5, amount: 1.5 }),
      ],
    });
    await generateVendorPoPdf({ po, company, supabase: null });
    const c = cells();
    expect(c).toContain('$0.0125');
    expect(c).toContain('$12.50');
    expect(c).toContain('$1.50');
    expect(drawn()).toContain('$14.00');
  });

  it('prints TBC for a line still to be priced, and says the total leaves it out', async () => {
    const po = poDetail({ lines: [poLine(), otherLine({ unitPrice: null, amount: null, priceSource: null })] });
    await generateVendorPoPdf({ po, company, supabase: null });
    expect(table().body[1]).toContain('TBC');
    expect(drawn().some((s) => /1 line to be confirmed/i.test(s))).toBe(true);
  });

  it('prints the due date — the need-by date, never the internal promised date', async () => {
    const po = poDetail({ lines: [poLine({ needByOn: '2026-11-20', promisedOn: '2026-12-31' })] });
    await generateVendorPoPdf({ po, company, supabase: null });
    const c = cells();
    expect(c).toContain('Nov 20, 2026');
    expect(c).not.toContain('Dec 31, 2026');
  });

  it('lists an outside line by its description, in the part’s own unit', async () => {
    await generateVendorPoPdf({ po: poDetail({ lines: [outsideLine()] }), company, supabase: null });
    expect(cells()).toContain('Anodize — 1234-A — Job J-1042, Op 30');
  });
});

describe('generateVendorPoPdf — what never prints', () => {
  it('never prints the internal notes', async () => {
    await generateVendorPoPdf({ po: poDetail(), company, supabase: null });
    expect(drawn().join('\n')).not.toContain('SECRET-INTERNAL-NOTE');
    expect(cells()).not.toContain('SECRET-INTERNAL-NOTE');
    expect(doc.splitTextToSize.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('SECRET-INTERNAL-NOTE');
  });
});

describe('generateVendorPoPdf — notes, terms and footer', () => {
  it('prints the notes to the vendor and the terms, setting the body font BEFORE measuring them', async () => {
    await generateVendorPoPdf({ po: poDetail(), company, supabase: null });
    const t = drawn();
    expect(t).toContain('NOTES');
    expect(t).toContain('Deliver to the back dock.');
    expect(t).toContain('TERMS AND CONDITIONS');
    expect(t).toContain('All material must be certified.');

    // The split for the terms must come after a normal 10pt font was set.
    const splitOrder = doc.splitTextToSize.mock.invocationCallOrder[
      doc.splitTextToSize.mock.calls.findIndex((c) => c[0] === 'All material must be certified.')
    ];
    const fontSets = doc.setFont.mock.calls
      .map((c, i) => ({ style: c[1], order: doc.setFont.mock.invocationCallOrder[i] }))
      .filter((f) => f.order < splitOrder);
    expect(fontSets[fontSets.length - 1].style).toBe('normal');
    const sizes = doc.setFontSize.mock.calls
      .map((c, i) => ({ size: c[0], order: doc.setFontSize.mock.invocationCallOrder[i] }))
      .filter((f) => f.order < splitOrder);
    expect(sizes[sizes.length - 1].size).toBe(10);
  });

  it('draws the footer on every page, after the content', async () => {
    doc.getNumberOfPages.mockReturnValue(2);
    await generateVendorPoPdf({ po: poDetail(), company, supabase: null });
    expect(doc.setPage).toHaveBeenCalledWith(1);
    expect(doc.setPage).toHaveBeenCalledWith(2);
    const t = drawn();
    expect(t).toContain('Page 1 of 2');
    expect(t).toContain('Page 2 of 2');
    expect(t.filter((s) => s.startsWith('Generated')).length).toBe(2);
  });
});
