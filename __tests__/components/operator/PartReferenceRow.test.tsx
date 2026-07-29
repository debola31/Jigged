import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';

import PartReferenceRow from '@/components/operator/PartReferenceRow';
import { countPartAttachments } from '@/utils/partAttachmentsAccess';
import { countPartPreviousNotes } from '@/utils/operatorAccess';

vi.mock('@/utils/partAttachmentsAccess', () => ({ countPartAttachments: vi.fn() }));
vi.mock('@/utils/operatorAccess', () => ({ countPartPreviousNotes: vi.fn() }));
// The sheets only render when opened; stub them so this test doesn't drag in the
// whole notes/files stack (and a real Supabase client) just to check a label.
vi.mock('@/components/operator/PartFilesSheet', () => ({ default: () => null }));
vi.mock('@/components/operator/PartNotesSheet', () => ({ default: () => null }));

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function renderRow() {
  return render(
    <PartReferenceRow
      companyId="c1"
      partId="p1"
      partName="PROD-MANIFOLD-300"
      excludeJobId="job-current"
      jobOperationId="op1"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mock(countPartAttachments).mockResolvedValue(0);
  mock(countPartPreviousNotes).mockResolvedValue(0);
});

// The read-back gap this fixes: the affordance used to be a bare "Playbook"
// label, so an operator had no way to tell whether anything was behind it — while
// Files sat right next to it showing a count. Knowledge nobody knows exists is not
// reachable, whatever the tap count says.
describe('PartReferenceRow — previous-notes count', () => {
  it('shows the count when prior notes exist', async () => {
    mock(countPartPreviousNotes).mockResolvedValue(3);
    renderRow();

    expect(await screen.findByRole('button', { name: 'Playbook · 3' })).toBeInTheDocument();
  });

  it('stays a bare label when there is nothing to read', async () => {
    // Not "· 0" — a zero badge is noise that trains operators to ignore the number.
    mock(countPartPreviousNotes).mockResolvedValue(0);
    renderRow();

    await waitFor(() => expect(countPartPreviousNotes).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Playbook' })).toBeInTheDocument();
  });

  it('excludes the current job, so a note is never "previous" to itself', async () => {
    renderRow();

    await waitFor(() =>
      expect(countPartPreviousNotes).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ excludeJobId: 'job-current' }),
      ),
    );
  });

  it('still renders the affordance when the count fails', async () => {
    // Decoration on a hot path: an operator must never lose access to prior
    // knowledge because a badge query failed.
    mock(countPartPreviousNotes).mockRejectedValue(new Error('offline'));
    renderRow();

    expect(await screen.findByRole('button', { name: 'Playbook' })).toBeInTheDocument();
  });
});
