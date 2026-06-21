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
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import MuiLink from '@mui/material/Link';
import NextLink from 'next/link';

import type { Part } from '@/types/part';
import type { ProductionStatus, FulfillmentStatus } from '@/types/job';
import type { QuoteStatus } from '@/types/quote';
import {
  getJobsForPart,
  getQuotesForPart,
  type PartJobUsage,
  type PartQuoteUsage,
} from '@/utils/partsAccess';
import { ProductionStatusChip, FulfillmentStatusChip } from '@/components/jobs/JobStatusChip';
import QuoteStatusChip from '@/components/quotes/QuoteStatusChip';
import PartWhereUsedPanel from '@/components/parts/PartWhereUsedPanel';

interface UsageTabProps {
  part: Part;
  partId: string;
  companyId: string;
  currentChain: string[];
}

const fmtDate = (s: string | null): string => (s ? new Date(s).toLocaleDateString() : '—');

/**
 * "Where does this part show up?" — the record view of a part's relationships:
 * every job and quote it appears on, plus the parent assemblies that consume
 * it. Jobs/quotes are fetched when the tab opens (plain Supabase reads, no AI).
 */
export default function UsageTab({ part, partId, companyId, currentChain }: UsageTabProps) {
  const bomParentsCount = part.bom_parents_count ?? 0;

  const [jobs, setJobs] = useState<PartJobUsage[] | null>(null);
  const [quotes, setQuotes] = useState<PartQuoteUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([getJobsForPart(partId), getQuotesForPart(partId)])
      .then(([j, q]) => {
        if (!cancelled) {
          setJobs(j);
          setQuotes(q);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load usage');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [partId]);

  const loading = jobs === null || quotes === null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {error && <Alert severity="error">{error}</Alert>}

      {/* Jobs */}
      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Jobs{jobs ? ` (${jobs.length})` : ''}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Every job this part has been put into production on.
          </Typography>
          <Divider sx={{ my: 2 }} />
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          ) : jobs && jobs.length > 0 ? (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Job #</TableCell>
                  <TableCell>Customer</TableCell>
                  <TableCell align="right">Qty</TableCell>
                  <TableCell>Production</TableCell>
                  <TableCell>Fulfillment</TableCell>
                  <TableCell>Due</TableCell>
                  <TableCell>Created</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {jobs.map((j) => (
                  <TableRow key={j.job_id} hover>
                    <TableCell>
                      <MuiLink
                        component={NextLink}
                        href={`/dashboard/${companyId}/jobs/${j.job_id}`}
                        underline="hover"
                      >
                        {j.job_number}
                      </MuiLink>
                    </TableCell>
                    <TableCell>{j.customer_name ?? '—'}</TableCell>
                    <TableCell align="right">{j.quantity}</TableCell>
                    <TableCell>
                      <ProductionStatusChip status={j.production_status as ProductionStatus} />
                    </TableCell>
                    <TableCell>
                      <FulfillmentStatusChip status={j.fulfillment_status as FulfillmentStatus} />
                    </TableCell>
                    <TableCell>{fmtDate(j.due_date)}</TableCell>
                    <TableCell>{fmtDate(j.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Typography variant="body2" color="text.secondary">
              This part hasn’t been added to any jobs yet.
            </Typography>
          )}
        </CardContent>
      </Card>

      {/* Quotes */}
      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Quotes{quotes ? ` (${quotes.length})` : ''}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Every quote this part has appeared on.
          </Typography>
          <Divider sx={{ my: 2 }} />
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          ) : quotes && quotes.length > 0 ? (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Quote #</TableCell>
                  <TableCell>Customer</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Expires</TableCell>
                  <TableCell>Created</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {quotes.map((q) => (
                  <TableRow key={q.quote_id} hover>
                    <TableCell>
                      <MuiLink
                        component={NextLink}
                        href={`/dashboard/${companyId}/quotes/${q.quote_id}`}
                        underline="hover"
                      >
                        {q.quote_number}
                      </MuiLink>
                    </TableCell>
                    <TableCell>{q.customer_name ?? '—'}</TableCell>
                    <TableCell>
                      <QuoteStatusChip status={q.status as QuoteStatus} />
                    </TableCell>
                    <TableCell>{fmtDate(q.expiration_date)}</TableCell>
                    <TableCell>{fmtDate(q.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Typography variant="body2" color="text.secondary">
              This part hasn’t appeared on any quotes yet.
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
