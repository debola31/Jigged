/**
 * J4 on the job page.
 *
 * The load-bearing assertion is the incomparable row: it must render an em dash in Short by
 * and never a number. A 0 there reads as "you're fine" — the one answer this card must not
 * give when the units can't actually be compared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

vi.mock('next/navigation', () => ({ useParams: () => ({ companyId: 'co1' }) }));
vi.mock('@/utils/materialCheckAccess', () => ({ getJobPartMaterialCheck: vi.fn() }));

import JobPartMaterialsCard from '@/components/jobs/JobPartMaterialsCard';
import { getJobPartMaterialCheck } from '@/utils/materialCheckAccess';
import type { MaterialRequirement } from '@/types/materialCheck';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const row = (over: Partial<MaterialRequirement> & { partId: string }): MaterialRequirement => ({
  bomLineId: `bom-${over.partId}`,
  partName: over.partId.toUpperCase(),
  bomUnit: 'each',
  consumeWholeUnits: false,
  requiredInBomUnit: 8,
  requiredInStockUnit: 8,
  stockUnit: 'each',
  onHand: 20,
  issued: 0,
  hasDiscrepancy: false,
  remainingToIssue: 8,
  shortBy: 0,
  status: 'ok',
  basis: { kind: 'same', unit: 'each' },
  isLocationTracked: false,
  locations: [],
  ...over,
});

const renderCard = () =>
  render(
    <JobPartMaterialsCard partId="made1" jobId="job1" jobPartId="jp1" orderQuantity={4} />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );

const rowFor = async (name: string) => (await screen.findByText(name)).closest('tr')!;

beforeEach(() => {
  vi.clearAllMocks();
  asMock(getJobPartMaterialCheck).mockResolvedValue([]);
});

describe('JobPartMaterialsCard', () => {
  it('scopes the read to this job part so "issued" is this job\'s', async () => {
    renderCard();
    await screen.findByText(/no materials/i);
    expect(getJobPartMaterialCheck).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'co1', jobId: 'job1', jobPartId: 'jp1', madePartId: 'made1', orderQuantity: 4 }),
    );
  });

  it('shows required, on-hand and short-by per material', async () => {
    asMock(getJobPartMaterialCheck).mockResolvedValue([
      row({ partId: 'steel', requiredInBomUnit: 30, requiredInStockUnit: 30, onHand: 10, shortBy: 20, status: 'short' }),
    ]);
    renderCard();

    const tr = await rowFor('STEEL');
    expect(within(tr).getByText('30 each')).toBeInTheDocument();
    expect(within(tr).getByText('10 each')).toBeInTheDocument();
    expect(within(tr).getByText('20 each')).toBeInTheDocument();
  });

  /**
   * This chip has pointed at a dead target TWICE, which is why the assertion is now that it
   * points at nothing at all.
   *
   * It linked to `/dashboard/co1/inventory/shortages` — a route never built, so the test was
   * locking in a 404 — and was then repointed at `/dashboard/co1/parts?status=low` once the
   * Parts stock filter became the shop-wide shortage lens. That filter went with `is_stocked`:
   * Parts is the item master and carries no quantities. An unknown query param does not 404, it
   * is ignored, so a leftover href would now be a live 200 onto an unfiltered catalogue — the
   * failure mode that hid the first dead link for two months.
   */
  it('summarises how many materials are short, as plain text with no link', async () => {
    asMock(getJobPartMaterialCheck).mockResolvedValue([
      row({ partId: 'a', shortBy: 5, status: 'short' }),
      row({ partId: 'b', shortBy: 2, status: 'short' }),
      row({ partId: 'c' }),
    ]);
    renderCard();

    const chip = await screen.findByText('2 short');
    expect(chip.closest('a')).toBeNull();
  });

  /**
   * The whole reason the incomparable state exists. 4 ft against 120 in must not render a
   * number in Short by — silently comparing them would say "you have plenty" when you have
   * 10 ft.
   */
  it('renders an em dash, never a number, when the units cannot be compared', async () => {
    asMock(getJobPartMaterialCheck).mockResolvedValue([
      row({
        partId: 'bar', bomUnit: 'feet', requiredInBomUnit: 4, requiredInStockUnit: null,
        stockUnit: 'inches', onHand: 120, shortBy: null, remainingToIssue: null,
        status: 'incomparable', basis: { kind: 'incomparable', bomUnit: 'feet', stockUnit: 'inches' },
      }),
    ]);
    renderCard();

    const tr = await rowFor('BAR');
    expect(within(tr).getByText(/can't compare units/i)).toBeInTheDocument();
    expect(within(tr).getByText('4 feet')).toBeInTheDocument();
    // No shortage figure at all — not "0 inches", not "0".
    expect(within(tr).queryByText(/^0/)).not.toBeInTheDocument();
    expect(within(tr).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows what has already been issued to this job', async () => {
    asMock(getJobPartMaterialCheck).mockResolvedValue([
      row({ partId: 'steel', issued: 6, remainingToIssue: 2 }),
    ]);
    renderCard();
    const tr = await rowFor('STEEL');
    expect(within(tr).getByText('6 each')).toBeInTheDocument();
  });

  it('flags a material whose depletion was clamped to zero', async () => {
    asMock(getJobPartMaterialCheck).mockResolvedValue([
      row({ partId: 'steel', hasDiscrepancy: true }),
    ]);
    renderCard();
    expect(await screen.findByText(/shortfall recorded/i)).toBeInTheDocument();
  });

  // Dropping the row would be worse than showing it flagged. `not_stocked` was the other member
  // of this list until `is_stocked` was dropped and the status became unproducible.
  it('keeps an archived material on the list, labelled', async () => {
    asMock(getJobPartMaterialCheck).mockResolvedValue([
      row({ partId: 'odd', status: 'archived' }),
    ]);
    renderCard();
    expect(await screen.findByText(/archived material/i)).toBeInTheDocument();
    expect(screen.getByText('ODD')).toBeInTheDocument();
  });

  // Both limitations are stated on screen rather than left to be discovered from a wrong number.
  it('says out loud that it only covers top-level materials and shop-wide stock', async () => {
    asMock(getJobPartMaterialCheck).mockResolvedValue([row({ partId: 'steel' })]);
    renderCard();
    expect(await screen.findByText(/top-level materials only/i)).toBeInTheDocument();
    expect(screen.getByText(/other open jobs may want the same material/i)).toBeInTheDocument();
  });

  it('says so when the part has no BOM at all', async () => {
    renderCard();
    expect(await screen.findByText(/no materials on this part/i)).toBeInTheDocument();
  });
});
