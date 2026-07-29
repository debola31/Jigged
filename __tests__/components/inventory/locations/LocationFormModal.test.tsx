/**
 * The manual location form.
 *
 * Untested until now. Its job in this phase is the half of dedupe a unique index can't do: the DB
 * refuses a duplicate sibling name outright, so the form has to warn *before* someone reaches
 * that error — and has to warn on exactly the names the index rejects, no more and no fewer. A
 * warning that fires on names the DB accepts trains people to ignore it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '../../../test-utils';
import userEvent from '@testing-library/user-event';

import LocationFormModal from '@/components/inventory/locations/LocationFormModal';
import type { InventoryLocation } from '@/types/inventoryLocations';

const loc = (over: Partial<InventoryLocation> & { id: string }): InventoryLocation => ({
  company_id: 'co1',
  parent_id: null,
  name: over.id,
  kind: null,
  code: null,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...over,
});

const renderForm = (
  props: Partial<React.ComponentProps<typeof LocationFormModal>> = {},
) => {
  const onSubmit = vi.fn(async () => {});
  render(
    <LocationFormModal
      open
      location={null}
      onClose={vi.fn()}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { onSubmit };
};

const nameField = () => screen.getByRole('combobox', { name: /name/i });

describe('LocationFormModal — duplicate sibling warning', () => {
  it('warns as you type, naming the parent it would collide in', async () => {
    const user = userEvent.setup();
    renderForm({ parentPath: ['Cabinet 3'], siblingNames: ['Shelf A', 'Shelf B'] });

    await user.type(nameField(), 'Shelf A');
    expect(screen.getByText('Cabinet 3 already has a Shelf A.')).toBeInTheDocument();
  });

  /** Matched the way the index matches, or the warning and the constraint disagree. */
  it('matches case- and whitespace-insensitively, like the index does', async () => {
    const user = userEvent.setup();
    renderForm({ parentPath: ['Cabinet 3'], siblingNames: ['Shelf A'] });

    await user.type(nameField(), '  shelf a  ');
    expect(screen.getByText(/already has a Shelf A/)).toBeInTheDocument();
  });

  it('stays quiet for a name no sibling holds', async () => {
    const user = userEvent.setup();
    renderForm({ parentPath: ['Cabinet 3'], siblingNames: ['Shelf A'] });

    await user.type(nameField(), 'Shelf C');
    expect(screen.queryByText(/already has a/)).not.toBeInTheDocument();
  });

  it('says "This company" for a top-level location, which has no parent to name', async () => {
    const user = userEvent.setup();
    renderForm({ siblingNames: ['Cabinet 3'] });

    await user.type(nameField(), 'Cabinet 3');
    expect(screen.getByText('This company already has a Cabinet 3.')).toBeInTheDocument();
  });

  /** Otherwise every rename dialog opens pre-warning about the name already in the field. */
  it('does not warn about a location\'s own current name while editing', () => {
    renderForm({
      location: loc({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab' }),
      siblingNames: ['Shelf A', 'Shelf B'],
    });

    expect(screen.queryByText(/already has a/)).not.toBeInTheDocument();
  });

  it('still warns when an edit renames onto a different sibling', async () => {
    const user = userEvent.setup();
    renderForm({
      location: loc({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab' }),
      siblingNames: ['Shelf A', 'Shelf B'],
    });

    await user.clear(nameField());
    await user.type(nameField(), 'Shelf B');
    expect(screen.getByText(/already has a Shelf B/)).toBeInTheDocument();
  });

  /**
   * A warning, not a block. Nothing exact catches `ST0CK` for `STOCK`, so the field's real job is
   * to be *read*; the DB is what actually refuses an exact duplicate, and its message is mapped.
   */
  it('does not block submit — the DB is the constraint, this is the nudge', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ parentPath: ['Cabinet 3'], siblingNames: ['Shelf A'] });

    await user.type(nameField(), 'Shelf A');
    await user.click(screen.getByRole('button', { name: /create/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Shelf A' }));
  });

  it('offers the existing names, so a second spelling need never be typed', async () => {
    const user = userEvent.setup();
    renderForm({ parentPath: ['Cabinet 3'], siblingNames: ['Shelf A', 'Shelf B'] });

    await user.click(nameField());
    expect(await screen.findByRole('option', { name: 'Shelf A' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Shelf B' })).toBeInTheDocument();
  });
});

describe('LocationFormModal — basics', () => {
  it('requires a name', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.click(screen.getByRole('button', { name: /create/i }));
    expect(screen.getByText('Name is required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('trims the name and drops empty optional fields', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(nameField(), '  Cabinet 4  ');
    await user.click(screen.getByRole('button', { name: /create/i }));

    expect(onSubmit).toHaveBeenCalledWith({ name: 'Cabinet 4', kind: null, code: null });
  });

  // The vocabulary the builder's templates emit, so a hand-added shelf can carry the same word.
  it('suggests the shared kind vocabulary', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('combobox', { name: /kind/i }));
    expect(await screen.findByRole('option', { name: 'cabinet' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'shelving' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'drawer unit' })).toBeInTheDocument();
  });

  it('surfaces a save failure instead of closing', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <LocationFormModal
        open
        location={null}
        onClose={onClose}
        onSubmit={vi.fn(async () => {
          throw new Error('There\'s already a "Shelf A" in the same place. Pick a different name.');
        })}
      />,
    );

    await user.type(nameField(), 'Shelf A');
    await user.click(screen.getByRole('button', { name: /create/i }));

    expect(await screen.findByText(/already a "Shelf A" in the same place/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
