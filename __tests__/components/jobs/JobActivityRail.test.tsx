import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

const { addJobNote, voidOperationCompletion, capture } = vi.hoisted(() => ({
  addJobNote: vi.fn(),
  voidOperationCompletion: vi.fn().mockResolvedValue(undefined),
  capture: vi.fn(),
}));

vi.mock('posthog-js', () => ({ default: { capture } }));
vi.mock('@/utils/operatorAccess', () => ({ addJobNote, updateNoteBody: vi.fn() }));
vi.mock('@/utils/operationCompletionsAccess', () => ({ voidOperationCompletion }));
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  deleteJobNote: vi.fn(),
  deleteJobNoteMedia: vi.fn(),
  getJobNoteMediaUrl: vi.fn().mockResolvedValue(null),
}));

import JobActivityRail, {
  RAIL_OPEN_STORAGE_KEY,
  readRailOpen,
  writeRailOpen,
} from '@/components/jobs/activity/JobActivityRail';
import { buildJobActivity } from '@/components/jobs/activity/jobActivityTimeline';
import type { JobNote } from '@/types/operator';
import type { JobActivityCompletion } from '@/utils/operationCompletionsAccess';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';

const NOTE = {
  id: 'n-1',
  created_at: '2026-09-05T13:40:00Z',
  body: 'Burr on the .250 edge',
  author_id: 'member-1',
  author_name: 'Kurtis',
  job_operation_id: 'op-20',
  operation_label: 'Op 20 · Mill',
  note_type: 'user',
  edited_at: null,
  subject_kind: 'job',
  media: [],
  reactions: [],
} as unknown as JobNote;

const COMPLETION: JobActivityCompletion = {
  id: 'c-1',
  job_operation_id: 'op-20',
  operation_name: 'Mill',
  operation_sequence: 20,
  quantity_good: 12,
  completed_at: '2026-09-05T14:31:00Z',
  completed_by: 'member-1',
  completed_by_name: 'Kurtis',
  note: null,
  voided_at: null,
  capture_source: 'operator',
};

const SLIP = {
  id: 's-1',
  company_id: 'co-1',
  job_id: 'job-1',
  job_part_id: 'jp-1',
  job_operation_id: 'op-30',
  vendor_id: 'v-1',
  vendor_name: 'Acme Plating',
  service_name: 'Zinc plate',
  slip_number: 'VPS-1042-1',
  quantity: 12,
  shipped_at: '2026-09-05T11:20:00Z',
  due_back_on: null,
  carrier: null,
  notes: null,
  closed_at: null,
  closed_by: null,
  created_by: null,
  voided_at: null,
  voided_by: null,
  created_at: '2026-09-05T11:20:00Z',
  updated_at: '2026-09-05T11:20:00Z',
  ship_to_address: null,
  ship_to_contact: null,
  vendor_address_id: null,
  vendor_contact_id: null,
  job_operation: { id: 'op-30', operation_name: 'Plating', sequence: 30 },
  receipts: [],
} as unknown as OutsideShipmentWithRelations;

const ITEMS = buildJobActivity({
  notes: [NOTE],
  completions: [COMPLETION],
  shipments: [SLIP],
});

function renderRail(over: Partial<React.ComponentProps<typeof JobActivityRail>> = {}) {
  const props = {
    companyId: 'co-1',
    jobId: 'job-1',
    items: ITEMS,
    loading: false,
    error: null,
    reload: vi.fn().mockResolvedValue(undefined),
    memberId: 'member-1',
    isAdmin: false,
    open: true,
    onClose: vi.fn(),
    mobileOpen: false,
    onMobileClose: vi.fn(),
    filter: null,
    onClearFilter: vi.fn(),
    onViewSlip: vi.fn(),
    ...over,
  };
  const utils = render(
    <ThemeProvider theme={jiggedTheme}>
      <JobActivityRail {...props} />
    </ThemeProvider>,
  );
  // Both mounts render the same labels; every query scopes to the docked one.
  return { ...utils, props, rail: within(screen.getByTestId('job-activity-rail')) };
}

