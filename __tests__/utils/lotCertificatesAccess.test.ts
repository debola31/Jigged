import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the mill-certificate access layer.
 *
 * What these CANNOT prove, and is left to the component tests and a manual pass: that the cert
 * upload happens AFTER the stock RPC (that ordering lives in the calling surfaces), and that RLS
 * actually restricts a delete — `lot_certificates` carries one permissive `FOR ALL` policy, so the
 * UI's delete gate is cosmetic and deliberately so.
 */

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

const { mockGetCurrentMember } = vi.hoisted(() => ({ mockGetCurrentMember: vi.fn() }));
vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: (...a: unknown[]) => mockGetCurrentMember(...a),
}));

import {
  CERT_ACCEPT_ATTR,
  CERT_MAX_BYTES,
  validateLotCertificateFile,
  certificatePreviewKind,
  uploadLotCertificate,
  listLotCertificates,
  listLotCertificatesForLots,
  getLotCertificateUrl,
  deleteLotCertificate,
} from '@/utils/lotCertificatesAccess';

function makeFile(name: string, sizeBytes = 10, type = ''): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: sizeBytes });
  return f;
}

function certRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cert-1',
    company_id: 'c1',
    lot_id: 'lot-1',
    file_path: 'c1/lots/lot-1/abc_MTR.pdf',
    file_name: 'MTR.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    uploaded_at: '2026-09-09T00:00:00Z',
    uploaded_by: 'access-1',
    uploader: { name: 'Dana' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryBuilder.data = null;
  mockQueryBuilder.error = null;
  mockDeleteFileFromStorage.mockResolvedValue(undefined);
  mockUploadFileToStorage.mockResolvedValue(undefined);
  mockGetCurrentMember.mockResolvedValue({ id: 'access-1' });
  mockGenerateStoragePath.mockReturnValue('c1/lots/lot-1/abc_MTR.pdf');
});

describe('validateLotCertificateFile', () => {
  it.each(['MTR.pdf', 'scan.jpg', 'scan.JPEG', 'photo.png', 'IMG_0042.HEIC', 'sheet.tiff'])(
    'accepts %s',
    (name) => {
      expect(validateLotCertificateFile(makeFile(name))).toBeNull();
    },
  );

  it.each(['model.step', 'notes.docx', 'noextension'])('rejects %s naming what is allowed', (name) => {
    expect(validateLotCertificateFile(makeFile(name))).toMatch(/PDF or a photo/i);
  });

  it('rejects an empty file rather than storing a blank cert', () => {
    expect(validateLotCertificateFile(makeFile('MTR.pdf', 0))).toMatch(/empty/i);
  });

  it('rejects a file over the cap, naming the limit', () => {
    expect(validateLotCertificateFile(makeFile('MTR.pdf', CERT_MAX_BYTES + 1))).toMatch(/25 MB/);
  });

  it('builds the accept attribute from the same allowlist it validates against', () => {
    expect(CERT_ACCEPT_ATTR).toContain('.pdf');
    expect(CERT_ACCEPT_ATTR).toContain('.heic');
    expect(CERT_ACCEPT_ATTR).not.toContain('.step');
  });
});

describe('certificatePreviewKind', () => {
  it.each([
    ['MTR.pdf', 'pdf'],
    ['scan.jpg', 'image'],
    ['scan.png', 'image'],
    ['sheet.tiff', 'image'],
    // No browser renders HEIC in an <img>; treating it as an image shows a broken tile, and
    // iPhones produce it by default, so this is the ordinary case rather than an edge one.
    ['IMG_0042.heic', 'download'],
    ['IMG_0042.heif', 'download'],
    ['mystery', 'download'],
  ])('maps %s to %s', (name, expected) => {
    expect(certificatePreviewKind({ file_name: name, mime_type: null })).toBe(expected);
  });
});

