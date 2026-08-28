import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorOperationActionPage from '@/app/operator/[companyId]/jobs/[jobId]/parts/[jobPartId]/operations/[jobOperationId]/page';
import { getOperatorOperationDetail, revertOperationCompletion } from '@/utils/operatorAccess';
import {
  createOperationCompletion,
  getOperationCompletionSummaries,
} from '@/utils/operationCompletionsAccess';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import { addJobNote } from '@/utils/operatorAccess';

/**
 * CHARACTERISATION TESTS — what the completion path does TODAY.
 *
 * Written before B4 rewrites this screen, and deliberately not written
 * alongside it: tests authored next to a rewrite describe the new code, which
 * is precisely what a rewrite must not be judged by.
 *
 * Completion is the one action an operator must never lose, and until now it had
 * nine unit tests on the access layer, no component test, and no E2E — the page
 * that owns handleRecord and handleRevert was unprotected. Anything here that
 * goes red during B4 is a regression to explain, not an argument to have.
 *
 * Two invariants matter more than the rest and are called out where they are
 * asserted: completion must be DURABLE BEFORE the note is attempted, and undoing
 * a completion must never be recorded as making one.
 *
 * UPDATED BY B4, deliberately and in one place. The offer-signal assertion below
 * became an ordering assertion: B4 deleted the post-completion prompt, but the
 * property that prompt existed to protect — completion lands first, capture
 * second, so a slow photo upload can never un-complete finished work — is now
 * enforced by the submit sequence instead. Everything else here passed unchanged
 * through the rewrite.
 */

vi.mock('next/navigation', () => ({
  useParams: () => ({
    companyId: 'co1',
    jobId: 'job1',
    jobPartId: 'jp1',
    jobOperationId: 'op1',
  }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/operator/co1/jobs/job1/parts/jp1/operations/op1',
}));

vi.mock('@/utils/operatorAccess', () => ({
  getOperatorOperationDetail: vi.fn(),
  getCurrentMember: vi.fn(async () => ({ id: 'acc1', name: 'Diego', user_id: 'u1' })),
  revertOperationCompletion: vi.fn(async () => undefined),
  markOperationSent: vi.fn(),
  markOperationReceived: vi.fn(),
  // B4: the page now writes the note itself, through useNoteCapture.
  addJobNote: vi.fn(async () => ({ id: 'note1', media: [] })),
}));

// useNoteCapture reaches these, and jobNoteMediaAccess imports lib/supabase,
// which creates its client at MODULE scope — so without a mock the whole test
// file throws on import rather than on use.
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  uploadJobNoteMediaFile: vi.fn(async () => 'company/jobs/job1/abcd_p.jpg'),
  insertNoteMedia: vi.fn(async () => ({ id: 'media1' })),
  discardNoteMediaUploads: vi.fn(async () => undefined),
  getJobNoteMediaUrl: vi.fn(async () => 'blob:x'),
}));
vi.mock('@/utils/imageCompression', () => ({
  compressPhoto: vi.fn(async (f: File) => ({ file: f, dims: { width: 10, height: 10 } })),
}));

vi.mock('@/utils/operationCompletionsAccess', () => ({
  // Returns { id } like the real thing: the page keeps that id so the interval
  // can point at the completion that closed it. A mock resolving undefined was
  // lying about the contract, and only stopped passing when the caller started
  // using the return value.
  createOperationCompletion: vi.fn(async () => ({ id: 'completion-1' })),
  getOperationCompletionSummaries: vi.fn(),
  // THE REAL CLASS, not a stand-in. The page branches on `instanceof`, so a
  // mock exporting a different constructor would send a genuine conflict down
  // the generic-error path and the test would still pass.
  CompletionConflictError: class CompletionConflictError extends Error {
    liveQtyGood: number;
    constructor(liveQtyGood: number) {
      super('Someone else recorded work on this step while this page was open.');
      this.name = 'CompletionConflictError';
      this.liveQtyGood = liveQtyGood;
    }
  },
}));

vi.mock('@/utils/operatorEventsAccess', () => ({ logOperatorEvent: vi.fn() }));

