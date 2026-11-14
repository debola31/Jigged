/**
 * The job page's line under a part with NO operations (plan §3.13 "Elsewhere", criterion B4).
 *
 * A bought part is `completed` the moment the job exists, so what sits under it is the purchasing
 * line — "Not on a purchase order · Buy it" — while a made part with no routing keeps the old
 * sentence. Which is which comes from the job read itself (`parts.source`, `getJobWithRelations`):
 * the page used to make a second parts read for it, and this pins that it no longer does. The
 * children with suites of their own are stood in for; the buying line is the real one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co1', jobId: 'job-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/dashboard/co1/jobs/job-1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/localDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/localDate')>()),
  todayLocalISODate: () => '2026-11-12',
}));

const m = vi.hoisted(() => ({
  getJobWithRelations: vi.fn(),
  listVendorPoLinesForJob: vi.fn(),
  getPartsForSelectByIds: vi.fn(),
}));
vi.mock('@/utils/jobsAccess', () => ({
  getJobWithRelations: (...a: unknown[]) => m.getJobWithRelations(...a),
  cancelJob: vi.fn(),
  reopenJob: vi.fn(),
  deleteJob: vi.fn(),
}));
vi.mock('@/utils/vendorPoAccess', () => ({ listVendorPoLinesForJob: (...a: unknown[]) => m.listVendorPoLinesForJob(...a) }));
vi.mock('@/utils/partsAccess', () => ({ getPartsForSelectByIds: (...a: unknown[]) => m.getPartsForSelectByIds(...a) }));
vi.mock('@/utils/shipmentsAccess', () => ({ getJobPartShipmentSummaries: vi.fn(async () => []) }));
vi.mock('@/utils/quickbooksAccess', () => ({ getJobPartInvoiceSummaries: vi.fn(async () => []) }));
vi.mock('@/utils/operatorAccess', () => ({ getCurrentMember: vi.fn(async () => null) }));
vi.mock('@/hooks/useJobActivity', () => ({
  useJobActivity: () => ({ items: [], loading: false, error: null, reload: vi.fn(async () => undefined), noteCounts: new Map() }),
}));

const { Stub } = vi.hoisted(() => ({ Stub: () => null }));
vi.mock('@/components/jobs', () => ({
  OperationsPanel: () => <div data-testid="operations-panel" />,
  JobTravelerPreviewDialog: Stub,
  JobBillingShippingCard: Stub,
  JobPartMaterialsCard: Stub,
  JobEditForm: Stub,
  ShipmentsMenu: Stub,
  InvoicesMenu: Stub,
}));
vi.mock('@/components/jobs/JobOverdueBadge', () => ({ default: Stub }));
vi.mock('@/components/jobs/JobStatusBlock', () => ({ default: Stub, formatShipDate: (d: string) => d }));
vi.mock('@/components/jobs/JobStatusChip', () => ({ ProductionStatusChip: Stub }));
vi.mock('@/components/jobs/JobAttachmentsInline', () => ({ default: Stub }));
vi.mock('@/components/jobs/activity/JobActivityRail', () => ({
  default: Stub,
  captureRailToggle: vi.fn(),
  readRailOpen: () => false,
  writeRailOpen: vi.fn(),
}));
vi.mock('@/components/outsideShipments', () => ({ OutsideShipmentPreviewDialog: Stub }));
vi.mock('@/components/shipments', () => ({ CreateShipmentModal: Stub }));
vi.mock('@/components/shipments/PackingSlipPreviewDialog', () => ({ default: Stub }));
vi.mock('@/components/jobs/PushToQuickBooksDialog', () => ({ default: Stub }));

import JobDetailPage from '@/app/dashboard/[companyId]/jobs/[jobId]/page';

const jobPart = (id: string, sequence: number, part: { id: string; part_name: string; source: string }) => ({
  id,
  job_id: 'job-1',
  company_id: 'co1',
  part_id: part.id,
  sequence,
  quantity: 10,
  production_status: part.source === 'bought' ? 'completed' : 'not_started',
  fulfillment_status: 'unshipped',
  parts: { ...part, description: null },
  job_operations: [],
});

const job = {
  id: 'job-1',
  company_id: 'co1',
  job_number: 'J-1042',
  customer_id: 'cust-1',
  customers: { id: 'cust-1', name: 'Acme Aero' },
  quote_id: null,
  quotes: null,
  customer_po_number: 'PO-77',
  due_date: null,
  production_status: 'in_progress',
  fulfillment_status: 'unshipped',
  created_at: '2026-11-01T00:00:00Z',
  job_parts: [
    jobPart('jp-made', 1, { id: 'p-made', part_name: 'BRKT-100', source: 'made' }),
    jobPart('jp-bought', 2, { id: 'p-bought', part_name: 'PUMP-200', source: 'bought' }),
  ],
};

const draw = () =>
  render(
    <ThemeProvider theme={jiggedTheme}>
      <JobDetailPage />
    </ThemeProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.getJobWithRelations.mockResolvedValue(job);
  m.listVendorPoLinesForJob.mockResolvedValue([]);
});

describe('JobDetailPage — a part with no operations', () => {
  it('gives a bought part its buying line, from the job read alone', async () => {
    draw();
    const buyIt = await screen.findByRole('link', { name: /buy it/i });
    expect(buyIt).toHaveAttribute('href', '/dashboard/co1/purchasing/orders/new?part=p-bought&job=job-1&jobPart=jp-bought');
    expect(screen.getByText(/not on a purchase order/i)).toBeInTheDocument();
    expect(m.getJobWithRelations).toHaveBeenCalledWith('job-1', 'co1');
    expect(m.listVendorPoLinesForJob).toHaveBeenCalledWith('job-1', { today: '2026-11-12' });
    // The part's source came with the job: there is no second parts read.
    expect(m.getPartsForSelectByIds).not.toHaveBeenCalled();
  });

  it('keeps the old sentence for a made part with no routing', async () => {
    draw();
    expect(await screen.findByText('No operations on this part.')).toBeInTheDocument();
    expect(screen.getAllByTestId('job-part-buying-line')).toHaveLength(1);
  });

  /** Neither sentence flashes while the job's PO lines are still loading. */
  it('says nothing under either part until the PO lines land', async () => {
    m.listVendorPoLinesForJob.mockReturnValue(new Promise(() => {}));
    draw();
    expect(await screen.findByText('J-1042')).toBeInTheDocument();
    expect(screen.queryByText(/not on a purchase order/i)).not.toBeInTheDocument();
    expect(screen.queryByText('No operations on this part.')).not.toBeInTheDocument();
  });
});
