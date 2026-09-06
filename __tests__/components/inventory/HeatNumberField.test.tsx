import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';
import HeatNumberField from '@/components/inventory/HeatNumberField';
import LotPicker from '@/components/inventory/LotPicker';
import type { LotOnHand } from '@/utils/inventoryLocationsAccess';

const lot = (over: Partial<LotOnHand> & { lotId: string }): LotOnHand => ({
  lotCode: over.lotId,
  heatNumber: over.lotId,
  quantity: 10,
  ...over,
});

function TextOwner() {
  const [value, setValue] = useState('');
  return (
    <>
      <HeatNumberField value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  );
}

function PickerOwner({ options, required }: { options: LotOnHand[]; required?: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <LotPicker options={options} value={value} onChange={setValue} unit="ea" required={required} />
      <output data-testid="value">{value ?? ''}</output>
    </>
  );
}

/**
 * The split these two components exist to make: a heat is TYPED where it enters the system, and
 * PICKED everywhere after. The bug that forced it was a free-text box on a removal, which let a
 * mistyped 4417 become a record and print on a packing slip as though it had come off a bar.
 */
describe('HeatNumberField — typed, at receiving only', () => {
  it('is a plain text box, with no list and no create affordance', async () => {
    render(<TextOwner />);
    await userEvent.type(screen.getByLabelText(/heat number \(optional\)/i), '4471');
    expect(screen.getByTestId('value')).toHaveTextContent('4471');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});

describe('LotPicker — picked, from what is on the shelf', () => {
  it('offers the lots that are here, with how much of each', async () => {
    render(<PickerOwner options={[lot({ lotId: '4471', quantity: 30 }), lot({ lotId: '8823', quantity: 5 })]} />);

    await userEvent.click(screen.getByRole('combobox'));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['447130 ea', '88235 ea']);

    await userEvent.click(screen.getByRole('option', { name: /4471/ }));
    expect(screen.getByTestId('value')).toHaveTextContent('4471');
  });

  /** THE GUARDRAIL: typing filters, it never creates. There is no `Other…` and no freeSolo. */
  it('cannot be used to name a heat that is not on the list', async () => {
    render(<PickerOwner options={[lot({ lotId: '4471' })]} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, '9999');

    expect(await screen.findByText(/no options/i)).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.getByTestId('value')).toHaveTextContent('');
  });

  /**
   * A tracked part whose shelf is empty is a real state, and it is not the same as an untracked
   * part. Saying so beats an empty box that looks like it is still loading.
   */
  it('says the shelf is empty rather than offering an empty box', () => {
    render(<PickerOwner options={[]} required />);
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByText(/none of this part is recorded here yet/i)).toBeInTheDocument();
  });

  /** A minted code is not a mill heat, and must not be read back to a customer as one. */
  it('marks a lot that carries no mill heat', async () => {
    render(<PickerOwner options={[lot({ lotId: 'l1', lotCode: 'LOT-260906-01', heatNumber: null })]} />);
    await userEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByRole('option', { name: /no mill heat/i })).toBeInTheDocument();
  });
});
