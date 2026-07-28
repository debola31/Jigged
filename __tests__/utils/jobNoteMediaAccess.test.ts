import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Chainable Supabase mock (same shape as partAttachmentsAccess.test.ts) ---
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = ['from', 'select', 'insert', 'delete', 'eq', 'in', 'order', 'single'];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = null;
  builder.error = null;
  return {
    mockQueryBuilder: builder,
    mockSupabase: { from: vi.fn().mockImplementation(() => builder) },
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));

const {
  mockGenerateStoragePath,
  mockUploadFileToStorage,
  mockDeleteFileFromStorage,
  mockGetSignedUrl,
} = vi.hoisted(() => ({
  mockGenerateStoragePath: vi.fn(),
  mockUploadFileToStorage: vi.fn(),
  mockDeleteFileFromStorage: vi.fn(),
  mockGetSignedUrl: vi.fn(),
}));

vi.mock('@/utils/storageHelpers', () => ({
  generateStoragePath: (...a: unknown[]) => mockGenerateStoragePath(...a),
  uploadFileToStorage: (...a: unknown[]) => mockUploadFileToStorage(...a),
  deleteFileFromStorage: (...a: unknown[]) => mockDeleteFileFromStorage(...a),
  getSignedUrl: (...a: unknown[]) => mockGetSignedUrl(...a),
}));

import {
  addJobNoteMedia,
  getJobNoteMediaUrl,
  deleteJobNoteMedia,
  deleteJobNote,
} from '@/utils/jobNoteMediaAccess';

function makeFile(name: string, sizeBytes = 10, type = 'image/jpeg'): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: sizeBytes });
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryBuilder.data = null;
  mockQueryBuilder.error = null;
  mockDeleteFileFromStorage.mockResolvedValue(undefined);
  mockUploadFileToStorage.mockResolvedValue(undefined);
});

describe('addJobNoteMedia', () => {
  const row = {
    id: 'media-1',
    note_id: 'n1',
    storage_path: 'c1/jobs/j1/abc_photo.jpg',
    thumbnail_path: null,
    kind: 'photo',
    mime_type: 'image/jpeg',
    width: 1600,
    height: 1200,
  };

  beforeEach(() => {
    mockGenerateStoragePath.mockReturnValue('c1/jobs/j1/abc_photo.jpg');
  });

  it('uploads under the job folder, inserts photo metadata, returns the mapped row', async () => {
    mockQueryBuilder.data = row;
    const result = await addJobNoteMedia('c1', 'j1', 'n1', makeFile('photo.jpg', 2048), {
      dims: { width: 1600, height: 1200 },
    });

    expect(mockGenerateStoragePath).toHaveBeenCalledWith('c1', 'jobs', 'j1', 'photo.jpg');
    expect(mockUploadFileToStorage).toHaveBeenCalledWith(
      'c1/jobs/j1/abc_photo.jpg',
      expect.any(File),
    );
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: 'c1',
        note_id: 'n1',
        storage_path: 'c1/jobs/j1/abc_photo.jpg',
        kind: 'photo',
        mime_type: 'image/jpeg',
        width: 1600,
        height: 1200,
      }),
    );
    expect(result.kind).toBe('photo');
    expect(result.id).toBe('media-1');
  });

  it('rolls back the uploaded file when the row insert fails', async () => {
    mockQueryBuilder.error = { message: 'insert boom' };
    await expect(
      addJobNoteMedia('c1', 'j1', 'n1', makeFile('photo.jpg', 2048)),
    ).rejects.toThrow(/Failed to attach the photo/);
    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/jobs/j1/abc_photo.jpg');
  });

  it('passes null dimensions when none are supplied', async () => {
    mockQueryBuilder.data = row;
    await addJobNoteMedia('c1', 'j1', 'n1', makeFile('photo.jpg', 2048));
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ width: null, height: null }),
    );
  });
});

describe('getJobNoteMediaUrl', () => {
  it('requests a signed URL with the 4-hour media expiry', async () => {
    mockGetSignedUrl.mockResolvedValue('https://signed/x');
    const url = await getJobNoteMediaUrl('c1/jobs/j1/x.jpg');
    expect(mockGetSignedUrl).toHaveBeenCalledWith('c1/jobs/j1/x.jpg', 4 * 60 * 60);
    expect(url).toBe('https://signed/x');
  });
});

