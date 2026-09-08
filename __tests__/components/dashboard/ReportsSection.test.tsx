import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, resetRouterMocks } from '../../test-utils';
import ReportsSection from '@/components/dashboard/ReportsSection';

const mockListReports = vi.fn();
vi.mock('@/utils/insightsAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/insightsAccess')>();
  return { ...actual, listReports: (...a: unknown[]) => mockListReports(...a) };
});
// The two dialogs have their own tests; here they only need to mount.
vi.mock('@/components/insights/ReportRequestDialog', () => ({ default: () => null }));
vi.mock('@/components/insights/ReportPreviewDialog', () => ({ default: () => null }));

const report = JSON.parse(readFileSync(join(__dirname, '..', '..', 'fixtures', 'reportSpecExample.json'), 'utf8'));

describe('ReportsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
  });

  it('lists recent reports by their own title and period', async () => {
    mockListReports.mockResolvedValue([
      { id: 'job-1', created_at: '2026-09-07T15:00:00Z', report, dropped: [] },
    ]);
    render(<ReportsSection companyId="co-1" />);

    expect(await screen.findByText('OPERATIONS SUMMARY')).toBeInTheDocument();
    expect(screen.getByText(/Jun 1 – Sep 3, 2026 · generated/)).toBeInTheDocument();
    expect(mockListReports).toHaveBeenCalledWith('co-1');
  });

  it('invites the first report when there are none', async () => {
    mockListReports.mockResolvedValue([]);
    render(<ReportsSection companyId="co-1" />);

    expect(await screen.findByText(/Ask for a one-page summary/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New report' })).toBeInTheDocument();
  });
});
