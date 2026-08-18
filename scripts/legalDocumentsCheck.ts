/**
 * Legal-document freeze checker.
 *
 * The whole clickwrap feature rests on one invariant: **a shipped version of a
 * legal document is frozen.** A `terms_acceptances` row stores a
 * `document_sha256`, and that hash is only worth storing if we can still
 * produce the exact bytes it refers to years later. Editing a published
 * document in place silently invalidates every acceptance already recorded
 * against it — the failure is total, and nothing else in the stack notices.
 *
 * So this runs in two tiers.
 *
 * TIER 1 — pure disk, always runs. Recomputes SHA-256 and byte counts from the
 * files and compares them to `public/legal/manifest.json`; checks that
 * `current` names a real version, that versions are consecutive from 1, that
 * effective dates are ISO and non-decreasing, that a claimed in-body effective
 * date really appears in the bytes, and that every `.html` under
 * `public/legal/**` is named by the manifest (the orphan check — a file nobody
 * declared is a document nobody froze).
 *
 * TIER 2 — git, and the actual invariant. For every (type, version) present in
 * BOTH the working manifest and the base ref's manifest, the ENTIRE entry must
 * be byte-identical. Not just `sha256`: `effective_date` is the field a dispute
 * most plausibly turns on, and freezing only the hash would let it be edited on
 * a shipped version with every check green.
 *
 * WHY THE BASE REF IS PASSED IN, NOT DISCOVERED. Resolving `origin/main`
 * ourselves would make the guard's behaviour depend on whether a developer's
 * remote-tracking ref happens to be current. CI supplies
 * `github.event.pull_request.base.sha`; locally, `git merge-base HEAD origin/main`.
 * With no ref supplied Tier 2 SKIPS with a loud log rather than throwing, so a
 * plain `pnpm test` on a laptop and a push-to-main run do not go red on a
 * missing ref.
 *
 * THE LIMIT, STATED SO NOBODY MISTAKES GREEN FOR SAFETY: Tier 2 is a PR-time
 * control. It does not cover a direct push to `main`, because there is no base
 * ref to compare against. `main` is not branch-protected in this repo, so the
 * freeze rests on the PR workflow being used at all.
 *
 * Driven through vitest like the repo's other source scanners —
 * `pnpm exec vitest run __tests__/standards/legalDocuments.test.ts`. Note `tsx`
 * is not a dependency here, so there is no working CLI entry point.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

export const MANIFEST_PATH = 'public/legal/manifest.json';
export const LEGAL_DIR = 'public/legal';
export const DOCUMENT_TYPES = ['tos', 'privacy'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Where each document renders. Kept in step with `lib/legal/manifest.ts`;
 *  the scan asserts the page file actually exists so a rename cannot orphan it. */
export const LEGAL_ROUTES: Record<DocumentType, string> = {
  tos: '/terms',
  privacy: '/privacy',
};

export type LegalIssueKind =
  | 'missing-file'
  | 'hash-mismatch'
  | 'size-mismatch'
  | 'bad-sha-format'
  | 'unknown-current'
  | 'duplicate-version'
  | 'non-consecutive-version'
  | 'bad-date-format'
  | 'effective-date-regressed'
  | 'effective-date-absent-from-body'
  | 'orphan-file'
  | 'unknown-document-type'
  | 'missing-document-type'
  | 'missing-route-page'
  | 'incorporated-missing-file'
  | 'incorporated-hash-mismatch'
  | 'incorporated-target-missing'
  | 'export-missing-file'
  | 'export-hash-mismatch'
  | 'export-target-missing'
  | 'export-changelog-missing'
  | 'export-prose-differs'
  | 'export-repair-count-wrong'
  | 'frozen-entry-edited'
  | 'version-removed';

export interface LegalIssue {
  kind: LegalIssueKind;
  target: string;
  message: string;
}

export interface LegalVersionEntry {
  version: number;
  effective_date: string;
  requires_reacceptance: boolean;
  sha256: string;
  bytes: number;
  effective_date_appears_in_body: boolean;
}

export interface LegalManifest {
  documents: Record<string, { current: number; versions: LegalVersionEntry[] }>;
  incorporated?: {
    id: string;
    version: string;
    path: string;
    source_url: string;
    retrieved_at: string;
    sha256: string;
    bytes: number;
    incorporated_by: { document_type: string; version: number }[];
  }[];
  source_exports?: {
    id: string;
    for: { document_type: string; version: number };
    path: string;
    extracted_from: string;
    sha256: string;
    bytes: number;
    repairs: number;
    changelog: string;
  }[];
}

