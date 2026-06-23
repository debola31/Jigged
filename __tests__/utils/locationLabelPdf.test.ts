import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture jsPDF calls without parsing PDF bytes.
const pdf = {
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  text: vi.fn(),
  addImage: vi.fn(),
  addPage: vi.fn(),
  save: vi.fn(),
  splitTextToSize: vi.fn((s: string) => [s]),
  internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
};
vi.mock('jspdf', () => ({ jsPDF: function MockJsPdf() { return pdf; } }));

const toDataURL = vi.fn(async () => 'data:image/png;base64,stub');
vi.mock('qrcode', () => ({ default: { toDataURL: (...a: unknown[]) => toDataURL(...a) } }));

import { generateLocationLabelSheet, buildLocationScanUrl } from '@/utils/locationLabelPdf';

const label = (id: string, path: string[], code: string | null = null) => ({ id, path, code });

beforeEach(() => {
  vi.clearAllMocks();
  pdf.splitTextToSize.mockImplementation((s: string) => [s]);
});

describe('buildLocationScanUrl', () => {
  it('encodes the location UUID against the operator login route', () => {
    expect(buildLocationScanUrl('http://x', 'co1', 'loc1')).toBe('http://x/operator/co1/login?location=loc1');
  });
});

describe('generateLocationLabelSheet', () => {
  it('renders one QR (level H) and image per label, with the path text', async () => {
    await generateLocationLabelSheet({
      companyId: 'co1',
      baseUrl: 'http://x',
      labels: [label('a', ['Cabinet 1', 'Row 3', 'Left'], 'CAB1-R3-L'), label('b', ['Cabinet 1', 'Row 3', 'Right'])],
    });

    expect(toDataURL).toHaveBeenCalledTimes(2);
    // payload is the UUID deep-link, high error-correction
    expect(toDataURL).toHaveBeenCalledWith(
      'http://x/operator/co1/login?location=a',
      expect.objectContaining({ errorCorrectionLevel: 'H' }),
    );
    expect(pdf.addImage).toHaveBeenCalledTimes(2);
    // the human path is printed on the label
    expect(pdf.text).toHaveBeenCalledWith(['Cabinet 1  ›  Row 3  ›  Left'], expect.any(Number), expect.any(Number));
  });

  it('paginates beyond 10 labels per page', async () => {
    const labels = Array.from({ length: 11 }, (_, i) => label(`n${i}`, [`Bin ${i}`]));
    await generateLocationLabelSheet({ companyId: 'co1', baseUrl: 'http://x', labels });
    expect(pdf.addPage).toHaveBeenCalledTimes(1); // 10 on page 1, 11th forces a new page
  });

  it('continues when a single QR fails to render', async () => {
    toDataURL.mockRejectedValueOnce(new Error('boom'));
    await generateLocationLabelSheet({
      companyId: 'co1',
      baseUrl: 'http://x',
      labels: [label('a', ['A']), label('b', ['B'])],
    });
    // first label's image is skipped, second still drawn
    expect(pdf.addImage).toHaveBeenCalledTimes(1);
    expect(pdf.text).toHaveBeenCalledTimes(2);
  });
});
