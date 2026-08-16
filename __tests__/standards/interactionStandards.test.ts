import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  isValueLikePlaceholder,
  findPlaceholderViolations,
  findGreyDeleteViolations,
  findButtonColorViolations,
  scanProject,
  findSilentBusyButtonViolations,
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

describe('interactionStandardsCheck — button-color rule', () => {
  it('flags a contained button with a semantic fill color (success/warning/info)', () => {
    for (const color of ['success', 'warning', 'info']) {
      const src = `<Button variant="contained" color="${color}">Go</Button>`;
      const found = findButtonColorViolations(src, 'Example.tsx');
      expect(found, color).toHaveLength(1);
      expect(found[0].rule).toBe('button-color');
    }
  });

  it('allows contained primary (default/explicit) and contained error (destructive)', () => {
    for (const src of [
      `<Button variant="contained">Save</Button>`,
      `<Button variant="contained" color="primary">Save</Button>`,
      `<Button variant="contained" color="error">Delete</Button>`,
    ]) {
      expect(findButtonColorViolations(src, 'X.tsx'), src).toHaveLength(0);
    }
  });

  it('does not flag outlined/text buttons — the theme re-colors them regardless', () => {
    // "Mark Sent Out" (outlined warning) is the sanctioned exception; text=default.
    const outlined = `<Button variant="outlined" color="warning">Mark Sent Out</Button>`;
    const text = `<Button color="warning">Skip</Button>`;
    expect(findButtonColorViolations(outlined, 'X.tsx')).toHaveLength(0);
    expect(findButtonColorViolations(text, 'X.tsx')).toHaveLength(0);
  });

  it('parses a multi-line tag with an arrow onClick without ending the tag early', () => {
    const src = [
      '<Button',
      '  variant="contained"',
      '  color="success"',
      '  onClick={() => doThing()}',
      '>',
      '  Add',
      '</Button>',
    ].join('\n');
    const found = findButtonColorViolations(src, 'Example.tsx');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(1);
  });

  it('matches <Button> only — not ButtonBase / IconButton / ToggleButton', () => {
    const src = `<ButtonBase color="success" />\n<IconButton color="warning" />\n<ToggleButton value="a" color="success" />`;
    expect(findButtonColorViolations(src, 'X.tsx')).toHaveLength(0);
  });
});

describe('interactionStandardsCheck — repo is clean', () => {
  it('has no value-like placeholders or grey delete icons under components/ and app/', () => {
    const violations = scanProject(REPO_ROOT);
    const formatted = violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.message}`).join('\n');
    expect(formatted, formatted).toBe('');
  });
});

describe('silent busy buttons (§5)', () => {
  const QB = 'components/settings/quickbooks/Thing.tsx';

  it('flags a busy-disabled Button on a QuickBooks surface', () => {
    const src = `<Button onClick={handleTest} disabled={busy}>Test connection</Button>`;
    const v = findSilentBusyButtonViolations(src, QB);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('silent-busy-button');
  });

  it('accepts BusyButton, which is the fix', () => {
    const src = `<BusyButton onClick={handleTest} disabled={busy} pendingLabel="Asking…">Test</BusyButton>`;
    expect(findSilentBusyButtonViolations(src, QB)).toEqual([]);
  });

  // The rule must not creep into the ~260 sub-second sites it deliberately skips.
  it('ignores the same pattern away from an integration surface', () => {
    const src = `<Button onClick={handleSave} disabled={saving}>Save</Button>`;
    expect(findSilentBusyButtonViolations(src, 'components/parts/PartForm.tsx')).toEqual([]);
  });

  // §4's business, not §5's: an action that is genuinely unavailable stays
  // disabled-and-explained, and must never grow a spinner.
  it('ignores a disable that is not a busy flag', () => {
    const src = `<Button onClick={handleSend} disabled={!canSend}>Send</Button>`;
    expect(findSilentBusyButtonViolations(src, QB)).toEqual([]);
  });

  it('ignores a button that only opens a dialog', () => {
    const src = `<Button onClick={() => setDisconnectOpen(true)} disabled={busy}>Disconnect</Button>`;
    expect(findSilentBusyButtonViolations(src, QB)).toEqual([]);
  });
});
