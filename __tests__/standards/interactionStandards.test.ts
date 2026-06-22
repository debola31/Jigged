import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  isValueLikePlaceholder,
  findPlaceholderViolations,
  findGreyDeleteViolations,
  scanProject,
} from '../../scripts/interactionStandardsCheck';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('interactionStandardsCheck — placeholder rule', () => {
  it('flags value-like placeholders', () => {
    for (const v of ['1', '25', '$0.00', '0.00', '25%', 'e.g. 5.50', 'e.g. 50']) {
      expect(isValueLikePlaceholder(v), v).toBe(true);
    }
  });

  it('allows instructional placeholders', () => {
    for (const v of ['Search parts…', 'customer@example.com', 'Qty', 'Note about this part…', 'Suite, unit, etc.']) {
      expect(isValueLikePlaceholder(v), v).toBe(false);
    }
  });

  it('detects a value-like placeholder in source with its line number', () => {
    const src = `<TextField\n  value={x}\n  placeholder="25"\n/>`;
    const found = findPlaceholderViolations(src, 'Example.tsx');
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('placeholder');
    expect(found[0].line).toBe(3);
  });

  it('ignores instructional placeholders in source', () => {
    const src = `<TextField placeholder="Search parts…" />`;
    expect(findPlaceholderViolations(src, 'Example.tsx')).toHaveLength(0);
  });
});

describe('interactionStandardsCheck — grey-delete rule', () => {
  it('flags a delete IconButton coloured text.secondary', () => {
    const src = `<IconButton onClick={d} aria-label="Delete note" sx={{ color: 'text.secondary' }}>\n  <DeleteOutlineIcon />\n</IconButton>`;
    const found = findGreyDeleteViolations(src, 'Example.tsx');
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('grey-delete');
  });

  it('does not flag an error-coloured delete IconButton', () => {
    const src = `<IconButton color="error" aria-label="Remove tier"><DeleteOutlineIcon /></IconButton>`;
    expect(findGreyDeleteViolations(src, 'Example.tsx')).toHaveLength(0);
  });

  it('does not flag a grey non-delete IconButton (e.g. edit)', () => {
    const src = `<IconButton aria-label="Edit" sx={{ color: 'text.secondary' }}><EditIcon /></IconButton>`;
    expect(findGreyDeleteViolations(src, 'Example.tsx')).toHaveLength(0);
  });
});

describe('interactionStandardsCheck — repo is clean', () => {
  it('has no value-like placeholders or grey delete icons under components/ and app/', () => {
    const violations = scanProject(REPO_ROOT);
    const formatted = violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.message}`).join('\n');
    expect(formatted, formatted).toBe('');
  });
});
