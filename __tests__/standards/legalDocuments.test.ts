import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  scanLegalDocuments,
  entryDiffers,
  humanDate,
  legalFilePath,
  sha256,
  legalHtmlFiles,
  localBaseRef,
  manifestAtRef,
  proseWords,
  documentUrls,
  countDiffHunks,
  type LegalIssue,
  type LegalVersionEntry,
} from '../../scripts/legalDocumentsCheck';

const REPO_ROOT = path.resolve(__dirname, '../..');

function format(issues: LegalIssue[]): string {
  return issues.map((i) => `[${i.kind}] ${i.target} — ${i.message}`).join('\n');
}

/**
 * Builds a throwaway repo holding just the legal tree, so the scanner's failure
 * modes can be driven for real instead of asserted about. Every "does it catch
 * X" test below mutates one of these rather than the repo's own documents.
 */
function fixture(overrides: {
  html?: string;
  entry?: Partial<LegalVersionEntry>;
  extraFiles?: Record<string, string>;
  skipPages?: boolean;
  /** Rewrites the ToS bytes AFTER the manifest is built, so the file and its
   *  committed hash genuinely disagree. Setting `html` alone cannot express
   *  this — the fixture hashes whatever `html` it was given, so the two stay
   *  in sync and the mismatch the test means to prove never occurs. */
  tamperWith?: string;
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'legal-fixture-'));
  const html = overrides.html ?? '<h1>Terms</h1><p>Last Updated: August 18, 2026</p>\n';
  const privacyHtml = '<h1>Privacy</h1><p>Effective June 20, 2026</p>\n';

  mkdirSync(path.join(root, 'public/legal/tos'), { recursive: true });
  mkdirSync(path.join(root, 'public/legal/privacy'), { recursive: true });
  writeFileSync(path.join(root, 'public/legal/tos/v1.html'), html);
  writeFileSync(path.join(root, 'public/legal/privacy/v1.html'), privacyHtml);

  if (!overrides.skipPages) {
    for (const route of ['terms', 'privacy']) {
      mkdirSync(path.join(root, `app/(marketing)/${route}`), { recursive: true });
      writeFileSync(path.join(root, `app/(marketing)/${route}/page.tsx`), 'export default () => null;\n');
    }
  }

  for (const [rel, body] of Object.entries(overrides.extraFiles ?? {})) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }

  const manifest = {
    documents: {
      tos: {
        current: 1,
        versions: [
          {
            version: 1,
            effective_date: '2026-08-18',
            enforcement_starts_on: '2026-09-01',
            requires_reacceptance: true,
            sha256: sha256(html),
            bytes: Buffer.byteLength(html),
            effective_date_appears_in_body: true,
            ...overrides.entry,
          },
        ],
      },
      privacy: {
        current: 1,
        versions: [
          {
            version: 1,
            effective_date: '2026-06-20',
            enforcement_starts_on: '2026-09-01',
            requires_reacceptance: true,
            sha256: sha256(privacyHtml),
            bytes: Buffer.byteLength(privacyHtml),
            effective_date_appears_in_body: false,
          },
        ],
      },
    },
  };
  writeFileSync(path.join(root, 'public/legal/manifest.json'), JSON.stringify(manifest, null, 2));
  if (overrides.tamperWith !== undefined) {
    writeFileSync(path.join(root, 'public/legal/tos/v1.html'), overrides.tamperWith);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function kindsFor(overrides: Parameters<typeof fixture>[0]): LegalIssueKindList {
  const { root, cleanup } = fixture(overrides);
  try {
    return scanLegalDocuments(root, { quiet: true, today: '2026-08-18' }).issues.map((i) => i.kind);
  } finally {
    cleanup();
  }
}
type LegalIssueKindList = string[];

describe('legalDocumentsCheck — date formatting', () => {
  it('renders an ISO date the way a document body writes it', () => {
    expect(humanDate('2026-08-18')).toBe('August 18, 2026');
    expect(humanDate('2026-06-20')).toBe('June 20, 2026');
    // No zero padding: a body reads "June 1, 2026", never "June 01, 2026".
    expect(humanDate('2026-06-01')).toBe('June 1, 2026');
  });
});

describe('legalDocumentsCheck — path derivation', () => {
  it('derives the file path from type and version, never from a stored field', () => {
    expect(legalFilePath('tos', 1)).toBe('public/legal/tos/v1.html');
    expect(legalFilePath('privacy', 12)).toBe('public/legal/privacy/v12.html');
  });
});

describe('legalDocumentsCheck — the freeze comparison', () => {
  const base: LegalVersionEntry = {
    version: 1,
    effective_date: '2026-08-18',
    enforcement_starts_on: '2026-09-01',
    requires_reacceptance: true,
    sha256: 'a'.repeat(64),
    bytes: 100,
    effective_date_appears_in_body: true,
  };

  it('sees no change when an entry is untouched', () => {
    expect(entryDiffers({ ...base }, base)).toEqual([]);
  });

  /**
   * THE CASE THIS EXISTS FOR. Freezing only `sha256` would let the effective
   * date — the field a dispute most plausibly turns on — be rewritten on an
   * already-published version with every other check green.
   */
  it('catches an edit to effective_date even when the bytes are unchanged', () => {
    expect(entryDiffers({ ...base, effective_date: '2026-01-01' }, base)).toEqual([
      'effective_date: 2026-08-18 -> 2026-01-01',
    ]);
  });

  it('catches a rewritten hash, a moved grace window, and a flipped re-acceptance flag', () => {
    expect(entryDiffers({ ...base, sha256: 'b'.repeat(64) }, base)).toHaveLength(1);
    expect(entryDiffers({ ...base, enforcement_starts_on: '2027-01-01' }, base)).toHaveLength(1);
    expect(entryDiffers({ ...base, requires_reacceptance: false }, base)).toHaveLength(1);
  });
});

describe('legalDocumentsCheck — Tier 1 catches real breakage', () => {
  it('passes a well-formed tree', () => {
    expect(kindsFor({})).toEqual([]);
  });

  it('catches bytes edited after publication', () => {
    // The document changed but the manifest hash did not — the exact move that
    // silently invalidates every acceptance already recorded against it.
    // The tamper swaps the trailing newline for a space, so the file is the
    // SAME LENGTH. Only the hash can see this — which is the whole reason the
    // manifest commits a digest and not just a byte count.
    const kinds = kindsFor({
      tamperWith: '<h1>Terms</h1><p>Last Updated: August 18, 2026</p> ',
    });
    expect(kinds).toContain('hash-mismatch');
    expect(kinds).not.toContain('size-mismatch');
  });

  it('catches a truncated document by byte count as well as by hash', () => {
    const kinds = kindsFor({ tamperWith: '<h1>Terms</h1>' });
    expect(kinds).toContain('hash-mismatch');
    expect(kinds).toContain('size-mismatch');
  });

  it('catches a manifest date the document body does not say', () => {
    expect(kindsFor({ entry: { effective_date: '2026-01-05' } }))
      .toContain('effective-date-absent-from-body');
  });

  it('catches an uppercase or malformed sha256', () => {
    expect(kindsFor({ entry: { sha256: 'A'.repeat(64) } })).toContain('bad-sha-format');
    expect(kindsFor({ entry: { sha256: 'nope' } })).toContain('bad-sha-format');
  });

  it('catches a version numbered from something other than 1', () => {
    expect(kindsFor({ entry: { version: 2 } })).toContain('non-consecutive-version');
  });

  it('catches a served document that no manifest entry declares', () => {
    // A file nobody declared is a document nobody froze.
    expect(kindsFor({ extraFiles: { 'public/legal/tos/draft.html': '<p>x</p>' } }))
      .toContain('orphan-file');
  });

  it('catches a document whose rendering page has been renamed away', () => {
    expect(kindsFor({ skipPages: true })).toContain('missing-route-page');
  });

  it('catches a non-ISO date', () => {
    expect(kindsFor({ entry: { effective_date: '08/18/2026' } })).toContain('bad-date-format');
  });
});

describe('legalDocumentsCheck — Tier 2 skips loudly rather than silently', () => {
  it('reports that no freeze comparison happened when no base ref is given', () => {
    const { root, cleanup } = fixture({});
    try {
      const result = scanLegalDocuments(root, { quiet: true, today: '2026-08-18' });
      // The count is the honest signal: zero means the freeze check did not run.
      expect(result.frozenEntriesCompared).toBe(0);
      expect(result.baseRefUsed).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('legalDocumentsCheck — export repairs are markup only', () => {
  const EXPORT = '<p>Hello <!-- note --> world at [here](https://x.test/p).</p>\n';
  const FROZEN = '<p>Hello  world at <a href="https://x.test/p">here</a>.</p>\n';

  it('sees a markup-only repair as no change to the words', () => {
    // The comment is dropped and a markdown link becomes an anchor — the exact
    // shape of repairs 1 and 3 on the real document.
    expect(proseWords(EXPORT)).toEqual(proseWords(FROZEN));
  });

  it('sees the same URLs before and after a link is rewritten', () => {
    expect(documentUrls(EXPORT)).toEqual(['https://x.test/p']);
    expect(documentUrls(FROZEN)).toEqual(['https://x.test/p']);
  });

  /**
   * THE CASE THIS EXISTS FOR. A word substitution with the hash dutifully
   * updated passes every other check in this file — the bytes and the manifest
   * agree, so hash, size and freeze all go green. Only the prose comparison
   * against the archived vendor export can object, which is what makes
   * "markup only, never a word" a checked fact rather than a promise.
   */
  it('catches a word substitution that every hash check would wave through', () => {
    const edited = FROZEN.replace('world', 'universe');
    expect(proseWords(EXPORT)).not.toEqual(proseWords(edited));
  });

  it('catches a repair that quietly retargets a link', () => {
    const retargeted = FROZEN.replace('https://x.test/p', 'https://evil.test/p');
    expect(documentUrls(EXPORT)).not.toEqual(documentUrls(retargeted));
  });

  it('counts contiguous differing regions, so an undocumented sixth edit fails', () => {
    expect(countDiffHunks('a\nb\nc', 'a\nb\nc')).toBe(0);
    expect(countDiffHunks('a\nb\nc', 'a\nX\nc')).toBe(1);
    expect(countDiffHunks('a\nb\nc\nd', 'a\nX\nc\nY')).toBe(2);
  });
});

describe('legalDocumentsCheck — the repo is clean', () => {
  /**
   * CI passes github.event.pull_request.base.sha through LEGAL_DOCS_BASE_REF;
   * locally we merge-base against origin/main. The ref is passed in rather than
   * discovered inside the scanner so the guard never depends on whether a
   * developer's remote-tracking ref happens to be current.
   */
  const baseRef = process.env.LEGAL_DOCS_BASE_REF || localBaseRef(REPO_ROOT);

  it('every published document matches its committed hash, and nothing is orphaned', () => {
    const result = scanLegalDocuments(REPO_ROOT, { baseRef, quiet: true });

    /**
     * Self-check: a scanner that found nothing must not pass. The floors sit
     * just under what the tree actually holds rather than at 1, because every
     * plausible way for the walk to break — stopping after the first document,
     * never descending into the version directories, hashing an empty buffer —
     * still returns a positive number and would otherwise report a clean tree.
     * privacy v1 alone is 154,273 bytes.
     */
    expect(result.documentsScanned).toBe(2);
    expect(result.versionsScanned).toBeGreaterThanOrEqual(2);
    expect(result.bytesHashed).toBeGreaterThan(150_000);
    // Zero would mean the export prose comparison never ran, which is the one
    // check standing between a word change and a green build.
    expect(result.exportsProseCompared).toBeGreaterThan(0);

    expect(format(result.issues), format(result.issues)).toBe('');
  });

  /**
   * Guards the wiring, not the documents. An env var the test never reads would
   * leave Tier 2 permanently skipped while CI showed a green "Legal docs check"
   * step — a freeze guard that never compares anything is worse than none,
   * because it is trusted. Once the base ref has a manifest, this asserts the
   * comparison actually ran. On the PR that introduces the manifest there is
   * nothing at the base to compare against, and zero is the honest answer.
   */
  it('runs the freeze comparison whenever the base ref has a manifest to compare', () => {
    const result = scanLegalDocuments(REPO_ROOT, { baseRef, quiet: true });
    const baseHasManifest = baseRef ? manifestAtRef(REPO_ROOT, baseRef) !== null : false;

    if (baseHasManifest) {
      expect(result.frozenEntriesCompared).toBeGreaterThan(0);
    } else {
      expect(result.frozenEntriesCompared).toBe(0);
    }
  });

  it('finds the document files on disk, so the orphan check is not vacuous', () => {
    const files = legalHtmlFiles(REPO_ROOT);
    expect(files).toContain('public/legal/tos/v1.html');
    expect(files).toContain('public/legal/privacy/v1.html');
  });
});