/**
 * The unit env provides no localStorage (the runner says so on every run), so
 * the repo's convention is an in-memory stand-in — same shape NoteUsageBanner's
 * spec uses. readRailOpen/writeRailOpen swallow a throwing accessor anyway;
 * this is about asserting the round-trip, not about surviving its absence.
 */
class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  key(i: number) {
    return Array.from(this.store.keys())[i] ?? null;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', new MemoryStorage());
});

describe('JobActivityRail — the three row kinds', () => {
  it('renders a note, a completion and a vendor movement in one list', () => {
    const { rail } = renderRail();

    expect(rail.getByText('Completed Mill')).toBeInTheDocument();
    expect(rail.getByText('Burr on the .250 edge')).toBeInTheDocument();
    expect(rail.getByText('Sent 12 to Acme Plating')).toBeInTheDocument();
  });

  it('offers Void on a live completion', () => {
    const { rail } = renderRail();
    expect(
      rail.getByRole('button', { name: /Void the completion of 12 pieces on Mill/i }),
    ).toBeInTheDocument();
  });

  it('offers no Void on an already-voided completion, but still shows the row', () => {
    const items = buildJobActivity({
      notes: [],
      completions: [{ ...COMPLETION, voided_at: '2026-09-05T15:00:00Z' }],
      shipments: [],
    });
    const { rail } = renderRail({ items });

    expect(rail.getByText('Completed Mill')).toBeInTheDocument();
    expect(rail.queryByRole('button', { name: /Void the completion/i })).not.toBeInTheDocument();
  });

  it('reports capture_source when a completion is voided', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const { rail } = renderRail({ reload });

    await userEvent.click(rail.getByRole('button', { name: /Void the completion/i }));

    expect(voidOperationCompletion).toHaveBeenCalledWith('c-1');
    expect(reload).toHaveBeenCalled();
    // The split that makes the event worth having: the office fixing its own
    // typo versus the office overruling the floor.
    expect(capture).toHaveBeenCalledWith('completion voided', {
      surface: 'office_job',
      capture_source: 'operator',
    });
  });

  it('opens the slip preview from a movement row', async () => {
    const onViewSlip = vi.fn();
    const { rail } = renderRail({ onViewSlip });

    await userEvent.click(rail.getByRole('button', { name: /VPS-1042-1/i }));

    expect(onViewSlip).toHaveBeenCalledWith('s-1');
  });
});

describe('JobActivityRail — the step filter', () => {
  it('narrows to the step and keeps a way back', () => {
    const { rail } = renderRail({ filter: { operationId: 'op-30', stepName: 'Plating' } });

    expect(rail.getByText('Sent 12 to Acme Plating')).toBeInTheDocument();
    expect(rail.queryByText('Completed Mill')).not.toBeInTheDocument();
    expect(rail.getByText('Showing Plating')).toBeInTheDocument();
  });

  it('names the step in the empty state when that step has nothing yet', () => {
    const { rail } = renderRail({ filter: { operationId: 'op-99', stepName: 'Deburr' } });
    expect(rail.getByText(/Nothing has been recorded on Deburr yet/i)).toBeInTheDocument();
  });

  it('reports the clear press as the other half of the event', async () => {
    const onClearFilter = vi.fn();
    const { rail } = renderRail({
      filter: { operationId: 'op-20', stepName: 'Mill' },
      onClearFilter,
    });

    await userEvent.click(rail.getByTestId('clear-step-filter'));

    expect(onClearFilter).toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith('activity step filtered', {
      surface: 'office_job',
      note_count: 1,
      cleared: true,
    });
  });
});

