import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChangeEvent } from 'react';

/**
 * The composer's write order (#624).
 *
 * The bug this suite exists for: `submit()` used to create the note row first and
 * upload into it afterwards. Uploading is the slow half, so a shop-floor phone on
 * dropping wifi stalled with the note already committed — leaving a note that
 * claimed to be saved without the photo it was taken for, and nothing saying so.
 *
 * Every assertion here is about ORDER. Photos go up first; nothing is committed
 * until they are all there; a failure leaves the operator exactly what they had.
 */

vi.mock('@/utils/operatorAccess', () => ({ addJobNote: vi.fn() }));
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  uploadJobNoteMediaFile: vi.fn(),
  insertNoteMedia: vi.fn(),
  discardNoteMediaUploads: vi.fn(async () => undefined),
}));
vi.mock('@/utils/imageCompression', () => ({
  compressPhoto: vi.fn(async (f: File) => ({ file: f, dims: { width: 10, height: 10 } })),
}));
vi.mock('@/utils/operatorEventsAccess', () => ({ logOperatorEvent: vi.fn() }));

import { useNoteCapture, type NoteWriter, type UploadedPhoto } from '@/hooks/useNoteCapture';
import { discardNoteMediaUploads } from '@/utils/jobNoteMediaAccess';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';

type TestNote = { id: string; body: string | null; media?: unknown[] };

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

/** Records the order calls arrive in, which is the whole point of the suite. */
function makeWriter(overrides: Partial<NoteWriter<TestNote>> = {}) {
  const calls: string[] = [];
  const writer: NoteWriter<TestNote> = {
    createNote: vi.fn(async (body: string | null) => {
      calls.push('createNote');
      return { id: 'note-1', body };
    }),
    uploadMedia: vi.fn(async (file: File) => {
      calls.push(`uploadMedia:${file.name}`);
      return `company/jobs/job-1/abcd_${file.name}`;
    }),
    linkMedia: vi.fn(async (_note: TestNote, upload: UploadedPhoto) => {
      calls.push('linkMedia');
      return { id: `media-${upload.file.name}` } as never;
    }),
    withMedia: (note, media) => ({ ...note, media }),
    ...overrides,
  };
  return { writer, calls };
}

function renderCapture(writer: NoteWriter<TestNote>) {
  return renderHook(() =>
    useNoteCapture<TestNote>({
      companyId: 'company-1',
      operatorId: 'operator-1',
      writer,
      enabled: true,
    }),
  );
}

/** Drive `pickPhotos` the way the hidden file input does. */
function photoPick(...names: string[]) {
  const files = names.map((n) => new File([new Uint8Array(8)], n, { type: 'image/jpeg' }));
  return { target: { files, value: '' } } as unknown as ChangeEvent<HTMLInputElement>;
}

