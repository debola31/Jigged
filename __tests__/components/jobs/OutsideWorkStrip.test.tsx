import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';
import OutsideWorkStrip from '@/components/jobs/OutsideWorkStrip';
import type { OutsideOperation } from '@/types/operator';

const DAY = 86_400_000;
const agoISO = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function op(over: Partial<OutsideOperation> = {}): OutsideOperation {
  return {
    id: 'op-1',
    job_id: 'j-1',
    job_part_id: 'jp-1',
    job_number: 'J-0141',
    part_name: 'BRACKET',
    operation_name: 'Anodize',
    vendor_id: 'v-1',
    vendor_name: 'PerformCoat',
    status: 'sent',
    sent_at: agoISO(6),
    sent_by_name: null,
    due_date: null,
    is_hot: false,
    ...over,
  };
}

const renderStrip = (ops: OutsideOperation[], onOpen = vi.fn()) => {
  render(
    <ThemeProvider theme={jiggedTheme}>
      <OutsideWorkStrip outsideOps={ops} onOpen={onOpen} />
    </ThemeProvider>,
  );
  return onOpen;
};

describe('OutsideWorkStrip', () => {
  it('renders NOTHING when nothing is at a vendor', () => {
    // The whole reason it earns a place above the grid. A zero state here would
    // be permanent chrome for a fact that is absent on most days.
    const { container } = render(
      <ThemeProvider theme={jiggedTheme}>
        <OutsideWorkStrip outsideOps={[]} onOpen={vi.fn()} />
      </ThemeProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when outside ops exist but none has been SENT', () => {
    // A routing with an anodize step on it is not "at a vendor". Counting
    // pending ops here would light the strip on a shop that has never shipped.
    const { container } = render(
      <ThemeProvider theme={jiggedTheme}>
        <OutsideWorkStrip outsideOps={[op({ status: 'pending', sent_at: null })]} onOpen={vi.fn()} />
      </ThemeProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('counts JOBS and VENDORS, not operations — two steps on one job is one job', () => {
    renderStrip([
      op({ id: 'a', job_id: 'j-1', vendor_id: 'v-1' }),
      op({ id: 'b', job_id: 'j-1', vendor_id: 'v-1' }),
      op({ id: 'c', job_id: 'j-2', vendor_id: 'v-2', vendor_name: 'Hansen/Balk' }),
    ]);
    expect(screen.getByText(/2 jobs have parts/i)).toBeInTheDocument();
    expect(screen.getByText(/at 2 vendors/i)).toBeInTheDocument();
  });

  it('names the longest-out job and vendor, which is the one worth chasing', () => {
    renderStrip([
      op({ id: 'a', job_number: 'J-0101', vendor_name: 'CLAS Carbide', sent_at: agoISO(22) }),
      op({ id: 'b', job_id: 'j-2', job_number: 'J-0141', sent_at: agoISO(3) }),
    ]);
    expect(screen.getByText(/J-0101 at CLAS Carbide, 22 days/i)).toBeInTheDocument();
  });

  it('says "sent today" rather than "0 days"', () => {
    renderStrip([op({ sent_at: new Date().toISOString() })]);
    expect(screen.getByText(/sent today/i)).toBeInTheDocument();
  });

  it('reads singular for one job at one vendor', () => {
    renderStrip([op()]);
    expect(screen.getByText(/1 job has parts/i)).toBeInTheDocument();
    expect(screen.getByText(/at 1 vendor$/i)).toBeInTheDocument();
  });

  it('offers exactly one action, and it opens the drawer rather than acting', () => {
    // No send, no receive, no undo. A second place to act on an operation is
    // what got the outside-work tab deleted in Aug 2026.
    const onOpen = renderStrip([op()]);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    return userEvent.click(buttons[0]).then(() => {
      expect(onOpen).toHaveBeenCalledTimes(1);
    });
  });
});

describe('OutsideWorkStrip — the action has to be legible on its own band', () => {
  it('does not take the theme default text-button blue, which fails AA here', () => {
    // Measured against the amber band: primary.light #6FA3D8 is 3.83:1 at rest
    // and 3.03:1 on hover, where AA wants 4.5:1. warning.light is 6.09 / 4.81.
    renderStrip([op()]);
    const btn = screen.getByRole('button', { name: /See what's out/i });
    const style = getComputedStyle(btn);
    expect(style.color).not.toBe('rgb(111, 163, 216)');
  });

  it('underlines the action, so it does not read as a control by hue alone', () => {
    renderStrip([op()]);
    const btn = screen.getByRole('button', { name: /See what's out/i });
    expect(getComputedStyle(btn).textDecoration).toMatch(/underline/);
  });
});
