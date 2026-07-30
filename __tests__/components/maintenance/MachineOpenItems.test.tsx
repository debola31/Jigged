import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';
import MachineOpenItems from '@/components/maintenance/MachineOpenItems';
import type { MachineNote } from '@/types/machineMaintenance';

function item(over: Partial<MachineNote> & { id: string }): MachineNote {
  return {
    work_center_id: 'wc1',
    body: 'Way cover has started to drag.',
    maintenance_kind: 'noticed',
    resolves_note_id: null,
    created_at: '2026-07-01T12:00:00Z',
    author_name: 'Kurtis Vandenberg',
    author_id: 'acc-1',
    viewer_count: 0,
    media: [],
    reactions: [],
    ...over,
  };
}

describe('MachineOpenItems', () => {
  it('shows the observation and the date', () => {
    render(<MachineOpenItems items={[item({ id: 'a' })]} />);

    expect(screen.getByText('Way cover has started to drag.')).toBeInTheDocument();
    expect(screen.getByText(/Jul 1/)).toBeInTheDocument();
  });

  // THE test in this file. A list of open items with names down the side is a
  // list of who reports the most problems, read straight down the column — the
  // shape of every operator scorecard this product refuses to build. The name is
  // one tap away on the entry's own card, where it reads as attribution.
  //
  // If someone ever "improves" this list by adding the author, this fails, and
  // the comment above is the argument for leaving it failing.
  it('never names who filed it', () => {
    render(<MachineOpenItems items={[item({ id: 'a' }), item({ id: 'b', author_name: 'Dana' })]} />);

    expect(screen.queryByText(/Kurtis/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Dana/)).not.toBeInTheDocument();
  });

  it('renders nothing at all when there is nothing outstanding', () => {
    // Not an empty state. A machine with nothing open should look like a machine
    // with nothing open, not like a section waiting to be filled.
    const { container } = render(<MachineOpenItems items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers the fix and hands back the item it belongs to', async () => {
    const onLogFix = vi.fn();
    const open = item({ id: 'a' });
    render(<MachineOpenItems items={[open]} onLogFix={onLogFix} />);

    await userEvent.click(screen.getByRole('button', { name: /log the fix/i }));
    expect(onLogFix).toHaveBeenCalledWith(open);
  });

  it('offers no action when the log is being read rather than worked', () => {
    render(<MachineOpenItems items={[item({ id: 'a' })]} />);
    expect(screen.queryByRole('button', { name: /log the fix/i })).not.toBeInTheDocument();
  });

  it('shows no priority, no due date and nobody it is assigned to', () => {
    // Each of those needs a second person to mean anything, and at this shop the
    // person who notices, decides and fixes is the same person.
    render(<MachineOpenItems items={[item({ id: 'a' })]} onLogFix={vi.fn()} />);

    expect(screen.queryByText(/priority|due|assigned/i)).not.toBeInTheDocument();
  });
});