// The page embeds the feed and the part reference row; both reach Supabase.
vi.mock('@/components/operator/JobFeed', () => ({
  default: ({
    refreshSignal,
    standaloneCapture,
  }: {
    refreshSignal?: number;
    standaloneCapture?: boolean;
  }) => (
    <div
      data-testid="job-feed"
      data-refresh-signal={refreshSignal ?? 0}
      data-standalone-capture={String(!!standaloneCapture)}
    />
  ),
}));
// Must render `leading`: the quantity field now shares this row, so a mock that
// drops the slot silently removes the control every completion test drives.
vi.mock('@/components/operator/PartReferenceRow', () => ({
  default: ({ leading }: { leading?: React.ReactNode }) => <div>{leading}</div>,
}));

// A station is selected and MATCHES the step, so the guard is out of the way
// unless a test overrides it.
const station = { stationId: 'wc1', stationName: 'Assembly Bench', initializing: false };
vi.mock('@/components/operator/OperatorStationContext', () => ({
  useStationContext: () => station,
}));
vi.mock('@/components/operator/OperatorChromeContext', () => ({
  useSetOperatorChrome: () => {},
  useOperatorNav: () => ({ push: vi.fn(), goBack: vi.fn() }),
}));
vi.mock('@/components/operator/StationSelector', () => ({ default: () => <div /> }));

/**
 * The interval context, made SWITCHABLE.
 *
 * Until now this file never mocked it, so every test ran against the real
 * context's default value — `intervalFor: () => null` — and therefore always in
 * the IDLE state. That left the entire running branch of this page uncovered,
 * including the `closeInterval` call inside handleRecord and (before it existed)
 * any control that only appears while a timer runs.
 *
 * `intervalState` deliberately defaults to exactly what the real default returns,
 * so the 21 tests above are unaffected; only the running-state describe at the
 * bottom of this file changes it.
 */
const runningInterval = {
  id: 'int1',
  job_operation_id: 'op1',
  effective_started_at: '2026-08-26T15:01:00.000Z',
};
const intervalState: {
  running: typeof runningInterval | null;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} = { running: null, cancel: vi.fn(), close: vi.fn() };

vi.mock('@/components/operator/OperatorIntervalContext', () => ({
  useIntervalContext: () => ({
    openIntervals: intervalState.running ? [intervalState.running] : [],
    serverSkewMs: 0,
    loading: false,
    intervalFor: () => intervalState.running,
    start: vi.fn(),
    close: intervalState.close,
    cancel: intervalState.cancel,
    refresh: vi.fn(),
  }),
}));

const mockDetail = vi.mocked(getOperatorOperationDetail);
const mockSummaries = vi.mocked(getOperationCompletionSummaries);
const mockCreate = vi.mocked(createOperationCompletion);
const mockRevert = vi.mocked(revertOperationCompletion);
const mockEvent = vi.mocked(logOperatorEvent);
const mockAddNote = vi.mocked(addJobNote);

function detail(over: Record<string, unknown> = {}) {
  return {
    id: 'jp1',
    job_id: 'job1',
    part_id: 'part1',
    job_number: 'J-0010',
    customer_name: 'Cascade Robotics',
    part_name: 'PROD-PUMP-100',
    part_description: null,
    part_quantity: 10,
    production_status: 'in_progress',
    operation_id: 'op1',
    operation_name: 'Assembly',
    operation_status: 'pending',
    operation_instructions: null,
    operation_work_center_id: 'wc1',
    operation_work_center_name: 'Assembly Bench',
    operation_work_center_kind: 'internal' as const,
    operation_vendor_name: null,
    operation_sent_at: null,
    estimated_minutes: null,
    operations_total: 2,
    operations_completed: 0,
    ...over,
  };
}

/** One row of the partial-completion summary for this op. */
function summary(qtyGood: number, target = 10) {
  return [
    {
      job_operation_id: 'op1',
      target,
      qty_good: qtyGood,
      qty_remaining: Math.max(0, target - qtyGood),
    },
  ];
}

function renderPage() {
  return render(
    <ThemeProvider theme={jiggedTheme}>
      <OperatorOperationActionPage />
    </ThemeProvider>,
  );
}

