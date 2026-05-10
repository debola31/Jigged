import { getSupabase } from '@/lib/supabase';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AtRiskJob {
  job_number: string;
  customer_name: string;
  status: string;
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

interface JobRow {
  id: string;
  job_number: string | null;
  status: string;
  created_at: string | null;
  customers: { name: string | null } | null;
  quotes: { quantity: number | null } | null;
  job_operations: JobOperationRow[] | null;
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
      id, job_number, status, created_at,
      customers!left(name),
      quotes!jobs_quote_id_fkey(quantity),
      job_operations(id, status, estimated_setup_minutes, estimated_run_minutes_per_unit)
      `
    )
    .eq('company_id', companyId)
    .in('status', ['not_started', 'in_progress']);

  if (error) throw error;

  const jobs = (data ?? []) as unknown as JobRow[];
  const now = Date.now();
  const atRisk: AtRiskJob[] = [];

  for (const job of jobs) {
    const operations = job.job_operations ?? [];
    if (operations.length === 0) continue;

    const quantity = Number(job.quotes?.quantity ?? 1) || 1;
    const totalOps = operations.length;
    const completedOps = operations.filter((op) => op.status === 'completed').length;
    const pctComplete = totalOps > 0 ? (completedOps / totalOps) * 100 : 0;

    let totalEstimatedHours = 0;
    for (const op of operations) {
      const setupMin = Number(op.estimated_setup_minutes ?? 0) || 0;
      const runMin = Number(op.estimated_run_minutes_per_unit ?? 0) || 0;
      totalEstimatedHours += (setupMin + runMin * quantity) / 60;
    }

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
      status: job.status,
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

export async function getLowStockPartsAlerts(
  companyId: string
): Promise<InventoryAlert[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .select('id, part_name, quantity, reorder_point, primary_unit')
    .eq('company_id', companyId)
    .eq('is_stocked', true)
    .not('reorder_point', 'is', null);

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