export interface LegalScanResult {
  issues: LegalIssue[];
  documentsScanned: number;
  versionsScanned: number;
  bytesHashed: number;
  /** How many (type, version) entries Tier 2 actually compared. Zero means the
   *  freeze check did not run — which the test asserts against explicitly, so a
   *  silently-skipped Tier 2 cannot masquerade as a pass. */
  frozenEntriesCompared: number;
  /** How many source exports were prose-compared against their frozen document.
   *  The legal claim these repairs rest on is 'markup only, never a word', and
   *  this is the number that says whether anything actually checked it. */
  exportsProseCompared: number;
  baseRefUsed: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The visible words of a document, punctuation- and markup-insensitive.
 *
 * Used to prove the one claim the export repairs rest on: every difference
 * between a vendor's export and the frozen document is a MARKUP repair and
 * never a word change. Markdown links collapse to their label and tags vanish,
 * so moving a URL from `[label](url)` into `<a href="url">label</a>` — repair 3
 * — is correctly seen as no change to the words. URLs are compared separately
 * by `documentUrls`, because that transformation moves one out of the prose.
 */
export function proseWords(html: string): string[] {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/<[^>]+>/g, ' ');
  return (stripped.match(/[A-Za-z0-9]+/g) ?? []).map((w) => w.toLowerCase());
}

/** Every URL in a document, wherever it lives — markdown target, href
 *  attribute (straight or typographic quotes), so a repair cannot quietly
 *  retarget a link. */
export function documentUrls(html: string): string[] {
  const found = [
    ...html.matchAll(/\]\((https?:\/\/[^)]+)\)/g),
    ...html.matchAll(/href="(https?:\/\/[^"]+)"/g),
    ...html.matchAll(/href=[\u201c\u201d](https?:\/\/[^\u201c\u201d]+)[\u201c\u201d]/g),
  ].map((m) => m[1]);
  return [...new Set(found)].sort();
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Repo-relative path for a version. Derived, never stored in the manifest —
 *  a field that can only agree with the convention or be wrong is a field to
 *  delete. Must stay identical to `legalFilePath` in `lib/legal/manifest.ts`. */
export function legalFilePath(type: string, version: number): string {
  return `${LEGAL_DIR}/${type}/v${version}.html`;
}

/** `2026-08-18` -> `August 18, 2026`, the form a document body writes it in.
 *  Deliberately not locale-aware: the documents are English and the check is
 *  about whether a specific literal string is present in specific bytes. */
export function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Number of contiguous differing regions between two texts, compared by line.
 *  Keeps the manifest's `repairs` count honest against the actual files. */
export function countDiffHunks(a: string, b: string): number {
  const x = a.split('\n');
  const y = b.split('\n');
  let i = 0;
  let j = 0;
  let hunks = 0;
  while (i < x.length || j < y.length) {
    if (x[i] === y[j]) {
      i += 1;
      j += 1;
      continue;
    }
    hunks += 1;
    // Re-sync on the next line that matches in both, which is enough for the
    // small, in-place edits a markup repair produces.
    let k = 1;
    for (; k < Math.max(x.length - i, y.length - j); k += 1) {
      if (x[i + k] !== undefined && x[i + k] === y[j + k]) break;
    }
    i += k;
    j += k;
  }
  return hunks;
}

export function parseManifest(text: string): LegalManifest {
  return JSON.parse(text) as LegalManifest;
}

function readManifest(repoRoot: string): LegalManifest {
  return parseManifest(readFileSync(join(repoRoot, MANIFEST_PATH), 'utf-8'));
}

/** Every `.html` under `public/legal/`, repo-relative. */
export function legalHtmlFiles(repoRoot: string): string[] {
  const root = join(repoRoot, LEGAL_DIR);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.html')) out.push(relative(repoRoot, full));
    }
  };
  walk(root);
  return out.sort();
}

/** The manifest as of a git ref, or null when the ref or the file is absent
 *  (a first PR that introduces the manifest has nothing to compare against). */
