import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import BusyButton from '@/components/common/BusyButton';

/**
 * The shared control behind docs/interaction-standards.md §5. Its job is to make
 * the rule unforgettable rather than merely documented: `pendingLabel` is a
 * required prop, so a busy button cannot be shipped silent.
 */
describe('BusyButton', () => {
  it('shows its own label at rest', () => {
    render(<BusyButton pendingLabel="Asking QuickBooks…">Test connection</BusyButton>);
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
  });

  it('names what it is waiting for while pending', () => {
    render(
      <BusyButton pending pendingLabel="Asking QuickBooks…">
        Test connection
      </BusyButton>,
    );
    // "Loading…" would hide the one fact that makes a long pause legible.
    expect(screen.getByRole('button', { name: /asking quickbooks/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
  });

  it('marks itself busy for assistive tech', () => {
    render(
      <BusyButton pending pendingLabel="Working…">
        Go
      </BusyButton>,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('does not claim to be busy at rest', () => {
    render(<BusyButton pendingLabel="Working…">Go</BusyButton>);
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy');
  });

  /**
   * WCAG 2.2 SC 4.1.3 (AA): a status message must be programmatically
   * determinable WITHOUT receiving focus. The detail appears after the press, so
   * it has to be announced rather than read on a focus the user does not have.
   */
  it('announces the detail in a live region, and only while pending', () => {
    const { rerender } = render(
      <BusyButton pendingLabel="Reading accounts…" pendingDetail="Reading from the shop computer.">
        Choose account
      </BusyButton>,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    rerender(
      <BusyButton
        pending
        pendingLabel="Reading accounts…"
        pendingDetail="Reading from the shop computer."
      >
        Choose account
      </BusyButton>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/reading from the shop computer/i);
  });

  it('still fires onClick, and respects disabled', async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <BusyButton pendingLabel="Working…" onClick={onClick}>
        Go
      </BusyButton>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <BusyButton pendingLabel="Working…" onClick={onClick} disabled>
        Go
      </BusyButton>,
    );
    // MUI sets pointer-events:none when disabled, which userEvent refuses to
    // click outright — so assert the state rather than staging a click that the
    // test library would reject before the component ever saw it.
    expect(screen.getByRole('button')).toBeDisabled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
