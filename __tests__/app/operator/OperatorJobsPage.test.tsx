import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorJobsPage from '@/app/operator/[companyId]/jobs/page';
import {
  getOperatorJobs,
  getAllStationsOperatorJobs,
  getCompletedOperatorJobs,
} from '@/utils/operatorAccess';
import type { OperatorJob, OperatorPlantJob } from '@/types/operator';

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockNavPush = vi.fn();
const mockCapture = vi.fn();
let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co1' }),
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => searchParams,
}));

vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => mockCapture(...a) } }));

vi.mock('@/components/operator/OperatorChromeContext', () => ({
  useOperatorNav: () => ({ push: mockNavPush, goBack: vi.fn() }),
}));

/**
 * `lib/supabase` builds its browser client at module scope, so importing the real access layer in
 * jsdom throws before any test runs — the established pattern in this repo is to stub the getter.
 */
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));

vi.mock('@/utils/operatorAccess', () => ({
  getOperatorJobs: vi.fn(),
  getAllStationsOperatorJobs: vi.fn(),
  getCompletedOperatorJobs: vi.fn(),
  getAllStationsCompletedOperatorJobs: vi.fn(),
}));

/** The banner runs its own Supabase read and has its own suite; it is noise here. */
vi.mock('@/components/operator/NoteUsageBanner', () => ({ default: () => null }));
vi.mock('@/components/operator/StationSelector', () => ({
  default: () => <div>Pick a station</div>,
}));

const stationContext = {
  stationId: 'wc-1' as string | null,
  stations: [
    { id: 'wc-1', name: 'CNC Mill' },
    { id: 'wc-2', name: 'Deburr' },
  ],
  initializing: false,
};
vi.mock('@/components/operator/OperatorStationContext', () => ({
  useStationContext: () => stationContext,
}));

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function job(over: Partial<OperatorJob> = {}): OperatorJob {
  return {
    id: 'jp-1',
    job_id: 'j-1',
    job_number: 'J-0118',
    customer_name: 'Apex Aerospace',
    part_name: 'Spindle Bracket',
    part_quantity: 12,
    is_hot: false,
    production_status: 'in_progress',
    operation_id: 'op-1',
    operation_name: 'Mill OP20',
    operation_status: 'pending',
    operations_total: 1,
    operations_completed: 0,
    ...over,
  };
}

function plantJob(over: Partial<OperatorPlantJob> = {}): OperatorPlantJob {
  return { ...job(), work_center_id: 'wc-1', work_center_name: 'CNC Mill', ...over };
}

function renderPage() {
  return render(
    <ThemeProvider theme={jiggedTheme}>
      <OperatorJobsPage />
    </ThemeProvider>,
  );
}

