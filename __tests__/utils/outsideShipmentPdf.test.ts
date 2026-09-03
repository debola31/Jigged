import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * THE SUITE MOCKS jsPDF WHOLESALE, so nothing here can see overflow, wrap width
 * or real page geometry. What survives mocking is ORDERING, ARGUMENT VALUES and
 * FONT STATE — which is where this document's real hazards live, so that is what
 * these assert. The PR carries a one-time manual render check for the rest.
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
    splitTextToSize: vi.fn().mockReturnValue(['wrapped']),
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
// packingSlipPdf reaches lib/supabase at module load, which builds a real
// browser client. supabase: null below means the logo path never calls it.
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));

import {
  generateOutsideShipmentPdf,
  outsideShipmentPdfFilename,
} from '@/utils/outsideShipmentPdf';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';
import type { Company } from '@/utils/companyAccess';

const company = {
  id: 'co-1',
  name: 'Contour Tool & Machine',
  address_line1: '123 Shop St',
  city: 'Warren',
  state: 'MI',
  postal_code: '48089',
  phone: '(586) 555-0100',
} as Company;

function slip(over: Partial<OutsideShipmentWithRelations> = {}): OutsideShipmentWithRelations {
  return {
    id: 's1',
    company_id: 'co-1',
    job_id: 'j1',
    job_part_id: 'jp1',
    job_operation_id: 'op1',
    vendor_id: 'v1',
    vendor_address_id: 'a1',
    vendor_contact_id: null,
    vendor_name: 'ProFinish Anodizing',
    service_name: 'Anodize Type II Clear',
    ship_to_address: {
      address_line1: '1 Anodize Way',
      address_line2: null,
      city: 'Warren',
      state: 'MI',
      postal_code: '48089',
      country: 'USA',
      attention_to: null,
    },
    ship_to_contact: { name: 'Receiving Dock', email: null, phone: null },
    slip_number: 'OSP-0141-2',
    quantity: 50,
    shipped_at: '2026-08-14T12:00:00Z',
    due_back_on: '2026-08-21',
    carrier: null,
    notes: null,
    created_by: 'u1',
    voided_at: null,
    voided_by: null,
    created_at: '2026-08-14T12:00:00Z',
    updated_at: '2026-08-14T12:00:00Z',
    job: { id: 'j1', job_number: 'J-0141' },
    job_part: { id: 'jp1', quantity: 100, part: { id: 'p1', part_name: 'BRACKET-A' } },
    ...over,
  };
}

const drawn = () => doc.text.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  // Pass-through by default, which is what the real splitTextToSize does for a
  // string that fits. Returning a placeholder instead would make every
  // assertion about drawn address text read 'wrapped'.
  doc.splitTextToSize.mockImplementation((s: string) => [s]);
  doc.getNumberOfPages.mockReturnValue(1);
});

describe('outsideShipmentPdfFilename', () => {
  it('names the file after the slip, not the job', () => {
    expect(outsideShipmentPdfFilename({ slip_number: 'OSP-0141-2' }))
      .toBe('OutsideProcessing-OSP-0141-2.pdf');
  });
});

