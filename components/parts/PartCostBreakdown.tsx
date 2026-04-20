'use client';

import { useEffect, useState } from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import {
  calculateRoutingCost,
  type RoutingCostBreakdown,
} from '@/utils/routingCostCalculation';

interface PartCostBreakdownProps {
  partId: string;
  /**
   * Bumped by the parent whenever the routing changes so we reload.
   * (The routing panel auto-saves, so the parent can simply increment this.)
   */
  refreshKey?: number;
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Read-only cost breakdown for a part. Pulls from the routing via
 * calculateRoutingCost so it reflects the current state (no snapshot).
 * Shows one-time setup + per-unit run + per-unit materials, and illustrative
 * selling prices at qty 1 and qty 10 to make setup amortization visible.
 */
export default function PartCostBreakdown({ partId, refreshKey = 0 }: PartCostBreakdownProps) {
  const [breakdown, setBreakdown] = useState<RoutingCostBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    calculateRoutingCost(partId)
      .then((data) => {
        if (!cancelled) setBreakdown(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load cost breakdown');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [partId, refreshKey]);

  const runPerUnit = breakdown ? round2(breakdown.total_labor_cost) : 0;
  const setupBatch = breakdown ? round2(breakdown.total_setup_cost) : 0;
  const materialPerUnit = breakdown ? round2(breakdown.total_material_cost) : 0;
  const setupQty1 = setupBatch;
  const setupQty10 = round2(setupBatch / 10);
  const unitCostQty1 = round2(runPerUnit + materialPerUnit + setupQty1);
  const unitCostQty10 = round2(runPerUnit + materialPerUnit + setupQty10);

  return (
    <Card elevation={2}>
      <CardContent>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
          Cost Breakdown
        </Typography>
        <Divider sx={{ mb: 2 }} />

        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        )}

        {error && <Alert severity="error">{error}</Alert>}

        {!loading && !error && breakdown && (
          <>
            {breakdown.warnings.length > 0 && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                  Heads up:
                </Typography>
                {breakdown.warnings.map((w, i) => (
                  <Typography key={i} variant="body2">
                    • {w.message}
                  </Typography>
                ))}
              </Alert>
            )}

            {breakdown.labor_items.length > 0 && (
              <Box sx={{ mb: 3 }}>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                  Operations
                </Typography>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Operation</TableCell>
                        <TableCell align="right">Run (min/unit)</TableCell>
                        <TableCell align="right">Setup (min)</TableCell>
                        <TableCell align="right">Rate</TableCell>
                        <TableCell align="right">Run / unit</TableCell>
                        <TableCell align="right">Setup (total)</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {breakdown.labor_items.map((op, i) => (
                        <TableRow key={i}>
                          <TableCell>{op.operation_name}</TableCell>
                          <TableCell align="right">{op.run_time_minutes}</TableCell>
                          <TableCell align="right">{op.setup_time_minutes}</TableCell>
                          <TableCell align="right">{formatCurrency(op.labor_rate)}</TableCell>
                          <TableCell align="right">{formatCurrency(op.cost)}</TableCell>
                          <TableCell align="right">{formatCurrency(op.setup_cost)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>
            )}

            {breakdown.material_items.length > 0 && (
              <Box sx={{ mb: 3 }}>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                  Materials (per unit)
                </Typography>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Item</TableCell>
                        <TableCell align="right">Qty / unit</TableCell>
                        <TableCell align="right">Unit</TableCell>
                        <TableCell align="right">Cost / unit</TableCell>
                        <TableCell align="right">Line / unit</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {breakdown.material_items.map((m, i) => (
                        <TableRow key={i}>
                          <TableCell>{m.item_name}</TableCell>
                          <TableCell align="right">{m.quantity}</TableCell>
                          <TableCell align="right">{m.unit ?? '—'}</TableCell>
                          <TableCell align="right">{formatCurrency(m.cost_per_unit)}</TableCell>
                          <TableCell align="right">{formatCurrency(m.cost)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>
            )}

            <Divider sx={{ my: 2 }} />

            {/* Summary */}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              <SummaryRow label="Run labor / unit" value={formatCurrency(runPerUnit)} />
              <SummaryRow
                label="Setup (one-time)"
                value={formatCurrency(setupBatch)}
                hint="amortizes across tier quantity"
              />
              <SummaryRow label="Materials / unit" value={formatCurrency(materialPerUnit)} />
              <Divider sx={{ my: 0.5 }} />
              <SummaryRow
                label="Unit cost @ qty 1"
                value={formatCurrency(unitCostQty1)}
                emphasis="subtotal"
              />
              <SummaryRow
                label="Unit cost @ qty 10"
                value={formatCurrency(unitCostQty10)}
                emphasis="subtotal"
                hint="setup amortized across 10 units"
              />
            </Box>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryRow({
  label,
  value,
  emphasis,
  hint,
}: {
  label: string;
  value: string;
  emphasis?: 'primary' | 'subtotal';
  hint?: string;
}) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        {hint && (
          <Typography variant="caption" color="text.secondary">
            ({hint})
          </Typography>
        )}
      </Box>
      <Typography
        variant={emphasis === 'primary' ? 'body1' : 'body2'}
        fontWeight={emphasis ? 600 : 500}
        color={
          emphasis === 'primary' ? 'primary' : emphasis === 'subtotal' ? 'text.primary' : undefined
        }
      >
        {value}
      </Typography>
    </Box>
  );
}
