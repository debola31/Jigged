/**
 * The certificates for a batch that landed (the Storage bin form's several heats, and a purchase
 * order receipt whose cert upload failed): one control per lot, one Done, never blocking.
 *
 * What is pinned here is the `surface` the lot-certificate events carry (docs/telemetry.md): it is
 * the number the feature exists to move — where certs are captured — so a PO receipt's retry must
 * not be counted as the bin form's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../test-utils';

const m = vi.hoisted(() => ({
  listLotCertificatesForLots: vi.fn(),
  uploadLotCertificate: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('@/utils/lotCertificatesAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/lotCertificatesAccess')>()),
  listLotCertificatesForLots: (...a: unknown[]) => m.listLotCertificatesForLots(...a),
  uploadLotCertificate: (...a: unknown[]) => m.uploadLotCertificate(...a),
}));
vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => m.capture(...a) } }));

import CertAfterBatchPanel from '@/components/inventory/CertAfterBatchPanel';

const LOTS = [
  { lotId: 'lot-1', partName: 'BAR-6061', heatLabel: 'Heat 4471' },
  { lotId: 'lot-2', partName: 'BAR-6061', heatLabel: 'Heat 4472' },
];

async function attach(surface?: string) {
  const user = userEvent.setup();
  const onDone = vi.fn();
  render(<CertAfterBatchPanel companyId="c1" lots={LOTS} onDone={onDone} {...(surface ? { surface } : {})} />);
  expect(await screen.findAllByRole('button', { name: 'Add cert' })).toHaveLength(2);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, new File(['%PDF'], 'mtr.pdf', { type: 'application/pdf' }));
  await waitFor(() => expect(m.uploadLotCertificate).toHaveBeenCalledWith('c1', 'lot-1', expect.any(File)));
  return { user, onDone };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.listLotCertificatesForLots.mockResolvedValue(new Map());
  m.uploadLotCertificate.mockResolvedValue({ id: 'cert-1' });
});

describe('CertAfterBatchPanel', () => {
  it('counts a cert from the Storage bin form as office_batch by default', async () => {
    await attach();
    await waitFor(() =>
      expect(m.capture).toHaveBeenCalledWith('lot certificate uploaded', expect.objectContaining({ surface: 'office_batch', at_receipt: true })),
    );
  });

  it('counts it under the surface it is given — a purchase order receipt', async () => {
    await attach('office_po_receipt');
    await waitFor(() =>
      expect(m.capture).toHaveBeenCalledWith('lot certificate uploaded', expect.objectContaining({ surface: 'office_po_receipt', at_receipt: true })),
    );
  });

  it('has one Done for the batch, always enabled', async () => {
    const { user, onDone } = await attach();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeEnabled();
    await user.click(done);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
