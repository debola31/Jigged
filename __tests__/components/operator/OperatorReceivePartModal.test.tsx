import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorReceivePartModal from '@/components/operator/OperatorReceivePartModal';
import { addStockAtLocation } from '@/utils/inventoryLocationsAccess';
import { searchPartsForSelect } from '@/utils/partsAccess';
import { uploadFileToStorage } from '@/utils/storageHelpers';
import type { PartSelectOption } from '@/utils/partsAccess';

vi.mock('@/utils/inventoryLocationsAccess', () => ({ addStockAtLocation: vi.fn() }));
// The picker is `PartAutocomplete`, which server-searches rather than bulk-loading — the modal
// itself no longer reads parts at all. Mocking the search is therefore mocking the picker.
vi.mock('@/utils/partsAccess', () => ({ searchPartsForSelect: vi.fn() }));
// Mirrors OperatorLocationActionModal.test.tsx, because this modal now does the same thing:
// storageHelpers reaches lib/supabase, which builds its client eagerly at import time whenever
// `window` exists, and `compressPhoto` runs browser-image-compression, which needs a canvas jsdom
// does not have — the real one throws and the field reports a failed pick instead of attaching.
vi.mock('@/utils/storageHelpers', () => ({
  generateStoragePath: (co: string, kind: string, id: string, name: string) =>
    `${co}/${kind}/${id}/${name}`,
  uploadFileToStorage: vi.fn(async () => undefined),
}));
vi.mock('@/utils/imageCompression', () => ({
  compressPhoto: vi.fn(async (f: File) => ({ file: f })),
}));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
// jsdom implements neither; the preview thumbnail needs both.
if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => 'blob:preview');
if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();

const part = (over: { id: string; part_name: string }) =>
  ({ ...over, primary_unit: 'ea' }) as unknown as PartSelectOption;

const renderModal = (props: Partial<React.ComponentProps<typeof OperatorReceivePartModal>> = {}) =>
  render(
    <OperatorReceivePartModal
      open
      companyId="co1"
      locationId="loc1"
      locationName="Bin 3"
      excludePartIds={['pC']}
      operatorId="op1"
      onClose={vi.fn()}
      onDone={vi.fn()}
      {...props}
    />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );

beforeEach(() => {
  vi.clearAllMocks();
  (searchPartsForSelect as ReturnType<typeof vi.fn>).mockResolvedValue([
    part({ id: 'pA', part_name: 'Part A' }),
    part({ id: 'pB', part_name: 'Part B' }),
    part({ id: 'pC', part_name: 'Part C' }), // already here → excluded
  ]);
});

