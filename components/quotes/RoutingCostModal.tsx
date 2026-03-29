'use client';

import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Alert from '@mui/material/Alert';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
import Link from 'next/link';
import type { RoutingCostBreakdown } from '@/utils/routingCostCalculation';

interface RoutingCostModalProps {
  open: boolean;
  onClose: () => void;
  breakdown: RoutingCostBreakdown | null;
  partId: string;
  companyId: string;
}

const formatCurrency = (value: number | null): string => {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
};

export default function RoutingCostModal({
  open,
  onClose,
  breakdown,
  partId,
  companyId,
}: RoutingCostModalProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          py: 1.5,
        }}
      >
        <Typography variant="h6" component="span" sx={{ fontWeight: 600 }}>
          Routing Cost Breakdown
        </Typography>
        <IconButton onClick={onClose} size="small" sx={{ color: 'text.secondary' }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pt: 3 }}>
        {!breakdown ? (
          <Typography color="text.secondary">No routing cost data available.</Typography>
        ) : (
          <>
            <Box sx={{ mb: 3 }}>
              <Typography variant="body2" color="text.secondary">
                Total Routing Cost (per unit)
              </Typography>
              <Typography variant="h5" sx={{ fontWeight: 600, color: 'primary.main' }}>
                {formatCurrency(breakdown.total_cost)}
              </Typography>
            </Box>

            {breakdown.warnings.length > 0 && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {breakdown.warnings.map((w, i) => (
                  <Typography key={i} variant="body2">{w.message}</Typography>
                ))}
              </Alert>
            )}

            {breakdown.labor_items.length > 0 && (
              <>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Labor (per unit)</Typography>
                <Table size="small" sx={{ mb: 2 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Operation</TableCell>
                      <TableCell align="right">Run (min)</TableCell>
                      <TableCell align="right">Rate ($/hr)</TableCell>
                      <TableCell align="right">Cost/unit</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {breakdown.labor_items.map((item, i) => (
                      <TableRow key={i}>
                        <TableCell>{item.operation_name}</TableCell>
                        <TableCell align="right">{item.run_time_minutes}</TableCell>
                        <TableCell align="right">{formatCurrency(item.labor_rate)}</TableCell>
                        <TableCell align="right">{formatCurrency(item.cost)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell colSpan={3} sx={{ fontWeight: 600 }}>Subtotal</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 600 }}>{formatCurrency(breakdown.total_labor_cost)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>

                {breakdown.total_setup_cost > 0 && (
                  <>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>Setup (one-time per batch)</Typography>
                    <Table size="small" sx={{ mb: 2 }}>
                      <TableHead>
                        <TableRow>
                          <TableCell>Operation</TableCell>
                          <TableCell align="right">Setup (min)</TableCell>
                          <TableCell align="right">Rate ($/hr)</TableCell>
                          <TableCell align="right">Cost</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {breakdown.labor_items.filter(item => item.setup_time_minutes > 0).map((item, i) => (
                          <TableRow key={i}>
                            <TableCell>{item.operation_name}</TableCell>
                            <TableCell align="right">{item.setup_time_minutes}</TableCell>
                            <TableCell align="right">{formatCurrency(item.labor_rate)}</TableCell>
                            <TableCell align="right">{formatCurrency(item.setup_cost)}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow>
                          <TableCell colSpan={3} sx={{ fontWeight: 600 }}>Subtotal</TableCell>
                          <TableCell align="right" sx={{ fontWeight: 600 }}>{formatCurrency(breakdown.total_setup_cost)}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </>
                )}
              </>
            )}

            {breakdown.material_items.length > 0 && (
              <>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Materials</Typography>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Item</TableCell>
                      <TableCell align="right">Qty</TableCell>
                      <TableCell align="right">Unit Cost</TableCell>
                      <TableCell align="right">Cost</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {breakdown.material_items.map((item, i) => (
                      <TableRow key={i}>
                        <TableCell>{item.item_name}</TableCell>
                        <TableCell align="right">{item.quantity} {item.unit}</TableCell>
                        <TableCell align="right">{formatCurrency(item.cost_per_unit)}</TableCell>
                        <TableCell align="right">{formatCurrency(item.cost)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell colSpan={3} sx={{ fontWeight: 600 }}>Subtotal</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 600 }}>{formatCurrency(breakdown.total_material_cost)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </>
            )}

            {breakdown.labor_items.length === 0 && breakdown.material_items.length === 0 && (
              <Typography color="text.secondary">No labor or material items in this routing.</Typography>
            )}
          </>
        )}
      </DialogContent>

      <DialogActions
        sx={{
          borderTop: '1px solid rgba(255, 255, 255, 0.1)',
          px: 3,
          py: 1.5,
        }}
      >
        <Button
          component={Link}
          href={`/dashboard/${companyId}/parts/${partId}/routing/edit`}
          target="_blank"
          startIcon={<EditIcon />}
          variant="outlined"
          size="small"
        >
          Edit Routing
        </Button>
        <Button onClick={onClose} variant="contained" size="small">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
