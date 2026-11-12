import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The RFQ to ONE vendor (criterion Q1).
 *
 * jsPDF is mocked wholesale, as in outsideShipmentPdf.test.ts, so nothing here sees real geometry.
 * What survives the mock is WHAT IS PRINTED and the font state around measuring — which is where
 * this document's real hazards are: another vendor's part numbers leaking onto the page, a price
 * printed on a request for prices, and the internal notes going out the door.
 */
const { jsPDFCtor, autoTableFn, doc } = vi.hoisted(() => {
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
    splitTextToSize: vi.fn(),
    save: vi.fn(),
    addPage: vi.fn(),
    setPage: vi.fn(),
    getNumberOfPages: vi.fn().mockReturnValue(1),
    getTextWidth: vi.fn().mockReturnValue(50),
    addImage: vi.fn(),
    getImageProperties: vi.fn().mockReturnValue({ width: 400, height: 100, fileType: 'PNG' }),
    lastAutoTable: { finalY: 400 },
  };
  return {
    jsPDFCtor: vi.fn().mockImplementation(function () {
      return docInstance;
    }),
    autoTableFn: vi.fn(),
    doc: docInstance,
  };
});

vi.mock('jspdf', () => ({ jsPDF: jsPDFCtor }));
vi.mock('jspdf-autotable', () => ({ default: autoTableFn }));
// packingSlipPdf reaches lib/supabase at module load; supabase: null below keeps the logo path inert.
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));

import { generateRfqPdf, rfqEmailHref, rfqPdfFilename, RFQ_QUOTE_REQUEST } from '@/utils/rfqPdf';
import type { RfqPdfContext } from '@/utils/rfqPdf';
import type { Company } from '@/utils/companyAccess';

const company: Company = {
  id: 'co-1',
  name: 'Contour Tool & Machine',
  address_line1: '123 Shop St',
  city: 'Warren',
  state: 'MI',
  postal_code: '48089',
  phone: '(586) 555-0100',
};

function context(over: Partial<RfqPdfContext> = {}): RfqPdfContext {
  return {
    company,
    supabase: null,
    invitationId: 'inv-acme',
    rfq: {
      header: {
        id: 'rfq-1',
        companyId: 'co-1',
        rfqNumber: 'RFQ-0007',
        title: 'Bar stock for the Q1 run',
        neededByOn: '2026-12-01',
        respondByOn: '2026-11-20',
        notesToVendors: 'Mill certs with every bar, please.',
        internalNotes: 'Beta was late last time — push Acme.',
        termsAndConditions: 'Prices firm for 30 days.',
        shipToName: 'Contour Tool & Machine',
        shipToAddress: {
          address_line1: '123 Shop St',
          address_line2: null,
          city: 'Warren',
          state: 'MI',
          postal_code: '48089',
          country: 'USA',
          attention_to: null,
        },
        closedAt: null,
        closedReason: null,
        createdAt: '2026-11-09T15:00:00Z',
        updatedAt: '2026-11-09T15:00:00Z',
        deletedAt: null,
        isArchived: false,
      },
      lines: [
        {
          id: 'line-1',
          lineNumber: 1,
          partId: 'part-bar',
          partName: 'BAR-6061',
          description: '6061-T6 round bar, 1" dia',
          unit: 'bar',
          quantities: [10, 25, 1200],
          jobId: null,
          jobNumber: null,
          certRequired: true,
          notes: 'Cut to 12 ft lengths',
        },
        {
          id: 'line-2',
          lineNumber: 2,
          partId: null,
          partName: null,
          description: 'Deburring brushes',
          unit: 'each',
          quantities: [50],
          jobId: null,
          jobNumber: null,
          certRequired: false,
          notes: null,
        },
      ],
      invitations: [
        {
          id: 'inv-acme',
          vendorId: 'v-acme',
          vendorName: 'Acme Steel Supply Company of Greater Michigan, LLC',
          vendorContactId: 'c-1',
          vendorContact: { name: 'Jane Buyer', email: 'jane@acme.test', phone: '555-0101' },
          sentAt: null,
          declinedAt: null,
          declinedReason: null,
          vendorQuoteReference: null,
          quotedOn: null,
        },
        {
          id: 'inv-beta',
          vendorId: 'v-beta',
          vendorName: 'Beta Metals',
          vendorContactId: null,
          vendorContact: null,
          sentAt: '2026-11-09T16:00:00Z',
          declinedAt: null,
          declinedReason: null,
          vendorQuoteReference: 'Q-88',
          quotedOn: '2026-11-10',
        },
      ],
      responses: [
        // Beta already answered: its price and ITS part number must never reach Acme's page.
        {
          id: 'resp-b1',
          invitationId: 'inv-beta',
          lineId: 'line-1',
          quantity: 10,
          unitPrice: 51.25,
          noBid: false,
          leadTimeDays: 5,
          minimumOrderQuantity: null,
          validUntil: null,
          vendorPartNumber: 'BETA-RB-1',
          notes: null,
          awardedAt: null,
          vendorPurchaseOrderLineId: null,
        },
      ],
    },
    vendorPartNumbers: [
      { partId: 'part-bar', vendorId: 'v-acme', vendorPartNumber: 'ACME-61-1' },
      { partId: 'part-bar', vendorId: 'v-beta', vendorPartNumber: 'BETA-61-1' },
    ],
    ...over,
  };
}

