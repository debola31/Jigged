import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { setupUploadedParts } from '@/lib/mcp/tools/chatUploads';
import { readChatUpload } from '@/utils/chatUploadsAccess';
import { createPartsFromRows } from '@/utils/drawingImportCreate';
import { resolveIdentities } from '@/utils/drawingImportIdentity';
import { copyChatFileToPart } from '@/utils/partAttachmentsAccess';

vi.mock('@/utils/chatUploadsAccess', () => ({ readChatUpload: vi.fn() }));
vi.mock('@/utils/drawingImportCreate', () => ({ createPartsFromRows: vi.fn() }));
vi.mock('@/utils/drawingImportIdentity', () => ({ resolveIdentities: vi.fn() }));
vi.mock('@/utils/partAttachmentsAccess', () => ({ copyChatFileToPart: vi.fn() }));
vi.mock('@/utils/customerAccess', () => ({ getCustomerWithRelations: vi.fn() }));

const env: CompanyToolEnv = {
  caller: { token: 'session', clientId: 'chat', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Shop', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  origin: 'https://jigged.app', link: (path) => `https://jigged.app${path}`,
};
const file = { name: 'P100.pdf', path: 'private/file.pdf', size: 100, kind: 'pdf' as const, mime_type: 'application/pdf' };
const part = {
  stem: 'P100', part_name: 'P100', description: 'plate', customer_part_number: 'P100',
  customer_drawing_number: 'D100', customer_revision: 'B', read_source: 'dxf' as const, files: [file],
};
const args = { manifest_path: 'private/manifest.json', unit: 'each', source: 'made' as const, draft_quote: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readChatUpload).mockResolvedValue({ version: 1, parts: [part] });
  vi.mocked(resolveIdentities).mockResolvedValue(new Map([['P100', { kind: 'new' }]]));
  vi.mocked(createPartsFromRows).mockResolvedValue([
    { stem: 'P100', partId: 'part-1', partName: 'P100', action: 'created', filesAttached: 1,
      fileErrors: [], operationsAdded: 0, componentsLinked: 0, quotable: false },
  ]);
});

describe('setting up an uploaded drawing package', () => {
  it('uses drawing identity checks and returns an unsaved quote form with even unpriced parts', async () => {
    const result = await setupUploadedParts.run(args, env);
    expect(resolveIdentities).toHaveBeenCalledWith('co-1', null, [{ stem: 'P100', partName: 'P100', customerPartNumber: 'P100' }]);
    const [rows, options] = vi.mocked(createPartsFromRows).mock.calls[0];
    expect(rows[0].edits).toMatchObject({ part_name: 'P100', description: 'plate', primary_unit: 'each' });
    expect(options.operationsByStem).toBeUndefined();
    expect(options.materialsByStem).toBeUndefined();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.quote_draft_url).toBe('https://jigged.app/dashboard/co-1/quotes/new?parts=part-1');
      expect(result.data.quote_saved).toBe(false);
    }
  });

  it('files sources through the existing part attachment layer and reports partial file failures', async () => {
    await setupUploadedParts.run(args, env);
    vi.mocked(copyChatFileToPart).mockRejectedValueOnce(new Error('storage unavailable'));
    const [rows, options] = vi.mocked(createPartsFromRows).mock.calls[0];
    const outcome = await options.attachUploadedFiles!('part-1', rows[0]);
    expect(copyChatFileToPart).toHaveBeenCalledWith('co-1', 'part-1', file);
    expect(outcome.attached).toBe(0);
    expect(outcome.errors).toHaveLength(1);
  });

  it('refuses an unknown group before writing and keeps a failed identity check failed', async () => {
    const result = await setupUploadedParts.run({ ...args, stems: ['not-in-package'] }, env);
    expect(result.ok).toBe(false);
    expect(createPartsFromRows).not.toHaveBeenCalled();
    vi.mocked(resolveIdentities).mockResolvedValue(new Map([['P100', { kind: 'unknown', reason: 'database unavailable' }]]));
    await setupUploadedParts.run(args, env);
    expect(vi.mocked(createPartsFromRows).mock.calls[0][0][0].identity.kind).toBe('unknown');
  });
});
