/**
 * No AGPL dependency may enter the product, and no unreviewed licence family may
 * arrive quietly.
 *
 * The audit function is tested against synthetic input as well as the real tree,
 * because a guard that has never been shown to FAIL is not evidence of anything --
 * and this one would pass trivially by reading nothing.
 */
import { describe, expect, it } from 'vitest';

import { auditLicenses, formatFindings, readInstalledLicenses } from '../../scripts/licenseCheck';

describe('dependency licences', () => {
  it('the installed tree carries no denied or unreviewed licence', () => {
    const findings = auditLicenses(readInstalledLicenses());
    expect(findings, `\n${formatFindings(findings)}\n`).toEqual([]);
  });

  it('refuses an AGPL dependency', () => {
    const findings = auditLicenses({ 'AGPL-3.0-only': [{ name: 'pymupdf-but-for-node' }] });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('denied');
  });

  it('refuses AGPL however the expression is spelled', () => {
    for (const spelling of ['AGPL-3.0', 'AGPL-3.0-or-later', '(MIT OR AGPL-3.0)', 'agpl-3.0']) {
      expect(auditLicenses({ [spelling]: [{ name: 'x' }] })[0]?.kind).toBe('denied');
    }
  });

  it('refuses SSPL too', () => {
    expect(auditLicenses({ 'SSPL-1.0': [{ name: 'x' }] })[0]?.kind).toBe('denied');
  });

  it('flags a licence nobody has reviewed rather than assuming it is fine', () => {
    const findings = auditLicenses({ 'WTFPL-ish-2.0': [{ name: 'mystery' }] });
    expect(findings[0].kind).toBe('unreviewed');
    expect(formatFindings(findings)).toContain('scripts/licenseCheck.ts');
  });

  it('accepts the permissive families the tree actually uses', () => {
    expect(
      auditLicenses({ MIT: [{ name: 'a' }], 'Apache-2.0': [{ name: 'b' }], ISC: [{ name: 'c' }] }),
    ).toEqual([]);
  });

  it('scanned something — a guard that reads nothing passes by accident', () => {
    const tree = readInstalledLicenses();
    const total = Object.values(tree).reduce((n, entries) => n + entries.length, 0);
    expect(total).toBeGreaterThan(100);
  });
});
