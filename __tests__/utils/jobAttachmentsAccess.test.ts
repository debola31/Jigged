import { describe, it, expect, vi } from 'vitest';

// Isolate the pure validator from the real Supabase client / storage helpers.
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));

import { validateAttachmentFile } from '@/utils/jobAttachmentsAccess';

describe('jobAttachmentsAccess', () => {
  describe('validateAttachmentFile', () => {
    it('accepts a PDF under the size cap', () => {
      const f = new File(['hello'], 'po.pdf', { type: 'application/pdf' });
      expect(validateAttachmentFile(f)).toBeNull();
    });

    it('rejects a non-PDF', () => {
      const f = new File(['x'], 'drawing.png', { type: 'image/png' });
      expect(validateAttachmentFile(f)).toMatch(/PDF/);
    });

    it('rejects a PDF over the 25 MB cap', () => {
      const f = new File(['x'], 'big.pdf', { type: 'application/pdf' });
      Object.defineProperty(f, 'size', { value: 26 * 1024 * 1024 });
      expect(validateAttachmentFile(f)).toMatch(/25 MB/);
    });
  });
});
