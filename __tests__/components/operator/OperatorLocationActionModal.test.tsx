import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorLocationActionModal from '@/components/operator/OperatorLocationActionModal';
import {
  addStockAtLocation,
  depleteStockAtLocation,
  transferStock,
} from '@/utils/inventoryLocationsAccess';
import { uploadFileToStorage } from '@/utils/storageHelpers';
import { getAllJobs } from '@/utils/jobsAccess';
import type { JobWithRelations } from '@/types/job';

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  addStockAtLocation: vi.fn(),
  depleteStockAtLocation: vi.fn(),
  adjustStockAtLocation: vi.fn(),
  transferStock: vi.fn(),
}));
// The action modal can now attach a photo, which pulls in storageHelpers -> lib/supabase, and that
// module builds its client eagerly at import time whenever `window` exists. Stubbed rather than
// mocking the whole Supabase client: these tests never exercise an upload.
// `compressPhoto` runs browser-image-compression, which needs canvas — jsdom has none, so the
// real one throws and the field reports a failed pick instead of attaching. Pass the file through.
vi.mock('@/utils/imageCompression', () => ({
  compressPhoto: vi.fn(async (f: File) => ({ file: f })),
}));
// jsdom implements neither of these; the preview thumbnail needs both.
if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => 'blob:preview');
if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();

vi.mock('@/utils/storageHelpers', () => ({
  generateStoragePath: (co: string, kind: string, id: string, name: string) =>
    `${co}/${kind}/${id}/${name}`,
  uploadFileToStorage: vi.fn(async () => undefined),
}));

vi.mock('@/utils/jobsAccess', () => ({ getAllJobs: vi.fn() }));

const job = (over: { id: string; job_number: string; parts: string[] }) =>
  ({
    id: over.id,
    job_number: over.job_number,
    job_parts: over.parts.map((n) => ({ parts: { part_name: n } })),
  }) as unknown as JobWithRelations;

const renderModal = (props: Partial<React.ComponentProps<typeof OperatorLocationActionModal>> = {}) =>
  render(
    <OperatorLocationActionModal
      open
      action="deplete"
      companyId="co1"
      partId="p1"
      partName="Steel Rod"
      currentQuantity={12}
      primaryUnit="ea"
      unitOptions={['ea']}
      locationId="loc1"
      locationName="Bin 3"
      operatorId="op1"
      onClose={vi.fn()}
      onDone={vi.fn()}
      {...props}
    />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );

beforeEach(() => {
  vi.clearAllMocks();
  (getAllJobs as ReturnType<typeof vi.fn>).mockResolvedValue({
    jobs: [
      job({ id: 'j1', job_number: 'JOB-001', parts: ['Bracket', 'Pin'] }),
      job({ id: 'j2', job_number: 'JOB-002', parts: ['Flange'] }),
    ],
    total: 2,
    truncated: false,
  });
  (depleteStockAtLocation as ReturnType<typeof vi.fn>).mockResolvedValue({ location_balance: 7, part_quantity: 7 });
});

describe('OperatorLocationActionModal — deplete job tag', () => {
  it('lists active jobs with their parts and tags the removal with the chosen job', async () => {
    renderModal();

    await userEvent.type(screen.getByRole('spinbutton', { name: /quantity/i }), '5');

    await userEvent.click(await screen.findByRole('combobox', { name: /tag to a job/i }));
    await userEvent.keyboard('{ArrowDown}');
    const option = await screen.findByRole('option', { name: /JOB-001/ });
    expect(option).toHaveTextContent('Bracket, Pin'); // the job's parts disambiguate it
    await userEvent.click(option);

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith(
        'p1',
        'loc1',
        5,
        'ea',
        expect.objectContaining({ jobId: 'j1', graceful: true, operatorId: 'op1' }),
      ),
    );
  });

  it('leaves the removal untagged when no job is picked', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('spinbutton', { name: /quantity/i }), '3');
    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith(
        'p1',
        'loc1',
        3,
        'ea',
        expect.objectContaining({ jobId: undefined }),
      ),
    );
  });
});

/**
 * Move on the operator surface. The admin part page has always had it; this one didn't, so an
 * operator consolidating two shelves had to Remove from one and Add at the other — two ledger
 * rows and a hole in the middle if they got interrupted.
 */
