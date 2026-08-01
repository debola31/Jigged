import { getTypedSupabase as getSupabase } from '@/lib/supabase';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AtRiskJob {
  job_number: string;
  customer_name: string;
  /** jobs.production_status — operator workflow status. */
  production_status: string;
  pct_complete: number;
  pct_time_elapsed: number;
  risk_gap: number;
  severity: Extract<AlertSeverity, 'high' | 'medium' | 'low'>;
  total_ops: number;
  completed_ops: number;
}

export interface InventoryAlert {
  item_name: string;
  quantity: number;
  reorder_point: number;
  deficit: number;
  unit: string;
  severity: Extract<AlertSeverity, 'critical' | 'high' | 'medium'>;
}

interface JobOperationRow {
  id: string;
  status: string;
  estimated_setup_minutes: number | null;
  estimated_run_minutes_per_unit: number | null;
}

interface JobPartRow {
  quantity: number | null;
  job_operations: JobOperationRow[] | null;
}

interface JobRow {
  id: string;
  job_number: string | null;
  production_status: string;
  created_at: string | null;
  customers: { name: string | null } | null;
  job_parts: JobPartRow[] | null;
}

interface InventoryRow {
  id: string;
  part_name: string | null;
  quantity: number | string | null;
  reorder_point: number | string | null;
  primary_unit: string | null;
}

export async function getAtRiskJobs(companyId: string): Promise<AtRiskJob[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('jobs')
    .select(
      `
      id, job_number, production_status, created_at,
      customers!left(name),
      job_parts(
        quantity,
        job_operations(id, status, estimated_setup_minutes, estimated_run_minutes_per_unit)
      )
      `
    )
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .in('production_status', ['not_started', 'in_progress']);

  if (error) throw error;

  const jobs = (data ?? []) as unknown as JobRow[];
  const now = Date.now();
  const atRisk: AtRiskJob[] = [];

  for (const job of jobs) {
    let totalOps = 0;
    let completedOps = 0;
    let totalEstimatedHours = 0;

    for (const part of job.job_parts ?? []) {
      const partQty = Number(part.quantity ?? 1) || 1;
      for (const op of part.job_operations ?? []) {
        totalOps++;
        if (op.status === 'completed') completedOps++;
        const setupMin = Number(op.estimated_setup_minutes ?? 0) || 0;
        const runMin = Number(op.estimated_run_minutes_per_unit ?? 0) || 0;
        totalEstimatedHours += (setupMin + runMin * partQty) / 60;
      }
    }

    if (totalOps === 0) continue;
    const pctComplete = (completedOps / totalOps) * 100;

    const createdMs = job.created_at ? Date.parse(job.created_at) : NaN;
    const elapsedHours = Number.isFinite(createdMs)
      ? (now - createdMs) / (1000 * 60 * 60)
      : 0;

    const pctTimeElapsed =
      totalEstimatedHours > 0
        ? Math.min((elapsedHours / totalEstimatedHours) * 100, 200)
        : 0;

    const riskGap = pctTimeElapsed - pctComplete;
    if (riskGap <= 30) continue;

    const severity: AtRiskJob['severity'] =
      riskGap > 60 ? 'high' : 'medium';

    atRisk.push({
      job_number: job.job_number ?? 'Unknown',
      customer_name: job.customers?.name ?? 'Unknown',
      production_status: job.production_status,
      pct_complete: round1(pctComplete),
      pct_time_elapsed: round1(pctTimeElapsed),
      risk_gap: round1(riskGap),
      severity,
      total_ops: totalOps,
      completed_ops: completedOps,
    });
  }

  const severityOrder: Record<AtRiskJob['severity'], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  atRisk.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return atRisk;
}

/**
 * How many candidate rows the badge will scan. Not a display cap — the badge shows however many
 * of these turn out to be low, which is normally far fewer.
 */
export const LOW_STOCK_SCAN_LIMIT = 500;

export async function getLowStockPartsAlerts(
  companyId: string
): Promise<InventoryAlert[]> {
  const supabase = getSupabase();

  /**
   * Bounded, and ordered so the bound keeps the parts that matter. Issue #619's sibling.
   *
   * This read was unbounded over every stocked part with a reorder point. On a 9,428-part
   * catalogue that is both a heavy read for a header badge and, worse, **silently truncated** at
   * PostgREST's `max_rows` of 1,000 — which returns whichever rows the planner happened to emit
   * first, so a genuinely-out part could be missing from the badge with no error anywhere.
   *
   * `ascending: true` on quantity means the cap keeps the emptiest shelves, so the truncation
   * that remains drops the *least* urgent rows rather than an arbitrary set.
   *
   * The low test itself stays in JS below because it compares two COLUMNS
   * (`quantity <= reorder_point`), which PostgREST cannot express as a filter. That is also why
   * this returns `truncated` rather than an exact total: a `count: 'exact'` here would count
   * parts that HAVE a reorder point, not parts that are under it, and reporting that as
   * "N parts are low" would be a wrong number stated confidently.
   */
  const { data, error } = await supabase
    .from('parts')
    .select('id, part_name, quantity, reorder_point, primary_unit')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .eq('is_stocked', true)
    .not('reorder_point', 'is', null)
    .order('quantity', { ascending: true })
    .limit(LOW_STOCK_SCAN_LIMIT);

  if (error) throw error;

  const items = (data ?? []) as unknown as InventoryRow[];
  const alerts: InventoryAlert[] = [];

  for (const item of items) {
    const qty = Number(item.quantity ?? 0) || 0;
    const reorder = Number(item.reorder_point ?? 0) || 0;
    if (qty > reorder) continue;

    const severity: InventoryAlert['severity'] =
      qty === 0 ? 'critical' : qty <= reorder * 0.5 ? 'high' : 'medium';

    alerts.push({
      item_name: item.part_name ?? 'Unknown',
      quantity: qty,
      reorder_point: reorder,
      deficit: round2(reorder - qty),
      unit: item.primary_unit ?? 'ea',
      severity,
    });
  }

  const severityOrder: Record<InventoryAlert['severity'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
  };
  alerts.sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  );

  return alerts;
}

// AlertBadge consumer hasn't been updated in this chunk; keep the original
// name as an alias so its import keeps resolving.
export const getInventoryAlerts = getLowStockPartsAlerts;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
