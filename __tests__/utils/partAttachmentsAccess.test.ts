import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Chainable Supabase mock (same shape as partsAccess.test.ts) ---
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

// --- Storage helpers are mocked: we assert the access layer calls them right ---
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

const { mockGetCurrentOperator } = vi.hoisted(() => ({ mockGetCurrentOperator: vi.fn() }));
vi.mock('@/utils/operatorAccess', () => ({
  getCurrentOperator: (...a: unknown[]) => mockGetCurrentOperator(...a),
}));

import {
  validatePartAttachmentFile,
  detectAttachmentKind,
  uploadPartAttachment,
  listPartAttachments,
  getPartAttachmentUrl,
  deletePartAttachment,
  getStoredPartAttachmentPaths,
  deleteStoredFilesByPaths,
} from '@/utils/partAttachmentsAccess';

function makeFile(name: string, sizeBytes = 10, type = ''): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: sizeBytes });
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryBuilder.data = null;
  mockQueryBuilder.error = null;
  // Storage helpers return promises; default them so `.catch(...)` is always safe.
  mockDeleteFileFromStorage.mockResolvedValue(undefined);
  mockUploadFileToStorage.mockResolvedValue(undefined);
});

describe('detectAttachmentKind', () => {
  it.each([
    ['drawing.pdf', 'pdf'],
    ['model.step', 'step'],
    ['model.stp', 'step'],
    ['legacy.dwg', 'dwg'],
    ['model.iges', 'other'],
    ['noextension', 'other'],
  ])('maps %s → %s', (name, kind) => {
    expect(detectAttachmentKind(name)).toBe(kind);
  });

  it('is case-insensitive on the extension', () => {
    expect(detectAttachmentKind('MODEL.STEP')).toBe('step');
    expect(detectAttachmentKind('Drawing.PDF')).toBe('pdf');
  });
});

describe('validatePartAttachmentFile', () => {
  it.each(['a.pdf', 'a.step', 'a.stp', 'a.dwg'])('accepts %s under its cap', (name) => {
    expect(validatePartAttachmentFile(makeFile(name, 1024))).toBeNull();
  });

  it('rejects a disallowed extension', () => {
    expect(validatePartAttachmentFile(makeFile('photo.png', 1024))).toMatch(/PDF, STEP/);
  });

  it('rejects a PDF over the 25 MB cap', () => {
    expect(validatePartAttachmentFile(makeFile('big.pdf', 26 * 1024 * 1024))).toMatch(/25 MB/);
  });

  it('rejects a STEP over the 100 MB cap', () => {
    expect(validatePartAttachmentFile(makeFile('huge.step', 101 * 1024 * 1024))).toMatch(/100 MB/);
  });

  it('allows a STEP up to 100 MB (above the PDF cap)', () => {
    expect(validatePartAttachmentFile(makeFile('mid.step', 50 * 1024 * 1024))).toBeNull();
  });
});

describe('uploadPartAttachment', () => {
  const row = {
    id: 'att-1',
    company_id: 'c1',
    part_id: 'p1',
    storage_path: 'c1/parts/p1/abc_model.step',
    file_name: 'model.step',
    kind: 'step',
    mime_type: null,
    size_bytes: 2048,
    uploaded_by: 'access-1',
    created_at: '2026-06-22T00:00:00Z',
    uploader: { name: 'Jane' },
  };

  beforeEach(() => {
    mockGetCurrentOperator.mockResolvedValue({ id: 'access-1', name: 'Jane', user_id: 'u1' });
    mockGenerateStoragePath.mockReturnValue('c1/parts/p1/abc_model.step');
    mockUploadFileToStorage.mockResolvedValue(undefined);
  });

  it('uploads, inserts the computed kind + operator uploaded_by, and returns the mapped row', async () => {
    mockQueryBuilder.data = row;
    const result = await uploadPartAttachment('c1', 'p1', makeFile('model.step', 2048));

    expect(mockGetCurrentOperator).toHaveBeenCalledWith('c1');
    expect(mockGenerateStoragePath).toHaveBeenCalledWith('c1', 'parts', 'p1', 'model.step');
    expect(mockUploadFileToStorage).toHaveBeenCalledWith(
      'c1/parts/p1/abc_model.step',
      expect.any(File),
    );
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: 'c1',
        part_id: 'p1',
        storage_path: 'c1/parts/p1/abc_model.step',
        file_name: 'model.step',
        kind: 'step',
        uploaded_by: 'access-1',
      }),
    );
    expect(result.uploaded_by_name).toBe('Jane');
    expect(result.kind).toBe('step');
  });

  it('rolls back the uploaded file if the row insert fails', async () => {
    mockQueryBuilder.error = { message: 'insert boom' };
    await expect(uploadPartAttachment('c1', 'p1', makeFile('model.step', 2048))).rejects.toThrow(
      /Failed to attach/,
    );
    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/parts/p1/abc_model.step');
  });

  it('throws (and never uploads) when the file is invalid', async () => {
    await expect(uploadPartAttachment('c1', 'p1', makeFile('photo.png', 10))).rejects.toThrow(
      /PDF, STEP/,
    );
    expect(mockUploadFileToStorage).not.toHaveBeenCalled();
  });

  it('throws (and never uploads) when the operator cannot be identified', async () => {
    mockGetCurrentOperator.mockResolvedValue(null);
    await expect(uploadPartAttachment('c1', 'p1', makeFile('model.step', 10))).rejects.toThrow(
      /identify your account/,
    );
    expect(mockUploadFileToStorage).not.toHaveBeenCalled();
  });
});