describe('deleteJobNoteMedia', () => {
  it('deletes the row first, then the file (row-first)', async () => {
    await deleteJobNoteMedia({ id: 'media-1', storage_path: 'c1/jobs/j1/x.jpg' });
    expect(mockSupabase.from).toHaveBeenCalledWith('note_media');
    expect(mockQueryBuilder.delete).toHaveBeenCalled();
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'media-1');
    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/jobs/j1/x.jpg');
  });

  it('throws and does NOT delete the file when the row delete fails', async () => {
    mockQueryBuilder.error = { message: 'rls denied' };
    await expect(
      deleteJobNoteMedia({ id: 'media-1', storage_path: 'c1/jobs/j1/x.jpg' }),
    ).rejects.toBeTruthy();
    expect(mockDeleteFileFromStorage).not.toHaveBeenCalled();
  });
});

describe('deleteJobNote', () => {
  it('reads media paths, deletes the note, then removes the orphaned files', async () => {
    mockQueryBuilder.data = [
      { storage_path: 'c1/jobs/j1/a.jpg' },
      { storage_path: 'c1/jobs/j1/b.jpg' },
    ];
    await deleteJobNote('n1');

    expect(mockSupabase.from).toHaveBeenCalledWith('note_media');
    expect(mockSupabase.from).toHaveBeenCalledWith('notes');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('note_id', 'n1');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'n1');
    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/jobs/j1/a.jpg');
    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/jobs/j1/b.jpg');
  });

  it('throws when the note row delete fails', async () => {
    // No media rows; the note delete reports an error.
    mockQueryBuilder.data = [];
    mockQueryBuilder.error = { message: 'rls denied' };
    await expect(deleteJobNote('n1')).rejects.toBeTruthy();
  });
});

// thumbnail_path was never written, so every renderer fell back to storage_path —
// a full 2048px JPEG behind a 76px tile. On shop wifi those tiles resolve slowly
// or not at all, which is indistinguishable from a photo that failed to upload.
describe('addJobNoteMedia — thumbnails', () => {
  const rowWithThumb = {
    id: 'media-1',
    note_id: 'n1',
    storage_path: 'c1/jobs/j1/abc_photo.jpg',
    thumbnail_path: 'c1/jobs/j1/def_thumb-photo.jpg',
    kind: 'photo',
    mime_type: 'image/jpeg',
    width: 1600,
    height: 1200,
  };

  it('uploads the thumbnail too and records its path', async () => {
    mockQueryBuilder.data = rowWithThumb;
    mockGenerateStoragePath
      .mockReturnValueOnce('c1/jobs/j1/abc_photo.jpg')
      .mockReturnValueOnce('c1/jobs/j1/def_thumb-photo.jpg');

    const result = await addJobNoteMedia('c1', 'j1', 'n1', makeFile('photo.jpg', 2048), {
      thumbnail: makeFile('thumb-photo.jpg', 40),
    });

    expect(mockUploadFileToStorage).toHaveBeenCalledTimes(2);
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ thumbnail_path: 'c1/jobs/j1/def_thumb-photo.jpg' }),
    );
    expect(result.thumbnail_path).toBe('c1/jobs/j1/def_thumb-photo.jpg');
  });

  it('still stores the photo when the thumbnail upload fails', async () => {
    // A thumbnail is an optimisation. Losing one must never cost the operator the
    // photo — the row falls back to a null thumbnail_path, today's behaviour.
    mockQueryBuilder.data = { ...rowWithThumb, thumbnail_path: null };
    mockGenerateStoragePath
      .mockReturnValueOnce('c1/jobs/j1/abc_photo.jpg')
      .mockReturnValueOnce('c1/jobs/j1/def_thumb-photo.jpg');
    mockUploadFileToStorage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('thumb upload failed'));

    const result = await addJobNoteMedia('c1', 'j1', 'n1', makeFile('photo.jpg', 2048), {
      thumbnail: makeFile('thumb-photo.jpg', 40),
    });

    expect(result.id).toBe('media-1');
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ thumbnail_path: null }),
    );
  });

  it('rolls back BOTH objects when the metadata insert fails', async () => {
    // Otherwise a failed attach leaks an orphaned thumbnail as well as the photo.
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = { message: 'insert boom' };
    mockGenerateStoragePath
      .mockReturnValueOnce('c1/jobs/j1/abc_photo.jpg')
      .mockReturnValueOnce('c1/jobs/j1/def_thumb-photo.jpg');

    await expect(
      addJobNoteMedia('c1', 'j1', 'n1', makeFile('photo.jpg', 2048), {
        thumbnail: makeFile('thumb-photo.jpg', 40),
      }),
    ).rejects.toThrow(/Failed to attach/i);

    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/jobs/j1/abc_photo.jpg');
    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/jobs/j1/def_thumb-photo.jpg');
  });
});
