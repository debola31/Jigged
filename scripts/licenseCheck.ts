/**
 * Dependency licences: no AGPL anywhere in the product.
 *
 * WHY THIS EXISTS NOW. The constraint predates this file, but nothing enforced it
 * -- there is no LICENSE file in this repo, no `license` field in package.json,
 * and no CI step that has ever looked at a dependency's terms. That was survivable
 * while every dependency happened to be permissive. It stopped being survivable
 * when the worker gained a PDF rasteriser, because the three most obvious tools
 * for that job are all disqualifying: PyMuPDF (AGPL-3.0), Ghostscript (AGPL-3.0)
 * and pdf2image/poppler (GPL-2.0). A rule enforced by a comment is a rule that
 * gets read once.
 *
 * TWO TIERS, DELIBERATELY:
 *   DENY  -- AGPL and SSPL, which no allowlist entry can override. For a
 *            closed-source SaaS these are not a judgement call.
 *   ALLOW -- everything else must be on a reviewed list, so a NEW licence family
 *            appearing is a conversation rather than a silent addition. Same
 *            allowlist-inside-the-guard shape as function_execute_leaks().
 *
 * The Python side is checked separately, by worker/tests/test_dependency_licences.py,
 * because pip metadata is too inconsistent for the allowlist half (35 installed
 * distributions declare nothing machine-readable) and an allowlist that is mostly
 * "UNKNOWN" proves nothing.
 */
import { execFileSync } from 'node:child_process';

/** No allowlist entry overrides these. Strong copyleft, closed-source product. */
const DENIED = /\b(AGPL|SSPL)\b/i;

/**
 * Reviewed and accepted. Add a line here and say in the PR why the licence is
 * compatible with a closed-source SaaS — that sentence is the point of the list.
 */
const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'MIT AND ISC',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'Python-2.0',
  // Weak copyleft, file-level. Obliges us to publish changes to THEIR files, which
  // we do not make; it does not reach our own source.
  'MPL-2.0',
  '(MPL-2.0 OR Apache-2.0)',
  // Functional Source Licence: source-available, converts to MIT. Restricts building
  // a COMPETING product, which is not what we use it for.
  'FSL-1.1-MIT',
  '(Apache-2.0 AND MIT)',
  '(MIT AND Zlib)',
  '(MIT OR CC0-1.0)',
  // sharp's prebuilt libvips binaries, pulled in by Next.js image optimisation.
  // LGPL is satisfied by dynamic linking to an unmodified prebuilt library, which
  // is exactly how sharp consumes it. Notably NOT the same call as AGPL: LGPL does
  // not reach across a process or a dynamic link into our source.
  'LGPL-3.0-or-later',
]);

export interface LicenseFinding {
  kind: 'denied' | 'unreviewed';
  license: string;
  packages: string[];
}

interface PnpmEntry {
  name: string;
  versions?: string[];
}

export function auditLicenses(byLicense: Record<string, PnpmEntry[]>): LicenseFinding[] {
  const findings: LicenseFinding[] = [];
  for (const [license, entries] of Object.entries(byLicense)) {
    const packages = [...new Set(entries.map((e) => e.name))].sort();
    if (DENIED.test(license)) {
      findings.push({ kind: 'denied', license, packages });
    } else if (!ALLOWED.has(license)) {
      findings.push({ kind: 'unreviewed', license, packages });
    }
  }
  return findings.sort((a, b) => a.license.localeCompare(b.license));
}

export function readInstalledLicenses(): Record<string, PnpmEntry[]> {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw) as Record<string, PnpmEntry[]>;
}

export function formatFindings(findings: LicenseFinding[]): string {
  return findings
    .map((f) =>
      f.kind === 'denied'
        ? `DENIED   ${f.license} — ${f.packages.join(', ')}\n` +
          `         Strong copyleft. This cannot be allowlisted; replace the dependency.`
        : `UNREVIEWED ${f.license} — ${f.packages.join(', ')}\n` +
          `         Add it to ALLOWED in scripts/licenseCheck.ts with a sentence on why ` +
          `it is compatible with a closed-source product.`,
    )
    .join('\n');
}
