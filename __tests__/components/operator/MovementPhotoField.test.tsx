import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/utils/imageCompression', () => ({ compressPhoto: vi.fn() }));

import MovementPhotoField from '@/components/operator/MovementPhotoField';
import { compressPhoto } from '@/utils/imageCompression';

const mockCompress = vi.mocked(compressPhoto);

const file = (name = 'shelf.jpg') => new File(['x'], name, { type: 'image/jpeg' });

const onChange = vi.fn();

/**
 * jsdom has no `createObjectURL`. Stubbing it is not incidental — `revokeObjectURL` is the thing
 * one of these tests is actually about, so both need to be observable.
 */
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  created.length = 0;
  revoked.length = 0;
  let n = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:mock/${n++}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((u: string) => {
    revoked.push(u);
  });
  mockCompress.mockResolvedValue({ file: file('compressed.jpg') } as Awaited<
    ReturnType<typeof compressPhoto>
  >);
});

describe('MovementPhotoField', () => {
  /** Uploading on pick strands a file in the bucket every time someone changes their mind. */
  it('hands the compressed file up rather than uploading it', async () => {
    const user = userEvent.setup();
    const { container } = render(<MovementPhotoField value={null} onChange={onChange} />);

    await user.upload(container.querySelector('input[type=file]') as HTMLInputElement, file());

    expect(mockCompress).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'compressed.jpg' }));
  });

  /**
   * The preview is derived from `value`, not held separately. The parent Dialog stays mounted
   * between opens and resets `photo` to null on entry, so separate state would survive as a stale
   * "Photo attached" thumbnail with no file behind it.
   */
  it('drops the preview the moment the parent clears the value', () => {
    const { rerender } = render(<MovementPhotoField value={file()} onChange={onChange} />);
    expect(screen.getByText('Photo attached')).toBeInTheDocument();

    rerender(<MovementPhotoField value={null} onChange={onChange} />);

    expect(screen.queryByText('Photo attached')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add a photo/i })).toBeInTheDocument();
  });

  /** Object URLs pin the blob until revoked; on a phone a shift of put-away photos is real memory. */
  it('revokes the object URL when the photo goes away', () => {
    const { rerender } = render(<MovementPhotoField value={file()} onChange={onChange} />);
    expect(created).toHaveLength(1);

    rerender(<MovementPhotoField value={null} onChange={onChange} />);
    expect(revoked).toEqual(created);
  });

  it('lets the photo be removed again', async () => {
    const user = userEvent.setup();
    render(<MovementPhotoField value={file()} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /remove photo/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  /** A put-away happens dozens of times a shift; a failed photo must not become a blocker. */
  it('reports a compression failure without attaching anything', async () => {
    const user = userEvent.setup();
    mockCompress.mockRejectedValue(new Error('That file is not an image.'));
    const { container } = render(<MovementPhotoField value={null} onChange={onChange} />);

    await user.upload(container.querySelector('input[type=file]') as HTMLInputElement, file());

    expect(await screen.findByText('That file is not an image.')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  /**
   * No `capture` attribute, deliberately: omitting it makes iOS/Android show the whole native
   * sheet, so a shot already in the camera roll can be attached. `capture="environment"` would
   * force the camera and hide the library, and photos-already-taken is the observed case.
   */
  it('does not force the camera over the photo library', () => {
    const { container } = render(<MovementPhotoField value={null} onChange={onChange} />);
    expect(container.querySelector('input[type=file]')).not.toHaveAttribute('capture');
  });
});
