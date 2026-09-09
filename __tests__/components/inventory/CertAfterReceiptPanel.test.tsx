import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The panel that offers a mill cert AFTER a receipt has already landed.
 *
 * The assertion this file exists for is the first one: `Done` is enabled with no file chosen. That
 * is the never-blocks guarantee, and it is the kind of promise that quietly stops being true when
 * someone later adds a "you haven't attached a cert" guard — so it is pinned here rather than left
 * to the prose in the component.
 */

const { mockListLotCertificates, mockUploadLotCertificate } = vi.hoisted(() => ({
  mockListLotCertificates: vi.fn(),
  mockUploadLotCertificate: vi.fn(),
}));

vi.mock('@/utils/lotCertificatesAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/lotCertificatesAccess')>();
  return {
    ...actual,
    listLotCertificates: (...a: unknown[]) => mockListLotCertificates(...a),
    uploadLotCertificate: (...a: unknown[]) => mockUploadLotCertificate(...a),
  };
});

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));
vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => mockCapture(...a) } }));

import CertAfterReceiptPanel from '@/components/inventory/CertAfterReceiptPanel';

function makeFile(name: string, sizeBytes = 1024, type = 'application/pdf'): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: sizeBytes });
  return f;
}

function renderPanel(onDone = vi.fn()) {
  render(
    <CertAfterReceiptPanel
      companyId="c1"
      lotId="lot-1"
      surface="operator_receive"
      heatLabel="Heat 4471"
      onDone={onDone}
    />,
  );
  return { onDone };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListLotCertificates.mockResolvedValue([]);
  mockUploadLotCertificate.mockResolvedValue({ id: 'cert-1' });
});

describe('CertAfterReceiptPanel — never blocks the receipt', () => {
  it('enables Done with no file chosen, and dismisses on click', async () => {
    const user = userEvent.setup();
    const { onDone } = renderPanel();

    const done = await screen.findByRole('button', { name: 'Done' });
    expect(done).toBeEnabled();

    await user.click(done);
    expect(onDone).toHaveBeenCalled();
    expect(mockUploadLotCertificate).not.toHaveBeenCalled();
  });

  it('says nothing red and never warns that a cert is missing', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'Done' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the stock recorded and offers a retry when the upload fails', async () => {
    const user = userEvent.setup();
    mockUploadLotCertificate.mockRejectedValue(new Error('network went away'));
    const { onDone } = renderPanel();

    await screen.findByRole('button', { name: /add the mill cert/i });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, makeFile('MTR.pdf'));

    const alert = await screen.findByRole('alert');
    // The FIRST thing it says is that the stock landed — not that something failed.
    expect(alert).toHaveTextContent(/The stock is recorded/i);
    // Warning, not error: the movement succeeded, only the document did not.
    expect(alert.className).toMatch(/Warning/);
    // The panel stays open so the cert can be retried against the same lot.
    expect(onDone).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('counts attempts so a second failure is distinguishable from a first', async () => {
    const user = userEvent.setup();
    mockUploadLotCertificate.mockRejectedValue(new Error('nope'));
    renderPanel();

    await screen.findByRole('button', { name: /add the mill cert/i });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, makeFile('MTR.pdf'));
    await screen.findByRole('button', { name: 'Try again' });
    await user.upload(input, makeFile('MTR.pdf'));

    await waitFor(() => {
      const failures = mockCapture.mock.calls.filter(
        (c) => c[0] === 'lot certificate upload failed',
      );
      expect(failures.map((c) => (c[1] as { attempt: number }).attempt)).toEqual([1, 2]);
    });
  });

  it('refuses a bad file in the browser, without uploading anything', async () => {
    renderPanel();

    await screen.findByRole('button', { name: /add the mill cert/i });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    // `applyAccept: false` on purpose. The `accept` attribute already stops this in a real picker,
    // so the only way a bad file reaches the handler is a path that ignores it — a drag-drop, or a
    // STEP file someone renamed. That is exactly the case the validation exists for, and testing
    // through the accept filter would assert the browser's behaviour instead of ours.
    // `fireEvent`, not `user.upload`. The `accept` attribute already stops this in a real picker,
    // so userEvent (which honours it) can never deliver the file. The only paths that CAN are ones
    // that ignore accept — a drag-drop, or a STEP file someone renamed to .pdf — and that is
    // exactly what this validation is the second line of defence for.
    const bad = makeFile('model.step', 1024, 'application/octet-stream');
    Object.defineProperty(input, 'files', { value: [bad], configurable: true });
    fireEvent.change(input);

    expect(await screen.findByRole('alert')).toHaveTextContent(/PDF or a photo/i);
    expect(mockUploadLotCertificate).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith('lot certificate upload failed', {
      surface: 'operator_receive',
      reason: 'rejected',
      attempt: 1,
    });
  });
});

describe('CertAfterReceiptPanel — a lot that already has one', () => {
  it('confirms rather than prompts, and offers View and Add another', async () => {
    mockListLotCertificates.mockResolvedValue([
      { id: 'cert-1', file_name: 'MTR.pdf', mime_type: 'application/pdf', file_path: 'p' },
    ]);
    renderPanel();

    expect(await screen.findByText(/already has a certificate/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add another' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add the mill cert/i })).not.toBeInTheDocument();
  });

  it('marks a further upload as a replacement', async () => {
    const user = userEvent.setup();
    mockListLotCertificates.mockResolvedValue([
      { id: 'cert-1', file_name: 'MTR.pdf', mime_type: 'application/pdf', file_path: 'p' },
    ]);
    renderPanel();

    await screen.findByRole('button', { name: 'Add another' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, makeFile('MTR-rev-b.pdf'));

    await waitFor(() => {
      expect(mockCapture).toHaveBeenCalledWith('lot certificate uploaded', {
        surface: 'operator_receive',
        at_receipt: true,
        file_kind: 'pdf',
        size_bucket: 'under_1mb',
        is_replacement: true,
      });
    });
  });
});
