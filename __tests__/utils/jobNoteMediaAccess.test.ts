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
  addNoteMedia,
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

// A machine-subject note has no job to file its photos under, so the folder
// became a caller decision. addJobNoteMedia is now a wrapper over this — the
// block above is what pins that the job path did not move.
describe('addNoteMedia', () => {
  it('files under whatever folder the caller names', async () => {
    mockGenerateStoragePath.mockReturnValue('c1/work-centers/wc1/abc_photo.jpg');
    mockQueryBuilder.data = {
      id: 'media-2',
      note_id: 'n9',
      storage_path: 'c1/work-centers/wc1/abc_photo.jpg',
      thumbnail_path: null,
      kind: 'photo',
      mime_type: 'image/jpeg',
      width: null,
      height: null,
    };

    await addNoteMedia('c1', 'n9', makeFile('photo.jpg', 2048), {
      folder: { entityType: 'work-centers', entityId: 'wc1' },
    });

    expect(mockGenerateStoragePath).toHaveBeenCalledWith('c1', 'work-centers', 'wc1', 'photo.jpg');
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: 'c1',
        note_id: 'n9',
        storage_path: 'c1/work-centers/wc1/abc_photo.jpg',
      }),
    );
  });

  it('still rolls the upload back when the row insert fails', async () => {
    mockGenerateStoragePath.mockReturnValue('c1/work-centers/wc1/abc_photo.jpg');
    mockQueryBuilder.error = { message: 'insert boom' };

    await expect(
      addNoteMedia('c1', 'n9', makeFile('photo.jpg', 2048), {
        folder: { entityType: 'work-centers', entityId: 'wc1' },
      }),
    ).rejects.toThrow(/Failed to attach the photo/);
    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/work-centers/wc1/abc_photo.jpg');
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