describe('generateOutsideShipmentPdf — what the vendor reads', () => {
  it('prints the slip number, the vendor, and the PROCESS rather than the vendor twice', async () => {
    await generateOutsideShipmentPdf({ shipment: slip(), company, sentBefore: 0, supabase: null });
    const t = drawn();
    expect(t).toContain('OUTSIDE PROCESSING');
    expect(t.some((s) => s.includes('OSP-0141-2'))).toBe(true);
    expect(t).toContain('ProFinish Anodizing');
    // The operation column carries the SERVICE name. Naming the vendor there is
    // the defect that motivated the vendor-services split.
    const table = autoTableFn.mock.calls[0][1];
    expect(table.body[0]).toContain('Anodize Type II Clear');
  });

  it('carries a SHIP FROM block, which the customer packing slip does not', async () => {
    await generateOutsideShipmentPdf({ shipment: slip(), company, sentBefore: 0, supabase: null });
    const t = drawn();
    // A plater's dock holds parts from a dozen shops; it has to know whose these
    // are and where they go back.
    expect(t).toContain('SHIP FROM');
    expect(t).toContain('SHIP TO');
    expect(t).toContain('Contour Tool & Machine');
    expect(t).toContain('123 Shop St');
  });

  it('degrades to the shared fallback when the vendor has no address on file', async () => {
    await generateOutsideShipmentPdf({
      shipment: slip({ ship_to_address: null, ship_to_contact: null }),
      company, sentBefore: 0, supabase: null,
    });
    expect(drawn()).toContain('(No address on file)');
  });

  it('shows Due Back only when somebody committed to one', async () => {
    await generateOutsideShipmentPdf({ shipment: slip(), company, sentBefore: 0, supabase: null });
    expect(drawn().some((s) => s.startsWith('Due Back:'))).toBe(true);

    vi.clearAllMocks();
    await generateOutsideShipmentPdf({
      shipment: slip({ due_back_on: null }), company, sentBefore: 0, supabase: null,
    });
    expect(drawn().some((s) => s.startsWith('Due Back:'))).toBe(false);
  });

  it('banners a voided slip as PARTS NOT SENT, before the table is drawn', async () => {
    await generateOutsideShipmentPdf({
      shipment: slip({ voided_at: '2026-08-15T00:00:00Z' }),
      company, sentBefore: 0, supabase: null,
    });
    const banner = drawn().find((s) => s.startsWith('VOIDED'));
    expect(banner).toContain('PARTS NOT SENT');
    expect(doc.rect).toHaveBeenCalled();
    expect(doc.rect.mock.invocationCallOrder[0])
      .toBeLessThan(autoTableFn.mock.invocationCallOrder[0]);
  });
});

describe('generateOutsideShipmentPdf — the conditional column', () => {
  it('omits Prev Sent on the first slip, and head/body/columnStyles stay aligned', async () => {
    await generateOutsideShipmentPdf({ shipment: slip(), company, sentBefore: 0, supabase: null });
    const t = autoTableFn.mock.calls[0][1];
    expect(t.head[0]).not.toContain('Prev Sent');
    expect(t.head[0]).toHaveLength(t.body[0].length);
    expect(Object.keys(t.columnStyles)).toHaveLength(t.head[0].length);
  });

  it('adds Prev Sent once a backlog exists, and stays aligned in that permutation too', async () => {
    await generateOutsideShipmentPdf({ shipment: slip(), company, sentBefore: 50, supabase: null });
    const t = autoTableFn.mock.calls[0][1];
    expect(t.head[0]).toContain('Prev Sent');
    expect(t.body[0]).toContain('50');
    // The off-by-one that the packing slip's quantity table shipped with.
    expect(t.head[0]).toHaveLength(t.body[0].length);
    expect(Object.keys(t.columnStyles)).toHaveLength(t.head[0].length);
  });

  it('keeps the 9pt head so "Qty Ordered" does not wrap mid-word in a 60pt column', async () => {
    await generateOutsideShipmentPdf({ shipment: slip(), company, sentBefore: 0, supabase: null });
    expect(autoTableFn.mock.calls[0][1].headStyles.fontSize).toBe(9);
  });
});

