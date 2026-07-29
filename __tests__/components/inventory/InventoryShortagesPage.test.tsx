/**
 * J4 shop-wide — "Short for this week".
 *
 * The reason this page exists at all is the case a job card structurally cannot show: two
 * jobs each needing 10 against 15 on hand both read "not short" individually. That, and
 * keeping unmeasurable materials out of the "you're fine" bucket, are what these tests pin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

vi.mock('next/navigation', () => ({ useParams: () => ({ companyId: 'co1' }) }));
vi.mock('@/utils/materialCheckAccess', () => ({ getShopMaterialShortages: vi.fn() }));

import InventoryShortagesPage from '@/app/dashboard/[companyId]/inventory/shortages/page';
import { getShopMaterialShortages } from '@/utils/materialCheckAccess';
import type { PartShortage } from '@/types/materialCheck';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const shortage = (over: Partial<PartShortage> & { partId: string }): PartShortage => ({
  partName: over.partId.toUpperCase(),
  stockUnit: 'each',
  onHand: 15,
  totalRequired: 20,
  totalIssued: 0,
  shortBy: 5,
  status: 'short',
  incomparableJobCount: 0,
  contributions: [],
  ...over,
});

const contribution = (jobId: string, over: Record<string, unknown> = {}) => ({
  jobId,
  jobNumber: jobId.toUpperCase(),
  jobPartId: `${jobId}-jp`,
  madePartName: 'Widget',
  dueDate: '2026-08-01',
  isHot: false,
  required: 10,
  ...over,
});

const result = (shortages: PartShortage[], over: Record<string, unknown> = {}) => ({
  shortages,
  rangeEnd: '2026-08-02',
  jobCount: shortages.length,
  ...over,
});

const renderPage = () =>
  render(<InventoryShortagesPage />, {
    wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>,
  });

beforeEach(() => {
  vi.clearAllMocks();
  asMock(getShopMaterialShortages).mockResolvedValue(result([]));
});

describe('InventoryShortagesPage', () => {
  /**
   * The case a job card cannot show. Both jobs individually fit inside 15 on hand; together
   * they don't. One row, one on-hand figure, both jobs listed.
   */
  it('shows a part once with every job that wants it', async () => {
    asMock(getShopMaterialShortages).mockResolvedValue(
      result([
        shortage({
          partId: 'steel',
          contributions: [contribution('j1'), contribution('j2', { dueDate: '2026-08-03' })],
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText('STEEL')).toBeInTheDocument();
    expect(screen.getByText('Short 5 each')).toBeInTheDocument();
    expect(screen.getByText(/20 needed · 15 on hand/)).toBeInTheDocument();
    expect(screen.getByText('J1')).toBeInTheDocument();
    expect(screen.getByText('J2')).toBeInTheDocument();
  });

  it('says which jobs it counted and what date the window resolved to', async () => {
    asMock(getShopMaterialShortages).mockResolvedValue(result([], { jobCount: 14 }));
    renderPage();
    expect(await screen.findByText(/due on or before/i)).toBeInTheDocument();
    expect(screen.getByText(/14 jobs/)).toBeInTheDocument();
    // Stated so nobody has to guess whether their late job is in the number.
    expect(screen.getByText(/plus overdue, hot and undated open jobs/)).toBeInTheDocument();
  });

  it('re-queries when the window changes', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/nothing is short/i);

    await user.click(screen.getByRole('button', { name: /all open/i }));
    expect(getShopMaterialShortages).toHaveBeenLastCalledWith('co1', 'all');
  });

  it('says plainly when nothing is short', async () => {
    renderPage();
    expect(await screen.findByText(/nothing is short/i)).toBeInTheDocument();
  });

  /**
   * An unmeasurable material must never sit silently in the "you're fine" bucket — it is a
   * different answer from "you have enough", and the page has to say which one it means.
   */
  it('lists materials it cannot compare separately, never as fine', async () => {
    asMock(getShopMaterialShortages).mockResolvedValue(
      result([
        shortage({
          partId: 'bar', status: 'incomparable', shortBy: null, totalRequired: null,
          incomparableJobCount: 3, contributions: [contribution('j1', { required: null })],
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText(/nothing is short/i)).toBeInTheDocument();
    const section = screen.getByText(/can't compare units \(1\)/i).parentElement!;
    expect(within(section).getByText('BAR')).toBeInTheDocument();
    expect(within(section).getByText(/3 jobs affected/)).toBeInTheDocument();
  });

  it('marks a hot job so the rush that motivated the feature is visible', async () => {
    asMock(getShopMaterialShortages).mockResolvedValue(
      result([shortage({ partId: 'steel', contributions: [contribution('j1', { isHot: true })] })]),
    );
    renderPage();
    expect(await screen.findByText('HOT')).toBeInTheDocument();
  });

  it('states the top-level-only limitation', async () => {
    renderPage();
    expect(await screen.findByText(/top-level materials only/i)).toBeInTheDocument();
  });

  it('surfaces a failed load rather than rendering an empty all-clear', async () => {
    asMock(getShopMaterialShortages).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(/could not work out shortages/i)).toBeInTheDocument();
  });
});
