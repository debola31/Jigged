import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';
import HeatNumberField from '@/components/inventory/HeatNumberField';

/** The field is controlled; a tiny owner lets the test type and pick the way a dialog would. */
function Owner({ suggestions }: { suggestions?: string[] }) {
  const [value, setValue] = useState('');
  return (
    <>
      <HeatNumberField value={value} onChange={setValue} suggestions={suggestions} />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe('HeatNumberField', () => {
  it('is a plain text box when no heat has ever been received for the part', async () => {
    render(<Owner />);
    await userEvent.type(screen.getByLabelText(/heat number \(optional\)/i), '4471');
    expect(screen.getByTestId('value')).toHaveTextContent('4471');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  /**
   * THE GUARDRAIL. A take must name a heat that actually came in — a free box here is how
   * "4471" becomes "4417" on a packing slip. So once receipts exist the field is a list of them,
   * and free text is behind an explicit Other…, never the default.
   */
  it('is a list of the received heats, with Other…, once any exist', async () => {
    render(<Owner suggestions={['4471', '8823']} />);
    expect(screen.queryByLabelText(/other heat number/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('combobox'));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['None', '4471', '8823', 'Other…']);

    await userEvent.click(screen.getByRole('option', { name: '8823' }));
    expect(screen.getByTestId('value')).toHaveTextContent('8823');
    expect(screen.queryByLabelText(/other heat number/i)).not.toBeInTheDocument();
  });

  it('opens a text box only behind Other…, and clears the picked heat when it does', async () => {
    render(<Owner suggestions={['4471']} />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: '4471' }));
    expect(screen.getByTestId('value')).toHaveTextContent('4471');

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Other…' }));
    expect(screen.getByTestId('value')).toHaveTextContent('');

    await userEvent.type(screen.getByLabelText(/other heat number/i), '9000');
    expect(screen.getByTestId('value')).toHaveTextContent('9000');
  });
});
