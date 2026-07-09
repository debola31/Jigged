/**
 * StationQRCode renders a QR code linking to /operator/{companyId}/login
 * and exposes a "Download PDF" button that bundles the QR + station name
 * into a printable sheet. These tests assert:
 *   - the QR's encoded URL matches the station-link contract
 *   - the "Open Operator View" link mirrors the QR URL
 *   - the PDF flow respects the optional companyName / operationCode props
 *     (file name, text blocks added)
 *   - the PDF button is a no-op when the canvas isn't yet in the DOM
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import StationQRCode from '@/components/operations/StationQRCode';

// Stub qrcode.react: render a div carrying the encoded value as data-attr
// so we can assert against it without depending on canvas internals.
vi.mock('qrcode.react', () => ({
  QRCodeCanvas: ({ value, size }: { value: string; size: number }) => (
    <div data-testid="qr-canvas" data-value={value} data-size={size}>
      <canvas data-testid="qr-canvas-element" />
    </div>
  ),
}));

// Stub jsPDF — capture every call so the test can assert on the PDF
// content shape without parsing PDF bytes. The component uses `new jsPDF(...)`
// so the export must be a constructable function (not an arrow).
const pdfText = vi.fn();
const pdfAddImage = vi.fn();
const pdfSave = vi.fn();
const pdfSetFontSize = vi.fn();
const pdfSetTextColor = vi.fn();
const pdfGetWidth = vi.fn(() => 210); // A4 width in mm
const pdfGetHeight = vi.fn(() => 297);
vi.mock('jspdf', () => ({
  jsPDF: function MockJsPdf() {
    return {
      setFontSize: pdfSetFontSize,
      setTextColor: pdfSetTextColor,
      text: pdfText,
      addImage: pdfAddImage,
      save: pdfSave,
      internal: {
        pageSize: { getWidth: pdfGetWidth, getHeight: pdfGetHeight },
      },
    };
  },
}));

const baseProps = {
  workCenterId: 'wc-lathe-01',
  operationName: 'CNC Lathe 1',
  companyId: 'co-acme',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Pin the origin so the QR URL is deterministic.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL('http://localhost:3000/dashboard/co-acme/work-centers/wc-lathe-01'),
  });
  // Stub HTMLCanvasElement.toDataURL since jsdom returns "" for it.
  HTMLCanvasElement.prototype.toDataURL = vi.fn(
    () => 'data:image/png;base64,stub-canvas',
  );
});

describe('StationQRCode', () => {
  it('renders the QR code with the operator-login URL', () => {
    render(<StationQRCode {...baseProps} />);

    const qr = screen.getByTestId('qr-canvas');
    expect(qr.getAttribute('data-value')).toBe(
      'http://localhost:3000/operator/co-acme/login?station=wc-lathe-01',
    );
  });

  it('uses the size prop on the QR canvas (default 200)', () => {
    const { rerender } = render(<StationQRCode {...baseProps} />);
    expect(screen.getByTestId('qr-canvas').getAttribute('data-size')).toBe('200');

    rerender(<StationQRCode {...baseProps} size={350} />);
    expect(screen.getByTestId('qr-canvas').getAttribute('data-size')).toBe('350');
  });

  it('"Open Operator View" link points at the same operator URL', () => {
    render(<StationQRCode {...baseProps} />);
    const link = screen.getByRole('link', { name: /open operator view/i });
    expect(link).toHaveAttribute(
      'href',
      'http://localhost:3000/operator/co-acme/login?station=wc-lathe-01',
    );
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('downloads a PDF with operationName-derived filename on button click', async () => {
    render(<StationQRCode {...baseProps} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download pdf/i }));

    expect(pdfSave).toHaveBeenCalledTimes(1);
    expect(pdfSave).toHaveBeenCalledWith('CNC-Lathe-1-station-qr.pdf');
    expect(pdfAddImage).toHaveBeenCalledWith(
      'data:image/png;base64,stub-canvas',
      'PNG',
      expect.any(Number),
      expect.any(Number),
      80,
      80,
    );
  });

  it('writes the station name into the PDF at all times', async () => {
    render(<StationQRCode {...baseProps} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download pdf/i }));

    // Station name appears in pdf.text calls
    const textCalls = pdfText.mock.calls;
    expect(textCalls.some((c) => c[0] === 'CNC Lathe 1')).toBe(true);
  });

  it('writes companyName above the station name when provided', async () => {
    render(<StationQRCode {...baseProps} companyName="Acme Precision" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download pdf/i }));

    const textCalls = pdfText.mock.calls;
    expect(textCalls.some((c) => c[0] === 'Acme Precision')).toBe(true);
  });

  it('omits companyName from the PDF when not provided', async () => {
    render(<StationQRCode {...baseProps} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download pdf/i }));

    const textCalls = pdfText.mock.calls;
    expect(textCalls.some((c) => c[0] === 'Acme Precision')).toBe(false);
  });

  it('writes operationCode under the QR when provided', async () => {
    render(<StationQRCode {...baseProps} operationCode="WC-001" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download pdf/i }));

    const textCalls = pdfText.mock.calls;
    expect(textCalls.some((c) => c[0] === 'WC-001')).toBe(true);
  });

  it('omits operationCode from the PDF when not provided', async () => {
    render(<StationQRCode {...baseProps} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download pdf/i }));

    // No call with a code-shaped second arg "WC-xxx". Spot-check that the
    // station name is the only large-font text.
    const textCalls = pdfText.mock.calls;
    expect(textCalls.some((c) => c[0] === 'WC-001')).toBe(false);
  });

  it('replaces whitespace in the filename with hyphens', async () => {
    render(<StationQRCode {...baseProps} operationName="  Heat Treat   Bay 3 " />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download pdf/i }));

    expect(pdfSave).toHaveBeenCalledWith('-Heat-Treat-Bay-3--station-qr.pdf');
  });

  it('is a no-op when no canvas is present (defensive guard)', async () => {
    // Re-stub QRCodeCanvas to NOT render a <canvas> inside the ref'd div.
    // The handleDownloadPDF guard returns early if querySelector('canvas')
    // is null.
    vi.doMock('qrcode.react', () => ({
      QRCodeCanvas: () => <div data-testid="qr-canvas" />,
    }));
    // Need a fresh import; reset the module registry.
    vi.resetModules();
    const { default: Comp } = await import('@/components/operations/StationQRCode');

    render(<Comp {...baseProps} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download pdf/i }));

    expect(pdfSave).not.toHaveBeenCalled();
  });
});