describe('listPartAttachments', () => {
  it('orders newest-first and flattens the uploader name', async () => {
    mockQueryBuilder.data = [
      { id: 'a', uploader: { name: 'Jane' }, file_name: 'a.pdf' },
      { id: 'b', uploader: null, file_name: 'b.dwg' },
    ];
    const result = await listPartAttachments('p1');

    expect(mockSupabase.from).toHaveBeenCalledWith('part_attachments');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('part_id', 'p1');
    expect(mockQueryBuilder.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(result[0].uploaded_by_name).toBe('Jane');
    expect(result[1].uploaded_by_name).toBeNull();
  });
});

describe('getPartAttachmentUrl', () => {
  it('requests a signed URL with the longer attachment expiry', async () => {
    mockGetSignedUrl.mockResolvedValue('https://signed/x');
    const url = await getPartAttachmentUrl('c1/parts/p1/x.pdf');
    expect(mockGetSignedUrl).toHaveBeenCalledWith('c1/parts/p1/x.pdf', 4 * 60 * 60);
    expect(url).toBe('https://signed/x');
  });
});

describe('deletePartAttachment', () => {
  it('deletes the row first, then the file (row-first)', async () => {
    await deletePartAttachment({ id: 'att-1', storage_path: 'c1/parts/p1/x.pdf' });
    expect(mockSupabase.from).toHaveBeenCalledWith('part_attachments');
    expect(mockQueryBuilder.delete).toHaveBeenCalled();
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'att-1');
    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/parts/p1/x.pdf');
  });

  it('throws and does NOT delete the file when the row delete fails', async () => {
    mockQueryBuilder.error = { message: 'rls denied' };
    await expect(
      deletePartAttachment({ id: 'att-1', storage_path: 'c1/parts/p1/x.pdf' }),
    ).rejects.toBeTruthy();
    expect(mockDeleteFileFromStorage).not.toHaveBeenCalled();
  });
});

describe('getStoredPartAttachmentPaths', () => {
  it('returns the storage paths for the given parts', async () => {
    mockQueryBuilder.data = [{ storage_path: 'p/1' }, { storage_path: 'p/2' }];
    const paths = await getStoredPartAttachmentPaths(['p1']);
    expect(mockQueryBuilder.in).toHaveBeenCalledWith('part_id', ['p1']);
    expect(paths).toEqual(['p/1', 'p/2']);
  });

  it('returns [] without querying when given no part ids', async () => {
    const paths = await getStoredPartAttachmentPaths([]);
    expect(paths).toEqual([]);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('returns [] (best-effort) when the query errors', async () => {
    mockQueryBuilder.error = { message: 'boom' };
    expect(await getStoredPartAttachmentPaths(['p1'])).toEqual([]);
  });
});

describe('deleteStoredFilesByPaths', () => {
  it('removes each file and swallows individual failures', async () => {
    mockDeleteFileFromStorage
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValueOnce(undefined);
    await expect(deleteStoredFilesByPaths(['p/1', 'p/2'])).resolves.toBeUndefined();
    expect(mockDeleteFileFromStorage).toHaveBeenCalledTimes(2);
  });
});