const drawn = () => doc.text.mock.calls.flatMap((c) => (Array.isArray(c[0]) ? c[0] : [c[0]])).map(String);
const tableCells = () => {
  const t = autoTableFn.mock.calls[0]?.[1];
  return t ? [...t.head.flat(), ...t.body.flat()].map(String) : [];
};
const everything = () => [...drawn(), ...tableCells()];

beforeEach(() => {
  vi.clearAllMocks();
  doc.splitTextToSize.mockImplementation((s: string) => [s]);
  doc.getNumberOfPages.mockReturnValue(1);
});

describe('rfqPdfFilename', () => {
  it('names the file after the RFQ and the vendor it is addressed to', () => {
    expect(rfqPdfFilename('RFQ-0007', 'Acme Steel, Inc.')).toBe('RFQ-0007-Acme-Steel-Inc.pdf');
  });
});

describe('rfqEmailHref — the mailto that carries the PDF', () => {
  const base = {
    rfqNumber: 'RFQ-0007',
    title: 'Bar stock',
    respondByOn: '2026-11-20',
    shopName: 'Contour Tool & Machine',
  };

  it('addresses the contact, names the RFQ in the subject and asks for the same four things', () => {
    const href = rfqEmailHref({ ...base, contact: { name: 'Jane Buyer', email: 'jane@acme.test', phone: null } });
    expect(href).not.toBeNull();
    expect(href!.startsWith('mailto:jane@acme.test?subject=')).toBe(true);
    const decoded = decodeURIComponent(href!);
    expect(decoded).toContain('subject=RFQ-0007 — request for quote from Contour Tool & Machine');
    expect(decoded).toContain('Hello Jane,');
    expect(decoded).toContain(RFQ_QUOTE_REQUEST);
    expect(decoded).toContain('Please reply by Nov 20, 2026.');
    // An ampersand in the shop name must not end the subject early.
    expect(href).not.toContain('Tool & Machine');
  });

  it('is nothing at all when the contact has no email, rather than a link to nobody', () => {
    expect(rfqEmailHref({ ...base, contact: { name: 'Jane', email: null, phone: null } })).toBeNull();
    expect(rfqEmailHref({ ...base, contact: null })).toBeNull();
  });
});