/** The two rows every station-scope test starts from — one per customer/part/number. */
const TWO_JOBS = [
  job({ id: 'jp-1', job_number: 'J-0118', part_name: 'Spindle Bracket', customer_name: 'Apex Aerospace' }),
  job({
    id: 'jp-2',
    job_id: 'j-2',
    operation_id: 'op-2',
    job_number: 'J-0992',
    part_name: 'Manifold Cap',
    customer_name: 'Northwind Medical',
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
  stationContext.stationId = 'wc-1';
  mock(getOperatorJobs).mockResolvedValue(TWO_JOBS);
  mock(getAllStationsOperatorJobs).mockResolvedValue([]);
  mock(getCompletedOperatorJobs).mockResolvedValue([]);
});

describe('OperatorJobsPage — find', () => {
  it('narrows the list as the operator types, and restores it when cleared', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/J-0118/);
    expect(screen.getByText(/J-0992/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Find a job'), 'manifold');
    await waitFor(() => expect(screen.queryByText(/J-0118/)).not.toBeInTheDocument());
    expect(screen.getByText(/J-0992/)).toBeInTheDocument();

    await user.click(screen.getByLabelText('Clear search'));
    await screen.findByText(/J-0118/);
    expect(screen.getByText(/J-0992/)).toBeInTheDocument();
  });

  it('matches a job number and a customer, not only the part', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/J-0118/);

    await user.type(screen.getByLabelText('Find a job'), '0992');
    await waitFor(() => expect(screen.queryByText(/J-0118/)).not.toBeInTheDocument());

    await user.clear(screen.getByLabelText('Find a job'));
    await user.type(screen.getByLabelText('Find a job'), 'northwind');
    await waitFor(() => expect(screen.queryByText(/J-0118/)).not.toBeInTheDocument());
    expect(screen.getByText(/J-0992/)).toBeInTheDocument();
  });

  /**
   * The filter has to run BEFORE the station grouping, not after. Filtering the rendered groups
   * instead would leave a station heading standing over an empty gap — which reads as "there is
   * work here that failed to load", the opposite of what happened.
   */
  it('drops a station group entirely when none of its rows match', async () => {
    const user = userEvent.setup();
    searchParams = new URLSearchParams('scope=plant');
    mock(getAllStationsOperatorJobs).mockResolvedValue([
      plantJob({ id: 'a', job_number: 'J-0118', work_center_name: 'CNC Mill' }),
      plantJob({
        id: 'b',
        job_id: 'j-2',
        operation_id: 'op-2',
        job_number: 'J-0992',
        part_name: 'Manifold Cap',
        work_center_id: 'wc-2',
        work_center_name: 'Deburr',
      }),
    ]);

    renderPage();
    await screen.findByText(/CNC Mill · 1/);
    expect(screen.getByText(/Deburr · 1/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Find a job'), 'manifold');
    await waitFor(() => expect(screen.queryByText(/CNC Mill · 1/)).not.toBeInTheDocument());
    expect(screen.getByText(/Deburr · 1/)).toBeInTheDocument();
  });

  it('says nothing matched — never that there is no work — and offers a way back', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/J-0118/);

    await user.type(screen.getByLabelText('Find a job'), 'zzzz');
    await screen.findByText(/No jobs match/);
    // The bug this guards: reporting a confident fact about the shop floor when
    // the only fact available is about the query.
    expect(screen.queryByText(/There are no pending jobs/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show all jobs' }));
    await screen.findByText(/J-0118/);
  });

  /**
   * Two ways out of a filter are fine; two buttons named the same thing are not — in a screen
   * reader's button list they are indistinguishable. The field's × owns "Clear search"; the empty
   * state names itself by its result instead.
   */
  it('gives the two escape routes distinct accessible names', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/J-0118/);

    await user.type(screen.getByLabelText('Find a job'), 'zzzz');
    await screen.findByText(/No jobs match/);
    expect(screen.getAllByRole('button', { name: 'Clear search' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Show all jobs' })).toBeInTheDocument();
  });

  /**
   * The office jobs page autofocuses its search, because a salesperson at a keyboard arrives to look
   * something up. Copying that here would throw the phone keyboard over the dispatch list on every
   * arrival, including the many that are not a search.
   */
  it('does not autofocus, so arriving at the tab does not raise the keyboard', async () => {
    renderPage();
    await screen.findByText(/J-0118/);
    expect(screen.getByLabelText('Find a job')).not.toHaveFocus();
  });

  it('mirrors the settled query into the URL with replace, never push', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/J-0118/);

    await user.type(screen.getByLabelText('Find a job'), 'manifold');
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/operator/co1/jobs?scope=station&q=manifold',
      ),
    );
    // A replace adds no history entry, which is what keeps the operator chrome's
    // depth counter honest — a push here would make Back retrace keystrokes.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('starts from ?q= so Back from a traveler lands on the same narrowed list', async () => {
    searchParams = new URLSearchParams('scope=station&q=manifold');
    renderPage();
    await screen.findByText(/J-0992/);
    expect(screen.queryByText(/J-0118/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Find a job')).toHaveValue('manifold');
  });

  it('narrows the completed list too', async () => {
    const user = userEvent.setup();
    searchParams = new URLSearchParams('scope=station&completed=1');
    mock(getCompletedOperatorJobs).mockResolvedValue(TWO_JOBS);

    renderPage();
    await screen.findByText(/J-0118/);
    await user.type(screen.getByLabelText('Find a job'), '0992');
    await waitFor(() => expect(screen.queryByText(/J-0118/)).not.toBeInTheDocument());
    expect(screen.getByText(/J-0992/)).toBeInTheDocument();
  });

  it('is hidden on the station picker, where there is no list to narrow', async () => {
    stationContext.stationId = null;
    renderPage();
    await screen.findByText('Pick a station');
    expect(screen.queryByLabelText('Find a job')).not.toBeInTheDocument();
  });

  /**
   * Two E2E specs race `getByRole('button', { name: 'My Station' })` against the station picker to
   * decide whether the list is up. Renaming or restructuring that control breaks them somewhere far
   * from here, so the accessible name is pinned at the unit level where the failure is legible.
   */
  it('keeps the My Station control addressable by its accessible name', async () => {
    renderPage();
    await screen.findByText(/J-0118/);
    expect(screen.getByRole('button', { name: 'My Station' })).toBeInTheDocument();
  });
});

