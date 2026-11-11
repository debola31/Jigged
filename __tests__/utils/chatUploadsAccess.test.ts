import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readChatUpload, uploadChatFiles, type PreparedChatUpload } from '@/utils/chatUploadsAccess';
import { deleteFileFromStorage, downloadFileFromStorage, uploadFileToStorage } from '@/utils/storageHelpers';

vi.mock('@/utils/storageHelpers', () => ({
  deleteFileFromStorage: vi.fn(), downloadFileFromStorage: vi.fn(), uploadFileToStorage: vi.fn(),
  sanitizeFilename: (value: string) => value,
}));
const CO = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const UPLOAD = '33333333-3333-3333-3333-333333333333';
const PATH = `${CO}/chat/${THREAD}/${UPLOAD}/manifest.json`;
const file = new File(['engineering source'], 'P100.dxf');
const prepared: PreparedChatUpload = {
  id: UPLOAD, name: 'parts.zip',
  rows: [{ stem: 'P100', readSource: 'dxf', fields: {},
    group: { stem: 'P100', files: [{ file, name: file.name, kind: 'dxf' }] },
    cutList: null, excluded: false, identity: { kind: 'new' }, edits: { part_name: 'P100' }, items: [],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(uploadFileToStorage).mockResolvedValue();
  vi.mocked(deleteFileFromStorage).mockResolvedValue();
});

describe('private chat upload storage', () => {
  it('uploads source bytes first and publishes the manifest only after they succeed', async () => {
    const ref = await uploadChatFiles(CO, THREAD, prepared);
    expect(uploadFileToStorage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(uploadFileToStorage).mock.calls[0][1]).toBe(file);
    expect(vi.mocked(uploadFileToStorage).mock.calls[1][0]).toBe(PATH);
    expect(ref).toMatchObject({ id: UPLOAD, manifest_path: PATH, part_count: 1, file_count: 1 });
    expect(JSON.stringify(ref)).not.toContain('engineering source');
    expect(ref.summary).toContain('P100');
  });

  it('cleans failed uploads and does not publish a manifest for missing sources', async () => {
    vi.mocked(uploadFileToStorage).mockRejectedValueOnce(new Error('connection failed'));
    await expect(uploadChatFiles(CO, THREAD, prepared)).rejects.toThrow('connection failed');
    expect(uploadFileToStorage).toHaveBeenCalledTimes(1);
    expect(deleteFileFromStorage).toHaveBeenCalledTimes(1);
  });

  it('refuses another company or a URL before asking Storage for anything', async () => {
    await expect(readChatUpload('other', PATH)).rejects.toThrow(/company/);
    await expect(readChatUpload(CO, `https://example.com/${PATH}`)).rejects.toThrow(/company/);
    expect(downloadFileFromStorage).not.toHaveBeenCalled();
  });

  it('refuses a manifest whose source file points outside its package', async () => {
    vi.mocked(downloadFileFromStorage).mockResolvedValue({ size: 100, text: async () => JSON.stringify({
      version: 1, parts: [{ stem: 'P100', part_name: 'P100', description: '', customer_part_number: '',
        customer_drawing_number: '', customer_revision: '', read_source: 'dxf',
        files: [{ name: 'P100.dxf', size: 10, mime_type: '', kind: 'dxf', path: 'other/private.dxf' }],
      }],
    }) } as Blob);
    await expect(readChatUpload(CO, PATH)).rejects.toThrow(/outside this package/);
  });
});