describe('generateOutsideShipmentPdf — the wrap hazard the mock cannot see', () => {
  it('sets the body font BEFORE measuring the instructions', async () => {
    await generateOutsideShipmentPdf({
      shipment: slip({ notes: 'Mask the two threaded holes. Do not bead blast.' }),
      company, sentBefore: 0, supabase: null,
    });

    // NOT "the first split" -- the details block measures too, and does so
    // correctly in the bold 11 it also draws in. The instructions split is the
    // one at full content width, and it is the one that must be normal 10.
    const idx = doc.splitTextToSize.mock.calls.findIndex((c) => c[1] === 612 - 40 * 2);
    expect(idx).toBeGreaterThanOrEqual(0);
    const instructionsSplit = doc.splitTextToSize.mock.invocationCallOrder[idx];

    // The details block above leaves the document in bold 11. Measuring there
    // wraps every line about a third short: nothing overflows, so only a real
    // render shows it — which is why this asserts the ORDER instead.
    const sizeBefore = doc.setFontSize.mock.calls
      .filter((_, i) => doc.setFontSize.mock.invocationCallOrder[i] < instructionsSplit)
      .pop();
    const fontBefore = doc.setFont.mock.calls
      .filter((_, i) => doc.setFont.mock.invocationCallOrder[i] < instructionsSplit)
      .pop();

    expect(sizeBefore?.[0]).toBe(10);
    expect(fontBefore).toEqual(['helvetica', 'normal']);
  });

  it('measures the instructions against the full content width', async () => {
    await generateOutsideShipmentPdf({
      shipment: slip({ notes: 'Mask the threads.' }),
      company, sentBefore: 0, supabase: null,
    });
    const widths = doc.splitTextToSize.mock.calls.map((c) => c[1]);
    expect(widths).toContain(612 - 40 * 2);
  });

  it("keeps the shop's own line breaks rather than reflowing the whole note", async () => {
    doc.splitTextToSize.mockImplementation((s: string) => [s]);
    await generateOutsideShipmentPdf({
      shipment: slip({ notes: 'Line one\nLine two' }),
      company, sentBefore: 0, supabase: null,
    });
    const t = drawn();
    expect(t).toContain('Line one');
    expect(t).toContain('Line two');
  });
});

describe('generateOutsideShipmentPdf — the footer', () => {
  it('runs after the instructions paginate, so a page they added is not bare', async () => {
    doc.getNumberOfPages.mockReturnValue(2);
    await generateOutsideShipmentPdf({
      shipment: slip({ notes: 'x'.repeat(50) }),
      company, sentBefore: 0, supabase: null,
    });
    const lastAddPage = doc.addPage.mock.invocationCallOrder.at(-1);
    const firstCount = doc.getNumberOfPages.mock.invocationCallOrder.at(-1)!;
    if (lastAddPage !== undefined) expect(lastAddPage).toBeLessThan(firstCount);
    expect(drawn()).toContain('Page 1 of 2');
    expect(drawn()).toContain('Page 2 of 2');
  });

  it('uses the DATED attribution — this footer has an empty left slot', async () => {
    await generateOutsideShipmentPdf({ shipment: slip(), company, sentBefore: 0, supabase: null });
    const mark = drawn().find((s) => s.includes('jigged.app'));
    expect(mark).toMatch(/^Generated .+ with jigged\.app$/);
  });
});

describe('generateOutsideShipmentPdf — the address blocks wrap', () => {
  it("measures a vendor's legal name against its column, in the font it is drawn in", async () => {
    // Found by rendering one: at 11pt bold, "PerformCoat of Michigan Limited
    // Liability Company" is 270pt against a 258pt column, so it ran off the
    // right edge of a document that leaves the building. Nothing errored.
    doc.splitTextToSize.mockImplementation((s: string) => [s]);
    await generateOutsideShipmentPdf({
      shipment: slip({ vendor_name: 'PerformCoat of Michigan Limited Liability Company' }),
      company, sentBefore: 0, supabase: null,
    });

    const call = doc.splitTextToSize.mock.calls.find(
      (c) => c[0] === 'PerformCoat of Michigan Limited Liability Company',
    );
    expect(call).toBeDefined();
    // (612 - 80) / 2 - 8
    expect(call![1]).toBe(258);

    const idx = doc.splitTextToSize.mock.calls.indexOf(call!);
    const order = doc.splitTextToSize.mock.invocationCallOrder[idx];
    const fontBefore = doc.setFont.mock.calls
      .filter((_, i) => doc.setFont.mock.invocationCallOrder[i] < order)
      .pop();
    expect(fontBefore).toEqual(['helvetica', 'bold']);
  });
});