describe('uploadLotCertificate', () => {
  it('files the object under the lots prefix and records file_path', async () => {
    mockQueryBuilder.data = certRow();

    const cert = await uploadLotCertificate('c1', 'lot-1', makeFile('MTR.pdf', 1024, 'application/pdf'));

    // Pins the new StorageEntityType literal — the likeliest typo in this feature.
    expect(mockGenerateStoragePath).toHaveBeenCalledWith('c1', 'lots', 'lot-1', 'MTR.pdf');
    expect(mockUploadFileToStorage).toHaveBeenCalledWith('c1/lots/lot-1/abc_MTR.pdf', expect.any(File));

    // `file_path`, NOT `storage_path` — part_attachments uses the other name.
    const inserted = (mockQueryBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inserted).toMatchObject({
      company_id: 'c1',
      lot_id: 'lot-1',
      file_path: 'c1/lots/lot-1/abc_MTR.pdf',
      file_name: 'MTR.pdf',
      uploaded_by: 'access-1',
    });
    expect(inserted).not.toHaveProperty('storage_path');

    expect(cert.uploaded_by_name).toBe('Dana');
  });

  it('rolls the storage object back when the row insert fails', async () => {
    mockQueryBuilder.error = { message: 'nope' };

    await expect(
      uploadLotCertificate('c1', 'lot-1', makeFile('MTR.pdf')),
    ).rejects.toThrow();

    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/lots/lot-1/abc_MTR.pdf');
  });

  it('never uploads when validation fails', async () => {
    await expect(uploadLotCertificate('c1', 'lot-1', makeFile('model.step'))).rejects.toThrow(
      /PDF or a photo/i,
    );
    expect(mockUploadFileToStorage).not.toHaveBeenCalled();
  });

  it('never uploads when the member cannot be identified', async () => {
    mockGetCurrentMember.mockResolvedValue(null);
    await expect(uploadLotCertificate('c1', 'lot-1', makeFile('MTR.pdf'))).rejects.toThrow(
      /identify your account/i,
    );
    expect(mockUploadFileToStorage).not.toHaveBeenCalled();
  });
});

describe('listLotCertificates', () => {
  it('reads one lot newest-first', async () => {
    mockQueryBuilder.data = [certRow()];
    const certs = await listLotCertificates('lot-1');

    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('lot_id', 'lot-1');
    expect(mockQueryBuilder.order).toHaveBeenCalledWith('uploaded_at', { ascending: false });
    expect(certs).toHaveLength(1);
  });

  it('THROWS on error — an empty list here would read as "this lot has no cert"', async () => {
    mockQueryBuilder.error = { message: 'boom' };
    await expect(listLotCertificates('lot-1')).rejects.toBeTruthy();
  });
});

describe('listLotCertificatesForLots', () => {
  it('asks once for the deduped ids and groups by lot', async () => {
    mockQueryBuilder.data = [certRow(), certRow({ id: 'cert-2', lot_id: 'lot-2' })];

    const byLot = await listLotCertificatesForLots(['lot-1', 'lot-2', 'lot-1']);

    expect(mockQueryBuilder.in).toHaveBeenCalledWith('lot_id', ['lot-1', 'lot-2']);
    expect(byLot.get('lot-1')).toHaveLength(1);
    expect(byLot.get('lot-2')).toHaveLength(1);
  });

  it('leaves a lot with no certificates ABSENT from the map', async () => {
    mockQueryBuilder.data = [certRow()];
    const byLot = await listLotCertificatesForLots(['lot-1', 'lot-9']);
    expect(byLot.has('lot-9')).toBe(false);
  });

  it('issues no query for an empty id list', async () => {
    const byLot = await listLotCertificatesForLots([]);
    expect(byLot.size).toBe(0);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('returns an empty map on error instead of throwing — a cert badge must not blank the page', async () => {
    mockQueryBuilder.error = { message: 'boom' };
    await expect(listLotCertificatesForLots(['lot-1'])).resolves.toEqual(new Map());
  });
});

describe('deleteLotCertificate', () => {
  it('removes the row first, then the file', async () => {
    await deleteLotCertificate({ id: 'cert-1', file_path: 'c1/lots/lot-1/abc_MTR.pdf' });

    expect(mockQueryBuilder.delete).toHaveBeenCalled();
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'cert-1');
    expect(mockDeleteFileFromStorage).toHaveBeenCalledWith('c1/lots/lot-1/abc_MTR.pdf');
  });

  it('leaves the file alone when the row delete fails', async () => {
    mockQueryBuilder.error = { message: 'denied' };
    await expect(
      deleteLotCertificate({ id: 'cert-1', file_path: 'c1/lots/lot-1/abc_MTR.pdf' }),
    ).rejects.toThrow();
    expect(mockDeleteFileFromStorage).not.toHaveBeenCalled();
  });
});

describe('getLotCertificateUrl', () => {
  it('asks for a four-hour link, fresh each time', async () => {
    mockGetSignedUrl.mockResolvedValue('https://signed');
    await expect(getLotCertificateUrl('c1/lots/lot-1/abc_MTR.pdf')).resolves.toBe('https://signed');
    expect(mockGetSignedUrl).toHaveBeenCalledWith('c1/lots/lot-1/abc_MTR.pdf', 4 * 60 * 60);
  });
});