export function manifestAtRef(repoRoot: string, ref: string): LegalManifest | null {
  try {
    const text = execFileSync('git', ['show', `${ref}:${MANIFEST_PATH}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseManifest(text);
  } catch {
    return null;
  }
}

/** Field-by-field comparison of one published version entry. Compares the WHOLE
 *  entry — see the header for why hash-only is not enough. */
export function entryDiffers(a: LegalVersionEntry, b: LegalVersionEntry): string[] {
  const keys: (keyof LegalVersionEntry)[] = [
    'version',
    'effective_date',
    'requires_reacceptance',
    'sha256',
    'bytes',
    'effective_date_appears_in_body',
  ];
  return keys.filter((k) => a[k] !== b[k]).map((k) => `${k}: ${b[k]} -> ${a[k]}`);
}

export interface ScanOptions {
  /** Git ref to freeze against. Omit to skip Tier 2 (logged, not silent). */
  baseRef?: string | null;
  /** Set false in tests that drive Tier 1 in isolation. */
  quiet?: boolean;
}

export function scanLegalDocuments(repoRoot: string, opts: ScanOptions = {}): LegalScanResult {
  const issues: LegalIssue[] = [];
  const manifest = readManifest(repoRoot);

  let versionsScanned = 0;
  let bytesHashed = 0;
  const declaredFiles = new Set<string>();

  // ── Tier 1: the manifest describes the bytes on disk ────────────────────────
  const declaredTypes = Object.keys(manifest.documents);
  for (const type of DOCUMENT_TYPES) {
    if (!declaredTypes.includes(type)) {
      issues.push({
        kind: 'missing-document-type',
        target: type,
        message: `Manifest has no "${type}" document, but it is an accepted document type.`,
      });
    }
  }
  for (const type of declaredTypes) {
    if (!(DOCUMENT_TYPES as readonly string[]).includes(type)) {
      issues.push({
        kind: 'unknown-document-type',
        target: type,
        message:
          `Manifest declares "${type}", which is not an accepted document type. ` +
          `document_type is a closed set matched by a DB CHECK on terms_acceptances.`,
      });
    }
  }

  for (const [type, doc] of Object.entries(manifest.documents)) {
    const seen = new Set<number>();
    let previousDate = '';

    const ordered = [...doc.versions].sort((a, b) => a.version - b.version);
    ordered.forEach((entry, index) => {
      versionsScanned += 1;
      const path = legalFilePath(type, entry.version);
      declaredFiles.add(path);
      const label = `${type} v${entry.version}`;

      if (seen.has(entry.version)) {
        issues.push({
          kind: 'duplicate-version',
          target: label,
          message: `Version ${entry.version} of "${type}" is declared more than once.`,
        });
      }
      seen.add(entry.version);

      if (entry.version !== index + 1) {
        issues.push({
          kind: 'non-consecutive-version',
          target: label,
          message:
            `Versions must be consecutive integers from 1; found ${entry.version} ` +
            `at position ${index + 1}. A gap means a version was deleted, and no ` +
            `version may ever be deleted.`,
        });
      }

      if (!SHA256_HEX.test(entry.sha256)) {
        issues.push({
          kind: 'bad-sha-format',
          target: label,
          message:
            `sha256 must be 64 lowercase hex characters, got "${entry.sha256}". ` +
            `Lowercase is load-bearing: the DB CHECK and digest('hex') are both lowercase.`,
        });
      }

      if (!ISO_DATE.test(entry.effective_date)) {
        issues.push({
          kind: 'bad-date-format',
          target: label,
          message: `effective_date must be ISO YYYY-MM-DD, got "${entry.effective_date}".`,
        });
      }

      if (previousDate && entry.effective_date < previousDate) {
        issues.push({
          kind: 'effective-date-regressed',
          target: label,
          message:
            `effective_date ${entry.effective_date} precedes v${entry.version - 1}'s ` +
            `${previousDate}. A later version cannot take effect earlier.`,
        });
      }
      previousDate = entry.effective_date;

      const full = join(repoRoot, path);
      if (!existsSync(full)) {
        issues.push({
          kind: 'missing-file',
          target: path,
          message:
            `${label} is declared in the manifest but the file is absent. ` +
            `No published version may be deleted — a stored document_sha256 must ` +
            `always resolve to real bytes.`,
        });
        return;
      }

      const bytes = readFileSync(full);
      bytesHashed += bytes.byteLength;

      const actual = sha256(bytes);
      if (actual !== entry.sha256) {
        issues.push({
          kind: 'hash-mismatch',
          target: path,
          message:
            `${label} bytes hash to ${actual} but the manifest says ${entry.sha256}. ` +
            `If you edited the document, publish a NEW version instead — a shipped ` +
            `version is frozen.`,
        });
      }
      if (bytes.byteLength !== entry.bytes) {
        issues.push({
          kind: 'size-mismatch',
          target: path,
          message: `${label} is ${bytes.byteLength} bytes; the manifest says ${entry.bytes}.`,
        });
      }

      if (entry.effective_date_appears_in_body && ISO_DATE.test(entry.effective_date)) {
        const human = humanDate(entry.effective_date);
        if (!bytes.toString('utf-8').includes(human)) {
          issues.push({
            kind: 'effective-date-absent-from-body',
            target: path,
            message:
              `${label} claims effective_date_appears_in_body but "${human}" is not in ` +
              `the bytes. Either the date is wrong or the document says something else — ` +
              `and the document is what the user read.`,
          });
        }
      }
    });

    const routePage = `app/(marketing)${LEGAL_ROUTES[type as DocumentType] ?? ''}/page.tsx`;
    if (LEGAL_ROUTES[type as DocumentType] && !existsSync(join(repoRoot, routePage))) {
      issues.push({
        kind: 'missing-route-page',
        target: routePage,
        message: `"${type}" renders at ${LEGAL_ROUTES[type as DocumentType]} but ${routePage} does not exist.`,
      });
    }
  }

  // Incorporated-by-reference archives. Not acceptable documents, so they never
  // reach CURRENT_LEGAL_VERSIONS — but they are hashed and frozen the same way,
  // because producing the complete agreement means producing them too.
  for (const inc of manifest.incorporated ?? []) {
    const full = join(repoRoot, inc.path);
    if (!existsSync(full)) {
      issues.push({
        kind: 'incorporated-missing-file',
        target: inc.path,
        message: `Incorporated document ${inc.id} v${inc.version} is declared but absent.`,
      });
      continue;
    }
    const bytes = readFileSync(full);
    bytesHashed += bytes.byteLength;
    if (sha256(bytes) !== inc.sha256) {
      issues.push({
        kind: 'incorporated-hash-mismatch',
        target: inc.path,
        message:
          `${inc.id} v${inc.version} hashes to ${sha256(bytes)}, manifest says ${inc.sha256}.`,
      });
    }
    if (inc.path.startsWith(`${LEGAL_DIR}/`)) declaredFiles.add(inc.path);

    for (const ref of inc.incorporated_by) {
      const target = manifest.documents[ref.document_type]?.versions.some(
        (v) => v.version === ref.version,
      );
      if (!target) {
        issues.push({
          kind: 'incorporated-target-missing',
          target: inc.id,
          message:
            `${inc.id} says it is incorporated by ${ref.document_type} v${ref.version}, ` +
            `which the manifest does not declare.`,
        });
      }
    }
  }

  // Source exports. The vendor's original export is archived so the repair
  // changelog is verifiable rather than merely asserted — and the prose
  // comparison below is what makes "markup only, never a word" a checked fact
  // instead of a sentence in a PR description nobody can re-derive in a year.
  let exportsProseCompared = 0;
  for (const exp of manifest.source_exports ?? []) {
    const full = join(repoRoot, exp.path);
    if (!existsSync(full)) {
      issues.push({
        kind: 'export-missing-file',
        target: exp.path,
        message: `Source export ${exp.id} is declared but absent — the repair changelog becomes unverifiable without it.`,
      });
      continue;
    }
    const bytes = readFileSync(full);
    bytesHashed += bytes.byteLength;
    const actual = sha256(bytes);
    if (actual !== exp.sha256) {
      issues.push({
        kind: 'export-hash-mismatch',
        target: exp.path,
        message: `${exp.id} hashes to ${actual}, manifest says ${exp.sha256}.`,
      });
    }
    if (!existsSync(join(repoRoot, exp.changelog))) {
      issues.push({
        kind: 'export-changelog-missing',
        target: exp.changelog,
        message: `${exp.id} names a changelog at ${exp.changelog}, which does not exist.`,
      });
    }

    const targetPath = legalFilePath(exp.for.document_type, exp.for.version);
    const targetFull = join(repoRoot, targetPath);
    const declared = manifest.documents[exp.for.document_type]?.versions.some(
      (v) => v.version === exp.for.version,
    );
    if (!declared || !existsSync(targetFull)) {
      issues.push({
        kind: 'export-target-missing',
        target: exp.id,
        message: `${exp.id} claims to be the export behind ${exp.for.document_type} v${exp.for.version}, which is not published.`,
      });
      continue;
    }

    const frozen = readFileSync(targetFull, 'utf-8');
    const source = bytes.toString('utf-8');

    const a = proseWords(source);
    const b = proseWords(frozen);
    exportsProseCompared += 1;
    if (a.length !== b.length || a.some((w, i) => w !== b[i])) {
      const at = a.findIndex((w, i) => w !== b[i]);
      issues.push({
        kind: 'export-prose-differs',
        target: exp.id,
        message:
          `The frozen ${exp.for.document_type} v${exp.for.version} does not say the same words as ` +
          `the export it came from (${a.length} words vs ${b.length}` +
          (at >= 0 ? `, first difference at word ${at + 1}: "${a[at]}" -> "${b[at]}"` : '') +
          `). Repairs to a vendor export must be MARKUP ONLY — never a word change.`,
      });
    }

    const urlsA = documentUrls(source);
    const urlsB = documentUrls(frozen);
    if (urlsA.join('|') !== urlsB.join('|')) {
      issues.push({
        kind: 'export-prose-differs',
        target: exp.id,
        message: `Repairs retargeted a link: ${urlsA.join(', ')} -> ${urlsB.join(', ')}.`,
      });
    }

    const hunks = countDiffHunks(source, frozen);
    if (hunks !== exp.repairs) {
      issues.push({
        kind: 'export-repair-count-wrong',
        target: exp.id,
        message:
          `Manifest records ${exp.repairs} repairs but the export and the frozen document ` +
          `differ in ${hunks} places. Update the count and ${exp.changelog} together.`,
      });
    }
  }

  // Orphan check: a document nobody declared is a document nobody froze.
  for (const file of legalHtmlFiles(repoRoot)) {
    if (!declaredFiles.has(file)) {
      issues.push({
        kind: 'orphan-file',
        target: file,
        message:
          `${file} is served from public/legal but no manifest entry names it, so ` +
          `nothing hashes or freezes it. Declare it, or move it out of public/legal.`,
      });
    }
  }

  // ── Tier 2: published entries are frozen against the base ref ───────────────
  let frozenEntriesCompared = 0;
  const baseRef = opts.baseRef ?? null;
  const base = baseRef ? manifestAtRef(repoRoot, baseRef) : null;

  if (!baseRef) {
    if (!opts.quiet) {
      console.warn(
        '[legalDocumentsCheck] No baseRef supplied — the FREEZE check (Tier 2) did not run. ' +
          'CI passes github.event.pull_request.base.sha; locally use ' +
          '`git merge-base HEAD origin/main`.',
      );
    }
  } else if (base) {
    for (const [type, baseDoc] of Object.entries(base.documents)) {
      const head = manifest.documents[type];
      for (const baseEntry of baseDoc.versions) {
        const headEntry = head?.versions.find((v) => v.version === baseEntry.version);
        if (!headEntry) {
          issues.push({
            kind: 'version-removed',
            target: `${type} v${baseEntry.version}`,
            message:
              `${type} v${baseEntry.version} exists at ${baseRef} but not here. A published ` +
              `version may never be removed — acceptance rows point at its hash.`,
          });
          continue;
        }
        frozenEntriesCompared += 1;
        const diffs = entryDiffers(headEntry, baseEntry);
        if (diffs.length) {
          issues.push({
            kind: 'frozen-entry-edited',
            target: `${type} v${baseEntry.version}`,
            message:
              `${type} v${baseEntry.version} is already published and must not change. ` +
              `Changed — ${diffs.join('; ')}. Publish a new version instead.`,
          });
        }
      }
    }

  }

  return {
    issues,
    documentsScanned: Object.keys(manifest.documents).length,
    versionsScanned,
    bytesHashed,
    frozenEntriesCompared,
    exportsProseCompared,
    baseRefUsed: baseRef,
  };
}

/** Best-effort local base ref, for the developer-machine path. Returns null
 *  rather than throwing when there is no `origin/main` to merge-base against. */
export function localBaseRef(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
