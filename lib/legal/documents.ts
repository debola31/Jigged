/**
 * Server-only half of the legal-document layer: reads a version's bytes off
 * disk and re-verifies them against the hash committed in the manifest.
 *
 * SERVER ONLY. The `fs` import is the boundary — importing this from a client
 * component fails the build, which is the enforcement. The isomorphic half
 * (version numbers, routes, labels) is `lib/legal/manifest.ts`; import that one
 * from components.
 *
 * WHY RE-VERIFY AT RENDER RATHER THAN TRUST THE MANIFEST. `scripts/legalDocumentsCheck.ts`
 * already proves the two agree on every CI run, so this is belt and braces —
 * but it is cheap belt and braces at a place where being wrong is expensive. If
 * the bytes on disk ever diverge from the committed hash, we do not know what
 * document we are showing, and a clickwrap that presents unknown bytes records
 * assent to nothing. Failing the render is strictly better than serving it.
 *
 * DO NOT CALL THIS FROM THE ACCEPT ROUTE. `app/legal/accept/route.ts` is dynamic
 * and runs in the Lambda, where a filesystem read is a live failure mode on the
 * only write path in the feature. It takes its version and hash from the bundled
 * manifest constant instead, which CI has already proved matches these bytes.
 * The marketing pages are statically prerendered, so for them this read happens
 * at build time.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  legalFilePath,
  versionEntry,
  LEGAL_MANIFEST,
  type LegalDocumentType,
  type LegalVersion,
} from './manifest';

export interface LoadedLegalDocument {
  type: LegalDocumentType;
  version: LegalVersion;
  /** The raw document bytes, injected with `dangerouslySetInnerHTML`. Safe
   *  because the source is a repo file frozen by a CI guard, not user input. */
  html: string;
  /** False when an archived version is being viewed, which the page surfaces
   *  as a supersession banner. */
  isCurrent: boolean;
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function loadLegalDocument(
  type: LegalDocumentType,
  version?: number,
): LoadedLegalDocument {
  const doc = LEGAL_MANIFEST.documents[type];
  const resolved = version ?? doc.current;
  const entry = versionEntry(type, resolved);

  const relativePath = legalFilePath(type, resolved);
  const bytes = readFileSync(join(process.cwd(), relativePath));

  const actual = sha256(bytes);
  if (actual !== entry.sha256) {
    throw new Error(
      `Legal document integrity check failed for ${relativePath}: ` +
        `manifest says ${entry.sha256}, bytes hash to ${actual}. ` +
        `A shipped version is frozen — publish a new version instead of editing this one.`,
    );
  }
  if (bytes.byteLength !== entry.bytes) {
    throw new Error(
      `Legal document size mismatch for ${relativePath}: ` +
        `manifest says ${entry.bytes} bytes, file is ${bytes.byteLength}.`,
    );
  }

  return {
    type,
    version: entry,
    html: bytes.toString('utf-8'),
    isCurrent: resolved === doc.current,
  };
}

/** Every published version of a document, newest first — the source for
 *  `generateStaticParams()` on the archive routes. No version is ever removed,
 *  so every hash a `terms_acceptances` row carries stays resolvable. */
export function publishedVersions(type: LegalDocumentType): LegalVersion[] {
  return [...LEGAL_MANIFEST.documents[type].versions].sort((a, b) => b.version - a.version);
}
