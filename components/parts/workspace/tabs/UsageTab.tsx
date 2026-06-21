'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import MuiLink from '@mui/material/Link';
import NextLink from 'next/link';

import type { Part } from '@/types/part';
import type { ProductionStatus } from '@/types/job';
import type { QuoteStatus } from '@/types/quote';
import {
  getJobsForPart,
  getQuotesForPart,
  type PartJobUsage,
  type PartQuoteUsage,
} from '@/utils/partsAccess';
import { ProductionStatusChip } from '@/components/jobs/JobStatusChip';
import QuoteStatusChip from '@/components/quotes/QuoteStatusChip';
import PartWhereUsedPanel from '@/components/parts/PartWhereUsedPanel';

interface UsageTabProps {
  part: Part;
  partId: string;
  companyId: string;
  currentChain: string[];
}

const fmtDate = (s: string | null): string => (s ? new Date(s).toLocaleDateString() : '—');

type UsageRow =
  | { kind: 'job'; sortKey: string; data: PartJobUsage }
  | { kind: 'quote'; sortKey: string; data: PartQuoteUsage };

/**
 * "Where does this part show up?" Jobs and quotes are linked, so they share one
 * table (a Type column distinguishes them), newest-first. Parent assemblies
 * (Where Used) stay separate since that's a BOM relationship, not commercial.
 */
export default function UsageTab({ part, partId, companyId, currentChain }: UsageTabProps) {
  const bomParentsCount = part.bom_parents_count ?? 0;

  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getJobsForPart(partId), getQuotesForPart(partId)])
      .then(([jobs, quotes]) => {
        if (cancelled) return;
        const merged: UsageRow[] = [
          ...jobs.map((j) => ({ kind: 'job' as const, sortKey: j.created_at ?? '', data: j })),
          ...quotes.map((q) => ({ kind: 'quote' as const, sortKey: q.created_at ?? '', data: q })),
        ].sort((a, b) => b.sortKey.localeCompare(a.sortKey));
        setRows(merged);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load usage');
      });
    return () => {
      cancelled = true;
    };
  }, [partId]);

  const loading = rows === null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {error && <Alert severity="error">{error}</Alert>}

      {/* Jobs & Quotes — one table */}
      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Jobs &amp; Quotes{rows ? ` (${rows.length})` : ''}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Every job and quote this part appears on.
          </Typography>
          <Divider sx={{ my: 2 }} />
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          ) : rows && rows.length > 0 ? (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Type</TableCell>
                  <TableCell>Number</TableCell>
                  <TableCell>Customer</TableCell>
                  <TableCell align="right">Qty</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) =>
                  row.kind === 'job' ? (
                    <TableRow key={`job-${row.data.job_id}`} hover>
                      <TableCell>
                        <Chip size="small" variant="outlined" color="primary" label="Job" />
                      </TableCell>
                      <TableCell>
                        <MuiLink
                          component={NextLink}
                          href={`/dashboard/${companyId}/jobs/${row.data.job_id}`}
                          underline="hover"
                        >
                          {row.data.job_number}
                        </MuiLink>
                      </TableCell>
                      <TableCell>{row.data.customer_name ?? '—'}</TableCell>
                      <TableCell align="right">{row.data.quantity}</TableCell>
                      <TableCell>
                        <ProductionStatusChip status={row.data.production_status as ProductionStatus} />
                      </TableCell>
                      <TableCell>{fmtDate(row.data.created_at)}</TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={`quote-${row.data.quote_id}`} hover>
                      <TableCell>
                        <Chip size="small" variant="outlined" label="Quote" />
                      </TableCell>
                      <TableCell>
                        <MuiLink
                          component={NextLink}
                          href={`/dashboard/${companyId}/quotes/${row.data.quote_id}`}
                          underline="hover"
                        >
                          {row.data.quote_number}
                        </MuiLink>
                      </TableCell>
                      <TableCell>{row.data.customer_name ?? '—'}</TableCell>
                      <TableCell align="right">—</TableCell>
                      <TableCell>
                        <QuoteStatusChip status={row.data.status as QuoteStatus} />
                      </TableCell>
                      <TableCell>{fmtDate(row.data.created_at)}</TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          ) : (
            <Typography variant="body2" color="text.secondary">
              This part hasn’t been quoted or put into production yet.
            </Typography>
          )}
        </CardContent>
      </Card>

      {/* Where used (parent assemblies) */}
      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Where Used
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Other parts whose BOM includes this part as a component.
          </Typography>
          <Divider sx={{ my: 2 }} />
          {bomParentsCount > 0 ? (
            <PartWhereUsedPanel partId={partId} companyId={companyId} currentChain={currentChain} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              This part isn’t used as a component in any other part’s BOM.
            </Typography>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
