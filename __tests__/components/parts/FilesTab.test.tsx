import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import type { Part, PartAttachment } from '@/types/part';

// --- Mock the access layer: the tab's behavior is tested independently of Supabase ---
const mockList = vi.fn();
const mockUpload = vi.fn();
const mockDelete = vi.fn();
const mockGetUrl = vi.fn();
const mockValidate = vi.fn();

vi.mock('@/utils/partAttachmentsAccess', () => ({
  listPartAttachments: (...a: unknown[]) => mockList(...a),
  uploadPartAttachment: (...a: unknown[]) => mockUpload(...a),
  deletePartAttachment: (...a: unknown[]) => mockDelete(...a),
  getPartAttachmentUrl: (...a: unknown[]) => mockGetUrl(...a),
  validatePartAttachmentFile: (...a: unknown[]) => mockValidate(...a),
}));

const mockUseUserRole = vi.fn();
vi.mock('@/hooks/useUserRole', () => ({
  useUserRole: () => mockUseUserRole(),
}));

const mockGetCurrentOperator = vi.fn();
vi.mock('@/utils/operatorAccess', () => ({
  getCurrentOperator: (...a: unknown[]) => mockGetCurrentOperator(...a),
}));

// The STEP 3D viewer is loaded via next/dynamic(() => import('./StepViewer')).
// Stub next/dynamic to return a lightweight component so the WASM/WebGL engine
// never loads in jsdom; we only assert the modal dispatches STEP to it.
vi.mock('next/dynamic', () => ({
  default: () =>
    function StepViewerStub({ url }: { url: string }) {
      return <div data-testid="step-viewer" data-url={url} />;
    },
}));

import FilesTab from '@/components/parts/workspace/tabs/FilesTab';

const part = { id: 'p1', company_id: 'c1', part_name: 'PART-1' } as Part;

function att(partial: Partial<PartAttachment>): PartAttachment {
  return {
    id: 'att',
    company_id: 'c1',
    part_id: 'p1',
    storage_path: 'c1/parts/p1/x',
    file_name: 'file',
    kind: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    uploaded_by: 'op-1',
    uploaded_by_name: 'Jane',
    created_at: '2026-06-22T00:00:00Z',
    ...partial,
  };
}

const PDF = att({ id: 'a-pdf', file_name: 'drawing.pdf', kind: 'pdf', uploaded_by: 'op-1' });
const DWG = att({ id: 'a-dwg', file_name: 'legacy.dwg', kind: 'dwg', uploaded_by: 'op-2' });

function renderTab() {
  return render(<FilesTab part={part} partId="p1" companyId="c1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([PDF, DWG]);
  mockGetCurrentOperator.mockResolvedValue({ id: 'op-1', name: 'Jane', user_id: 'u1' });
  mockUseUserRole.mockReturnValue({ isAdmin: false, role: 'user', loading: false });
  mockValidate.mockReturnValue(null);
  mockGetUrl.mockResolvedValue('https://signed/file');
});

describe('FilesTab', () => {
  it('lists attachments with kind chips', async () => {
    renderTab();
    expect(await screen.findByText('drawing.pdf')).toBeInTheDocument();
    expect(screen.getByText('legacy.dwg')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByText('DWG')).toBeInTheDocument();
  });

  it('shows the delete affordance only on rows the user uploaded (non-admin)', async () => {
    renderTab();
    await screen.findByText('drawing.pdf');
    // op-1 uploaded the PDF → delete shown; op-2 uploaded the DWG → hidden.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /delete file/i })).toHaveLength(1);
    });
  });

  it('shows delete on every row for an admin', async () => {
    mockUseUserRole.mockReturnValue({ isAdmin: true, role: 'admin', loading: false });
    renderTab();
    await screen.findByText('drawing.pdf');
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /delete file/i })).toHaveLength(2);
    });
  });

  it('opens a PDF inline in the viewer modal', async () => {
    const user = userEvent.setup();
    renderTab();
    const pdfRow = (await screen.findByText('drawing.pdf')).closest('li')!;
    await user.click(within(pdfRow).getByRole('button', { name: /open/i }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByTitle('drawing.pdf')).toBeInTheDocument();
    });
    expect(mockGetUrl).toHaveBeenCalledWith(PDF.storage_path);
  });

  it('opens a STEP file in the 3D viewer', async () => {
    const STEP = att({ id: 'a-step', file_name: 'model.step', kind: 'step', uploaded_by: 'op-2' });
    mockList.mockResolvedValue([STEP]);
    const user = userEvent.setup();
    renderTab();
    const stepRow = (await screen.findByText('model.step')).closest('li')!;
    await user.click(within(stepRow).getByRole('button', { name: /open/i }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('step-viewer')).toBeInTheDocument();
    expect(mockGetUrl).toHaveBeenCalledWith(STEP.storage_path);
  });

  it('downloads a DWG instead of opening the viewer', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    renderTab();
    const dwgRow = (await screen.findByText('legacy.dwg')).closest('li')!;
    await user.click(within(dwgRow).getByRole('button', { name: /download/i }));

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openSpy.mockRestore();
  });

  it('surfaces a validation error and does not upload a rejected file', async () => {
    mockValidate.mockReturnValue('Only PDF, STEP (.step/.stp), and DWG files can be attached.');
    renderTab();
    await screen.findByText('drawing.pdf');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const bad = new File(['x'], 'photo.png', { type: 'image/png' });
    // applyAccept:false — bypass the input's accept filter so the rejected-file
    // path (our own validator) actually runs in the test.
    await userEvent.upload(input, bad, { applyAccept: false });

    expect(await screen.findByText(/can be attached/i)).toBeInTheDocument();
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
