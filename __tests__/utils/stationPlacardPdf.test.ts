import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture jsPDF calls without parsing PDF bytes (mirrors locationLabelPdf.test).
const pdf = {
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  text: vi.fn(),
  addImage: vi.fn(),
  addPage: vi.fn(),
  save: vi.fn(),
  internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
};
vi.mock('jspdf', () => ({ jsPDF: function MockJsPdf() { return pdf; } }));

const toDataURL = vi.fn(async () => 'data:image/png;base64,stub');
vi.mock('qrcode', () => ({ default: { toDataURL: (...a: unknown[]) => toDataURL(...a) } }));

import { generateStationPlacards, buildStationScanUrl } from '@/utils/stationPlacardPdf';

const placard = (id: string, name: string, code: string | null = null) => ({ id, name, code });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildStationScanUrl', () => {
  it('encodes the work-center id against the operator login route', () => {
    expect(buildStationScanUrl('http://x', 'co1', 'wc1')).toBe(
      'http://x/operator/co1/login?station=wc1',
    );
  });
});

describe('generateStationPlacards', () => {
  it('renders one high-error-correction QR per station with name, company, code, and instruction', async () => {
    await generateStationPlacards({
      companyId: 'co1',
      baseUrl: 'http://x',
      placards: [placard('wc1', 'CNC Lathe #2', 'WC-001'), placard('wc2', 'Heat Treat')],
      companyName: 'Acme Precision',
    });

    expect(toDataURL).toHaveBeenCalledTimes(2);
    expect(toDataURL).toHaveBeenCalledWith(
      'http://x/operator/co1/login?station=wc1',
      expect.objectContaining({ errorCorrectionLevel: 'H' }),
    );
    expect(pdf.addImage).toHaveBeenCalledTimes(2);
    expect(pdf.text).toHaveBeenCalledWith('CNC Lathe #2', expect.any(Number), expect.any(Number), expect.anything());
    expect(pdf.text).toHaveBeenCalledWith('Acme Precision', expect.any(Number), expect.any(Number), expect.anything());
    expect(pdf.text).toHaveBeenCalledWith('WC-001', expect.any(Number), expect.any(Number), expect.anything());
    expect(pdf.text).toHaveBeenCalledWith(
      'Scan this QR code to open the Operator View for this station',
      expect.any(Number),
      expect.any(Number),
      expect.anything(),
    );
  });

  it('puts each station on its own page (one implicit page + addPage per extra)', async () => {
    await generateStationPlacards({
      companyId: 'co1',
      baseUrl: 'http://x',
      placards: [placard('a', 'A'), placard('b', 'B'), placard('c', 'C')],
    });
    expect(pdf.addPage).toHaveBeenCalledTimes(2);
  });

  it('continues when a single QR fails to render', async () => {
    toDataURL.mockRejectedValueOnce(new Error('boom'));
    await generateStationPlacards({
      companyId: 'co1',
      baseUrl: 'http://x',
      placards: [placard('a', 'A'), placard('b', 'B')],
    });
    expect(pdf.addImage).toHaveBeenCalledTimes(1); // first skipped, second still drawn
    expect(pdf.text).toHaveBeenCalledWith('A', expect.any(Number), expect.any(Number), expect.anything());
    expect(pdf.text).toHaveBeenCalledWith('B', expect.any(Number), expect.any(Number), expect.anything());
  });
});
