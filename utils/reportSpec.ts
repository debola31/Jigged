import type { ChartConfig } from '@/utils/insightsAccess';
import type { ValueFormat } from '@/utils/chartFormat';

/**
 * The browser's mirror of api/models/report_spec.py.
 *
 * Two shapes reach this file and both are accepted: the spec as the model filled
 * it (a chart block carries `points`) and the result as the handler stored it (a
 * chart block carries a ready `chart_config`, the points having been through the
 * chat gate). `reportSpecOf` normalises both to `chart_config`, so the renderer
 * has one shape to draw and __tests__/fixtures/reportSpecExample.json -- the file
 * pytest validates against the Python model -- also validates here.
 */

export interface ReportKpi {
  label: string;
  value: number;
  format: ValueFormat;
  caption: string | null;
}

export interface ReportColumn {
  label: string;
  format: ValueFormat;
}

export type ReportCell = string | number | null;

export interface ReportTableBlock {
  type: 'table';
  title: string;
  columns: ReportColumn[];
  rows: ReportCell[][];
  total_row: ReportCell[] | null;
  note: string | null;
}

export interface ReportChartBlock {
  type: 'chart';
  title: string;
  chart_config: ChartConfig;
  note: string | null;
}

export interface ReportTextBlock {
  type: 'text';
  body: string;
}

export type ReportBlock = ReportTableBlock | ReportChartBlock | ReportTextBlock;

export interface ReportSpec {
  title: string;
  period_start: string;
  period_end: string;
  period_label: string;
  headline: string;
  kpis: ReportKpi[];
  blocks: ReportBlock[];
}

const FORMATS: ReadonlySet<string> = new Set(['currency', 'integer', 'percent', 'plain']);
const CHART_TYPES: ReadonlySet<string> = new Set(['area', 'pie', 'bar', 'bar_horizontal', 'sparkline']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isFormat = (v: unknown): v is ValueFormat => typeof v === 'string' && FORMATS.has(v);
const isCell = (v: unknown): v is ReportCell =>
  v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const optionalText = (v: unknown): string | null | undefined =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : undefined;

function kpiOf(raw: unknown): ReportKpi | null {
  if (!isRecord(raw)) return null;
  const caption = optionalText(raw.caption);
  if (typeof raw.label !== 'string' || typeof raw.value !== 'number' || !isFormat(raw.format)) return null;
  if (caption === undefined) return null;
  return { label: raw.label, value: raw.value, format: raw.format, caption };
}

function chartConfigOf(raw: unknown): ChartConfig | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.chart_type !== 'string' || !CHART_TYPES.has(raw.chart_type)) return null;
  if (!Array.isArray(raw.data) || typeof raw.x_key !== 'string' || typeof raw.y_key !== 'string') return null;
  return raw as unknown as ChartConfig;
}

/** A model-shaped chart block (`points`) as the renderer's chart_config. */
function chartConfigFromPoints(raw: Record<string, unknown>): ChartConfig | null {
  if (!Array.isArray(raw.points) || typeof raw.chart_type !== 'string' || !CHART_TYPES.has(raw.chart_type)) {
    return null;
  }
  const data: Record<string, unknown>[] = [];
  for (const p of raw.points) {
    if (!isRecord(p) || typeof p.label !== 'string' || typeof p.value !== 'number') return null;
    data.push({ label: p.label, value: p.value });
  }
  return {
    chart_type: raw.chart_type as ChartConfig['chart_type'],
    data,
    x_key: 'label',
    y_key: 'value',
    x_label: typeof raw.x_label === 'string' ? raw.x_label : undefined,
    y_label: typeof raw.y_label === 'string' ? raw.y_label : undefined,
  };
}

function blockOf(raw: unknown): ReportBlock | null {
  if (!isRecord(raw) || typeof raw.title !== 'string' && raw.type !== 'text') return null;
  const note = optionalText(raw.note);
  if (raw.type === 'text') {
    return typeof raw.body === 'string' ? { type: 'text', body: raw.body } : null;
  }
  if (raw.type === 'chart') {
    if (note === undefined) return null;
    const chart_config = chartConfigOf(raw.chart_config) ?? chartConfigFromPoints(raw);
    return chart_config ? { type: 'chart', title: raw.title as string, chart_config, note } : null;
  }
  if (raw.type === 'table') {
    if (note === undefined || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null;
    const columns: ReportColumn[] = [];
    for (const c of raw.columns) {
      if (!isRecord(c) || typeof c.label !== 'string' || !isFormat(c.format)) return null;
      columns.push({ label: c.label, format: c.format });
    }
    const rows: ReportCell[][] = [];
    for (const r of raw.rows) {
      if (!Array.isArray(r) || r.length !== columns.length || !r.every(isCell)) return null;
      rows.push(r as ReportCell[]);
    }
    let total_row: ReportCell[] | null = null;
    if (raw.total_row !== null && raw.total_row !== undefined) {
      if (!Array.isArray(raw.total_row) || raw.total_row.length !== columns.length || !raw.total_row.every(isCell)) {
        return null;
      }
      total_row = raw.total_row as ReportCell[];
    }
    return { type: 'table', title: raw.title as string, columns, rows, total_row, note };
  }
  return null;
}

/**
 * Narrow a stored report to the renderer's shape, or null.
 *
 * Checked at runtime rather than asserted, like `chatResultOf`: a report written
 * by an older handler, or a block the renderer does not know, renders as "no
 * report" rather than as a blank page with a header on it.
 */
export function reportSpecOf(raw: unknown): ReportSpec | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.title !== 'string' || typeof raw.headline !== 'string') return null;
  if (typeof raw.period_start !== 'string' || typeof raw.period_end !== 'string') return null;
  if (typeof raw.period_label !== 'string') return null;
  if (!Array.isArray(raw.kpis) || !Array.isArray(raw.blocks)) return null;
  const kpis: ReportKpi[] = [];
  for (const k of raw.kpis) {
    const kpi = kpiOf(k);
    if (!kpi) return null;
    kpis.push(kpi);
  }
  const blocks: ReportBlock[] = [];
  for (const b of raw.blocks) {
    const block = blockOf(b);
    if (!block) return null;
    blocks.push(block);
  }
  return {
    title: raw.title,
    period_start: raw.period_start,
    period_end: raw.period_end,
    period_label: raw.period_label,
    headline: raw.headline,
    kpis,
    blocks,
  };
}
