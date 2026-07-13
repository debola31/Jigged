import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import MaterialRowEditor, {
  type MaterialEditorValue,
  type PartSelectOption,
} from '@/components/parts/MaterialRowEditor';

// getPartUnitConversions is called when a child is selected; no secondary
// units by default so the unit stays the child's primary_unit.
vi.mock('@/utils/partsAccess', () => ({
  getPartUnitConversions: vi.fn().mockResolvedValue([]),
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

    const yieldField = (await screen.findByLabelText(/Yield \(parts/i)) as HTMLInputElement;
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
    const yieldField = await screen.findByLabelText(/Yield \(parts/i);
    await user.clear(yieldField);
    await user.type(yieldField, '20');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as MaterialEditorValue;
    expect(parseFloat(saved.quantity)).toBeCloseTo(0.05, 10);
  });

  it('defaults whole-unit ON for a count unit on a new line', async () => {
    nextPickOption = makeOption({ primary_unit: 'each' });
    const { container } = render(
      <MaterialRowEditor companyId="co-1" onSave={() => undefined} onCancel={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: 'pick-part' }));

    // The consume-whole-units switch is a checkbox input; count unit → checked.
    await waitFor(() => {
      const sw = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(sw).not.toBeNull();
      expect(sw.checked).toBe(true);
    });
  });

  it('defaults whole-unit OFF for a length unit on a new line', async () => {
    nextPickOption = makeOption({ primary_unit: 'inches' });
    const { container } = render(
      <MaterialRowEditor companyId="co-1" onSave={() => undefined} onCancel={() => undefined} />,
    );

    await user.click(screen.getByRole('button', { name: 'pick-part' }));

    await waitFor(() => {
      const sw = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(sw).not.toBeNull();
      expect(sw.checked).toBe(false);
    });
  });
});