describe('generateRfqPdf — addressed to ONE vendor (Q1)', () => {
  it('prints the RFQ number, the respond-by date and the vendor it goes to', async () => {
    await generateRfqPdf(context());
    const t = drawn();
    expect(t).toContain('REQUEST FOR QUOTE');
    expect(t.some((s) => s.includes('RFQ-0007'))).toBe(true);
    expect(t.some((s) => s.startsWith('Respond by:') && s.includes('Nov 20, 2026'))).toBe(true);
    expect(t).toContain('Acme Steel Supply Company of Greater Michigan, LLC');
    expect(t).toContain('Attn: Jane Buyer');
    // The other invited vendor is never named on Acme's copy.
    expect(everything().some((s) => s.includes('Beta Metals'))).toBe(false);
  });

  it("prints ONLY that vendor's part numbers", async () => {
    await generateRfqPdf(context());
    const all = everything();
    expect(all).toContain('ACME-61-1');
    expect(all.some((s) => s.includes('BETA-61-1'))).toBe(false);
    expect(all.some((s) => s.includes('BETA-RB-1'))).toBe(false);
  });

  it("falls back to the part number the vendor itself quoted, and to nothing for anyone else's", async () => {
    await generateRfqPdf(
      context({
        invitationId: 'inv-beta',
        vendorPartNumbers: [{ partId: 'part-bar', vendorId: 'v-acme', vendorPartNumber: 'ACME-61-1' }],
      }),
    );
    const all = everything();
    expect(all).toContain('BETA-RB-1');
    expect(all.some((s) => s.includes('ACME-61-1'))).toBe(false);
  });

  it('prints every quantity on each line, in its unit', async () => {
    await generateRfqPdf(context());
    const t = autoTableFn.mock.calls[0][1];
    const first = t.body[0].map(String);
    expect(first.some((c: string) => c.includes('10') && c.includes('25') && c.includes('1,200'))).toBe(true);
    expect(first).toContain('bar');
    // An ad-hoc line prints its description in place of a part.
    expect(t.body[1].map(String).some((c: string) => c.includes('Deburring brushes'))).toBe(true);
  });

  it('asks for the four things a quote needs, in words', async () => {
    await generateRfqPdf(context());
    expect(RFQ_QUOTE_REQUEST).toMatch(/unit price/i);
    expect(RFQ_QUOTE_REQUEST).toMatch(/lead time/i);
    expect(RFQ_QUOTE_REQUEST).toMatch(/minimum order/i);
    expect(RFQ_QUOTE_REQUEST).toMatch(/how long the price is good for/i);
    expect(drawn().some((s) => s.includes(RFQ_QUOTE_REQUEST))).toBe(true);
  });

  it('prints NO prices — not the quotes already in, not a dollar sign anywhere', async () => {
    await generateRfqPdf(context());
    const all = everything();
    expect(all.some((s) => s.includes('$'))).toBe(false);
    expect(all.some((s) => s.includes('51.25'))).toBe(false);
    expect(all.map((s) => s.toLowerCase()).some((s) => s.includes('price:'))).toBe(false);
  });

  it('flags certs and prints the notes to vendors, never the internal notes', async () => {
    await generateRfqPdf(context());
    const all = everything();
    expect(all.some((s) => s.includes('Certs required'))).toBe(true);
    expect(all.some((s) => s.includes('Mill certs with every bar, please.'))).toBe(true);
    expect(all.some((s) => s.includes('Prices firm for 30 days.'))).toBe(true);
    expect(all.some((s) => s.includes('push Acme'))).toBe(false);
  });

  it('keeps head, body and column styles aligned', async () => {
    await generateRfqPdf(context());
    const t = autoTableFn.mock.calls[0][1];
    expect(t.head[0]).toHaveLength(t.body[0].length);
    expect(Object.keys(t.columnStyles)).toHaveLength(t.head[0].length);
  });

  it('refuses an invitation that is not on this RFQ rather than printing a blank vendor', async () => {
    await expect(generateRfqPdf(context({ invitationId: 'inv-elsewhere' }))).rejects.toThrow(/not on this RFQ/);
  });
});

describe('generateRfqPdf — measuring and the footer', () => {
  it("measures a long vendor name in the font it is drawn in", async () => {
    await generateRfqPdf(context());
    const name = 'Acme Steel Supply Company of Greater Michigan, LLC';
    const idx = doc.splitTextToSize.mock.calls.findIndex((c) => c[0] === name);
    expect(idx).toBeGreaterThanOrEqual(0);
    const order = doc.splitTextToSize.mock.invocationCallOrder[idx];
    const fontBefore = doc.setFont.mock.calls
      .filter((_, i) => doc.setFont.mock.invocationCallOrder[i] < order)
      .pop();
    expect(fontBefore).toEqual(['helvetica', 'bold']);
  });

  it('sets the body font BEFORE measuring the terms', async () => {
    await generateRfqPdf(context());
    const idx = doc.splitTextToSize.mock.calls.findIndex((c) => String(c[0]).includes('Prices firm for 30 days.'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const order = doc.splitTextToSize.mock.invocationCallOrder[idx];
    const sizeBefore = doc.setFontSize.mock.calls
      .filter((_, i) => doc.setFontSize.mock.invocationCallOrder[i] < order)
      .pop();
    const fontBefore = doc.setFont.mock.calls
      .filter((_, i) => doc.setFont.mock.invocationCallOrder[i] < order)
      .pop();
    expect(sizeBefore?.[0]).toBe(10);
    expect(fontBefore).toEqual(['helvetica', 'normal']);
  });

  it('puts the dated attribution and the page count on every page', async () => {
    doc.getNumberOfPages.mockReturnValue(2);
    await generateRfqPdf(context());
    expect(drawn()).toContain('Page 1 of 2');
    expect(drawn()).toContain('Page 2 of 2');
    expect(drawn().find((s) => s.includes('jigged.app'))).toMatch(/^Generated .+ with jigged\.app$/);
  });
});