describe('move', () => {
  const DESTINATIONS = [
    { id: 'loc2', label: 'Cabinet 3 › Shelf B' },
    { id: 'loc3', label: 'Yard' },
  ];

  it('transfers to the chosen destination in one call', async () => {
    const user = userEvent.setup();
    renderModal({ action: 'move', moveDestinations: DESTINATIONS });

    await user.click(screen.getByRole('combobox', { name: /move to/i }));
    await user.click(await screen.findByRole('option', { name: 'Yard' }));
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '4');
    await user.click(screen.getByRole('button', { name: /^move$/i }));

    await waitFor(() =>
      // operatorId now rides on every operator write, not just depletion — bin history
      // has to be able to name who moved it.
      expect(transferStock).toHaveBeenCalledWith('p1', 'loc1', 'loc3', 4, 'ea', {
        notes: undefined,
        operatorId: 'op1',
      }),
    );
  });

  it('asks where it is going rather than guessing', async () => {
    const user = userEvent.setup();
    renderModal({ action: 'move', moveDestinations: DESTINATIONS });

    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '4');
    await user.click(screen.getByRole('button', { name: /^move$/i }));

    expect(await screen.findByText(/choose where it's going/i)).toBeInTheDocument();
    expect(transferStock).not.toHaveBeenCalled();
  });

  // One action, one name across both surfaces — this said "Set" where admin says "Adjust".
  it('calls the cycle-count action Adjust, matching the admin page', async () => {
    renderModal({ action: 'adjust' });
    expect(screen.getByText(/set the true quantity/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^adjust$/i })).toBeInTheDocument();
  });
});

/**
 * Photo evidence on a movement.
 *
 * The ordering is the part worth pinning: `photo_path` is written at INSERT inside the RPC and is
 * immutable afterwards, so the upload MUST complete first — there is no later step in which to
 * attach one. Get it backwards and the column is silently always NULL.
 */
describe('photo evidence', () => {
  const file = () => new File(['x'], 'shelf.jpg', { type: 'image/jpeg' });

  it('offers a photo where material lands, and not where it does not', async () => {
    // `add` puts material somewhere — there is a shelf to show.
    renderModal({ action: 'add' });
    expect(screen.getByRole('button', { name: /add a photo/i })).toBeInTheDocument();

    // `deplete` takes it away (nothing to show) and `adjust` corrects a number (its evidence is
    // the count that produced it).
    for (const action of ['deplete', 'adjust'] as const) {
      cleanup();
      renderModal({ action });
      expect(screen.queryByRole('button', { name: /add a photo/i })).not.toBeInTheDocument();
    }
  });

  it('uploads BEFORE the write, and sends the path it just wrote', async () => {
    const user = userEvent.setup();
    renderModal({ action: 'add' });

    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file());
    await screen.findByText(/photo attached/i);
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '5');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(addStockAtLocation).toHaveBeenCalled());
    const path = vi.mocked(uploadFileToStorage).mock.calls[0][0];
    expect(vi.mocked(uploadFileToStorage).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(addStockAtLocation).mock.invocationCallOrder[0],
    );
    expect(addStockAtLocation).toHaveBeenCalledWith(
      'p1',
      'loc1',
      5,
      'ea',
      expect.objectContaining({ photoPath: path }),
    );
  });

  /**
   * A failed upload aborts the write. Saving anyway would record a movement without the photo the
   * operator just attached — a quiet lie about what went in.
   */
  it('does not record the movement when the upload fails', async () => {
    const user = userEvent.setup();
    vi.mocked(uploadFileToStorage).mockRejectedValueOnce(new Error('offline'));
    renderModal({ action: 'add' });

    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file());
    await screen.findByText(/photo attached/i);
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '5');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    // Names the PHOTO as the cause. The shared error mapper would have said "Failed to update
    // stock", sending the operator to retype a quantity that was never the problem.
    const msg = await screen.findByText(/couldn't upload the photo/i);
    expect(msg).toHaveTextContent(/offline/i);
    expect(msg).toHaveTextContent(/nothing was recorded/i);
    expect(addStockAtLocation).not.toHaveBeenCalled();
  });

  it('records the movement with no photo at all, which is the normal case', async () => {
    const user = userEvent.setup();
    renderModal({ action: 'add' });
    await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), '5');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      expect(addStockAtLocation).toHaveBeenCalledWith(
        'p1',
        'loc1',
        5,
        'ea',
        expect.objectContaining({ photoPath: undefined }),
      ),
    );
    expect(uploadFileToStorage).not.toHaveBeenCalled();
  });
});