/**
 * The untimed completion path — see the same note in e2e/operator-completion.
 * `RECORD <n> FINISHED` requires a running interval now that starting is
 * mandatory on the shop floor; this file is about completion mechanics, not
 * time, so it takes the escape hatch that records the identical event with no
 * interval attached.
 */
const recordButton = () => screen.getByRole('button', { name: /complete without timing/i });

beforeEach(() => {
  vi.clearAllMocks();
  mockDetail.mockResolvedValue(detail() as never);
  mockSummaries.mockResolvedValue(summary(0) as never);
  mockCreate.mockResolvedValue({ id: 'completion-1' } as never);
  mockRevert.mockResolvedValue(undefined as never);
  mockAddNote.mockResolvedValue({ id: 'note1', media: [] } as never);
});

describe('operation action page — completion (characterisation)', () => {
  it('defaults the quantity to what is REMAINING, not the order quantity', async () => {
    // 10 ordered, 4 already good → the field offers 6. Defaulting to the order
    // quantity would silently double-count on the second visit.
    mockSummaries.mockResolvedValue(summary(4) as never);
    renderPage();

    const field = await screen.findByLabelText('Parts finished');
    await waitFor(() => expect(field).toHaveValue(6));
  });

  it('records the quantity in the field', async () => {
    renderPage();
    await screen.findByLabelText('Parts finished');

    await userEvent.click(recordButton());

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        companyId: 'co1',
        jobOperationId: 'op1',
        jobPartId: 'jp1',
        quantityGood: 10,
        // The step screen is operator capture by definition, and it declares the
        // qty_good it was showing so a completion the office recorded meanwhile
        // is refused rather than added on top of.
        captureSource: 'operator',
        expectedQtyGood: 0,
      }),
    );
  });

  it('records a partial when the number is dialled down', async () => {
    // The whole point of one field and one button: a partial is the same
    // gesture with a smaller number, not a separate mode.
    const user = userEvent.setup();
    renderPage();
    const field = await screen.findByLabelText('Parts finished');

    await user.clear(field);
    await user.type(field, '3');
    await user.click(recordButton());

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ quantityGood: 3 })),
    );
  });

  it('offers no way to record zero', async () => {
    // The floor is unchanged — no zero-quantity completion — but the shape of
    // "no" changed with the timer. This used to assert a DISABLED save button,
    // because completing was the only thing this screen could do and an empty
    // quantity left nothing to offer. Starting needs no quantity, so with the
    // field cleared there is now a real action available and the primary is
    // START. What must stay true is that NEITHER completion path is reachable.
    const user = userEvent.setup();
    renderPage();
    const field = await screen.findByLabelText('Parts finished');

    await user.clear(field);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /start this step/i })).toBeEnabled(),
    );
    expect(screen.queryByRole('button', { name: /^record /i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /complete without timing/i }),
    ).not.toBeInTheDocument();
  });

  it('saves a note alone when nothing was finished', async () => {
    // THE HOLE B4 OPENED. Capture rides on RECORD COMPLETION, which needs
    // qty > 0 — so an operator who finished ZERO pieces ("machine down",
    // "waiting on material") had to either say nothing, losing exactly the
    // knowledge this workstream exists to capture, or type a false quantity to
    // get the note saved. Falsifying production data to satisfy a UI constraint
    // is much worse than an extra code path.
    const user = userEvent.setup();
    renderPage();
    const field = await screen.findByLabelText('Parts finished');

    await user.clear(field);
    await user.type(screen.getByPlaceholderText(/worth noting/i), 'machine down, nothing run');

    const save = screen.getByRole('button', { name: /save note/i });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    await waitFor(() =>
      expect(mockAddNote).toHaveBeenCalledWith(
        'job1',
        'co1',
        'acc1',
        'machine down, nothing run',
        { jobPartId: 'jp1', jobOperationId: 'op1' },
      ),
    );
    // And crucially: NO completion was invented to carry it.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('collapses the job details by default, and opens them in place', async () => {
    // Reference detail does not belong between an operator and the button they
    // came to press — but it should not cost a page navigation either.
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('Parts finished');

    expect(screen.queryByText('Cascade Robotics')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show job details/i }));

    expect(await screen.findByText('Cascade Robotics')).toBeInTheDocument();
    // Still on the same screen — expanded, not navigated.
    expect(screen.getByLabelText('Parts finished')).toBeInTheDocument();
  });

  it('allows over-completion — warned, never blocked', async () => {
    // Shops finish more than ordered. Blocking it would leave the operator
    // unable to record what physically happened.
    const user = userEvent.setup();
    renderPage();
    const field = await screen.findByLabelText('Parts finished');

    await user.clear(field);
    await user.type(field, '12');

    expect(recordButton()).toBeEnabled();
    await user.click(recordButton());
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ quantityGood: 12 })),
    );
  });

  it('logs completion_recorded only AFTER the write resolves', async () => {
    // The funnel's entire job is separating "tried" from "succeeded". A failed
    // completion that still logged would make the number a lie.
    let release: () => void = () => {};
    // Resolves to { id }, like the real function — the page reads it to link the
    // interval to its completion. A void promise here breaks the caller, not the
    // ordering property this test is actually about.
    mockCreate.mockReturnValue(
      new Promise<{ id: string }>((r) => (release = () => r({ id: 'completion-1' }))) as never,
    );
    renderPage();
    await screen.findByLabelText('Parts finished');

    await userEvent.click(recordButton());
    expect(mockEvent).not.toHaveBeenCalledWith('co1', 'completion_recorded', expect.anything());

    release();
    await waitFor(() =>
      expect(mockEvent).toHaveBeenCalledWith(
        'co1',
        'completion_recorded',
        expect.objectContaining({ jobOperationId: 'op1', quantityGood: 10 }),
      ),
    );
  });

  it('does not log a completion when the write fails', async () => {
    mockCreate.mockRejectedValue(new Error('offline') as never);
    renderPage();
    await screen.findByLabelText('Parts finished');

    await userEvent.click(recordButton());

    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(mockEvent).not.toHaveBeenCalledWith('co1', 'completion_recorded', expect.anything());
  });

  it('writes the note only AFTER the completion has landed', async () => {
    // THE INVARIANT, in its post-B4 shape. The note — and especially its photo
    // upload, the slowest and most failure-prone part of the flow on shop wifi —
    // is attempted strictly after the completion resolves, so it can never
    // un-complete finished work. Not a transaction, on purpose: rolling back real
    // work because an image failed to upload would be worse, not safer.
    const user = userEvent.setup();
    let release: () => void = () => {};
    // Resolves to { id }, like the real function — the page reads it to link the
    // interval to its completion. A void promise here breaks the caller, not the
    // ordering property this test is actually about.
    mockCreate.mockReturnValue(
      new Promise<{ id: string }>((r) => (release = () => r({ id: 'completion-1' }))) as never,
    );
    renderPage();
    await screen.findByLabelText('Parts finished');

    await user.type(screen.getByPlaceholderText(/worth noting/i), 'fixture walks');
    await user.click(recordButton());

    expect(mockAddNote).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(mockAddNote).toHaveBeenCalled());
  });

  it('completes with no note at all', async () => {
    // Capture is optional, always. Requiring it would make finishing a step
    // conditional on having something to say.
    renderPage();
    await screen.findByLabelText('Parts finished');

    await userEvent.click(recordButton());

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockAddNote).not.toHaveBeenCalled();
  });

  it('records the note and the completion from ONE button', async () => {
    // The defect this removes: capture used to need a SECOND tap on a separate
    // Post, with no durability in between — attaching a photo showed a thumbnail,
    // read as finished, and a back tap discarded it silently.
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('Parts finished');

    await user.type(screen.getByPlaceholderText(/worth noting/i), 'back the feed off');
    await user.click(recordButton());

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockAddNote).toHaveBeenCalledWith('job1', 'co1', 'acc1', 'back the feed off', {
        jobPartId: 'jp1',
        jobOperationId: 'op1',
      }),
    );
    // No second Post anywhere on the screen.
    expect(screen.queryByRole('button', { name: /^post$/i })).not.toBeInTheDocument();
  });

  it('keeps the completion when the note fails', async () => {
    // A failed note must not un-complete a finished step, and the operator must
    // not be told the completion failed when it did not.
    const user = userEvent.setup();
    mockAddNote.mockRejectedValue(new Error('note write failed'));
    renderPage();
    await screen.findByLabelText('Parts finished');

    await user.type(screen.getByPlaceholderText(/worth noting/i), 'something');
    await user.click(recordButton());

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(
      mockEvent.mock.calls.some(
        (c) => c[1] === 'completion_recorded',
      ),
      'the completion still counts',
    ).toBe(true);
    expect(screen.queryByText('Failed to record completion')).not.toBeInTheDocument();
  });

  it('owns capture itself, so the feed does not offer a second composer', async () => {
    // Two composers on one screen would be a bug; this asserts which one is live.
    renderPage();
    await screen.findByLabelText('Parts finished');

    expect(screen.getByTestId('job-feed')).toHaveAttribute('data-standalone-capture', 'false');
  });

  it('hands capture BACK to the feed once the step is complete', async () => {
    // A completed step has no completion block to attach a note to. Without this
    // an operator could never add the photo afterwards — the phone-camera-then-
    // attach flow the audit found is how photos actually arrive.
    mockDetail.mockResolvedValue(detail({ operation_status: 'completed' }) as never);
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('job-feed')).toHaveAttribute('data-standalone-capture', 'true'),
    );
  });

  it('hands capture back to the feed on an outside step', async () => {
    // Outside steps use send/receive, so there is no completion block either —
    // and operator-view.md calls "sent to coater 7/9, back 7/16" the
    // highest-value note in the system.
    mockDetail.mockResolvedValue(
      detail({ operation_work_center_kind: 'external', operation_vendor_name: 'AcmeCoat' }) as never,
    );
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('job-feed')).toHaveAttribute('data-standalone-capture', 'true'),
    );
  });

  it('offers Undo only once something has been recorded', async () => {
    renderPage();
    await screen.findByLabelText('Parts finished');
    expect(screen.queryByRole('button', { name: /undo all/i })).not.toBeInTheDocument();

    mockSummaries.mockResolvedValue(summary(4) as never);
    await userEvent.click(recordButton());

    expect(await screen.findByRole('button', { name: /undo all \(4\)/i })).toBeInTheDocument();
  });

  it('undoing is NOT recorded as a completion', async () => {
    // Both handlers share the same tail (clear dirty, reload), and the funnel
    // event once sat in the wrong one — an operator UNDOING a step counted as
    // finishing it.
    mockSummaries.mockResolvedValue(summary(4) as never);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /undo all/i }));

    await waitFor(() => expect(mockRevert).toHaveBeenCalledWith('op1'));
    expect(mockEvent).not.toHaveBeenCalledWith('co1', 'completion_recorded', expect.anything());
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('tells the job feed to reload after an undo', async () => {
    // Undo voids the completion AND, through the cascade trigger, the time
    // intervals it closed — so the Started/Finished pair is gone from the
    // database. The feed loads its own data, so without this signal it keeps
    // rendering rows that no longer exist and Undo reads as having retracted
    // the count but kept the time. Recording already bumps it; undoing did not.
    mockSummaries.mockResolvedValue(summary(4) as never);
    renderPage();

    const before = Number(
      (await screen.findByTestId('job-feed')).getAttribute('data-refresh-signal'),
    );

    await userEvent.click(await screen.findByRole('button', { name: /undo all/i }));

    await waitFor(() =>
      expect(
        Number(screen.getByTestId('job-feed').getAttribute('data-refresh-signal')),
      ).toBeGreaterThan(before),
    );
  });

  it('surfaces a failed undo without pretending it worked', async () => {
    mockSummaries.mockResolvedValue(summary(4) as never);
    mockRevert.mockRejectedValue(new Error('could not undo') as never);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /undo all/i }));

    expect(await screen.findByText('could not undo')).toBeInTheDocument();
  });

  it('warns on a station mismatch but still lets the step be recorded', async () => {
    // Completion keys off the operation id, not the station, so a mismatch is a
    // likely wrong-QR signal — not a reason to stop someone recording real work.
    mockDetail.mockResolvedValue(
      detail({ operation_work_center_id: 'wc9', operation_work_center_name: 'Bandsaw' }) as never,
    );
    renderPage();

    expect(await screen.findByText(/but this step runs at/i)).toBeInTheDocument();
    await userEvent.click(recordButton());
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
  });

  it('reports reaching the step, for the reader funnel', async () => {
    renderPage();

    await waitFor(() =>
      expect(mockEvent).toHaveBeenCalledWith(
        'co1',
        'op_card_opened',
        expect.objectContaining({ jobOperationId: 'op1' }),
      ),
    );
  });
});


