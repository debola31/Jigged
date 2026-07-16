import { describe, it, expect } from 'vitest';
import { render, screen } from '../../test-utils';
import ImportProgressPanel from '@/components/data-import/ImportProgressPanel';
import type { ImportProgress } from '@/lib/dataImportIngest';

const progress = (over: Partial<ImportProgress> = {}): ImportProgress => ({
  batchesDone: 1,
  batchesTotal: 3,
  rowsDone: 53,
  rowsTotal: 504,
  currentEntity: 'parts',
  entities: [
    { entity: 'vendors', rowsTotal: 3, rowsDone: 3, rowsFailed: 0 },
    { entity: 'parts', rowsTotal: 501, rowsDone: 50, rowsFailed: 0 },
  ],
  ...over,
});

describe('ImportProgressPanel', () => {
  it('shows a determinate bar with the row count and percent once started', () => {
    render(<ImportProgressPanel progress={progress()} />);
    expect(screen.getByText('53 of 504 rows')).toBeInTheDocument();
    expect(screen.getByText('11%')).toBeInTheDocument(); // round(53/504*100)
    // The linear bar is the determinate one (the active-stage spinner is also a progressbar).
    const determinate = screen.getAllByRole('progressbar').find((b) => b.getAttribute('aria-valuenow') === '11');
    expect(determinate).toBeTruthy();
  });

  it('renders each entity as a stage in write order', () => {
    render(<ImportProgressPanel progress={progress()} />);
    expect(screen.getByText('Vendors')).toBeInTheDocument();
    expect(screen.getByText('Parts')).toBeInTheDocument();
    // The in-flight stage shows its partial count.
    expect(screen.getByText('50 of 501 rows')).toBeInTheDocument();
  });

  it('falls back to an indeterminate bar before the first batch reports', () => {
    render(<ImportProgressPanel progress={null} />);
    expect(screen.getByText('Starting…')).toBeInTheDocument();
    // With no progress there are no stages, so the single bar is the indeterminate one.
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  it('marks a completed-with-failures stage as an error, not a green check', () => {
    render(
      <ImportProgressPanel
        progress={progress({
          currentEntity: 'parts',
          entities: [
            { entity: 'vendors', rowsTotal: 3, rowsDone: 3, rowsFailed: 0 },
            { entity: 'parts', rowsTotal: 501, rowsDone: 501, rowsFailed: 501 },
          ],
        })}
      />,
    );
    expect(screen.getByText(/501 couldn't be saved/)).toBeInTheDocument();
  });
});
