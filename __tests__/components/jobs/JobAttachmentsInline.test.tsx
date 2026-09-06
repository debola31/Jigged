import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

const { listJobAttachments, getJobAttachmentUrl } = vi.hoisted(() => ({
  listJobAttachments: vi.fn(),
  getJobAttachmentUrl: vi.fn().mockResolvedValue('https://signed.example/po.pdf'),
}));

vi.mock('@/utils/jobAttachmentsAccess', () => ({ listJobAttachments, getJobAttachmentUrl }));

import JobAttachmentsInline from '@/components/jobs/JobAttachmentsInline';

const att = (over: { id: string; file_name: string; mime_type?: string }) => ({
  storage_path: `jobs/job-1/${over.id}`,
  mime_type: 'application/pdf',
  ...over,
});

const renderInline = () =>
  render(
    <ThemeProvider theme={jiggedTheme}>
      <JobAttachmentsInline jobId="job-1" />
    </ThemeProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  getJobAttachmentUrl.mockResolvedValue('https://signed.example/po.pdf');
});

describe('JobAttachmentsInline', () => {
  /**
   * THE WHOLE SAVING. This replaced an Attachments block that spent two lines
   * saying "None" on every job that had no files — which is most of them. An
   * affordance that appears only when there is something behind it is the point,
   * so its absence is the behaviour worth pinning.
   */
  it('renders nothing when the job has no attachments', async () => {
    listJobAttachments.mockResolvedValue([]);
    const { container } = renderInline();

    await vi.waitFor(() => expect(listJobAttachments).toHaveBeenCalled());
    expect(screen.queryByTestId('job-attachment-open')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('names the file it will open, so the paperclip is not a mystery', async () => {
    listJobAttachments.mockResolvedValue([att({ id: 'a1', file_name: 'PO-88231.pdf' })]);
    renderInline();

    expect(
      await screen.findByRole('button', { name: /Open PO-88231\.pdf/i }),
    ).toBeInTheDocument();
  });

  it('opens a single attachment straight away, with no menu in the way', async () => {
    // Making the common case a two-step menu of one item would be worse than
    // the block this replaced.
    listJobAttachments.mockResolvedValue([att({ id: 'a1', file_name: 'PO-88231.pdf' })]);
    renderInline();

    await userEvent.click(await screen.findByTestId('job-attachment-open'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('PO-88231.pdf')).toBeInTheDocument();
    expect(getJobAttachmentUrl).toHaveBeenCalledWith('jobs/job-1/a1');
  });

  it('asks which one when there are several', async () => {
    listJobAttachments.mockResolvedValue([
      att({ id: 'a1', file_name: 'PO-88231.pdf' }),
      att({ id: 'a2', file_name: 'drawing-rev-c.pdf' }),
    ]);
    renderInline();

    await userEvent.click(await screen.findByTestId('job-attachment-open'));

    expect(await screen.findByRole('menuitem', { name: 'PO-88231.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'drawing-rev-c.pdf' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('menuitem', { name: 'drawing-rev-c.pdf' }));
    expect(getJobAttachmentUrl).toHaveBeenCalledWith('jobs/job-1/a2');
  });
});
