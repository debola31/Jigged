import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperationCard from '@/components/jobs/OperationCard';
import type { JobOperation } from '@/types/job';
import type { OutsideOperationSummary } from '@/types/outsideShipment';

// The card reads no data of its own any more — completion history, vendor slips
// and notes all moved to the job activity rail — so the Supabase-importing
// stubs this file used to need are gone with them. `posthog-js` is stubbed
// because the note badge reports `activity step filtered`.
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

const op = (over: Partial<JobOperation> = {}): JobOperation =>
  ({
    id: 'op-1',
    job_id: 'job-1',
    job_part_id: 'jp-1',
    sequence: 10,
    operation_name: 'Mill',
    work_center_id: null,
    routing_operation_id: null,
    estimated_setup_minutes: 15,
    estimated_run_minutes_per_unit: 2,
    status: 'pending',
    completed_at: null,
    completed_by: null,
    notes: null,
    created_at: '',
    updated_at: '',
    ...over,
  }) as unknown as JobOperation;

// A pending op with isNextReady=false renders no Start/Complete/Undo button, so
// the note badge is the only button in the card — keeps role queries simple.
const baseProps = {
  hasInProgressOperation: false,
  isNextReady: false,
  onStart: vi.fn(),
  onComplete: vi.fn(),
  onUndo: vi.fn(),
};

const renderCard = (
  operation: JobOperation,
  extra: { noteCount?: number; onShowActivity?: (id: string, name: string) => void } = {},
) =>
  render(
    <ThemeProvider theme={jiggedTheme}>
      <OperationCard operation={operation} {...baseProps} {...extra} />
    </ThemeProvider>,
  );

describe('OperationCard — the note badge', () => {
  /**
   * The expand chevron is GONE. Completion history, vendor packing slips and
   * operator notes all moved into the job's activity rail — chronological,
   * which is what all three already were — so the card had nothing left to
   * reveal. What survives is the count, and it is now a control: pressing it
   * narrows the rail to this step.
   */
  it('renders no badge when the step has no notes', () => {
    renderCard(op(), { noteCount: 0, onShowActivity: vi.fn() });
    // A bare "0" reads as a stray number.
    expect(screen.queryByTestId('operation-note-count')).not.toBeInTheDocument();
  });

  it('renders no badge on a surface with no rail, rather than a dead control', () => {
    renderCard(op(), { noteCount: 3 });
    expect(screen.queryByTestId('operation-note-count')).not.toBeInTheDocument();
  });

  it('shows the count it was given', () => {
    renderCard(op(), { noteCount: 2, onShowActivity: vi.fn() });
    expect(screen.getByTestId('operation-note-count')).toHaveTextContent('2');
  });

  it('names the step and the count in the accessible name', () => {
    renderCard(op(), { noteCount: 2, onShowActivity: vi.fn() });
    expect(
      screen.getByRole('button', { name: /Show 2 notes for Mill in the activity feed/i }),
    ).toBeInTheDocument();
  });

  it('singularises a lone note', () => {
    renderCard(op(), { noteCount: 1, onShowActivity: vi.fn() });
    expect(
      screen.getByRole('button', { name: /Show 1 note for Mill in the activity feed/i }),
    ).toBeInTheDocument();
  });

  it('asks the rail for this step when pressed', async () => {
    const onShowActivity = vi.fn();
    renderCard(op(), { noteCount: 2, onShowActivity });

    await userEvent.click(screen.getByTestId('operation-note-count'));

    expect(onShowActivity).toHaveBeenCalledWith('op-1', 'Mill');
  });

  it('no longer offers an expand control', () => {
    renderCard(op({ notes: 'admin completion note' }), { noteCount: 2, onShowActivity: vi.fn() });
    expect(screen.queryByTestId('operation-expand')).not.toBeInTheDocument();
    // The admin completion note renders on its completion's row in the rail,
    // not here — which is also why it is not counted in the badge.
    expect(screen.queryByText('admin completion note')).not.toBeInTheDocument();
  });
});

