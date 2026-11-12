'use client';

/**
 * The Purchasing hub's RFQs tab (plan §3.13): number · status · vendors · replies (n of m) ·
 * respond-by.
 *
 * A plain table sorted in the browser, not a server-sorted grid: a shop has a handful of RFQs open
 * at a time, and the useful order is a judgement no single column holds — the ones still waiting on
 * vendors first, soonest respond-by first, then the finished ones newest first.
 *
 * Three states that must never be confused: a failed load (Try Again — never "none yet", the
 * failure that told a shop with three hundred parts its catalogue was empty), none yet, and a list
 * capped at the newest N, which says so.
 */
import NextLink from 'next/link';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import MuiLink from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';

import LoadFailedState from '@/components/common/LoadFailedState';
import StatusDot from '@/components/common/StatusDot';
import { useLoad } from '@/hooks/useLoad';
import { formatDateOnly } from '@/lib/localDate';
import { VENDOR_RFQ_STATUS_CONFIG } from '@/lib/purchasing/vendorPoStatus';
import { purchasingHubPath, vendorRfqPath } from '@/lib/purchasingRoutes';
import { listVendorRfqs } from '@/utils/vendorRfqAccess';
import type { VendorRfqListRow, VendorRfqStatus } from '@/types/vendorRfq';

/** Still waiting on vendors — what a buyer opens this tab to chase. */
const WAITING: readonly VendorRfqStatus[] = ['draft', 'sent', 'quoted'];

function byAttention(a: VendorRfqListRow, b: VendorRfqListRow): number {
  const aw = WAITING.includes(a.status) ? 0 : 1;
  const bw = WAITING.includes(b.status) ? 0 : 1;
  if (aw !== bw) return aw - bw;
  if (aw === 0 && a.respondByOn !== b.respondByOn) {
    if (a.respondByOn === null) return 1;
    if (b.respondByOn === null) return -1;
    return a.respondByOn < b.respondByOn ? -1 : 1;
  }
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

function replies(row: VendorRfqListRow): string {
  if (row.invitedCount === 0) return 'No vendors yet';
  const base = `${row.respondedCount} of ${row.invitedCount}`;
  return row.declinedCount > 0 ? `${base} · ${row.declinedCount} declined` : base;
}

export function RfqList({ companyId }: { companyId: string }) {
  const { data, loading, error, reload } = useLoad(() => listVendorRfqs(companyId), [companyId]);

  const newButton = (
    <Button
      variant="contained"
      startIcon={<AddIcon />}
      component={NextLink}
      href={vendorRfqPath(companyId, 'new')}
    >
      New RFQ
    </Button>
  );

  let body: React.ReactNode;
  if (loading && !data) {
    body = (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  } else if (error && !data) {
    body = (
      <Card>
        <CardContent sx={{ textAlign: 'center', py: 6 }}>
          <LoadFailedState error={error} entity="RFQs" onRetry={() => void reload()} />
        </CardContent>
      </Card>
    );
  } else if (!data || data.rows.length === 0) {
    body = (
      <Card>
        <CardContent sx={{ textAlign: 'center', py: 6 }}>
          <Typography variant="h6" gutterBottom>
            No RFQs yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Ask vendors for prices before you order — on a part, or on anything else you buy. Each vendor gets its own
            copy, and their quotes line up side by side.
          </Typography>
          <Button variant="outlined" component={NextLink} href={purchasingHubPath(companyId, 'to-buy')}>
            See what to buy
          </Button>
        </CardContent>
      </Card>
    );
  } else {
    const rows = [...data.rows].sort(byAttention);
    body = (
      <>
        {data.truncated && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Showing the {data.rows.length} newest of {data.total} RFQs.
          </Alert>
        )}
        <Card>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>RFQ #</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Title</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Status</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Vendors</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Replies</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Respond by</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => {
                  const status = VENDOR_RFQ_STATUS_CONFIG[row.status];
                  return (
                    <TableRow key={row.id} hover>
                      <TableCell>
                        <MuiLink
                          component={NextLink}
                          href={vendorRfqPath(companyId, row.id)}
                          underline="hover"
                          sx={{ fontWeight: 600 }}
                        >
                          {row.rfqNumber}
                        </MuiLink>
                      </TableCell>
                      <TableCell>{row.title ?? '—'}</TableCell>
                      <TableCell>
                        <StatusDot label={status.label} color={status.color} />
                      </TableCell>
                      <TableCell>{row.vendorNames.length > 0 ? row.vendorNames.join(', ') : '—'}</TableCell>
                      <TableCell>{replies(row)}</TableCell>
                      <TableCell>{row.respondByOn ? formatDateOnly(row.respondByOn) : '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <Typography variant="body2" color="text.secondary">
          Requests for prices sent to vendors.
        </Typography>
        <Box sx={{ flex: 1 }} />
        {newButton}
      </Box>
      {body}
    </Box>
  );
}

export default RfqList;