describe('useNoteCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads every photo BEFORE it creates the note', async () => {
    const { writer, calls } = makeWriter();
    const { result } = renderCapture(writer);

    await act(async () => {
      await result.current.pickPhotos(photoPick('a.jpg', 'b.jpg'));
    });
    act(() => result.current.setDraft('coolant low'));
    await act(async () => {
      await result.current.submit();
    });

    expect(calls).toEqual([
      'uploadMedia:a.jpg',
      'uploadMedia:b.jpg',
      'createNote',
      'linkMedia',
      'linkMedia',
    ]);
  });

  it('never creates the note when a photo upload fails', async () => {
    // THE HEADLINE INVARIANT. Before the fix this left a committed, photo-less note.
    const { writer } = makeWriter({
      uploadMedia: vi.fn().mockRejectedValue(new Error('Network request failed')),
    });
    const { result } = renderCapture(writer);

    await act(async () => {
      await result.current.pickPhotos(photoPick('a.jpg'));
    });
    act(() => result.current.setDraft('spindle noise'));
    await act(async () => {
      await expect(result.current.submit()).rejects.toThrow();
    });

    expect(writer.createNote).not.toHaveBeenCalled();
    expect(writer.linkMedia).not.toHaveBeenCalled();
  });

  it('leaves the draft and the photo staged so a retry is clean', async () => {
    const { writer } = makeWriter({
      uploadMedia: vi.fn().mockRejectedValue(new Error('Network request failed')),
    });
    const { result } = renderCapture(writer);

    await act(async () => {
      await result.current.pickPhotos(photoPick('a.jpg'));
    });
    act(() => result.current.setDraft('spindle noise'));
    await act(async () => {
      await expect(result.current.submit()).rejects.toThrow();
    });

    expect(result.current.draft).toBe('spindle noise');
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.hasContent).toBe(true);
    expect(result.current.error).toBeTruthy();
    expect(result.current.saving).toBe(false);
  });

  it('records no save in the funnel when the upload fails', async () => {
    const { writer } = makeWriter({
      uploadMedia: vi.fn().mockRejectedValue(new Error('Network request failed')),
    });
    const { result } = renderCapture(writer);

    await act(async () => {
      await result.current.pickPhotos(photoPick('a.jpg'));
    });
    await act(async () => {
      await expect(result.current.submit()).rejects.toThrow();
    });

    const kinds = mock(logOperatorEvent).mock.calls.map((c) => c[1]);
    expect(kinds).not.toContain('note_saved');
    expect(kinds).not.toContain('note_saved_with_photo');
  });

  it('sweeps photos already in the bucket when the note write fails', async () => {
    // Uploading first moves the orphan risk here, so it has to be cleaned up.
    const { writer } = makeWriter({
      createNote: vi.fn().mockRejectedValue(new Error('insert failed')),
    });
    const { result } = renderCapture(writer);

    await act(async () => {
      await result.current.pickPhotos(photoPick('a.jpg', 'b.jpg'));
    });
    await act(async () => {
      await expect(result.current.submit()).rejects.toThrow();
    });

    expect(discardNoteMediaUploads).toHaveBeenCalledWith([
      'company/jobs/job-1/abcd_a.jpg',
      'company/jobs/job-1/abcd_b.jpg',
    ]);
  });

  it('sweeps the photos that did land when a later one fails mid-loop', async () => {
    const uploadMedia = vi
      .fn()
      .mockResolvedValueOnce('company/jobs/job-1/abcd_a.jpg')
      .mockRejectedValueOnce(new Error('Network request failed'));
    const { writer } = makeWriter({ uploadMedia });
    const { result } = renderCapture(writer);

    await act(async () => {
      await result.current.pickPhotos(photoPick('a.jpg', 'b.jpg'));
    });
    await act(async () => {
      await expect(result.current.submit()).rejects.toThrow();
    });

    expect(discardNoteMediaUploads).toHaveBeenCalledWith(['company/jobs/job-1/abcd_a.jpg']);
    expect(writer.createNote).not.toHaveBeenCalled();
  });

  it('clears the composer and records the save once everything lands', async () => {
    const { writer } = makeWriter();
    const { result } = renderCapture(writer);

    await act(async () => {
      await result.current.pickPhotos(photoPick('a.jpg'));
    });
    act(() => result.current.setDraft('replaced the filter'));

    let saved: TestNote | null = null;
    await act(async () => {
      saved = await result.current.submit();
    });

    expect(saved).toMatchObject({ id: 'note-1', body: 'replaced the filter' });
    expect(result.current.draft).toBe('');
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.error).toBeNull();
    expect(logOperatorEvent).toHaveBeenCalledWith(
      'company-1',
      'note_saved_with_photo',
      expect.objectContaining({ photoCount: 1, bodyLength: 'replaced the filter'.length }),
    );
  });

  it('writes a text-only note without touching storage', async () => {
    const { writer, calls } = makeWriter();
    const { result } = renderCapture(writer);

    act(() => result.current.setDraft('just a note'));
    await act(async () => {
      await result.current.submit();
    });

    expect(calls).toEqual(['createNote']);
    expect(logOperatorEvent).toHaveBeenCalledWith(
      'company-1',
      'note_saved',
      expect.objectContaining({ photoCount: 0 }),
    );
  });
});
