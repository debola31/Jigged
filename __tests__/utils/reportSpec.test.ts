/**
 * The browser's mirror of api/models/report_spec.py, pinned to the SAME fixture
 * pytest validates -- the two ends that have to agree are the Python producer and
 * this narrowing, so they read one file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportSpecOf } from '@/utils/reportSpec';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'reportSpecExample.json'), 'utf8'),
) as unknown;

describe('reportSpecOf', () => {
  it('accepts the shared fixture and turns its chart points into a chart_config', () => {
    const spec = reportSpecOf(fixture);
    expect(spec).not.toBeNull();
    expect(spec!.title).toBe('OPERATIONS SUMMARY');
    expect(spec!.kpis).toHaveLength(4);
    const chart = spec!.blocks.find((b) => b.type === 'chart');
    expect(chart && chart.type === 'chart' && chart.chart_config.x_key).toBe('label');
    expect(chart && chart.type === 'chart' && chart.chart_config.data).toHaveLength(5);
    expect(chart && chart.type === 'chart' && chart.chart_config.chart_type).toBe('bar_horizontal');
  });

  it('accepts the handler\'s stored shape, where a chart already carries chart_config', () => {
    const stored = {
      ...(fixture as Record<string, unknown>),
      blocks: [{
        type: 'chart', title: 'Booked by month', note: null,
        chart_config: {
          chart_type: 'bar', x_key: 'label', y_key: 'value',
          data: [{ label: 'Jun', value: 1 }, { label: 'Jul', value: 2 }, { label: 'Aug', value: 3 }],
        },
      }],
    };
    const spec = reportSpecOf(stored);
    expect(spec?.blocks[0].type).toBe('chart');
  });

  it('refuses a table whose row width disagrees with its columns', () => {
    const bad = {
      ...(fixture as Record<string, unknown>),
      blocks: [{
        type: 'table', title: 'T', note: null, total_row: null,
        columns: [{ label: 'A', format: 'plain' }, { label: 'B', format: 'integer' }],
        rows: [['x']],
      }],
    };
    expect(reportSpecOf(bad)).toBeNull();
  });

  it('refuses a block kind the renderer does not know, rather than drawing a blank', () => {
    const bad = { ...(fixture as Record<string, unknown>), blocks: [{ type: 'image', title: 'x', src: 'y' }] };
    expect(reportSpecOf(bad)).toBeNull();
  });

  it('refuses a KPI with an unknown format', () => {
    const bad = {
      ...(fixture as Record<string, unknown>),
      kpis: [{ label: 'Booked', value: 1, format: 'money', caption: null }],
    };
    expect(reportSpecOf(bad)).toBeNull();
  });

  it('is null for anything that is not a report', () => {
    expect(reportSpecOf(null)).toBeNull();
    expect(reportSpecOf({ answer: 'Four.' })).toBeNull();
  });
});