describe('OperationCard — external (outside-vendor) operations', () => {
  const externalOp = (over: Partial<JobOperation> = {}): JobOperation =>
    op({
      work_center: null,
      vendor_service_id: 'vs-1',
      vendor_service: { id: 'vs-1', name: 'Anodize', unit_price: null, vendor: { id: 'v1', name: 'AcmeCoat' } },
      ...over,
    } as Partial<JobOperation>);

  /**
   * The outside quantity ledger. The buttons are gated on THIS, not on
   * operation.status, which is the change that makes send-50-now-50-later
   * reachable at all -- so every case here states its quantities.
   */
  const ledger = (over: Partial<OutsideOperationSummary> = {}): OutsideOperationSummary => ({
    job_operation_id: 'op-1',
    qty_ordered: 100,
    qty_sent: 0,
    qty_good: 0,
    qty_at_vendor: 0,
    qty_to_send: 100,
    oldest_open_shipped_at: null,
    earliest_due_back_on: null,
    open_slip_count: 0,
    ...over,
  });

  const renderExternal = (
    operation: JobOperation,
    over: Partial<typeof baseProps> & {
      onSend?: () => void;
      onReceive?: () => void;
      outside?: OutsideOperationSummary;
    } = {},
  ) =>
    render(
      <ThemeProvider theme={jiggedTheme}>
        <OperationCard
          operation={operation}
          {...baseProps}
          onSend={vi.fn()}
          onReceive={vi.fn()}
          {...over}
        />
      </ThemeProvider>,
    );

  it('a pending outside op offers Send to the vendor by name, and Receive for the after-the-fact case', () => {
    renderExternal(externalOp({ status: 'pending' }), { outside: ledger() });
    expect(screen.getByRole('button', { name: /Send to AcmeCoat/i })).toBeInTheDocument();
    // Receive stays available with nothing sent: the common case is that nobody
    // made a slip and the parts came back anyway.
    expect(screen.getByRole('button', { name: /Receive/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Complete$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Outside · AcmeCoat/i)).toBeInTheDocument();
  });

  it('a PART-SENT op offers BOTH Send and Receive — the whole point of the quantity picker', () => {
    // 50 out, 50 still in the shop. Gating on status === 'pending' (what this
    // did) hides Send the moment the first slip exists, and send-50-now-50-later
    // becomes unreachable.
    renderExternal(externalOp({ status: 'sent', sent_at: '2026-07-15T00:00:00Z' }), {
      outside: ledger({ qty_sent: 50, qty_at_vendor: 50, qty_to_send: 50, open_slip_count: 1 }),
    });
    expect(screen.getByRole('button', { name: /Send to AcmeCoat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Receive 50/i })).toBeInTheDocument();
  });

  it('offers neither once everything is back', () => {
    renderExternal(externalOp({ status: 'completed', completed_at: '2026-07-20T00:00:00Z' }), {
      outside: ledger({ qty_sent: 100, qty_good: 100, qty_at_vendor: 0, qty_to_send: 0 }),
    });
    expect(screen.queryByRole('button', { name: /Send to/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Receive/i })).not.toBeInTheDocument();
  });

  it('reads the ledger back in the shop\'s own words, dropping every zero clause', () => {
    renderExternal(externalOp({ status: 'sent' }), {
      outside: ledger({ qty_sent: 100, qty_good: 48, qty_at_vendor: 50, qty_to_send: 2 }),
    });
    expect(screen.getByText(/48 \/ 100 back · 50 at vendor · 2 to send/)).toBeInTheDocument();
  });

  it('keeps Receive as a filled PRIMARY button, never green', async () => {
    // scripts/interactionStandardsCheck.ts fails a contained success/warning
    // button; asserting it structurally here fails the regression twice.
    renderExternal(externalOp({ status: 'sent' }), {
      outside: ledger({ qty_sent: 50, qty_at_vendor: 50, qty_to_send: 50 }),
    });
    const receive = screen.getByRole('button', { name: /Receive 50/i });
    expect(receive.className).toMatch(/MuiButton-containedPrimary/);
  });

  it('calls onSend with the op id when Send is clicked', async () => {
    const onSend = vi.fn();
    renderExternal(externalOp({ status: 'pending' }), { onSend, outside: ledger() });
    await userEvent.click(screen.getByRole('button', { name: /Send to AcmeCoat/i }));
    expect(onSend).toHaveBeenCalledWith('op-1');
  });

  it('an internal op shows Mark Complete (no send/receive) and no Pending chip', () => {
    renderExternal(op({ status: 'pending', vendor_service_id: null, vendor_service: null, work_center: { id: 'wc-i', name: 'Mill', labor_rate: 50 } }));
    expect(screen.getByRole('button', { name: /Mark Complete/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send to/i })).not.toBeInTheDocument();
    // A pending op reads as "not done" from the Mark Complete button, so the
    // grey "Pending" chip is omitted (it made the row look finished).
    expect(screen.queryByText(/^Pending$/i)).not.toBeInTheDocument();
  });

  it('a completed internal op still shows its status chip', () => {
    renderExternal(
      op({
        status: 'completed',
        completed_at: '2026-07-15T00:00:00Z',
        vendor_service_id: null,
        vendor_service: null,
        work_center: { id: 'wc-i', name: 'Mill', labor_rate: 50 },
      }),
    );
    // Only 'pending' is suppressed; real states (Completed / In Progress / At
    // Vendor) still render their chip.
    expect(screen.getByText(/^Completed$/i)).toBeInTheDocument();
  });
});
