import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import MaterialRowEditor, {
  type MaterialEditorValue,
  type PartSelectOption,
} from '@/components/parts/MaterialRowEditor';

// getPartUnitConversions runs on child selection (no secondary units here, so
// the unit stays the child's primary).
vi.mock('@/utils/partsAccess', () => ({
  getPartUnitConversions: vi.fn().mockResolvedValue([]),
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
      charge_basis: 'cost',
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
      charge_basis: 'cost',
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

    const unit = await screen.findByRole('combobox', { name: /unit/i });
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

    const unit = await screen.findByRole('combobox', { name: /unit/i });
    await waitFor(() => expect(unit).toHaveAttribute('aria-disabled', 'true'));
  });

  it('does not surface a batch field — the costing batch lives on the child part page', async () => {
    // Even for a made child consumed as a fraction (the old inline-batch case),
    // this editor stays part + unit + qty; the batch is edited on the child.
    const initial: MaterialEditorValue = {
      childPart: makeOption(),
      quantity: '0.05',
      unit: 'each',
      consume_whole_units: true,
      charge_basis: 'cost',
    };
    render(
      <MaterialRowEditor
        companyId="co-1"
        initial={initial}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    await screen.findByLabelText(/per part/i);
    expect(screen.queryByLabelText(/Batch qty/i)).toBeNull();
  });

  // #727. Charge basis is decided once per part on the Materials panel, not on
  // every row — a shop that marks up purchased material marks up all of it, and
  // a fourth control here bought nothing. What this editor must still do is
  // carry the value through untouched, so editing a row's quantity cannot
  // silently reset how that material is charged.
  describe('charge basis', () => {
    it('offers no control for it', async () => {
      nextPickOption = makeOption({ primary_unit: 'each' });
      render(
        <MaterialRowEditor companyId="co-1" onSave={() => undefined} onCancel={() => undefined} />,
      );
      await user.click(screen.getByRole('button', { name: 'pick-part' }));
      await screen.findByLabelText(/per part/i);

      expect(screen.queryByRole('combobox', { name: /charge at/i })).toBeNull();
      expect(screen.queryByText(/marked-up price/i)).toBeNull();
    });

    it('carries an existing line’s basis through an unrelated edit', async () => {
      const initial: MaterialEditorValue = {
        childPart: makeOption({ primary_unit: 'each' }),
        quantity: '2',
        unit: 'each',
        consume_whole_units: true,
        charge_basis: 'price',
      };
      const onSave = vi.fn();
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
      await user.type(qty, '7');
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: '7', charge_basis: 'price' }),
      );
    });
  });
});

