import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  parseTrackingPlan,
  extractCaptures,
  compare,
  scanProject,
  DOC_PATH,
  REGISTRY_START,
  REGISTRY_END,
} from '../../scripts/analyticsEventsCheck';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Wraps a fixture in the markers the parser requires. */
const registry = (body: string) => `${REGISTRY_START}\n${body}\n${REGISTRY_END}`;

describe('analyticsEventsCheck — doc parsing', () => {
  it('reads events and properties out of a registry row', () => {
    const plan = parseTrackingPlan(
      registry(
        '| Event | Fires when | Properties | Call site |\n' +
          '|---|---|---|---|\n' +
          '| `quote created` | A quote is saved | `line_item_count`, `customer_id` | [x](../x.ts) |',
      ),
    );
    expect([...plan.keys()]).toEqual(['quote created']);
    expect([...plan.get('quote created')!]).toEqual(['line_item_count', 'customer_id']);
  });

  it('treats an em dash in the properties cell as no properties', () => {
    const plan = parseTrackingPlan(registry('| `user signed in` | Login submitted | — | [x](../x.ts) |'));
    expect(plan.get('user signed in')!.size).toBe(0);
  });

  /**
   * GUARD 1. The registry now lives inside observability.md, which documents
   * session-replay settings in a table of its own. Without the marker slice
   * those rows parse as events named `session_recording_opt_in`.
   */
  it('ignores tables outside the markers', () => {
    const plan = parseTrackingPlan(
      '| `session_recording_opt_in` | `true` | The change itself |\n' +
        registry('| `part created` | A part is created | `source` | [x](../x.ts) |') +
        '\n| `capture_console_log_opt_in` | `false` | Console holds API responses |',
    );
    expect([...plan.keys()]).toEqual(['part created']);
  });

  /**
   * GUARD 2. Prose inside the registry section is full of `code spans`; only a
   * row whose first cell is exactly a backticked event name counts. Note the
   * snake_case row is rejected — property-shaped names are not event names.
   */
  it('ignores prose and non-event rows inside the markers', () => {
    const plan = parseTrackingPlan(
      registry(
        'A surface is a property — see `stock updated` and `surface` above.\n' +
          '| Doc | What it is |\n' +
          '| [observability.md](observability.md) | The runbook |\n' +
          '| `session_recording_opt_in` | `true` | a setting, not an event |\n' +
          '| `part created` | A part is created | `source` | [x](../x.ts) |',
      ),
    );
    expect([...plan.keys()]).toEqual(['part created']);
  });

  it('throws rather than silently finding nothing when the markers are missing', () => {
    expect(() => parseTrackingPlan('| `quote created` | x | — | y |')).toThrow(/markers not found/i);
  });
});

describe('analyticsEventsCheck — source parsing', () => {
  it('extracts the event name and literal property keys', () => {
    const sites = extractCaptures(
      `posthog.capture('shipment created', {\n` +
        `  line_item_count: payload.line_items.length,\n` +
        `  shipping_method: payload.shipping_method,\n` +
        `});`,
      'components/shipments/ShipmentForm.tsx',
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].event).toBe('shipment created');
    expect(sites[0].properties).toEqual(['line_item_count', 'shipping_method']);
  });

  it('handles a capture with no properties', () => {
    const sites = extractCaptures(`posthog.capture('user signed out');`, 'x.tsx');
    expect(sites[0].properties).toEqual([]);
  });

  it('reads shorthand keys', () => {
    const sites = extractCaptures(
      `posthog.capture('stock updated', { surface: 'office', action, unit });`,
      'x.tsx',
    );
    expect(sites[0].properties).toEqual(['surface', 'action', 'unit']);
  });

  /**
   * A comma inside a nested call or a template literal must not be read as a
   * key separator — that would invent property names out of argument lists.
   */
  it('does not split on commas nested inside calls, objects or template literals', () => {
    const sites = extractCaptures(
      `posthog.capture('job created from purchase order', {\n` +
        `  part_count: lines.filter((l, i) => l.part).length,\n` +
        `  label: \`\${a}, \${b}\`,\n` +
        `  nested: { a: 1, b: 2 },\n` +
        `});`,
      'x.tsx',
    );
    expect(sites[0].properties).toEqual(['part_count', 'label', 'nested']);
  });

  it('records a 1-indexed line number', () => {
    const sites = extractCaptures(`const a = 1;\n\nposthog.capture('part created');`, 'x.tsx');
    expect(sites[0].line).toBe(3);
  });

  it('finds several captures in one file', () => {
    const sites = extractCaptures(
      `posthog.capture('quote created');\nposthog.capture('part created', { n: 1 });`,
      'x.tsx',
    );
    expect(sites.map((s) => s.event)).toEqual(['quote created', 'part created']);
  });
});

describe('analyticsEventsCheck — comparison', () => {
  const site = (event: string, properties: string[] = []) => [
    { event, properties, file: 'x.tsx', line: 1 },
  ];

  it('passes when code and doc agree', () => {
    const plan = new Map([['quote created', new Set(['line_item_count'])]]);
    expect(compare(plan, site('quote created', ['line_item_count']))).toEqual([]);
  });

  it('flags an event that is captured but undocumented', () => {
    const v = compare(new Map(), site('note posted'));
    expect(v.map((x) => x.kind)).toContain('undocumented-event');
  });

  /** The direction that keeps the registry trustworthy once a name changes. */
  it('flags a documented event that nothing sends', () => {
    const plan = new Map([['quote deleted', new Set<string>()]]);
    expect(compare(plan, []).map((x) => x.kind)).toEqual(['stale-doc-entry']);
  });

  it('flags properties missing from the doc and missing from the code', () => {
    const plan = new Map([['part created', new Set(['source', 'is_stocked'])]]);
    const v = compare(plan, site('part created', ['source', 'colour']));
    expect(v.map((x) => x.kind).sort()).toEqual(['stale-doc-property', 'undocumented-property']);
  });

  /**
   * `stock updated` is sent from both the office and operator modals with
   * different property sets, so the doc describes the union, not either call.
   */
  it('unions properties across call sites before judging the doc', () => {
    const plan = new Map([['stock updated', new Set(['surface', 'location_id'])]]);
    const sites = [
      { event: 'stock updated', properties: ['surface'], file: 'a.tsx', line: 1 },
      { event: 'stock updated', properties: ['surface', 'location_id'], file: 'b.tsx', line: 1 },
    ];
    expect(compare(plan, sites)).toEqual([]);
  });

  /** The old snake_case convention is now itself a violation. */
  it('flags snake_case and capitalised event names', () => {
    for (const bad of ['quote_created', 'Quote Created']) {
      const v = compare(new Map([[bad, new Set<string>()]]), site(bad));
      expect(v.map((x) => x.kind), bad).toContain('bad-event-name');
    }
  });
});

describe('analyticsEventsCheck — the live tree', () => {
  /**
   * The check that actually binds. If this fails, either a capture call was
   * added without a registry row in docs/observability.md, or a row is
   * describing an event that no longer exists.
   */
  it('every captured event matches the tracking plan', () => {
    const violations = scanProject(REPO_ROOT);
    const report = violations
      .map((v) => `  [${v.kind}] ${v.file}${v.line ? `:${v.line}` : ''} — ${v.detail}`)
      .join('\n');
    expect(violations, `Tracking-plan drift (registry: ${DOC_PATH}):\n${report}`).toEqual([]);
  });
});
