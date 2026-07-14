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

// Stub PartAutocomplete: a button that selects a preset option. The preset is
// swapped per test so we can drive "new line picks a count vs length unit".
let nextPickOption: PartSelectOption | null = null;
vi.mock('@/components/parts/PartAutocomplete', () => ({
  __esModule: true,
  default: ({ onChange }: { onChange: (o: PartSelectOption | null) => void }) => (
    <button type="button" onClick={() => onChange(nextPickOption)}>
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

describe('MaterialRowEditor — yield / whole-unit', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    nextPickOption = null;
  });

  it('(e) edit mode with a fractional quantity displays it back as a yield', async () => {
    // quantity 0.05 (per part) ⇒ derives yield mode showing 20 parts / unit.
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
        lockChildPart
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const yieldField = (await screen.findByLabelText(/Yield/i)) as HTMLInputElement;
    expect(yieldField.value).toBe('20');
  });

  it('(e) yield input 20 round-trips to a stored per-part quantity of 0.05', async () => {
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
        lockChildPart
        onSave={onSave}
        onCancel={() => undefined}
      />,
    );

    // Re-type the yield explicitly to prove the handler stores 1/yield.
    const yieldField = await screen.findByLabelText(/Yield/i);
    await user.clear(yieldField);
    await user.type(yieldField, '20');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as MaterialEditorValue;
    expect(parseFloat(saved.quantity)).toBeCloseTo(0.05, 10);
  });

  it('defaults whole-unit ON for a count unit once consumption is fractional (yield)', async () => {
    nextPickOption = makeOption({ primary_unit: 'each' });
    const { container } = render(
      <MaterialRowEditor companyId="co-1" onSave={() => undefined} onCancel={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: 'pick-part' }));

    // Count unit → the field opens in yield framing. The round-up toggle is only
    // shown once consumption is fractional, so enter a yield to reveal it.
    const yieldField = await screen.findByLabelText(/Yield/i);
    await user.type(yieldField, '20'); // → 0.05 ea per part (fractional)

    // The consume-whole-units switch is a checkbox input; count unit → checked.
    await waitFor(() => {
      const sw = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(sw).not.toBeNull();
      expect(sw.checked).toBe(true);
    });
  });

  it('defaults whole-unit OFF for a length unit once consumption is fractional', async () => {
    nextPickOption = makeOption({ primary_unit: 'inches' });
    const { container } = render(
      <MaterialRowEditor companyId="co-1" onSave={() => undefined} onCancel={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: 'pick-part' }));

    // Length unit → amount-per-part framing; a fractional amount reveals the toggle.
    const qtyField = await screen.findByLabelText(/per part/i);
    await user.type(qtyField, '0.5');

    await waitFor(() => {
      const sw = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(sw).not.toBeNull();
      expect(sw.checked).toBe(false);
    });
  });

  it('hides the whole-unit toggle for whole-number consumption (ceiling is a no-op)', async () => {
    // qty 1 per part → ceil(N×1)=N, so rounding changes nothing → no toggle shown.
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
        lockChildPart
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('surfaces the batch cost basis for a made child consumed as a fraction and returns it on save', async () => {
    const onSave = vi.fn();
    const initial: MaterialEditorValue = {
      childPart: makeOption(), // made child
      quantity: '0.05', // fractional → yield 20
      unit: 'each',
      consume_whole_units: true,
      childCostingBatchQuantity: 25,
    };
    render(
      <MaterialRowEditor
        companyId="co-1"
        initial={initial}
        lockChildPart
        onSave={onSave}
        onCancel={() => undefined}
      />,
    );

    // The batch-qty field is shown, seeded from the child's stored value.
    const batchField = (await screen.findByLabelText(/Batch qty/i)) as HTMLInputElement;
    expect(batchField.value).toBe('25');

    await user.clear(batchField);
    await user.type(batchField, '10');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const saved = onSave.mock.calls[0][0] as MaterialEditorValue;
    expect(saved.childCostingBatchQuantity).toBe(10);
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
        lockChildPart
        onSave={onSave}
        onCancel={() => undefined}
      />,
    );

    expect(screen.queryByLabelText(/Batch qty/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const saved = onSave.mock.calls[0][0] as MaterialEditorValue;
    expect(saved.childCostingBatchQuantity).toBeUndefined();
  });
});
