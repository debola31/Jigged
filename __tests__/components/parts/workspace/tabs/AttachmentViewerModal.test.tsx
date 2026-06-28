import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import AttachmentViewerModal from '@/components/parts/workspace/tabs/AttachmentViewerModal';
import { getPartAttachmentUrl } from '@/utils/partAttachmentsAccess';
import type { PartAttachment } from '@/types/part';

vi.mock('@/utils/partAttachmentsAccess', () => ({
  getPartAttachmentUrl: vi.fn(),
}));

const pdfAttachment = (id: string, storagePath: string): PartAttachment =>
  ({
    id,
    company_id: 'co1',
    part_id: 'p1',
    storage_path: storagePath,
    file_name: `${id}.pdf`,
    kind: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 1,
    uploaded_by: null,
    uploaded_by_name: null,
    created_at: '',
  }) as unknown as PartAttachment;

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const getMock = getPartAttachmentUrl as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AttachmentViewerModal — parent key-remount fetches a fresh URL per attachment', () => {
  it('refetches the signed URL for a DIFFERENT attachment on key change (no stale URL/loading)', async () => {
    getMock.mockResolvedValue('https://signed/url');

    // Mount attachment A under key="a1" → fetches "pathA".
    const { rerender } = render(
      wrap(
        <AttachmentViewerModal
          key="a1"
          open
          attachment={pdfAttachment('a1', 'pathA')}
          onClose={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('pathA'));
    // A's URL resolved → PDF iframe is shown (not the loading spinner).
    await waitFor(() =>
      expect(document.querySelector('iframe[title="a1.pdf"]')).toBeInTheDocument(),
    );

    // Remount with a NEW key + attachment B → must refetch "pathB" with a fresh
    // loading cycle (initial state loading=true / url=null), never reuse pathA's URL.
    rerender(
      wrap(
        <AttachmentViewerModal
          key="a2"
          open
          attachment={pdfAttachment('a2', 'pathB')}
          onClose={vi.fn()}
        />,
      ),
    );

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('pathB'));
    // Both paths were fetched — proves the key-remount drove a fresh load per target.
    const calledPaths = getMock.mock.calls.map((c) => c[0]);
    expect(calledPaths).toContain('pathA');
    expect(calledPaths).toContain('pathB');

    // And B's own iframe renders off its own fresh URL.
    await waitFor(() =>
      expect(document.querySelector('iframe[title="a2.pdf"]')).toBeInTheDocument(),
    );
  });

  it('shows a fresh loading spinner on the new key before the new URL resolves', async () => {
    // Resolve A immediately; hold B pending so we can observe the reset loading state.
    let resolveB: (url: string) => void = () => {};
    getMock.mockImplementationOnce(() => Promise.resolve('https://signed/a'));
    getMock.mockImplementationOnce(
      () => new Promise<string>((res) => { resolveB = res; }),
    );

    const { rerender } = render(
      wrap(
        <AttachmentViewerModal
          key="a1"
          open
          attachment={pdfAttachment('a1', 'pathA')}
          onClose={vi.fn()}
        />,
      ),
    );
    await waitFor(() =>
      expect(document.querySelector('iframe[title="a1.pdf"]')).toBeInTheDocument(),
    );

    // Remount on a new key with B pending → loading state reset (spinner visible,
    // and crucially A's iframe is gone — no stale content carried over).
    rerender(
      wrap(
        <AttachmentViewerModal
          key="a2"
          open
          attachment={pdfAttachment('a2', 'pathB')}
          onClose={vi.fn()}
        />,
      ),
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(document.querySelector('iframe[title="a1.pdf"]')).not.toBeInTheDocument();

    // Let B resolve → its iframe replaces the spinner.
    resolveB('https://signed/b');
    await waitFor(() =>
      expect(document.querySelector('iframe[title="a2.pdf"]')).toBeInTheDocument(),
    );
  });
});
