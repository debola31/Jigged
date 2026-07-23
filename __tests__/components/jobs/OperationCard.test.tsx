import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperationCard from '@/components/jobs/OperationCard';
import type { JobOperation } from '@/types/job';
import type { JobNote } from '@/types/operator';

// OperationNotes → jobNoteMediaAccess imports the Supabase client at module load
// (which needs env creds absent in the unit env). We render notes with no media,
// so a no-op stub for the signed-URL fetch is all that's needed.
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  getJobNoteMediaUrl: vi.fn().mockResolvedValue(null),
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
      work_center: { id: 'wc-x', name: 'Coating', labor_rate: null, kind: 'external', vendor: { id: 'v1', name: 'AcmeCoat' } },
      ...over,
    } as Partial<JobOperation>);

  const renderExternal = (operation: JobOperation, over: Partial<typeof baseProps> = {}) =>
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

  it('a pending external op shows Mark Sent Out + Mark Received, never Complete', () => {
    renderExternal(externalOp({ status: 'pending' }));
    expect(screen.getByRole('button', { name: /Mark Sent Out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark Received/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Complete$/i })).not.toBeInTheDocument();
    // Outside identity + vendor chip.
    expect(screen.getByText(/Outside · AcmeCoat/i)).toBeInTheDocument();
  });

  it('a sent (at-vendor) external op shows Mark Received but not Mark Sent Out', () => {
    renderExternal(externalOp({ status: 'sent', sent_at: '2026-07-15T00:00:00Z' }));
    expect(screen.getByRole('button', { name: /Mark Received/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark Sent Out/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Complete$/i })).not.toBeInTheDocument();
  });

  it('calls onSend with the op id when Mark Sent Out is clicked', async () => {
    const onSend = vi.fn();
    renderExternal(externalOp({ status: 'pending' }), { onSend });
    await userEvent.click(screen.getByRole('button', { name: /Mark Sent Out/i }));
    expect(onSend).toHaveBeenCalledWith('op-1');
  });

  it('an internal op still shows Complete (no send/receive)', () => {
    renderExternal(op({ status: 'pending', work_center: { id: 'wc-i', name: 'Mill', labor_rate: 50, kind: 'internal' } as JobOperation['work_center'] }));
    expect(screen.getByRole('button', { name: /Complete/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark Sent Out/i })).not.toBeInTheDocument();
  });
});