describe('OperatorReceivePartModal', () => {
  const openPartPicker = async () => {
    const input = await screen.findByRole('combobox', { name: 'Part' });
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}'); // ensure the listbox opens
    return input;
  };

  /**
   * "Already in the bin" is the only exclusion left, and it is now `PartAutocomplete`'s
   * `excludeIds` rather than a filter in this component. The other one — a part not tracked by
   * place — went with `is_location_tracked` in 20260802015837; the one after that was
   * `is_stocked`, which used to keep this picker's bulk load down to a few hundred rows.
   */
  it('offers every part not already in the bin', async () => {
    renderModal();
    await openPartPicker();
    expect(await screen.findByRole('option', { name: 'Part A' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Part B' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Part C' })).not.toBeInTheDocument(); // already here
  });

  it('adds the chosen part at this location', async () => {
    (addStockAtLocation as ReturnType<typeof vi.fn>).mockResolvedValue({ location_balance: 10, part_quantity: 10 });
    const onDone = vi.fn();
    renderModal({ onDone });

    await openPartPicker();
    await userEvent.click(await screen.findByRole('option', { name: 'Part A' }));
    await userEvent.type(screen.getByRole('spinbutton', { name: 'Quantity' }), '10');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      // Receiving into a bin is a put-away, so it carries an author like every other
      // operator write — bin history cannot name `created_by` (an auth user id).
      expect(addStockAtLocation).toHaveBeenCalledWith('pA', 'loc1', 10, 'ea', {
        notes: undefined,
        operatorId: 'op1',
        photoPath: undefined,
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  /**
   * The bug this closes.
   *
   * Two modals write stock at a bin, and only the OTHER one offered a photo — so a part gained one
   * on its second visit to a shelf and never on its first, which is exactly backwards: the first
   * drop is the one nobody else has seen. `uploadMovementPhoto` is now shared by both.
   */
  describe('photo on the first drop', () => {
    const file = () => new File(['x'], 'shelf.jpg', { type: 'image/jpeg' });

    const pickPartAndQuantity = async (user: ReturnType<typeof userEvent.setup>) => {
      await openPartPicker();
      await user.click(await screen.findByRole('option', { name: 'Part A' }));
      await user.type(screen.getByRole('spinbutton', { name: 'Quantity' }), '10');
    };

    it('offers a photo when stocking a part into a bin for the first time', async () => {
      renderModal();
      expect(await screen.findByRole('button', { name: /add a photo/i })).toBeInTheDocument();
    });

    it('uploads BEFORE the write, and sends the path it just wrote', async () => {
      const user = userEvent.setup();
      (addStockAtLocation as ReturnType<typeof vi.fn>).mockResolvedValue({});
      renderModal();

      await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file());
      await screen.findByText(/photo attached/i);
      await pickPartAndQuantity(user);
      await user.click(screen.getByRole('button', { name: /^add$/i }));

      await waitFor(() => expect(addStockAtLocation).toHaveBeenCalled());
      // `photo_path` is written at INSERT inside the RPC and immutable after, so an upload that
      // ran second could never be attached — the order is the whole point.
      expect(vi.mocked(uploadFileToStorage).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(addStockAtLocation).mock.invocationCallOrder[0],
      );
      expect(addStockAtLocation).toHaveBeenCalledWith(
        'pA',
        'loc1',
        10,
        'ea',
        expect.objectContaining({ photoPath: vi.mocked(uploadFileToStorage).mock.calls[0][0] }),
      );
    });

    /**
     * A failed upload aborts the write, and says so in its own words. Left to the shared mapper it
     * would read "Failed to add stock", which points at the quantity — so an operator retypes a
     * number that was never the problem.
     */
    it('records nothing when the upload fails, and names the photo as the reason', async () => {
      const user = userEvent.setup();
      vi.mocked(uploadFileToStorage).mockRejectedValueOnce(new Error('offline'));
      renderModal();

      await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file());
      await screen.findByText(/photo attached/i);
      await pickPartAndQuantity(user);
      await user.click(screen.getByRole('button', { name: /^add$/i }));

      expect(await screen.findByText(/couldn't upload the photo/i)).toBeInTheDocument();
      expect(addStockAtLocation).not.toHaveBeenCalled();
    });
  });
  /**
   * Recording the first heat against a part turns tracking on for it, and from then on every
   * removal asks which heat. That is a change to how the part works, caused by the person standing
   * here holding the bar — so this is the one save the dialog does not close on.
   */
  describe('when this receipt is what started tracing the part', () => {
    const receiveWithHeat = async (started: boolean) => {
      (addStockAtLocation as ReturnType<typeof vi.fn>).mockResolvedValue({
        location_balance: 10,
        part_quantity: 10,
        started_tracking: started,
      });
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderModal({ onClose });

      await openPartPicker();
      await user.click(await screen.findByRole('option', { name: 'Part A' }));
      await user.type(screen.getByRole('spinbutton', { name: 'Quantity' }), '10');
      await user.type(screen.getByRole('textbox', { name: /heat number/i }), '4471');
      await user.click(screen.getByRole('button', { name: /^add$/i }));
      return { onClose, user };
    };

    it('stays open and says what just changed, instead of closing silently', async () => {
      const { onClose } = await receiveWithHeat(true);

      const notice = await screen.findByRole('alert');
      // Names the part, and says what will happen next rather than only that something did.
      expect(notice).toHaveTextContent(/Part A is now tracked by heat/i);
      expect(notice).toHaveTextContent(/ask which heat/i);
      expect(onClose).not.toHaveBeenCalled();
    });

    /**
     * The form is replaced, not left beside the message. The write has landed, so the obvious next
     * tap on a still-armed Add would put a second bar in a bin that already has the first.
     */
    it('leaves nothing to re-submit', async () => {
      await receiveWithHeat(true);

      await screen.findByRole('alert');
      expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^done$/i })).toBeInTheDocument();
    });

    /** Says nothing about the operator: no count of heats, no tally, no standing. */
    it('states a rule about the part, never anything about the person', async () => {
      await receiveWithHeat(true);

      const notice = await screen.findByRole('alert');
      for (const forbidden of [/streak/i, /rank/i, /leaderboard/i, /total/i, /points?\b/i]) {
        expect(notice.textContent ?? '').not.toMatch(forbidden);
      }
    });

    /** The ordinary receipt — an already-traced part, or no heat at all — closes as it always did. */
    it('closes as usual when nothing changed about the part', async () => {
      const { onClose } = await receiveWithHeat(false);

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
