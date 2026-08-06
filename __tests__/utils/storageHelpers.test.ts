import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock crypto.randomUUID
const mockUUID = '12345678-1234-1234-1234-123456789012';
vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => mockUUID),
});

// Use vi.hoisted to define mock storage before vi.mock is called
const { mockStorage, mockSupabase } = vi.hoisted(() => {
  const storage = {
    from: vi.fn().mockReturnThis(),
    upload: vi.fn(),
    remove: vi.fn(),
    createSignedUrl: vi.fn(),
    createSignedUrls: vi.fn(),
    download: vi.fn(),
  };

  const supabase = {
    storage: {
      from: vi.fn().mockImplementation(() => storage),
    },
  };

  return { mockStorage: storage, mockSupabase: supabase };
});

// Mock the supabase module
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

// Import functions after mock setup
import {
  sanitizeFilename,
  generateStoragePath,
  generateTempStoragePath,
  uploadFileToStorage,
  uploadTimeoutMs,
  UploadTimeoutError,
  deleteFileFromStorage,
  getSignedUrl,
  getSignedUrls,
  downloadFileFromStorage,
  moveFileInStorage,
} from '@/utils/storageHelpers';

describe('storageHelpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set environment variable for tests
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_S3_BUCKET', 'test-bucket');
  });

  // ============== sanitizeFilename Tests ==============

  describe('sanitizeFilename', () => {
    it('preserves alphanumeric characters', () => {
      const result = sanitizeFilename('document123.pdf');
      expect(result).toBe('document123.pdf');
    });

    it('preserves dots, dashes, and underscores', () => {
      const result = sanitizeFilename('my-file_name.v2.pdf');
      expect(result).toBe('my-file_name.v2.pdf');
    });

    it('replaces special characters with underscores (collapsed)', () => {
      const result = sanitizeFilename('file@#$%name.pdf');
      // Special chars become underscores, then collapsed to single underscore
      expect(result).toBe('file_name.pdf');
    });

    it('collapses multiple underscores', () => {
      const result = sanitizeFilename('file___name.pdf');
      expect(result).toBe('file_name.pdf');
    });

    it('handles spaces', () => {
      const result = sanitizeFilename('my file name.pdf');
      expect(result).toBe('my_file_name.pdf');
    });

    it('limits length to 100 characters', () => {
      const longName = 'a'.repeat(150) + '.pdf';
      const result = sanitizeFilename(longName);
      expect(result.length).toBe(100);
    });

    it('handles unicode characters', () => {
      const result = sanitizeFilename('документ_2024.pdf');
      // Unicode chars should be replaced with underscores
      expect(result).not.toContain('д');
    });

    it('handles empty filename', () => {
      const result = sanitizeFilename('');
      expect(result).toBe('');
    });

    it('handles filename with only special chars', () => {
      const result = sanitizeFilename('@#$%^&*()');
      expect(result).toBe('_'); // All special chars become underscores, then collapsed
    });
  });

  // ============== generateStoragePath Tests ==============

  describe('generateStoragePath', () => {
    it('generates correct path format for quotes', () => {
      const result = generateStoragePath('company-1', 'quotes', 'quote-1', 'document.pdf');
      expect(result).toMatch(/^company-1\/quotes\/quote-1\/[a-f0-9]{8}_document\.pdf$/);
    });

    it('generates correct path format for jobs', () => {
      const result = generateStoragePath('company-1', 'jobs', 'job-1', 'attachment.pdf');
      expect(result).toMatch(/^company-1\/jobs\/job-1\/[a-f0-9]{8}_attachment\.pdf$/);
    });

    it('generates correct path format for parts', () => {
      const result = generateStoragePath('company-1', 'parts', 'part-1', 'model.step');
      expect(result).toMatch(/^company-1\/parts\/part-1\/[a-f0-9]{8}_model\.step$/);
    });

    it('sanitizes filename in path', () => {
      const result = generateStoragePath('company-1', 'quotes', 'quote-1', 'bad file@name.pdf');
      expect(result).toContain('bad_file_name.pdf');
    });

    it('uses UUID prefix for uniqueness', () => {
      const result = generateStoragePath('company-1', 'quotes', 'quote-1', 'doc.pdf');
      expect(result).toContain('12345678'); // First 8 chars of mocked UUID
    });
  });

  // ============== generateTempStoragePath Tests ==============

  describe('generateTempStoragePath', () => {
    it('generates correct temp path format', () => {
      const result = generateTempStoragePath('company-1', 'session-123', 'upload.pdf');
      expect(result).toMatch(/^company-1\/temp\/session-123\/[a-f0-9]{8}_upload\.pdf$/);
    });

    it('sanitizes filename in temp path', () => {
      const result = generateTempStoragePath('company-1', 'session-123', 'bad file.pdf');
      expect(result).toContain('bad_file.pdf');
    });
  });

  // ============== uploadFileToStorage Tests ==============

  describe('uploadFileToStorage', () => {
    it('uploads file successfully', async () => {
      mockStorage.upload.mockResolvedValue({ data: {}, error: null });
      const mockFile = new File(['test'], 'test.pdf', { type: 'application/pdf' });

      await uploadFileToStorage('path/to/file.pdf', mockFile);

      expect(mockSupabase.storage.from).toHaveBeenCalledWith('test-bucket');
      expect(mockStorage.upload).toHaveBeenCalledWith(
        'path/to/file.pdf',
        mockFile,
        expect.objectContaining({
          cacheControl: '3600',
          upsert: false,
        })
      );
    });

    it('throws error on upload failure', async () => {
      mockStorage.upload.mockResolvedValue({
        data: null,
        error: { message: 'Upload failed' },
      });
      const mockFile = new File(['test'], 'test.pdf', { type: 'application/pdf' });

      await expect(uploadFileToStorage('path/to/file.pdf', mockFile)).rejects.toThrow(
        'Failed to upload file: Upload failed'
      );
    });

    it('works with Blob as well as File', async () => {
      mockStorage.upload.mockResolvedValue({ data: {}, error: null });
      const mockBlob = new Blob(['test content'], { type: 'application/pdf' });

      await uploadFileToStorage('path/to/file.pdf', mockBlob);

      expect(mockStorage.upload).toHaveBeenCalled();
    });
  });

  // ============== Upload deadline (#624) Tests ==============

  describe('uploadTimeoutMs', () => {
    // Pinned rather than recomputed, so a change to the constants has to be a
    // deliberate edit here rather than a silent one. The sizes are the real range
    // this choke point carries.
    it('scales the budget with payload size', () => {
      expect(uploadTimeoutMs(16 * 1024)).toBe(20_274); // the issue's control, observed <5s
      expect(uploadTimeoutMs(1.5 * 1024 * 1024)).toBe(46_215); // compressed operator photo
      expect(uploadTimeoutMs(25 * 1024 * 1024)).toBe(456_907); // job / part attachment PDF
    });

    it('caps the budget so no single request can pin a tab indefinitely', () => {
      expect(uploadTimeoutMs(100 * 1024 * 1024)).toBe(900_000); // 100MB part model
      expect(uploadTimeoutMs(5 * 1024 * 1024 * 1024)).toBe(900_000);
    });
  });

  describe('uploadFileToStorage deadline', () => {
    // #624: a stalled upload used to hang forever — no timeout, no error, no way
    // out — and the composer sat on "Saving…" until the tab was killed.
    it('rejects an upload that never settles once its budget elapses', async () => {
      vi.useFakeTimers();
      try {
        mockStorage.upload.mockReturnValue(new Promise(() => {}));
        const photo = new File([new Uint8Array(1024)], 'photo.jpg', { type: 'image/jpeg' });

        const pending = uploadFileToStorage('a/b/photo.jpg', photo);
        const assertion = expect(pending).rejects.toBeInstanceOf(UploadTimeoutError);

        await vi.advanceTimersByTimeAsync(uploadTimeoutMs(photo.size) + 1);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('says the upload timed out rather than that the server refused it', async () => {
      vi.useFakeTimers();
      try {
        mockStorage.upload.mockReturnValue(new Promise(() => {}));
        const photo = new File([new Uint8Array(1024)], 'photo.jpg', { type: 'image/jpeg' });

        const pending = uploadFileToStorage('a/b/photo.jpg', photo);
        const assertion = expect(pending).rejects.toThrow(/timed out — check your connection/);

        await vi.advanceTimersByTimeAsync(uploadTimeoutMs(photo.size) + 1);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves no timer armed when the upload lands inside its budget', async () => {
      vi.useFakeTimers();
      try {
        mockStorage.upload.mockResolvedValue({ data: {}, error: null });
        const photo = new File([new Uint8Array(1024)], 'photo.jpg', { type: 'image/jpeg' });

        await uploadFileToStorage('a/b/photo.jpg', photo);

        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ============== deleteFileFromStorage Tests ==============

  describe('deleteFileFromStorage', () => {
    it('deletes file successfully', async () => {
      mockStorage.remove.mockResolvedValue({ data: {}, error: null });

      await deleteFileFromStorage('path/to/file.pdf');

      expect(mockSupabase.storage.from).toHaveBeenCalledWith('test-bucket');
      expect(mockStorage.remove).toHaveBeenCalledWith(['path/to/file.pdf']);
    });

    it('throws error on delete failure', async () => {
      mockStorage.remove.mockResolvedValue({
        data: null,
        error: { message: 'Delete failed' },
      });

      await expect(deleteFileFromStorage('path/to/file.pdf')).rejects.toThrow(
        'Failed to delete file: Delete failed'
      );
    });
  });

  // ============== getSignedUrl Tests ==============

  describe('getSignedUrl', () => {
    it('returns signed URL successfully', async () => {
      mockStorage.createSignedUrl.mockResolvedValue({
        data: { signedUrl: 'https://signed-url.example.com/file.pdf' },
        error: null,
      });

      const result = await getSignedUrl('path/to/file.pdf');

      expect(mockSupabase.storage.from).toHaveBeenCalledWith('test-bucket');
      expect(mockStorage.createSignedUrl).toHaveBeenCalledWith('path/to/file.pdf', 3600);
      expect(result).toBe('https://signed-url.example.com/file.pdf');
    });

    it('uses custom expiry time', async () => {
      mockStorage.createSignedUrl.mockResolvedValue({
        data: { signedUrl: 'https://signed-url.example.com/file.pdf' },
        error: null,
      });

      await getSignedUrl('path/to/file.pdf', 7200);

      expect(mockStorage.createSignedUrl).toHaveBeenCalledWith('path/to/file.pdf', 7200);
    });

    it('throws error when URL creation fails', async () => {
      mockStorage.createSignedUrl.mockResolvedValue({
        data: null,
        error: { message: 'URL creation failed' },
      });

      await expect(getSignedUrl('path/to/file.pdf')).rejects.toThrow(
        'Failed to generate download link'
      );
    });
  });

  // ============== downloadFileFromStorage Tests ==============

  describe('downloadFileFromStorage', () => {
    it('downloads file successfully', async () => {
      const mockBlob = new Blob(['file content'], { type: 'application/pdf' });
      mockStorage.download.mockResolvedValue({
        data: mockBlob,
        error: null,
      });

      const result = await downloadFileFromStorage('path/to/file.pdf');

      expect(mockSupabase.storage.from).toHaveBeenCalledWith('test-bucket');
      expect(mockStorage.download).toHaveBeenCalledWith('path/to/file.pdf');
      expect(result).toBe(mockBlob);
    });

    it('throws error on download failure', async () => {
      mockStorage.download.mockResolvedValue({
        data: null,
        error: { message: 'Download failed' },
      });

      await expect(downloadFileFromStorage('path/to/file.pdf')).rejects.toThrow(
        'Failed to download file: Download failed'
      );
    });
  });

  // ============== moveFileInStorage Tests ==============

  describe('moveFileInStorage', () => {
    it('moves file successfully (download, upload, delete)', async () => {
      const mockBlob = new Blob(['file content'], { type: 'application/pdf' });
      mockStorage.download.mockResolvedValue({ data: mockBlob, error: null });
      mockStorage.upload.mockResolvedValue({ data: {}, error: null });
      mockStorage.remove.mockResolvedValue({ data: {}, error: null });

      await moveFileInStorage('old/path.pdf', 'new/path.pdf');

      // Should download first
      expect(mockStorage.download).toHaveBeenCalledWith('old/path.pdf');
      // Then upload to new location
      expect(mockStorage.upload).toHaveBeenCalledWith(
        'new/path.pdf',
        mockBlob,
        expect.any(Object)
      );
      // Then delete old file
      expect(mockStorage.remove).toHaveBeenCalledWith(['old/path.pdf']);
    });

    it('throws error if download fails', async () => {
      mockStorage.download.mockResolvedValue({
        data: null,
        error: { message: 'Download failed' },
      });

      await expect(moveFileInStorage('old/path.pdf', 'new/path.pdf')).rejects.toThrow(
        'Failed to download file'
      );
    });

    it('throws error if upload fails', async () => {
      const mockBlob = new Blob(['file content']);
      mockStorage.download.mockResolvedValue({ data: mockBlob, error: null });
      mockStorage.upload.mockResolvedValue({
        data: null,
        error: { message: 'Upload failed' },
      });

      await expect(moveFileInStorage('old/path.pdf', 'new/path.pdf')).rejects.toThrow(
        'Failed to upload file'
      );
    });

    it('continues even if delete of old file fails', async () => {
      const mockBlob = new Blob(['file content']);
      mockStorage.download.mockResolvedValue({ data: mockBlob, error: null });
      mockStorage.upload.mockResolvedValue({ data: {}, error: null });
      mockStorage.remove.mockResolvedValue({
        data: null,
        error: { message: 'Delete failed' },
      });

      // Should not throw - delete failure is caught
      await expect(moveFileInStorage('old/path.pdf', 'new/path.pdf')).resolves.toBeUndefined();
    });
  });

  // ============== Environment Variable Tests ==============

  describe('environment variable handling', () => {
    it('throws error when bucket env var is not set', async () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_S3_BUCKET', '');
      vi.stubEnv('SUPABASE_S3_BUCKET', '');

      mockStorage.upload.mockResolvedValue({ data: {}, error: null });
      const mockFile = new File(['test'], 'test.pdf');

      await expect(uploadFileToStorage('path/to/file.pdf', mockFile)).rejects.toThrow(
        'SUPABASE_S3_BUCKET environment variable is not set'
      );

      // Reset env for other tests
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_S3_BUCKET', 'test-bucket');
    });

    it('uses SUPABASE_S3_BUCKET as fallback', async () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_S3_BUCKET', '');
      vi.stubEnv('SUPABASE_S3_BUCKET', 'fallback-bucket');

      mockStorage.upload.mockResolvedValue({ data: {}, error: null });
      const mockFile = new File(['test'], 'test.pdf');

      await uploadFileToStorage('path/to/file.pdf', mockFile);

      expect(mockSupabase.storage.from).toHaveBeenCalledWith('fallback-bucket');

      // Reset env for other tests
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_S3_BUCKET', 'test-bucket');
    });
  });
});

/**
 * Batched signed URLs.
 *
 * The bucket is private, so every private image on a page needs a signed URL. Without a batch
 * helper a grid pays one round trip per tile — `NoteMediaGallery` works around the gap with
 * `Promise.all` over singles, and the storage board would have done the same for 22 locations.
 */
describe('getSignedUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_S3_BUCKET', 'test-bucket');
  });

  it('asks for every path in ONE request', async () => {
    mockStorage.createSignedUrls.mockResolvedValue({
      data: [
        { path: 'co1/locations/a/x.jpg', signedUrl: 'https://s/a', error: null },
        { path: 'co1/locations/b/y.jpg', signedUrl: 'https://s/b', error: null },
      ],
      error: null,
    });

    const urls = await getSignedUrls(['co1/locations/a/x.jpg', 'co1/locations/b/y.jpg'], 900);

    expect(mockStorage.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(mockStorage.createSignedUrls).toHaveBeenCalledWith(
      ['co1/locations/a/x.jpg', 'co1/locations/b/y.jpg'],
      900,
    );
    expect(urls.get('co1/locations/a/x.jpg')).toBe('https://s/a');
    expect(urls.size).toBe(2);
  });

  it('makes no request at all for an empty list', async () => {
    expect((await getSignedUrls([])).size).toBe(0);
    expect(mockStorage.createSignedUrls).not.toHaveBeenCalled();
  });

  /** One unreadable photo must not blank a whole board, so failures are absent rather than thrown. */
  it('omits the paths that failed and keeps the rest', async () => {
    mockStorage.createSignedUrls.mockResolvedValue({
      data: [
        { path: 'good.jpg', signedUrl: 'https://s/good', error: null },
        { path: 'gone.jpg', signedUrl: null, error: 'Object not found' },
      ],
      error: null,
    });

    const urls = await getSignedUrls(['good.jpg', 'gone.jpg']);
    expect(urls.get('good.jpg')).toBe('https://s/good');
    expect(urls.has('gone.jpg')).toBe(false);
  });

  it('returns an empty map rather than throwing when the whole call fails', async () => {
    mockStorage.createSignedUrls.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect((await getSignedUrls(['a.jpg'])).size).toBe(0);
  });
});
