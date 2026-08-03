/**
 * The shared location picker.
 *
 * Worth its own file because three surfaces now depend on it (the admin part modal, the operator
 * bin modal, and put-away), and because the two it replaced had silently drifted apart — one showed
 * quantities and the other didn't, neither excluded the source, and neither knew the `Unassigned`
 * bucket was a nonsense destination.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '../../../test-utils';
import userEvent from '@testing-library/user-event';

import LocationPicker, {
  type LocationPickerOption,
} from '@/components/inventory/locations/LocationPicker';

const OPTIONS: LocationPickerOption[] = [
  { id: 'cab', label: 'Cabinet 3', quantity: 0 },
  { id: 'shelf-a', label: 'Cabinet 3 › Shelf A', quantity: 2 },
  { id: 'yard', label: 'Yard', quantity: 7 },
  { id: 'un', label: 'Unassigned', kind: 'system', quantity: 9428 },
];

const renderPicker = (props: Partial<React.ComponentProps<typeof LocationPicker>> = {}) => {
  const onChange = vi.fn();
  render(
    <LocationPicker
      label="Move to"
      options={OPTIONS}
      value={null}
      onChange={onChange}
      {...props}
    />,
  );
  return { onChange };
};

const open = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('combobox', { name: /move to/i }));

describe('LocationPicker — what it offers', () => {
  it('lists every location by full path', async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);

    expect(await screen.findByRole('option', { name: /^Cabinet 3 › Shelf A/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Yard/ })).toBeInTheDocument();
  });

  /** You can't move something to where it already is. The admin picker didn't enforce this. */
  it('excludes the source', async () => {
    const user = userEvent.setup();
    renderPicker({ excludeId: 'yard' });
    await open(user);

    await screen.findByRole('option', { name: /^Cabinet 3$/ });
    expect(screen.queryByRole('option', { name: /^Yard/ })).not.toBeInTheDocument();
  });

  /**
   * Putting something away *into* the pile of unplaced things is the situation you're escaping, so
   * the system bucket is never a destination — even though it's a perfectly good source.
   */
  it('excludes the system bucket when asked', async () => {
    const user = userEvent.setup();
    renderPicker({ excludeSystem: true });
    await open(user);

    await screen.findByRole('option', { name: /^Yard/ });
    expect(screen.queryByRole('option', { name: /^Unassigned/ })).not.toBeInTheDocument();
  });

  it('still offers the system bucket when it is a legitimate choice', async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);
    expect(await screen.findByRole('option', { name: /^Unassigned/ })).toBeInTheDocument();
  });

  it('shows what is already at each candidate, so the choice is informed', async () => {
    const user = userEvent.setup();
    renderPicker({ unit: 'ea' });
    await open(user);

    expect(await screen.findByRole('option', { name: /Cabinet 3 › Shelf A.*2 ea/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Cabinet 3.*empty/ })).toBeInTheDocument();
  });

  it('hides quantities when the caller has no unit to report them in', async () => {
    const user = userEvent.setup();
    renderPicker();
    await open(user);

    await screen.findByRole('option', { name: 'Yard' });
    expect(screen.queryByText(/7 ea/)).not.toBeInTheDocument();
  });

  it('reports the chosen location', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();
    await open(user);
    await user.click(await screen.findByRole('option', { name: /^Yard/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'yard' }));
  });
});

describe('LocationPicker — creating one inline', () => {
  it('offers to create a name nothing here answers to', async () => {
    const user = userEvent.setup();
    renderPicker({ onCreate: vi.fn() });

    await user.type(screen.getByRole('combobox', { name: /move to/i }), 'Bench by the saw');
    expect(await screen.findByText('Create “Bench by the saw”')).toBeInTheDocument();
  });

  it('does not offer creation at all without an onCreate handler', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.type(screen.getByRole('combobox', { name: /move to/i }), 'Bench by the saw');
    expect(screen.queryByText(/^Create/)).not.toBeInTheDocument();
  });

  /**
   * The guard that keeps this from being the `ST0CK`-beside-`STOCK` mechanism again. Matched
   * case- and whitespace-insensitively, the same way the DB's unique index compares names — so the
   * offer never appears for something the index would refuse.
   */
  it('suppresses the offer when a location already answers to that name', async () => {
    const user = userEvent.setup();
    renderPicker({ onCreate: vi.fn() });

    await user.type(screen.getByRole('combobox', { name: /move to/i }), '  yard  ');
    expect(await screen.findByRole('option', { name: /^Yard/ })).toBeInTheDocument();
    expect(screen.queryByText(/^Create/)).not.toBeInTheDocument();
  });

  it('creates and selects in one gesture', async () => {
    const user = userEvent.setup();
    const created = { id: 'new', label: 'Bench by the saw' };
    const onCreate = vi.fn(async () => created);
    const { onChange } = renderPicker({ onCreate });

    await user.type(screen.getByRole('combobox', { name: /move to/i }), 'Bench by the saw');
    await user.click(await screen.findByText('Create “Bench by the saw”'));

    expect(onCreate).toHaveBeenCalledWith('Bench by the saw');
    expect(onChange).toHaveBeenCalledWith(created);
  });

  /** The DB refuses duplicates outright; show its reason rather than a half-selected field. */
  it('surfaces a refusal and leaves nothing selected', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {
      throw new Error('There\'s already a "Yard 2" in the same place. Pick a different name.');
    });
    const { onChange } = renderPicker({ onCreate });

    await user.type(screen.getByRole('combobox', { name: /move to/i }), 'Yard 2');
    await user.click(await screen.findByText('Create “Yard 2”'));

    expect(await screen.findByText(/already a "Yard 2" in the same place/)).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('never hands the synthetic create row back as a real location', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async (name: string) => ({ id: 'real', label: name }));
    const { onChange } = renderPicker({ onCreate });

    await user.type(screen.getByRole('combobox', { name: /move to/i }), 'Bench');
    await user.click(await screen.findByText('Create “Bench”'));

    for (const call of onChange.mock.calls) {
      expect(call[0]?.id).not.toBe('__create__');
    }
  });
});
