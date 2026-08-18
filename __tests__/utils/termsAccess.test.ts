import { describe, it, expect } from 'vitest';
import { documentsNeedingAcceptance, type AcceptedVersion } from '@/utils/termsAccess';
import type { LegalVersion, LegalDocumentType } from '@/lib/legal/manifest';

function version(n: number, over: Partial<LegalVersion> = {}): LegalVersion {
  return {
    version: n,
    effective_date: '2026-08-18',
    requires_reacceptance: true,
    sha256: 'a'.repeat(64),
    bytes: 100,
    effective_date_appears_in_body: true,
    ...over,
  };
}

const current = (tos: LegalVersion, privacy: LegalVersion): Record<LegalDocumentType, LegalVersion> => ({
  tos,
  privacy,
});

describe('termsAccess — who still has to accept', () => {
  it('asks for both when the user has never accepted anything', () => {
    expect(documentsNeedingAcceptance([], current(version(1), version(1)))).toEqual([
      'tos',
      'privacy',
    ]);
  });

  it('says nothing when every document is current', () => {
    const accepted: AcceptedVersion[] = [
      { document_type: 'tos', version: 1 },
      { document_type: 'privacy', version: 1 },
    ];
    expect(documentsNeedingAcceptance(accepted, current(version(1), version(1)))).toEqual([]);
  });

  it('asks again when the accepted version is behind current', () => {
    const accepted: AcceptedVersion[] = [
      { document_type: 'tos', version: 1 },
      { document_type: 'privacy', version: 1 },
    ];
    expect(documentsNeedingAcceptance(accepted, current(version(2), version(1)))).toEqual(['tos']);
  });

  /**
   * THE CASE THIS EXISTS FOR. Both documents are independent monotonic counters
   * that both start at 1, so they will routinely share a version number. A
   * version-only match would let a privacy acceptance satisfy the ToS check and
   * silently record the user as having agreed to a document they never opened.
   */
  it('matches on the document_type + version PAIR, not on version alone', () => {
    const onlyPrivacy: AcceptedVersion[] = [{ document_type: 'privacy', version: 2 }];
    expect(documentsNeedingAcceptance(onlyPrivacy, current(version(2), version(2)))).toEqual([
      'tos',
    ]);
  });

  /**
   * Equality, not "accepted < current". A rollback -- republishing v1 after a
   * bad v2 -- leaves rows at version 2, and a "below current" test would treat
   * those users as compliant with a document they never saw.
   */
  it('asks again after a rollback, where a "below current" test would fail open', () => {
    const accepted: AcceptedVersion[] = [
      { document_type: 'tos', version: 2 },
      { document_type: 'privacy', version: 1 },
    ];
    expect(documentsNeedingAcceptance(accepted, current(version(1), version(1)))).toEqual(['tos']);
  });

  it('honours requires_reacceptance: false for someone who accepted an earlier version', () => {
    const accepted: AcceptedVersion[] = [
      { document_type: 'tos', version: 1 },
      { document_type: 'privacy', version: 1 },
    ];
    const versions = current(version(1), version(2, { requires_reacceptance: false }));
    expect(documentsNeedingAcceptance(accepted, versions)).toEqual([]);
  });

  it('still asks a brand-new user even when requires_reacceptance is false', () => {
    // The flag says "you need not agree AGAIN", not "you need never agree".
    const versions = current(version(1), version(2, { requires_reacceptance: false }));
    expect(documentsNeedingAcceptance([], versions)).toEqual(['tos', 'privacy']);
  });

  it('ignores an acceptance of a document type it does not know', () => {
    const accepted = [{ document_type: 'cookies', version: 1 }] as unknown as AcceptedVersion[];
    expect(documentsNeedingAcceptance(accepted, current(version(1), version(1)))).toEqual([
      'tos',
      'privacy',
    ]);
  });
});
