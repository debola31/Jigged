import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperationCard from '@/components/jobs/OperationCard';
import type { JobOperation } from '@/types/job';
import type { OutsideOperationSummary } from '@/types/outsideShipment';
import type { JobNote } from '@/types/operator';

// OperationNotes → jobNoteMediaAccess imports the Supabase client at module load
// (which needs env creds absent in the unit env). We render notes with no media,
// so a no-op stub for the signed-URL fetch is all that's needed.
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  getJobNoteMediaUrl: vi.fn().mockResolvedValue(null),
}));

// OperationCard pulls in operationCompletionsAccess (completion history + void),
// which imports the Supabase client at module load — stub it so the unit env
// needs no creds. Events default to empty (no history rendered unless expanded).
vi.mock('@/utils/operationCompletionsAccess', () => ({
  getOperationCompletionEvents: vi.fn().mockResolvedValue([]),
  voidOperationCompletion: vi.fn().mockResolvedValue(undefined),
}));

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

const note = (over: Partial<JobNote> = {}): JobNote =>
  ({
    id: 'n-1',
    job_id: 'job-1',
    job_operation_id: 'op-1',
    operation_label: 'Op 10 · Mill',
    body: 'floor note',
    created_at: '2026-06-01T00:00:00Z',
    author_name: 'Sam',
    media: [], // no media → OperationNotes' signed-URL effect is a no-op, no mocking needed
    ...over,
  }) as unknown as JobNote;

// A pending op with isNextReady=false renders no Start/Complete/Undo button, so
// the expand control is the only button in the card — keeps role queries simple.
const baseProps = {
  hasInProgressOperation: false,
  isNextReady: false,
  onStart: vi.fn(),
  onComplete: vi.fn(),
  onUndo: vi.fn(),
};

const renderCard = (operation: JobOperation, stepNotes: JobNote[] = []) =>
  render(
    <ThemeProvider theme={jiggedTheme}>
      <OperationCard operation={operation} stepNotes={stepNotes} {...baseProps} />
    </ThemeProvider>,
  );

describe('OperationCard — always-expandable + note count', () => {
  it('always renders the expand control, with no count shown when there are no notes', () => {
    renderCard(op(), []);
    expect(screen.getByTestId('operation-expand')).toBeInTheDocument();
    // A bare "0" reads as a stray number, so note-less rows show only the chevron.
    expect(screen.queryByTestId('operation-note-count')).not.toBeInTheDocument();
  });

  it('counts operator step-notes', () => {
    renderCard(op(), [note({ id: 'a' }), note({ id: 'b' })]);
    expect(screen.getByTestId('operation-note-count')).toHaveTextContent('2');
  });

  it('counts the admin completion note alongside operator notes', () => {
    renderCard(op({ notes: 'setup dialed in' }), [note({ id: 'a' })]);
    expect(screen.getByTestId('operation-note-count')).toHaveTextContent('2');
  });

  it('encodes the note count in the button accessible name', () => {
    renderCard(op(), [note({ id: 'a' }), note({ id: 'b' })]);
    expect(
      screen.getByRole('button', { name: /Expand operation details \(2 notes\)/i }),
    ).toBeInTheDocument();
  });

  it('reveals a "No notes yet" empty state for an operation with no notes', async () => {
    renderCard(op(), []);
    // MUI Collapse keeps children mounted, so the empty state sits in the DOM
    // ready to reveal — expanding shows it instead of a blank panel.
    await userEvent.click(screen.getByTestId('operation-expand'));
    expect(screen.getByText(/No notes yet/i)).toBeInTheDocument();
  });

  it('does not render the empty state when the operation has notes', () => {
    renderCard(op({ notes: 'done' }), [note()]);
    expect(screen.queryByText(/No notes yet/i)).not.toBeInTheDocument();
  });

  it('reveals both the admin note and operator notes when expanded', async () => {
    renderCard(op({ notes: 'admin completion note' }), [note({ body: 'operator floor note' })]);

    await userEvent.click(screen.getByTestId('operation-expand'));

    expect(screen.getByText('admin completion note')).toBeInTheDocument();
    expect(screen.getByText('operator floor note')).toBeInTheDocument();
    expect(screen.queryByText(/No notes yet/i)).not.toBeInTheDocument();
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
    qty_scrapped: 0,
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
      outside: ledger({ qty_sent: 100, qty_good: 48, qty_scrapped: 2, qty_at_vendor: 50, qty_to_send: 0 }),
    });
    expect(screen.getByText(/48 \/ 100 back · 50 at vendor · 2 scrapped/)).toBeInTheDocument();
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
