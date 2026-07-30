import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

const { mockGetMachineLog, mockGetMachineDetails, mockAddMachineNote, mockLogOperatorEvent } =
  vi.hoisted(() => ({
    mockGetMachineLog: vi.fn(),
    mockGetMachineDetails: vi.fn(),
    mockAddMachineNote: vi.fn(),
    mockLogOperatorEvent: vi.fn(),
  }));

vi.mock('@/utils/machineMaintenanceAccess', () => ({
  getMachineLog: (...a: unknown[]) => mockGetMachineLog(...a),
  getMachineDetails: (...a: unknown[]) => mockGetMachineDetails(...a),
  addMachineNote: (...a: unknown[]) => mockAddMachineNote(...a),
  addMachineNoteMedia: vi.fn(),
}));
vi.mock('@/utils/operatorEventsAccess', () => ({
  logOperatorEvent: (...a: unknown[]) => mockLogOperatorEvent(...a),
}));
vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: vi.fn().mockResolvedValue({ id: 'acc-me', name: 'Me' }),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
}));
vi.mock('@/hooks/useNoteDwell', () => ({
  useNoteDwell: vi.fn(() => ({ observe: () => () => {} })),
}));
// NoteMediaGallery reaches jobNoteMediaAccess, which imports lib/supabase and
// creates its client at MODULE scope — without this the file throws on import
// rather than on use. Same reason as OperationActionPage.test.tsx.
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  addNoteMedia: vi.fn(),
  getJobNoteMediaUrl: vi.fn(async () => 'blob:x'),
}));
vi.mock('@/utils/imageCompression', () => ({
  compressPhoto: vi.fn(async (f: File) => ({ file: f, dims: { width: 10, height: 10 } })),
}));
const { mockCountManuals } = vi.hoisted(() => ({ mockCountManuals: vi.fn() }));
vi.mock('@/utils/workCenterAttachmentsAccess', () => ({
  countWorkCenterAttachments: (...a: unknown[]) => mockCountManuals(...a),
  listWorkCenterAttachments: vi.fn(async () => []),
  getWorkCenterAttachmentUrl: vi.fn(async () => 'blob:x'),
}));

import MachineLogPanel from '@/components/maintenance/MachineLogPanel';
import { useNoteDwell } from '@/hooks/useNoteDwell';
import type { MachineNote } from '@/types/machineMaintenance';

function note(over: Partial<MachineNote> & { id: string }): MachineNote {
  return {
    work_center_id: 'wc1',
    body: 'Topped up the way lube.',
    maintenance_kind: null,
    resolves_note_id: null,
    created_at: '2026-07-01T12:00:00Z',
    author_name: 'Kurtis',
    author_id: 'acc-1',
    viewer_count: 4,
    media: [],
    reactions: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMachineDetails.mockResolvedValue(null);
  mockGetMachineLog.mockResolvedValue({ entries: [], open: [] });
  mockCountManuals.mockResolvedValue(0);
});