/**
 * THE RUNNING STATE — the first coverage this page has ever had of it.
 *
 * `Cancel activity` is the reason it exists: before it, an operator who started a
 * step and produced nothing had no way to stop the clock, and the documented
 * workaround was to record a quantity they had not made and then undo it.
 */
describe('while a timer is running', () => {
  beforeEach(() => {
    intervalState.running = runningInterval;
    intervalState.cancel = vi.fn(async () => undefined);
    intervalState.close = vi.fn(async () => undefined);
    mockDetail.mockResolvedValue(detail() as never);
    mockSummaries.mockResolvedValue(summary(0) as never);
  });

  afterEach(() => {
    intervalState.running = null;
  });

  /** The PAGE's button, never the dialog's confirm (they share a label). */
  const cancelButton = () =>
    screen.getAllByRole('button', { name: /^cancel activity$/i })[0];

  it('offers Cancel activity, and the escape hatch it replaces is gone', async () => {
    renderPage();
    await screen.findByRole('button', { name: /record/i });

    expect(cancelButton()).toBeInTheDocument();
    // `Complete without timing` is the IDLE-state sibling in the same slot. Both
    // showing at once would mean the two conditionals had been collapsed into a
    // ternary on the wrong predicate.
    expect(
      screen.queryByRole('button', { name: /complete without timing/i }),
    ).not.toBeInTheDocument();
  });

  it('does not offer it when nothing is running', async () => {
    intervalState.running = null;
    renderPage();
    await screen.findByRole('button', { name: /start this step/i });

    expect(screen.queryByRole('button', { name: /^cancel activity$/i })).not.toBeInTheDocument();
  });

  it('leaves the primary action alone — cancelling is not completing', async () => {
    renderPage();

    // The quantity default still drives the primary button; Cancel sits beside it
    // rather than replacing it.
    expect(await screen.findByRole('button', { name: /record 10 finished/i })).toBeInTheDocument();
    expect(cancelButton()).toBeInTheDocument();
  });

  it('confirms before discarding, and does nothing if the dialog is dismissed', async () => {
    renderPage();
    await screen.findByRole('button', { name: /record/i });

    await userEvent.click(cancelButton());
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // The consequence is stated before the fact, not discovered after.
    expect(screen.getByText(/will not be kept/i)).toBeInTheDocument();
    expect(screen.getByText(/the step stays where it is/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /keep timing/i }));
    expect(intervalState.cancel).not.toHaveBeenCalled();
  });

  it('discards the interval on confirm, and records no completion doing it', async () => {
    renderPage();
    await screen.findByRole('button', { name: /record/i });

    await userEvent.click(cancelButton());
    // Scoped to the dialog: the page button and the confirm share a label, which
    // is deliberate (the confirm should say what it does, not "OK") and means an
    // unscoped query here would be ambiguous.
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^cancel activity$/i }));

    await waitFor(() => expect(intervalState.cancel).toHaveBeenCalledWith('int1'));
    // THE INVARIANT THIS BUTTON EXISTS FOR: no fabricated production record.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('surfaces a failed cancel inside the dialog rather than silently leaving the timer up', async () => {
    intervalState.cancel = vi.fn(async () => {
      throw new Error('Your subscription is not active (billing_gate_update)');
    });
    renderPage();
    await screen.findByRole('button', { name: /record/i });

    await userEvent.click(cancelButton());
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^cancel activity$/i }));

    // Unlike handleRecord's closeInterval — swallowed there because a durable
    // completion has already landed — here the cancel IS the whole action.
    expect(await within(dialog).findByText(/subscription is not active/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
