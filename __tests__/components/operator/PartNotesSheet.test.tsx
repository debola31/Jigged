import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import PartNotesSheet from '@/components/operator/PartNotesSheet';
import { getPartPreviousNotes } from '@/utils/operatorAccess';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import type { PartPreviousNote } from '@/types/operator';

vi.mock('@/utils/operatorAccess', () => ({
  getPartPreviousNotes: vi.fn(),
  getCurrentMember: vi.fn().mockResolvedValue(null),
  updateNoteBody: vi.fn(),
}));
vi.mock('@/utils/operatorEventsAccess', () => ({ logOperatorEvent: vi.fn() }));
// The sheet gained edit/delete (#628), which pulls in jobNoteMediaAccess — that
// module builds a Supabase client at import time, so it has to be mocked here the
// same way JobFeed's suite does it.
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  deleteJobNote: vi.fn(),
  deleteJobNoteMedia: vi.fn(),
  getJobNoteMediaUrl: vi.fn().mockResolvedValue('blob:thumb'),
}));
vi.mock('@/components/operator/NoteMediaGallery', () => ({ default: () => null }));
// Dwell tracking imports the Supabase client at module scope; it has its own
// suite in __tests__/hooks/useNoteDwell.test.tsx.
vi.mock('@/hooks/useNoteDwell', () => ({ useNoteDwell: () => ({ observe: () => () => {} }) }));

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function note(over: Partial<PartPreviousNote> = {}): PartPreviousNote {
  return {
    id: 'n1',
    job_id: '',
    job_operation_id: null,
    operation_label: 'Op 10 · CNC Mill',
    body: 'indicate the fixture to 0.001 before the first bore',
    note_type: 'user',
    created_at: '2026-04-19T00:00:00Z',
    edited_at: null,
    author_name: 'Diego Alvarez',
    subject_kind: 'part',
    viewer_count: 0,
    author_id: 'them',
    reactions: [],
    usage_count: 0,
    media: [],
    job_number: 'J-0004',
    ...over,
  };
}

const onClose = vi.fn();

function renderSheet(props: Partial<React.ComponentProps<typeof PartNotesSheet>> = {}) {
  return render(
    <PartNotesSheet
      open
      onClose={onClose}
      partId="p1"
      companyId="c1"
      excludeJobId="job-current"
      jobOperationId="op1"
      partName="PROD-MANIFOLD-300"
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mock(getPartPreviousNotes).mockResolvedValue([note()]);
});

describe('PartNotesSheet — scope', () => {
  it('opens at All part, the broader view', async () => {
    // The toggle NARROWS; it does not gate. Worth pinning, because the plan once
    // proposed deleting it on the belief that it hid knowledge behind a
    // non-default — which the default being the broader view contradicts.
    renderSheet();
    await screen.findByText(/indicate the fixture/);

    expect(screen.getByRole('button', { name: 'All part' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('re-queries scoped to the step when narrowed', async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByText(/indicate the fixture/);

    await user.click(screen.getByRole('button', { name: 'This step' }));

    await waitFor(() =>
      expect(getPartPreviousNotes).toHaveBeenLastCalledWith(
        'p1',
        'c1',
        expect.objectContaining({ jobOperationId: 'op1' }),
      ),
    );
  });
});

// Whether All-part-first is the right default is deliberately an open question,
// to be settled by what operators actually do rather than by argument. These
// tests pin the instrument that will answer it.
describe('PartNotesSheet — scope instrumentation', () => {
  it('records the scope they left on, and that they narrowed', async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByText(/indicate the fixture/);

    await user.click(screen.getByRole('button', { name: 'This step' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(logOperatorEvent).toHaveBeenCalledWith(
      'c1',
      'prior_notes_opened',
      expect.objectContaining({ finalScope: 'step', toggled: true }),
    );
  });

  it('records an untouched toggle as such, which is the signal it is dead weight', async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByText(/indicate the fixture/);

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(logOperatorEvent).toHaveBeenCalledWith(
      'c1',
      'prior_notes_opened',
      expect.objectContaining({ finalScope: 'part', toggled: false, noteCount: 1 }),
    );
  });

  it('distinguishes opening from the operation vs the traveler', async () => {
    // Read-back matters most at the machine; the traveler is browsing. Conflating
    // them would make the discoverability numbers unreadable.
    const user = userEvent.setup();
    renderSheet({ jobOperationId: undefined });
    await screen.findByText(/indicate the fixture/);

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(logOperatorEvent).toHaveBeenCalledWith(
      'c1',
      'prior_notes_opened',
      expect.objectContaining({ openedFrom: 'traveler' }),
    );
  });

  it('never records which notes were shown, only how many', async () => {
    // operator_events is service-role readable. A row naming the notes someone
    // read would reconstruct exactly what note_views' RLS exists to prevent.
    const user = userEvent.setup();
    renderSheet();
    await screen.findByText(/indicate the fixture/);

    await user.click(screen.getByRole('button', { name: 'Close' }));

    const ctx = JSON.stringify(mock(logOperatorEvent).mock.calls[0][2]);
    expect(ctx).not.toContain('n1');
    expect(ctx).not.toContain('indicate the fixture');
    expect(ctx).toContain('noteCount');
  });
});
