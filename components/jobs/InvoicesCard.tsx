'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

import {
  getQuickBooksInvoiceLinksForJob,
  type QuickBooksInvoiceView,
} from '@/utils/quickbooksAccess';

// Stable empty fallback so derived data doesn't churn while the first load runs.
const EMPTY_INVOICES: QuickBooksInvoiceView[] = [];

interface InvoicesCardProps {
  companyId: string;
  jobId: string;
  /** Bump (e.g. Date.now()) after creating an invoice so the card refetches. */
  refreshKey?: number;
}

/**
 * Lists every QuickBooks invoice created for a job (a job now has many —
 * progressive billing), each with the parts + quantities it billed and a deep
 * link into QuickBooks. Replaces the old single "View invoice" button. Read-only
 * (v1 is additive — corrections happen in QuickBooks).
 */
export default function InvoicesCard({ companyId, jobId, refreshKey = 0 }: InvoicesCardProps) {
  const [error, setError] = useState<string | null>(null);

  const { data, loading } = useLoad(
    () => getQuickBooksInvoiceLinksForJob(companyId, jobId),
    [companyId, jobId, refreshKey],
    {
      onError: (err) => {
        console.error('Failed to load invoices:', err);
        setError(err instanceof Error ? err.message : 'Failed to load invoices.');
      },
    },
  );
  const invoices = data ?? EMPTY_INVOICES;

  return (
    <Card elevation={2} data-testid="invoices-card">
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Invoices ({invoices.length})
          </Typography>
        </Box>
        <Divider sx={{ mb: 2 }} />

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : error ? (
          <Typography variant="body2" color="error">
            {error}
          </Typography>
        ) : invoices.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No invoices yet. Create one with the &quot;Create invoice&quot; action above — an invoice
            bills the parts that have shipped.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Invoice #</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Parts billed</TableCell>
                <TableCell align="right">Amount</TableCell>
                <TableCell align="right" sx={{ width: 60 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id} data-testid="invoice-row">
                  <TableCell sx={{ fontWeight: 600 }}>{inv.docNumber ?? '—'}</TableCell>
                  <TableCell>{formatDate(inv.createdAt)}</TableCell>
                  <TableCell>
                    {inv.lines.length === 0
                      ? '—'
                      : inv.lines.map((l) => `${l.partName} ×${l.quantity}`).join(', ')}
                  </TableCell>
                  <TableCell align="right">{formatCurrency(inv.total)}</TableCell>
                  <TableCell align="right">
                    {inv.url && (
                      <Tooltip title="View in QuickBooks">
                        <IconButton
                          size="small"
                          component="a"
                          href={inv.url}
                          target="_blank"
                          rel="noopener"
                        >
                          <OpenInNewIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
