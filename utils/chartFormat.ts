/**
 * Number and label formatting shared by the on-screen charts (components/insights/
 * InsightChart.tsx) and the PDF renderer (utils/pdfCharts.ts, utils/reportPdf.ts).
 *
 * Moved out of the chart component so the two renderers cannot drift: a tick that
 * reads "7.7K" on the dashboard must read "7.7K" on the page.
 */

/** Whether a category label is an ISO date or timestamp: the axis is time, not names. */
export function isDateLabel(value: string): boolean {
  return /^\d{4}-\d{2}/.test(value);
}

const MONTH_WORDS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * A sortable key for a label on a time axis, or null when the label is not one.
 *
 * Recognises ISO dates and timestamps, month names with or without a year
 * ("Jul 2026", "August"), and quarters ("Q3", "Q3 2026"). A model asked for a
 * month-by-month figure often relabels the months by name -- the first live
 * report did -- and a renderer that ranks those by value prints a scrambled
 * calendar. Both renderers order by this key instead. Bare month names carry no
 * year, so they sort within one; a series that crosses a year boundary needs
 * the year in the label. Whole words only: "Marlin" and "Decatur" are customers.
 */
export function temporalKey(value: string): number | null {
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(v);
  if (iso) return Number(iso[1]) * 10000 + Number(iso[2]) * 100 + Number(iso[3] ?? 1);
  const monthYear = /^([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(v);
  if (monthYear) {
    const m = MONTH_WORDS[monthYear[1].toLowerCase()];
    return m ? Number(monthYear[2]) * 10000 + m * 100 + 1 : null;
  }
  const month = /^([A-Za-z]+)\.?$/.exec(v);
  if (month) {
    const m = MONTH_WORDS[month[1].toLowerCase()];
    return m ? m * 100 + 1 : null;
  }
  const quarter = /^Q([1-4])(?:\s+(\d{4}))?$/i.exec(v);
  if (quarter) return Number(quarter[2] ?? 0) * 10000 + (Number(quarter[1]) * 3 - 2) * 100 + 1;
  return null;
}

/**
 * Format ISO timestamps and date strings into clean short labels.
 *
 * A nominal label longer than `maxChars` is cut with an ellipsis. The screen chart
 * keeps the default, sized for an axis tick; the PDF renderer passes `Infinity`
 * and fits the full label to the room it measures, since a 12-character cut in a
 * 100pt gutter would throw away half of every customer's name.
 *
 * A date-only value ("2026-06-01") is parsed from its PARTS, not through
 * `new Date(string)`: that constructor reads a bare date as UTC midnight, which
 * for every viewer west of Greenwich is the evening before -- so the first of
 * June rendered as "May 31" and never matched the first-of-month rule. The same
 * trap `formatDate` in utils/packingSlipPdf.ts documents, fixed the same way.
 */
export function formatLabel(value: string, maxChars = 12): string {
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
  if (isDateLabel(value)) {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      if (date.getDate() === 1 || value.includes('T00:00:00')) {
        return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      }
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }
  return value.length > maxChars ? value.slice(0, maxChars).trimEnd() + '...' : value;
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
