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
import Chip from '@mui/material/Chip';
import type {
  QuoteOperationSnapshot,
  QuoteMaterialSnapshot,
  QuoteLineItem,
} from '@/types/quote';

export interface QuotePartBreakdownViewProps {
  partName: string | null;
  operations: QuoteOperationSnapshot[];
  materials: QuoteMaterialSnapshot[];
  lineItems: QuoteLineItem[];
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function QuoteCostBreakdownView({
  partName,
  operations,
  materials,
  lineItems,
}: QuotePartBreakdownViewProps) {
  const totalRunPerUnit = round2(operations.reduce((s, o) => s + (o.run_cost ?? 0), 0));
  const totalSetupBatch = round2(operations.reduce((s, o) => s + (o.setup_cost ?? 0), 0));
  const totalMaterialPerUnit = round2(materials.reduce((s, m) => s + (m.line_cost ?? 0), 0));

  return (
    <Box sx={{ mb: 4 }}>
      {partName && (
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
          {partName}
        </Typography>
      )}

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
                  <TableRow key={op.id}>
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
          No operations snapshot for this part.
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
                {materials.map((mat) => {
                  // When whole-unit ceiling (or batch pinning) is in play, the
                  // per-part qty × cost/unit no longer multiplies out to
                  // line/unit — e.g. 0.05 strips × $109 ≠ $10.38 because the
                  // order rounds up to whole strips. Surface the discrete count
                  // that reconciles them so the row doesn't read as an error.
                  const reconciles =
                    mat.units_consumed == null ||
                    Math.abs((mat.quantity ?? 0) * (mat.cost_per_unit ?? 0) - (mat.line_cost ?? 0)) <=
                      0.005;
                  return (
                    <TableRow key={mat.id}>
                      <TableCell>
                        {mat.item_name}
                        {!reconciles && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            {mat.units_consumed} {mat.unit ?? ''} consumed for this order (whole-unit)
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">{mat.quantity}</TableCell>
                      <TableCell align="right">{mat.unit ?? '—'}</TableCell>
                      <TableCell align="right">{formatCurrency(mat.cost_per_unit)}</TableCell>
                      <TableCell align="right">{formatCurrency(mat.line_cost)}</TableCell>
                    </TableRow>
                  );
                })}
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
          No materials snapshot for this part.
        </Typography>
      )}

      {/* Per-tier (line item) table */}
      {lineItems.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
            Quantity tiers on this quote
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell align="right">Qty</TableCell>
                  <TableCell align="right">Base / unit</TableCell>
                  <TableCell align="right">Setup / unit</TableCell>
                  <TableCell align="right">Markup %</TableCell>
                  <TableCell align="right">Unit price</TableCell>
                  <TableCell align="right">Total</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {lineItems.map((li) => {
                  const setupPerUnit = li.quantity > 0 ? round2(totalSetupBatch / li.quantity) : 0;
                  const baseFromSnapshot =
                    li.base_cost_per_unit ?? round2(totalRunPerUnit + totalMaterialPerUnit + setupPerUnit);
                  return (
                    <TableRow key={li.id}>
                      <TableCell align="right">{li.quantity}</TableCell>
                      <TableCell align="right">{formatCurrency(baseFromSnapshot)}</TableCell>
                      <TableCell align="right">{formatCurrency(setupPerUnit)}</TableCell>
                      <TableCell align="right">
                        {li.markup_percent != null ? `${li.markup_percent}%` : '—'}
                      </TableCell>
                      <TableCell align="right">
                        {formatCurrency(li.unit_price)}
                        {li.is_quote_override && (
                          <Chip
                            size="small"
                            label="✏ adjusted for this quote"
                            color="success"
                            variant="outlined"
                            sx={{ ml: 1, height: 18 }}
                          />
                        )}
                      </TableCell>
                      <TableCell align="right" sx={{ fontWeight: 600 }}>
                        {formatCurrency(li.total_price)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      )}

      <Divider />
    </Box>
  );
}
