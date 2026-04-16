'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';

/**
 * Shape the view expects. One row per operation (run_cost is per-unit labor,
 * setup_cost is the total one-time setup for this op). Materials are per-unit.
 * Computed fields (totals, override) are derived here from the props.
 */
export interface CostBreakdownOperationRow {
  key: string;
  operation_name: string;
  run_time_minutes: number | null;
  setup_time_minutes: number | null;
  labor_rate: number | null;
  run_cost: number | null;   // per unit
  setup_cost: number | null; // one-time total for this op
}

export interface CostBreakdownMaterialRow {
  key: string;
  item_name: string;
  quantity: number;
  unit: string | null;
  cost_per_unit: number | null;
  line_cost: number | null;  // per unit of the part being quoted
}

export interface QuoteCostBreakdownViewProps {
  operations: CostBreakdownOperationRow[];
  materials: CostBreakdownMaterialRow[];
  quantity: number;
  baseCost: number;
  markupPercent: number | null;
  computedUnitPrice: number | null;
  actualUnitPrice: number | null;
}

function formatCurrency(value: number | null): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function QuoteCostBreakdownView({
  operations,
  materials,
  quantity,
  baseCost,
  markupPercent,
  computedUnitPrice,
  actualUnitPrice,
}: QuoteCostBreakdownViewProps) {
  // Per-unit run labor (sum across ops; each op's run_cost is already per-unit)
  const totalRunPerUnit = round2(operations.reduce((s, o) => s + (o.run_cost ?? 0), 0));
  // One-time setup labor across all ops
  const totalSetupBatch = round2(operations.reduce((s, o) => s + (o.setup_cost ?? 0), 0));
  // Setup amortized per unit (over the quote's quantity)
  const setupPerUnit = quantity > 0 ? round2(totalSetupBatch / quantity) : 0;
  // Per-unit material (materials quantities are specified per-unit of the part)
  const totalMaterialPerUnit = round2(materials.reduce((s, m) => s + (m.line_cost ?? 0), 0));
  // Full labor per unit = run + amortized setup
  const laborPerUnit = round2(totalRunPerUnit + setupPerUnit);

  const markupDollars =
    markupPercent !== null ? round2(baseCost * (markupPercent / 100)) : null;

  const overridePerUnit =
    computedUnitPrice !== null && actualUnitPrice !== null
      ? round2(actualUnitPrice - computedUnitPrice)
      : null;
  const hasOverride = overridePerUnit !== null && Math.abs(overridePerUnit) >= 0.005;

  const lineTotal =
    actualUnitPrice !== null ? round2(actualUnitPrice * quantity) : null;

  return (
    <Box>
      {/* Operations */}
      {operations.length > 0 ? (
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
                {operations.map((op) => (
                  <TableRow key={op.key}>
                    <TableCell>{op.operation_name}</TableCell>
                    <TableCell align="right">{op.run_time_minutes ?? '—'}</TableCell>
                    <TableCell align="right">{op.setup_time_minutes ?? '—'}</TableCell>
                    <TableCell align="right">{formatCurrency(op.labor_rate)}</TableCell>
                    <TableCell align="right">{formatCurrency(op.run_cost)}</TableCell>
                    <TableCell align="right">{formatCurrency(op.setup_cost)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={4} sx={{ fontWeight: 600 }}>
                    Totals
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600 }}>
                    {formatCurrency(totalRunPerUnit)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600 }}>
                    {formatCurrency(totalSetupBatch)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          No operations available for this quote.
        </Typography>
      )}

      {/* Materials */}
      {materials.length > 0 ? (
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
                {materials.map((mat) => (
                  <TableRow key={mat.key}>
                    <TableCell>{mat.item_name}</TableCell>
                    <TableCell align="right">{mat.quantity}</TableCell>
                    <TableCell align="right">{mat.unit ?? '—'}</TableCell>
                    <TableCell align="right">{formatCurrency(mat.cost_per_unit)}</TableCell>
                    <TableCell align="right">{formatCurrency(mat.line_cost)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={4} sx={{ fontWeight: 600 }}>
                    Total materials / unit
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600 }}>
                    {formatCurrency(totalMaterialPerUnit)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          No materials available for this quote.
        </Typography>
      )}

      <Divider sx={{ my: 2 }} />

      {/* Build-up summary: setup amortization → base → markup → price */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        <SummaryRow label="Run labor / unit" value={formatCurrency(totalRunPerUnit)} />
        <SummaryRow
          label={`Setup (one-time) ÷ qty ${quantity}`}
          value={formatCurrency(setupPerUnit)}
          hint={totalSetupBatch > 0 ? `${formatCurrency(totalSetupBatch)} total` : undefined}
        />
        <SummaryRow label="Materials / unit" value={formatCurrency(totalMaterialPerUnit)} />
        <Divider sx={{ my: 0.5 }} />
        <SummaryRow label="Base cost / unit" value={formatCurrency(baseCost)} emphasis="subtotal" />
        <SummaryRow
          label={`Markup${markupPercent !== null ? ` (${markupPercent}%)` : ''}`}
          value={formatCurrency(markupDollars)}
        />
        <SummaryRow
          label="Computed unit price"
          value={formatCurrency(computedUnitPrice)}
        />
        {hasOverride && (
          <SummaryRow
            label="Override / unit"
            value={`${overridePerUnit! >= 0 ? '+' : ''}${formatCurrency(overridePerUnit)}`}
            emphasis="warning"
          />
        )}
        <Divider sx={{ my: 0.5 }} />
        <SummaryRow
          label="Actual unit price"
          value={formatCurrency(actualUnitPrice)}
          emphasis="primary"
        />
        <SummaryRow
          label={`Line total (× ${quantity})`}
          value={formatCurrency(lineTotal)}
          emphasis="primary"
        />
      </Box>

      {hasOverride && (
        <Alert severity="info" sx={{ mt: 2 }}>
          The unit price on this quote differs from the computed base cost + markup by{' '}
          <strong>{formatCurrency(overridePerUnit)}</strong> per unit.
        </Alert>
      )}

      {/* Sanity check alert: if the sum doesn't match base_cost, flag it. */}
      {Math.abs(baseCost - laborPerUnit - totalMaterialPerUnit) > 0.01 && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          The stored base cost ({formatCurrency(baseCost)}) doesn't match the sum of labor + materials per unit
          ({formatCurrency(laborPerUnit + totalMaterialPerUnit)}). The routing may have changed since this quote was snapshotted.
        </Alert>
      )}
    </Box>
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
  emphasis?: 'primary' | 'warning' | 'subtotal';
  hint?: string;
}) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography variant="body2" color={emphasis === 'warning' ? 'warning.main' : 'text.secondary'}>
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
          emphasis === 'warning'
            ? 'warning.main'
            : emphasis === 'primary'
            ? 'primary'
            : emphasis === 'subtotal'
            ? 'text.primary'
            : undefined
        }
      >
        {value}
      </Typography>
    </Box>
  );
}
