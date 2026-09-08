/**
 * Number and label formatting shared by the on-screen charts (components/insights/
 * InsightChart.tsx) and the PDF renderer (utils/pdfCharts.ts, utils/reportPdf.ts).
 *
 * Moved out of the chart component so the two renderers cannot drift: a tick that
 * reads "7.7K" on the dashboard must read "7.7K" on the page.
 */

/**
 * Format ISO timestamps and date strings into clean short labels.
 *
 * A date-only value ("2026-06-01") is parsed from its PARTS, not through
 * `new Date(string)`: that constructor reads a bare date as UTC midnight, which
 * for every viewer west of Greenwich is the evening before -- so the first of
 * June rendered as "May 31" and never matched the first-of-month rule. The same
 * trap `formatDate` in utils/packingSlipPdf.ts documents, fixed the same way.
 */
export function formatLabel(value: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    if (!isNaN(date.getTime())) {
      return date.getDate() === 1
        ? date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
        : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }
  if (/^\d{4}-\d{2}/.test(value)) {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      if (date.getDate() === 1 || value.includes('T00:00:00')) {
        return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      }
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }
  return value.length > 12 ? value.slice(0, 12) + '...' : value;
}

/** Abbreviate large numbers for axis ticks: 7749 -> "7.7K", 1.2e6 -> "1.2M". */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (abs >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(value);
}

/** The declared kind of a report figure; the model never formats, the renderer does. */
export type ValueFormat = 'currency' | 'integer' | 'percent' | 'plain';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const usdCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/**
 * A figure in a table cell or a KPI caption, by its declared format.
 *
 * Currency keeps cents only under $100, where they carry information; above that
 * a whole-dollar figure reads faster and matches the reference document
 * ("$13,367"). Percent is one decimal at most and drops a trailing ".0".
 */
export function formatValue(value: number, format: ValueFormat): string {
  if (!Number.isFinite(value)) return '—';
  switch (format) {
    case 'currency':
      return Math.abs(value) < 100 && !Number.isInteger(value) ? usdCents.format(value) : usd.format(value);
    case 'integer':
      return Math.round(value).toLocaleString('en-US');
    case 'percent':
      return `${(Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, '')}%`;
    default:
      return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
}

/**
 * The big number on a KPI tile. Compact past five figures — "$99.3k", "1.2M" — the
 * way the reference document prints its band, so four tiles fit one row at 21pt.
 */
export function formatKpi(value: number, format: ValueFormat): string {
  if (!Number.isFinite(value)) return '—';
  if (format === 'percent') return formatValue(value, 'percent');
  const abs = Math.abs(value);
  const compact =
    abs >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
      : abs >= 10_000
        ? `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`
        : null;
  if (format === 'currency') return compact ? `$${compact}` : usd.format(value);
  if (compact && abs >= 100_000) return compact;
  return formatValue(value, format);
}