describe('MachineLogPanel', () => {
  it('records that the machine page was opened', async () => {
    // The precondition for reading any result from the pilot at all. A container
    // nobody filled and a container nobody REACHED both look like silence from
    // outside; without this event a quiet four weeks cannot honestly be called a
    // kill.
    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);

    await waitFor(() =>
      expect(mockLogOperatorEvent).toHaveBeenCalledWith('c1', 'machine_page_opened', {
        workCenterId: 'wc1',
      }),
    );
  });

  it('does not record a page open when the office is reading the log', async () => {
    render(<MachineLogPanel workCenterId="wc1" companyId="c1" readOnly />);

    await waitFor(() => expect(mockGetMachineLog).toHaveBeenCalled());
    expect(mockLogOperatorEvent).not.toHaveBeenCalledWith(
      'c1',
      'machine_page_opened',
      expect.anything(),
    );
  });

  it('logs reads with no job, which is what a machine read actually is', async () => {
    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
    await waitFor(() => expect(useNoteDwell).toHaveBeenCalledWith('c1', null));
  });

  it('says the machine has no history rather than nudging anyone to start one', async () => {
    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);

    expect(await screen.findByText(/nothing logged for this machine yet/i)).toBeInTheDocument();
    // No completeness meter, no "finish setting up this machine" (§4.5).
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/set up|get started|complete your/i)).not.toBeInTheDocument();
  });

  it('never renders a usage count', async () => {
    // usage_count counts distinct JOBS a note was consulted on, so it is
    // permanently zero here (§8). "Used on 0 jobs" beside real knowledge reads as
    // a verdict on the entry rather than a gap in the instrument.
    mockGetMachineLog.mockResolvedValue({ entries: [note({ id: 'a' })], open: [] });
    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);

    await screen.findByText('Topped up the way lube.');
    expect(screen.queryByText(/used on/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bjobs\b/i)).not.toBeInTheDocument();
  });

  it('shows an outstanding item exactly once, pinned above the log', async () => {
    // It used to render in the pinned block AND again in the log below — the
    // same fact twice with different chrome. Now it appears once and moves: it
    // sits pinned while outstanding, and drops into the log once resolved.
    const open = note({ id: 'obs', body: 'Coolant smells off.', maintenance_kind: 'noticed' });
    mockGetMachineLog.mockResolvedValue({ entries: [note({ id: 'a' }), open], open: [open] });

    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
    await screen.findByText('Topped up the way lube.');

    expect(screen.getAllByText('Coolant smells off.')).toHaveLength(1);
    expect(
      screen
        .getByText('Coolant smells off.')
        .compareDocumentPosition(screen.getByText('Topped up the way lube.')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('puts the composer above the outstanding items, so it cannot be pushed off-screen', async () => {
    // With the pinned block first, a machine with several outstanding items
    // scrolled the one thing this screen exists for off the top of the phone.
    const open = note({ id: 'obs', body: 'Coolant smells off.', maintenance_kind: 'noticed' });
    mockGetMachineLog.mockResolvedValue({ entries: [open], open: [open] });

    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
    await screen.findByText('Coolant smells off.');

    expect(
      screen
        .getByPlaceholderText(/what did you do/i)
        .compareDocumentPosition(screen.getByText('Coolant smells off.')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('nests a fix under what it fixed, rather than filing it as its own entry', async () => {
    const obs = note({ id: 'obs', body: 'Coolant smells off.', created_at: '2026-07-01T08:00:00Z' });
    const fix = note({
      id: 'fix',
      body: 'Drained and recharged.',
      resolves_note_id: 'obs',
      created_at: '2026-07-03T09:00:00Z',
    });
    mockGetMachineLog.mockResolvedValue({ entries: [fix, obs], open: [] });

    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
    await screen.findByText('Drained and recharged.');

    // The reply reads downward from what it answers.
    expect(
      screen
        .getByText('Coolant smells off.')
        .compareDocumentPosition(screen.getByText('Drained and recharged.')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // And says so by POSITION — no quote of the original, no "Fixed by" line.
    // The quote had to be truncated to fit, which cut off the text it quoted.
    expect(screen.queryByText(/^Fixes:/)).toBeNull();
    expect(screen.queryByText(/Fixed by/)).toBeNull();
  });

  it('sorts threads by latest activity, so a fix logged today does not sink', async () => {
    // The cost nesting would otherwise carry: an observation from three weeks
    // ago, answered this morning, would sit below untouched newer entries — and
    // §4.2 keeps this list newest-first because the reader is asking what has
    // happened lately.
    const oldObs = note({ id: 'obs', body: 'Old observation.', created_at: '2026-07-01T08:00:00Z' });
    const recentFix = note({
      id: 'fix',
      body: 'Fixed it this morning.',
      resolves_note_id: 'obs',
      created_at: '2026-07-20T09:00:00Z',
    });
    const newerPlain = note({
      id: 'plain',
      body: 'Something unrelated.',
      created_at: '2026-07-10T08:00:00Z',
    });
    mockGetMachineLog.mockResolvedValue({
      entries: [newerPlain, recentFix, oldObs],
      open: [],
    });

    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
    await screen.findByText('Fixed it this morning.');

    // The old observation leads, because its thread was touched most recently.
    expect(
      screen
        .getByText('Old observation.')
        .compareDocumentPosition(screen.getByText('Something unrelated.')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('renders an entry that is BOTH a reply and still open exactly once', async () => {
    // The exactly-once invariant (§4.2) applied to the nested case. `openIds` is
    // filtered out of replies as well as roots, because an entry pinned above
    // must never also appear below.
    //
    // A resolver carries no flag of its own, so this row cannot be produced by
    // the UI — replyWriter hard-codes maintenanceKind: null. That coupling is
    // invisible from the render site, which is exactly why it is pinned here:
    // add a kind chip to the reply composer and without the filter this entry
    // renders twice, pinned AND nested, with nothing else catching it.
    const root = note({ id: 'root', body: 'Root entry.', created_at: '2026-07-01T08:00:00Z' });
    const replyStillOpen = note({
      id: 'reply',
      body: 'A reply that is itself flagged.',
      resolves_note_id: 'root',
      maintenance_kind: 'noticed',
      created_at: '2026-07-02T08:00:00Z',
    });
    mockGetMachineLog.mockResolvedValue({
      entries: [replyStillOpen, root],
      // Derived exactly as deriveOpenItems would: noticed, and nothing resolves it.
      open: [replyStillOpen],
    });

    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
    await screen.findByText('Root entry.');

    expect(screen.getAllByText('A reply that is itself flagged.')).toHaveLength(1);
    // And the one appearance is the pinned one.
    expect(
      within(screen.getByTestId('machine-open-items')).getByText('A reply that is itself flagged.'),
    ).toBeInTheDocument();
  });

  it('names the author in the log but not while an item is outstanding', async () => {
    // §5: a list of outstanding items with names down the side is a list of who
    // reports the most problems. The name is deferred, not lost.
    const open = note({ id: 'obs', body: 'Coolant smells off.', maintenance_kind: 'noticed',
      author_name: 'Kurtis' });
    mockGetMachineLog.mockResolvedValue({ entries: [note({ id: 'a' }), open], open: [open] });

    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
    await screen.findByText('Coolant smells off.');

    // One "Kurtis" — from the logged entry, not the pinned one.
    expect(screen.getAllByText('Kurtis')).toHaveLength(1);
  });

  it('replies inline, binds the fix to its item, and records the loop closing', async () => {
    const open = note({ id: 'obs', body: 'Coolant smells off.', maintenance_kind: 'noticed' });
    mockGetMachineLog.mockResolvedValue({ entries: [open], open: [open] });
    mockAddMachineNote.mockResolvedValue(note({ id: 'fix', resolves_note_id: 'obs' }));

    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
    await screen.findAllByText('Coolant smells off.');

    // The reply composer does not exist until it is asked for, and it is its own
    // field — not the one at the top wearing a banner.
    expect(screen.queryByPlaceholderText(/what did you do to fix it/i)).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: /log the fix/i })[0]);

    await userEvent.type(
      screen.getByPlaceholderText(/what did you do to fix it/i),
      'Drained and recharged.',
    );
    await userEvent.click(screen.getByRole('button', { name: /^log the fix$/i }));

    await waitFor(() =>
      expect(mockAddMachineNote).toHaveBeenCalledWith(
        'wc1',
        'c1',
        'acc-me',
        'Drained and recharged.',
        expect.objectContaining({ resolvesNoteId: 'obs', maintenanceKind: null }),
      ),
    );
    await waitFor(() =>
      expect(mockLogOperatorEvent).toHaveBeenCalledWith('c1', 'noticed_resolved', {
        workCenterId: 'wc1',
      }),
    );
  });

  it('does not hand a half-written note to an item somebody then taps', async () => {
    // The bug the inline reply removes structurally. Starting a fix used to
    // leave whatever was in the main composer alone while re-binding it to a
    // resolution, so a sentence about something else silently became the fix.
    // Two composers cannot do that to each other.
    const open = note({ id: 'obs', body: 'Coolant smells off.', maintenance_kind: 'noticed' });
    mockGetMachineLog.mockResolvedValue({ entries: [open], open: [open] });
    mockAddMachineNote.mockResolvedValue(note({ id: 'fix' }));

    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
    await screen.findAllByText('Coolant smells off.');

    await userEvent.type(
      screen.getByPlaceholderText(/what did you do, or what did you notice/i),
      'Unrelated: swept the floor.',
    );
    await userEvent.click(screen.getAllByRole('button', { name: /log the fix/i })[0]);

    // The reply starts empty, and the unrelated draft is still where it was.
    expect(screen.getByPlaceholderText(/what did you do to fix it/i)).toHaveValue('');
    expect(
      screen.getByPlaceholderText(/what did you do, or what did you notice/i),
    ).toHaveValue('Unrelated: swept the floor.');
  });

  it('offers no flag on the reply — a fix resolves, it does not also raise', async () => {
    const open = note({ id: 'obs', body: 'Coolant smells off.', maintenance_kind: 'noticed' });
    mockGetMachineLog.mockResolvedValue({ entries: [open], open: [open] });

    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
    await screen.findAllByText('Coolant smells off.');
    await userEvent.click(screen.getAllByRole('button', { name: /log the fix/i })[0]);

    // One checkbox on the page: the main composer's. The reply has none.
    expect(screen.getAllByRole('checkbox', { name: /needs attention/i })).toHaveLength(1);
  });

  it('offers no composer when the office is reading', async () => {
    mockGetMachineLog.mockResolvedValue({ entries: [note({ id: 'a' })], open: [] });
    render(<MachineLogPanel workCenterId="wc1" companyId="c1" readOnly />);

    await screen.findByText('Topped up the way lube.');
    expect(screen.queryByRole('button', { name: /add to log/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/what did you do/i)).not.toBeInTheDocument();
  });

  describe('the composer', () => {
    it('offers one flag, not a taxonomy', async () => {
      // Four of the original five verbs had no reader anywhere — nothing filtered,
      // grouped, ranked or counted by them — so they were four extra decisions
      // asked of somebody in a container whose whole risk is that nobody writes in
      // it. If they come back, they should come back with a consumer.
      render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
      await screen.findByText(/nothing logged for this machine yet/i);

      expect(screen.getByRole('checkbox', { name: /needs attention/i })).toBeInTheDocument();
      for (const dead of ['cleaned', 'repaired', 'replaced', 'adjusted']) {
        expect(screen.queryByRole('checkbox', { name: new RegExp(`^${dead}$`, 'i') })).toBeNull();
      }
    });

    it('is off by default, because most entries record work already done', async () => {
      mockAddMachineNote.mockResolvedValue(note({ id: 'a' }));
      render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
      await screen.findByText(/nothing logged for this machine yet/i);

      await userEvent.type(screen.getByPlaceholderText(/what did you do/i), 'Topped up the lube.');
      await userEvent.click(screen.getByRole('button', { name: /add to log/i }));

      await waitFor(() =>
        expect(mockAddMachineNote).toHaveBeenCalledWith(
          'wc1', 'c1', 'acc-me', 'Topped up the lube.',
          expect.objectContaining({ maintenanceKind: null }),
        ),
      );
    });

    it('can be turned back off after being turned on', async () => {
      // Somebody who taps it and reconsiders must be able to undo that without
      // clearing the sentence they already wrote.
      mockAddMachineNote.mockResolvedValue(note({ id: 'a' }));
      render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);
      await screen.findByText(/nothing logged for this machine yet/i);

      const flag = screen.getByRole('checkbox', { name: /needs attention/i });
      await userEvent.type(screen.getByPlaceholderText(/what did you do/i), 'Looked at it.');
      await userEvent.click(flag);
      await userEvent.click(flag);
      await userEvent.click(screen.getByRole('button', { name: /add to log/i }));

      await waitFor(() =>
        expect(mockAddMachineNote).toHaveBeenCalledWith(
          'wc1', 'c1', 'acc-me', 'Looked at it.',
          expect.objectContaining({ maintenanceKind: null }),
        ),
      );
    });
  });
});

describe('MachineLogPanel manuals', () => {
  it('shows no manuals affordance at all when the machine has none', async () => {
    // Not "Manuals · 0", and certainly not "Add a manual" — an empty machine
    // must not advertise a gap in itself (§4.5).
    mockCountManuals.mockResolvedValue(0);
    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);

    await screen.findByText(/nothing logged for this machine yet/i);
    expect(screen.queryByRole('button', { name: /manual/i })).not.toBeInTheDocument();
  });

  it('offers the manuals once there is something to open', async () => {
    mockCountManuals.mockResolvedValue(2);
    render(<MachineLogPanel workCenterId="wc1" companyId="c1" />);

    expect(await screen.findByRole('button', { name: /manuals · 2/i })).toBeInTheDocument();
  });
});
