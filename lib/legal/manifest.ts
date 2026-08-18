/**
 * The legal-document manifest: the single source of truth for which version of
 * each document is current, when it took effect, and what its bytes hash to.
 *
 * ISOMORPHIC AND CLIENT-SAFE, deliberately. The consent checkbox and the
 * re-acceptance modal both need the current version number, and both run in the
 * browser. Nothing here touches `fs`, so importing it from a client component
 * costs a few hundred bytes rather than pulling a Node built-in into the bundle.
 * The server-only half — reading and hashing the actual bytes — lives in
 * `lib/legal/documents.ts`; keep the split.
 *
 * WHY A COMMITTED HASH RATHER THAN ONE COMPUTED AT BUILD. `pnpm build` is a bare
 * `next build` with no prebuild hook, and this repo's established shape for a
 * generated artifact is generate-and-commit-then-assert (`types/database.ts`).
 * A legal document's hash changing is precisely the diff a reviewer should be
 * made to look at, so burying it in a build step would remove the one moment
 * anyone notices. `scripts/legalDocumentsCheck.ts` recomputes it from the bytes
 * on every CI run, so the committed value cannot drift.
 *
 * A SHIPPED VERSION IS FROZEN. Editing a document means adding a new version,
 * never touching an existing one, and no version file is ever deleted — a
 * `terms_acceptances.document_sha256` you cannot produce bytes for is an
 * assertion you cannot substantiate. The freeze is enforced by the same check.
 */

import manifestJson from '@/public/legal/manifest.json';

export type LegalDocumentType = 'tos' | 'privacy';

/** Every document a user is asked to accept. Matches the DB CHECK on
 *  `terms_acceptances.document_type`, which is a closed set on purpose. */
export const LEGAL_DOCUMENT_TYPES: readonly LegalDocumentType[] = ['tos', 'privacy'] as const;

export interface LegalVersion {
  /** Monotonic integer, NOT semver. The re-acceptance test is equality against
   *  `current`, so there is no ordering to get wrong — and no `"1.10" < "1.9"`. */
  version: number;
  /** ISO date the document took effect. Display only; also present in the
   *  document body, which `effective_date_appears_in_body` asserts. */
  effective_date: string;
  /** Whether a bump to this version should prompt existing users at all. The
   *  privacy policy is a Termly export that regenerates on Termly's cadence,
   *  not ours; a sub-processor-list refresh must not push the whole customer
   *  base through a blocking modal. Defaults true; setting false is a
   *  reviewable diff and someone has to make the materiality call. */
  requires_reacceptance: boolean;
  /** Lowercase hex SHA-256 of the exact bytes served for this version. */
  sha256: string;
  bytes: number;
  effective_date_appears_in_body: boolean;
}

export interface LegalDocument {
  current: number;
  versions: LegalVersion[];
}

/** A document incorporated by reference into one of ours — archived so the
 *  complete agreement stays producible if the third party's site changes or
 *  disappears. Not something anyone accepts, so deliberately NOT a
 *  `LegalDocumentType`: it must never reach `CURRENT_LEGAL_VERSIONS` or the
 *  acceptance gate. Carries an explicit `path` because, unlike our own
 *  documents, its location is not derivable from a type and a version. */
export interface IncorporatedDocument {
  id: string;
  version: string;
  path: string;
  source_url: string;
  retrieved_at: string;
  sha256: string;
  bytes: number;
  incorporated_by: { document_type: LegalDocumentType; version: number }[];
}

export interface LegalManifest {
  documents: Record<LegalDocumentType, LegalDocument>;
  incorporated: IncorporatedDocument[];
}

export const LEGAL_MANIFEST: LegalManifest = manifestJson as LegalManifest;

/** Where each document is rendered. The gate must never block these routes —
 *  a modal covering the document you are being asked to read is a clickwrap
 *  that does not survive contact with a court. */
export const LEGAL_ROUTES: Record<LegalDocumentType, string> = {
  tos: '/terms',
  privacy: '/privacy',
};

export const LEGAL_LABELS: Record<LegalDocumentType, string> = {
  tos: 'Terms of Service',
  privacy: 'Privacy Policy',
};

function documentFor(type: LegalDocumentType): LegalDocument {
  const doc = LEGAL_MANIFEST.documents[type];
  if (!doc) throw new Error(`No legal document in the manifest for "${type}"`);
  return doc;
}

export function versionEntry(type: LegalDocumentType, version: number): LegalVersion {
  const found = documentFor(type).versions.find((v) => v.version === version);
  if (!found) throw new Error(`No version ${version} of "${type}" in the manifest`);
  return found;
}

export function currentVersion(type: LegalDocumentType): LegalVersion {
  return versionEntry(type, documentFor(type).current);
}

/** The current version of every document, which is what the gate compares
 *  against and what the accept route stamps onto a row. */
export const CURRENT_LEGAL_VERSIONS: Record<LegalDocumentType, LegalVersion> = {
  tos: currentVersion('tos'),
  privacy: currentVersion('privacy'),
};

/** Repo-relative path to a version's bytes. Derived, never stored — a field
 *  that can only agree with the convention or be wrong is a field to delete. */
export function legalFilePath(type: LegalDocumentType, version: number): string {
  return `public/legal/${type}/v${version}.html`;
}

/** The rendered page for a specific version, e.g. `/terms/v1`. */
export function archiveHref(type: LegalDocumentType, version: number): string {
  return `${LEGAL_ROUTES[type]}/v${version}`;
}

/** The raw bytes, served straight out of `public/`, e.g. `/legal/tos/v1.html`.
 *  A permanent URL for the exact document a stored hash refers to. */
export function rawAssetHref(type: LegalDocumentType, version: number): string {
  return `/legal/${type}/v${version}.html`;
}
