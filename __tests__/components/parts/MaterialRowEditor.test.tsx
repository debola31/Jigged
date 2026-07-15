import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import MaterialRowEditor, {
  type MaterialEditorValue,
  type PartSelectOption,
} from '@/components/parts/MaterialRowEditor';

// getPartUnitConversions runs on child selection (no secondary units here, so
// the unit stays the child's primary). getPart loads the child's current batch
// qty on selecting a made child; getComputedPartCost derives the batch cost.
vi.mock('@/utils/partsAccess', () => ({
  getPartUnitConversions: vi.fn().mockResolvedValue([]),
  getPart: vi.fn().mockResolvedValue({ id: 'child-1', costing_batch_quantity: null }),
  getComputedPartCost: vi.fn().mockResolvedValue(109),
}));

// Stub PartAutocomplete: a button that selects a preset option and reflects the
// `disabled` prop (so we can assert the picker is editable in edit mode).
let nextPickOption: PartSelectOption | null = null;
vi.mock('@/components/parts/PartAutocomplete', () => ({
  __esModule: true,
  default: ({
    onChange,
    disabled,
  }: {
    onChange: (o: PartSelectOption | null) => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={() => onChange(nextPickOption)}>
      pick-part
    </button>
  ),
}));

function makeOption(over: Partial<PartSelectOption> = {}): PartSelectOption {
  return {
    id: 'child-1',
    part_name: 'M48 Ground',
    description: null,
    primary_unit: 'each',
    is_stocked: true,
    source: 'made',
    has_routing: false,
    quantity: 0,
    ...over,
  } as PartSelectOption;
}

describe('MaterialRowEditor — single quantity field', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    nextPickOption = null;
  });

  it('(e) edit mode with a fractional quantity shows the value and its yield reciprocal', async () => {
    const initial: MaterialEditorValue = {
      childPart: makeOption(),
      quantity: '0.05',
      unit: 'each',
      consume_whole_units: true,
    };
    render(
      <MaterialRowEditor
        companyId="co-1"
        initial={initial}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const qty = (await screen.findByLabelText(/per part/i)) as HTMLInputElement;
    expect(qty.value).toBe('0.05');
    // A count material < 1 per part reads as a yield — reciprocal is confirmed.
    expect(screen.getByText(/20 parts from one ea/i)).toBeInTheDocument();
  });

  it('accepts a fraction and stores its decimal (1/20 → 0.05)', async () => {
    const onSave = vi.fn();
    const initial: MaterialEditorValue = {
      childPart: makeOption(),
      quantity: '0.05',
      unit: 'each',
      consume_whole_units: true,
    };
    render(
      <MaterialRowEditor
        companyId="co-1"
        initial={initial}
        onSave={onSave}
        onCancel={() => undefined}
      />,
    );

    const qty = await screen.findByLabelText(/per part/i);
    await user.clear(qty);
    await user.type(qty, '1/20');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(parseFloat(onSave.mock.calls[0][0].quantity)).toBeCloseTo(0.05, 10);
  });

  it('rejects an unparseable quantity (Save disabled, error shown)', async () => {
    const initial: MaterialEditorValue = {
      childPart: makeOption(),
      quantity: '1',
      unit: 'each',
      consume_whole_units: true,
    };
    render(
      <MaterialRowEditor
        companyId="co-1"
        initial={initial}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const qty = await screen.findByLabelText(/per part/i);
    await user.clear(qty);
    await user.type(qty, '1/0');
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('derives consume_whole_units = true for a count unit (no manual toggle)', async () => {
    const onSave = vi.fn();
    nextPickOption = makeOption({ primary_unit: 'each' });
    render(
      <MaterialRowEditor companyId="co-1" onSave={onSave} onCancel={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: 'pick-part' }));
    const qty = await screen.findByLabelText(/per part/i);
    await user.type(qty, '2');
    await user.click(screen.getByRole('button', { name: /add to bom/i }));

    expect(onSave.mock.calls[0][0].consume_whole_units).toBe(true);
    // No round-up switch is rendered anymore.
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('derives consume_whole_units = false for a length unit', async () => {
    const onSave = vi.fn();
    nextPickOption = makeOption({ primary_unit: 'inches' });
    render(
      <MaterialRowEditor companyId="co-1" onSave={onSave} onCancel={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: 'pick-part' }));
    const qty = await screen.findByLabelText(/per part/i);
    await user.type(qty, '7');
    await user.click(screen.getByRole('button', { name: /add to bom/i }));

    expect(onSave.mock.calls[0][0].consume_whole_units).toBe(false);
  });

  it('allows changing the material part in edit mode (picker not locked)', async () => {
    const initial: MaterialEditorValue = {
      childPart: makeOption(),
      quantity: '1',
      unit: 'each',
      consume_whole_units: true,
    };
    render(
      <MaterialRowEditor
        companyId="co-1"
        initial={initial}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(await screen.findByRole('button', { name: 'pick-part' })).toBeEnabled();
  });

  it('enables the unit selector when standard same-dimension units exist (inches → feet/meters)', async () => {
    nextPickOption = makeOption({ primary_unit: 'inches' });
    render(
      <MaterialRowEditor companyId="co-1" onSave={() => undefined} onCancel={() => undefined} />,
    );
    await user.click(screen.getByRole('button', { name: 'pick-part' }));

    const unit = await screen.findByRole('combobox');
    await waitFor(() => expect(unit).not.toHaveAttribute('aria-disabled', 'true'));

    // Opening it offers the standard siblings.
    await user.click(unit);
    expect(await screen.findByRole('option', { name: 'feet' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'meters' })).toBeInTheDocument();
  });

  it('disables the unit selector when only the primary unit is available', async () => {
    nextPickOption = makeOption({ primary_unit: 'widgets' }); // custom → no siblings
    render(
      <MaterialRowEditor companyId="co-1" onSave={() => undefined} onCancel={() => undefined} />,
    );
    await user.click(screen.getByRole('button', { name: 'pick-part' }));

    const unit = await screen.findByRole('combobox');
    await waitFor(() => expect(unit).toHaveAttribute('aria-disabled', 'true'));
  });

  it('surfaces the batch cost basis for a made child consumed as a fraction and returns it on save', async () => {
    const onSave = vi.fn();
    const initial: MaterialEditorValue = {
      childPart: makeOption(),
      quantity: '0.05',
      unit: 'each',
      consume_whole_units: true,
      childCostingBatchQuantity: 25,
    };
    render(
      <MaterialRowEditor
        companyId="co-1"
        initial={initial}
        onSave={onSave}
        onCancel={() => undefined}
      />,
    );

    const batchField = (await screen.findByLabelText(/Batch qty/i)) as HTMLInputElement;
    expect(batchField.value).toBe('25');

    await user.clear(batchField);
    await user.type(batchField, '10');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave.mock.calls[0][0].childCostingBatchQuantity).toBe(10);
  });

  it('does not touch the child batch qty when consumption is not fractional', async () => {
    const onSave = vi.fn();
    const initial: MaterialEditorValue = {
      childPart: makeOption(),
      quantity: '2', // whole units per part → not fractional → no batch field
      unit: 'each',
      consume_whole_units: false,
    };
    render(
      <MaterialRowEditor
        companyId="co-1"
        initial={initial}
        onSave={onSave}
        onCancel={() => undefined}
      />,
    );

    expect(screen.queryByLabelText(/Batch qty/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave.mock.calls[0][0].childCostingBatchQuantity).toBeUndefined();
  });
});