describe('OperatorJobsPage — instrumentation', () => {
  it('reports a settled search once, with shape and not the query text', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/J-0118/);

    await user.type(screen.getByLabelText('Find a job'), 'manifold');
    await waitFor(() => expect(mockCapture).toHaveBeenCalledTimes(1));

    const [name, props] = mockCapture.mock.calls[0];
    expect(name).toBe('job list searched');
    expect(props).toEqual({ surface: 'operator', scope: 'station', has_results: true });
    // The registry rule: properties describe the SHAPE of the interaction, never
    // the customer's business data. A job number or part name is theirs.
    expect(JSON.stringify(props)).not.toMatch(/manifold/i);
  });

  it('reports a search that found nothing, which is the interesting half', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/J-0118/);

    await user.type(screen.getByLabelText('Find a job'), 'zzzz');
    await waitFor(() => expect(mockCapture).toHaveBeenCalledTimes(1));
    expect(mockCapture.mock.calls[0][1]).toMatchObject({ has_results: false });
  });

  it('does not report an empty query, or the same query twice', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/J-0118/);

    const field = screen.getByLabelText('Find a job');
    await user.type(field, 'cap');
    await waitFor(() => expect(mockCapture).toHaveBeenCalledTimes(1));

    await user.clear(field);
    await user.type(field, 'cap');
    await waitFor(() => expect(screen.queryByText(/J-0118/)).not.toBeInTheDocument());
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});

describe('OperatorJobsPage — surveillance guardrail', () => {
  /**
   * THE GUARDRAIL, asserted on a surface that had no unit test at all until this file. The rule is
   * that a number here may describe the job in front of the operator but may never accumulate across
   * jobs to describe the person — and the reason to assert it on the JOBS list specifically is that
   * a filter is exactly the kind of control that invites a "3 of 12 done today" tally to be added
   * beside it later.
   */
  it('adds no tally, rate or window alongside the filter', async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await screen.findByText(/J-0118/);
    await user.type(screen.getByLabelText('Find a job'), 'a');
    await waitFor(() => expect(screen.getByLabelText('Find a job')).toHaveValue('a'));

    const text = container.textContent ?? '';
    for (const forbidden of [
      /streak/i,
      /average/i,
      /\bpace\b/i,
      /\brank\b/i,
      /leaderboard/i,
      /per hour/i,
      /\btotal\b/i,
      /\bentries\b/i,
      /this (week|month)/i,
      /\bso far this\b/i,
      /^since \d/im,
    ]) {
      expect(text, `the jobs list must not surface ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('shows no match count — the station headings already carry the only count here', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/J-0118/);
    await user.type(screen.getByLabelText('Find a job'), 'manifold');
    await waitFor(() => expect(screen.queryByText(/J-0118/)).not.toBeInTheDocument());

    expect(screen.queryByText(/\b1 (match|result)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/showing \d+/i)).not.toBeInTheDocument();
  });
});

describe('OperatorJobsPage — loading', () => {
  it('does not refetch when the query changes', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/J-0118/);
    expect(getOperatorJobs).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText('Find a job'), 'manifold');
    await waitFor(() => expect(screen.queryByText(/J-0118/)).not.toBeInTheDocument());
    // The list arrives whole and unpaginated; narrowing it is a client-side pass.
    // A keystroke that refetched would fan the readiness RPC across every station.
    expect(getOperatorJobs).toHaveBeenCalledTimes(1);
  });

  it('still surfaces a load failure rather than reading as an empty search', async () => {
    mock(getOperatorJobs).mockRejectedValue(new Error('readiness RPC exploded'));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/readiness RPC exploded/)).toBeInTheDocument();
  });
});
