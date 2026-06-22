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
  // storageHelpers.ts adopted getTypedSupabase under the typed-client rollout.
  getTypedSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

// Import functions after mock setup
import {
  sanitizeFilename,
  generateStoragePath,
  generateTempStoragePath,
  uploadFileToStorage,
  deleteFileFromStorage,
  getSignedUrl,
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
