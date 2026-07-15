import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import CostingBatchField from '@/components/parts/CostingBatchField';

const mockGetComputedPartCost = vi.fn();
const mockUpdateBatch = vi.fn();

vi.mock('@/utils/partsAccess', () => ({
  getComputedPartCost: (...a: unknown[]) => mockGetComputedPartCost(...a),
  updatePartCostingBatchQuantity: (...a: unknown[]) => mockUpdateBatch(...a),
}));

describe('CostingBatchField', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetComputedPartCost.mockResolvedValue(109);
    mockUpdateBatch.mockResolvedValue(undefined);
  });

  it('shows the current batch and its live per-unit cost', async () => {
    render(<CostingBatchField partId="p1" initialBatch={25} unitLabel="ea" />);

    const field = screen.getByLabelText(/Batch qty/i) as HTMLInputElement;
    expect(field.value).toBe('25');
    await waitFor(() => expect(mockGetComputedPartCost).toHaveBeenCalledWith('p1', 25));
    expect(await screen.findByText(/=\s*\$109\.00\s*\/\s*ea/)).toBeInTheDocument();
  });

  it('is in the default state (blank) with Save disabled and cascade messaging', () => {
    render(<CostingBatchField partId="p1" initialBatch={null} unitLabel="ea" />);
    expect(screen.getByText(/Valued at the quantity each order draws/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('saves the entered batch via updatePartCostingBatchQuantity and fires onSaved', async () => {
    const onSaved = vi.fn();
    render(<CostingBatchField partId="p1" initialBatch={null} unitLabel="ea" onSaved={onSaved} />);

    await user.type(screen.getByLabelText(/Batch qty/i), '25');
    const save = screen.getByRole('button', { name: /save/i });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(mockUpdateBatch).toHaveBeenCalledWith('p1', 25));
    expect(onSaved).toHaveBeenCalled();
  });

  it('saves null when the batch is cleared (back to default)', async () => {
    render(<CostingBatchField partId="p1" initialBatch={25} unitLabel="ea" />);

    await user.clear(screen.getByLabelText(/Batch qty/i));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(mockUpdateBatch).toHaveBeenCalledWith('p1', null));
  });
});
