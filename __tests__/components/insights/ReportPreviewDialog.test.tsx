/**
 * The preview draws the stored spec and the download is the event -- a report
 * generated and never downloaded was a curiosity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import posthog from 'posthog-js';
import { render, screen, waitFor, resetRouterMocks } from '../../test-utils';
import ReportPreviewDialog from '@/components/insights/ReportPreviewDialog';

const fakeDoc = { output: vi.fn().mockReturnValue('blob:report'), save: vi.fn() };
const mockGenerate = vi.fn();
vi.mock('@/utils/reportPdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/reportPdf')>();
  return { ...actual, generateReportPdf: (...a: unknown[]) => mockGenerate(...a) };
});
vi.mock('@/utils/companyAccess', () => ({
  getCompany: vi.fn().mockResolvedValue({ id: 'co-1', name: 'Contour Tool & Machine' }),
}));
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { identify: vi.fn(), capture: vi.fn() } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const report = JSON.parse(readFileSync(join(__dirname, '..', '..', 'fixtures', 'reportSpecExample.json'), 'utf8'));
const summary = { id: 'job-1', created_at: '2026-09-07T15:00:00Z', report, dropped: [] };

describe('ReportPreviewDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    mockGenerate.mockResolvedValue(fakeDoc);
    vi.stubGlobal('URL', { ...URL, revokeObjectURL: vi.fn(), createObjectURL: vi.fn() });
  });

  it('renders the spec into a preview and counts the download, shape only', async () => {
    render(<ReportPreviewDialog open onClose={() => {}} companyId="co-1" summary={summary} />);

    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
    const [spec, company] = mockGenerate.mock.calls[0];
    expect(spec.title).toBe('OPERATIONS SUMMARY');
    expect(company.name).toBe('Contour Tool & Machine');
    expect(await screen.findByTitle('OPERATIONS SUMMARY preview')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: /download/i }));

    expect(fakeDoc.save).toHaveBeenCalledWith(expect.stringMatching(/^OPERATIONS-SUMMARY-\d{4}-\d{2}-\d{2}\.pdf$/));
    expect(posthog.capture).toHaveBeenCalledWith('report exported', { block_count: 4, chart_count: 1 });
  });

  it('says so when a stored report no longer has a shape it can draw', async () => {
    render(
      <ReportPreviewDialog open onClose={() => {}} companyId="co-1" summary={{ ...summary, report: { title: 'x' } }} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/can't be displayed/);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