describe('JobActivityRail — the composer', () => {
  it('posts a job note and reports it shape-only', async () => {
    addJobNote.mockResolvedValue({ ...NOTE, id: 'n-new' });
    const reload = vi.fn().mockResolvedValue(undefined);
    const { rail } = renderRail({ reload });

    await userEvent.type(rail.getByLabelText('Note on this job'), 'call the vendor');
    await userEvent.click(rail.getByRole('button', { name: 'Post' }));

    // No opts: a null step means subject_kind 'job', which is what the operator
    // traveler renders — the office note reaches the floor.
    expect(addJobNote).toHaveBeenCalledWith('job-1', 'co-1', 'member-1', 'call the vendor');
    expect(capture).toHaveBeenCalledWith('note posted', {
      surface: 'office_job',
      has_text: true,
      photo_count: 0,
      video_count: 0,
    });
    expect(reload).toHaveBeenCalled();
  });

  it('will not post an empty note', () => {
    const { rail } = renderRail();
    expect(rail.getByRole('button', { name: 'Post' })).toBeDisabled();
  });

  it('will not post before the member resolves', () => {
    const { rail } = renderRail({ memberId: null });
    expect(rail.getByRole('button', { name: 'Post' })).toBeDisabled();
  });
});

describe('JobActivityRail — note permissions mirror RLS', () => {
  it('offers the actions menu on your own note', () => {
    const { rail } = renderRail({ memberId: 'member-1' });
    expect(rail.getByRole('button', { name: /Actions for this note/i })).toBeInTheDocument();
  });

  it('offers nothing on somebody else’s note when you are not an admin', () => {
    const { rail } = renderRail({ memberId: 'someone-else', isAdmin: false });
    expect(rail.queryByRole('button', { name: /Actions for this note/i })).not.toBeInTheDocument();
  });

  it('offers the menu to an admin on somebody else’s note', () => {
    const { rail } = renderRail({ memberId: 'someone-else', isAdmin: true });
    expect(rail.getByRole('button', { name: /Actions for this note/i })).toBeInTheDocument();
  });

  it('offers nothing on an auto-logged event row', () => {
    // notes_update_body and notes_delete both carry note_type = 'user', so a
    // menu here would be a button guaranteed to 42501.
    const items = buildJobActivity({
      notes: [{ ...NOTE, note_type: 'event' } as JobNote],
      completions: [],
      shipments: [],
    });
    const { rail } = renderRail({ items });
    expect(rail.queryByRole('button', { name: /Actions for this note/i })).not.toBeInTheDocument();
  });
});

describe('the remembered open state', () => {
  it('defaults OPEN when nothing has been stored', () => {
    // The whole reason this is a docked rail rather than an on-demand drawer.
    expect(readRailOpen()).toBe(true);
  });

  it('round-trips a close and a reopen', () => {
    writeRailOpen(false);
    expect(localStorage.getItem(RAIL_OPEN_STORAGE_KEY)).toBe('false');
    expect(readRailOpen()).toBe(false);

    writeRailOpen(true);
    expect(readRailOpen()).toBe(true);
  });

  it('stays open on an unrecognised stored value rather than failing shut', () => {
    localStorage.setItem(RAIL_OPEN_STORAGE_KEY, 'yes');
    expect(readRailOpen()).toBe(true);
  });
});

describe('both breakpoint branches render without a matchMedia stub', () => {
  /**
   * The payoff for making this an in-flow column plus a Drawer rather than
   * `variant="persistent"` behind a `useMediaQuery`: which branch shows is CSS,
   * so jsdom can render and assert on both.
   */
  it('renders the docked column', () => {
    renderRail();
    expect(screen.getByTestId('job-activity-rail')).toBeInTheDocument();
  });

  it('does not mount the overlay while the rail is docked', () => {
    renderRail({ mobileOpen: false });
    expect(screen.queryByTestId('job-activity-rail-overlay')).not.toBeInTheDocument();
  });

  it('mounts the overlay when the narrow-screen toggle opens it', () => {
    renderRail({ mobileOpen: true });
    expect(screen.getByTestId('job-activity-rail-overlay')).toBeInTheDocument();
  });
});
