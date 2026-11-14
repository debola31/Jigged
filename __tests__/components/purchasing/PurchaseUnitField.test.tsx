/**
 * The purchase-unit field (plan §3.5 "Units", criterion L1).
 *
 * A PO line buys in the stock unit, a unit the part already converts, or a same-kind preset — each
 * shown with its factor ("1 bar = 144 in"). Anything else is reachable only through "Another
 * unit…", which needs the factor typed: a unit that cannot be related to the stock unit is never
 * offered as if it could, because the database would refuse it (and a factor of 1 would be a lie).
 */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { render, screen } from '../../test-utils';
import PurchaseUnitField from '@/components/purchasing/PurchaseUnitField';

const bar = [{ from_unit: 'bar', to_primary_factor: 144 }];

function Harness({ initial = '', onChange = vi.fn() }: { initial?: string; onChange?: (v: { unit: string; factor: string }) => void }) {
  const [value, setValue] = useState({ unit: initial, factor: '' });
  return (
    <PurchaseUnitField
      stockUnit="inches"
      conversions={bar}
      value={value.unit}
      factor={value.factor}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('PurchaseUnitField (L1)', () => {
  it('shows the factor of the unit chosen', () => {
    render(<Harness initial="bar" />);
    expect(screen.getByText('1 bar = 144 in')).toBeInTheDocument();
  });

  it('offers the stock unit, the part’s conversions and same-kind presets — never an unrelated unit', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Unit' }));
    const names = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(names.some((n) => n.startsWith('in'))).toBe(true);
    expect(names.some((n) => n.startsWith('bar'))).toBe(true);
    expect(names.some((n) => n.startsWith('ft'))).toBe(true);
    expect(names.some((n) => /lb|pounds/i.test(n))).toBe(false);
    expect(names[names.length - 1]).toMatch(/another unit/i);
  });

  it('"Another unit…" needs a factor greater than zero before it is a unit', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('combobox', { name: 'Unit' }));
    await user.click(screen.getByRole('option', { name: /another unit/i }));
    await user.type(screen.getByLabelText('New unit name'), 'bundle');
    await user.type(screen.getByLabelText(/in one bundle/i), '0');
    expect(screen.getByText(/say how many in are in one bundle/i)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/in one bundle/i));
    await user.type(screen.getByLabelText(/in one bundle/i), '12');
    expect(onChange).toHaveBeenLastCalledWith({ unit: 'bundle', factor: '12' });
    expect(screen.getByText('1 bundle = 12 in')).toBeInTheDocument();
  });

  it('shows a saved unit the part can no longer relate as needing its factor, not as a unit to pick', () => {
    render(
      <PurchaseUnitField stockUnit="inches" conversions={[]} value="bar" factor="" onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('New unit name')).toHaveValue('bar');
    expect(screen.getByText(/say how many in are in one bar/i)).toBeInTheDocument();
  });

  it('can be locked, saying why', () => {
    render(
      <PurchaseUnitField
        stockUnit="inches"
        conversions={bar}
        value="bar"
        factor=""
        onChange={vi.fn()}
        disabled
        disabledReason="Received already — its part and unit can't change."
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/received already/i)).toBeInTheDocument();
  });
});
