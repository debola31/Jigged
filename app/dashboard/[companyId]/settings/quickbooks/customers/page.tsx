'use client';

import { use, useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import AdminGuard from '@/components/auth/AdminGuard';
import StatusChip from '@/components/common/StatusChip';
import QuickBooksUnreachableAlert from '@/components/quickbooks/QuickBooksUnreachableAlert';
import { useLoad } from '@/hooks/useLoad';
import {
  exceedsQuickBooksNameLimit,
  suggestQuickBooksCustomer,
  truncateForQuickBooks,
} from '@/lib/quickbooksNameMatch';
import { isQuickBooksUnreachable } from '@/utils/quickbooksAccess';
import {
  listQuickBooksCustomerLinks,
  listQuickBooksDesktopCustomers,
  saveQuickBooksCustomerLinks,
  type DesktopCustomer,
} from '@/utils/quickbooksDesktop';
import { getAllCustomers } from '@/utils/customerAccess';

/**
 * Match Jigged customers to the ones already in QuickBooks Desktop.
 *
 * A leaf route rather than a dialog: it needs a URL (the push dialog links here),
 * it holds staged edits behind an explicit save, and hundreds of rows with a
 * sticky save bar inside a modal is worse on the office monitor this is used on.
 *
 * Matching here is an OPTIMISATION, never a gate. Anything left unlinked is
 * created in QuickBooks on first invoice, exactly as it was before this screen
 * existed — the screen only stops a shop ending up with two records for one
 * customer.
 */

const PAGE_SIZE = 50;
const MAX_PAGES = 20; // 20 x 100 = 2,000 customers

export default function QuickBooksCustomerMatchPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = use(params);
  const router = useRouter();

  const [qbCustomers, setQbCustomers] = useState<DesktopCustomer[] | null>(null);
  const [loadingQb, setLoadingQb] = useState(false);
  const [loadedCount, setLoadedCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [staged, setStaged] = useState<Map<string, string | null>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Both of these are plain Supabase reads under RLS, so they are safe on mount.
  // The QuickBooks list below is NOT, and is behind a click.
  const { data: jiggedCustomers } = useLoad(
    () => getAllCustomers(companyId, ''),
    [companyId],
  );
  const { data: existingLinks } = useLoad(
    () => listQuickBooksCustomerLinks(companyId),
    [companyId],
  );

  const baseline = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of existingLinks ?? []) m.set(l.customerId, l.qbCustomerId);
    return m;
  }, [existingLinks]);

  const handleLoadFromQuickBooks = useCallback(async () => {
    setLoadingQb(true);
    setUnreachable(null);
    setQbCustomers(null);
    setLoadedCount(0);
    try {
      const all: DesktopCustomer[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (; pages < MAX_PAGES; pages += 1) {
        const res = await listQuickBooksDesktopCustomers(companyId, { cursor, limit: 100 });
        all.push(...res.customers);
        setLoadedCount(all.length);
        if (!res.next_cursor) {
          cursor = undefined;
          break;
        }
        cursor = res.next_cursor;
      }
      setTruncated(Boolean(cursor));
      setQbCustomers(all);
    } catch (err) {
      if (isQuickBooksUnreachable(err)) {
        setUnreachable(err instanceof Error ? err.message : null);
      } else {
        setUnreachable(null);
      }
    } finally {
      setLoadingQb(false);
    }
  }, [companyId]);

  const rows = useMemo(() => {
    const list = jiggedCustomers ?? [];
    return list.map((c) => {
      const suggestion = qbCustomers
        ? suggestQuickBooksCustomer(c.name, qbCustomers)
        : null;
      const linked = baseline.get(c.id) ?? null;
      const stagedValue = staged.has(c.id) ? staged.get(c.id)! : undefined;
      const effective = stagedValue !== undefined ? stagedValue : linked;
      return { customer: c, suggestion, linked, effective, dirty: stagedValue !== undefined };
    });
  }, [jiggedCustomers, qbCustomers, baseline, staged]);

  const dirtyCount = staged.size;
  const visible = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const stage = (customerId: string, qbId: string | null) => {
    setStaged((prev) => {
      const next = new Map(prev);
      const original = baseline.get(customerId) ?? null;
      // Dirty is DERIVED, never latched: undoing an edit un-dirties the row.
      if (original === qbId) next.delete(customerId);
      else next.set(customerId, qbId);
      return next;
    });
  };

  const acceptExactMatches = () => {
    setStaged((prev) => {
      const next = new Map(prev);
      for (const r of rows) {
        if (r.suggestion?.confidence === 'exact' && !r.linked) {
          next.set(r.customer.id, r.suggestion.qbId);
        }
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const links = Array.from(staged.entries()).map(([customer_id, qb_customer_id]) => ({
        customer_id,
        qb_customer_id,
        qb_display_name:
          qbCustomers?.find((q) => q.qb_id === qb_customer_id)?.full_name ?? null,
      }));
      const result = await saveQuickBooksCustomerLinks(companyId, links);
      posthog.capture('customer links saved', {
        provider: 'qbd',
        linked_count: result.linked,
        unlinked_count: result.unlinked,
      });
      setSaved(`Saved ${result.linked} link(s).`);
      setStaged(new Map());
    } finally {
      setSaving(false);
    }
  };

  const exactCount = rows.filter(
    (r) => r.suggestion?.confidence === 'exact' && !r.linked,
  ).length;

  return (
    <AdminGuard message="You don't have permission to access settings.">
      <Box>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/settings`)}
          sx={{ mb: 2 }}
        >
          Back to settings
        </Button>
        <Typography variant="h5" gutterBottom>
          Match customers to QuickBooks
        </Typography>
        <Alert severity="info" sx={{ mb: 3 }}>
          Anything you don&apos;t link here is created in QuickBooks the first time you invoice it.
          Matching now just keeps you from ending up with two records for the same customer.
        </Alert>

        {unreachable !== null && (
          <QuickBooksUnreachableAlert
            message={unreachable}
            onRetry={handleLoadFromQuickBooks}
            busy={loadingQb}
          />
        )}
        {saved && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSaved(null)}>
            {saved}
          </Alert>
        )}
        {truncated && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Showing the first {loadedCount} QuickBooks customers. Anything beyond that can still be
            created automatically at invoice time.
          </Alert>
        )}

        {qbCustomers === null ? (
          <Card elevation={2}>
            <CardContent sx={{ p: 4, textAlign: 'center' }}>
              <CloudSyncIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
              <Typography variant="h6" gutterBottom>
                Load your QuickBooks customer list
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                QuickBooks Desktop has to be open on the shop computer. This usually takes a few
                seconds — longer if QuickBooks was closed.
              </Typography>
              {loadingQb && (
                <Box sx={{ mb: 2 }}>
                  <LinearProgress />
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    Loaded {loadedCount} customers…
                  </Typography>
                </Box>
              )}
              <Button
                variant="contained"
                startIcon={<CloudSyncIcon />}
                onClick={handleLoadFromQuickBooks}
                disabled={loadingQb}
              >
                Load from QuickBooks
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <Stack direction="row" spacing={2} sx={{ mb: 2 }} alignItems="center">
              <Button variant="outlined" onClick={acceptExactMatches} disabled={exactCount === 0}>
                Accept all exact matches ({exactCount})
              </Button>
              <Box sx={{ flex: 1 }} />
              {dirtyCount > 0 && (
                <>
                  <Typography variant="body2" color="text.secondary">
                    {dirtyCount} unsaved change(s)
                  </Typography>
                  <Button onClick={() => setStaged(new Map())} disabled={saving}>
                    Discard
                  </Button>
                  <Button variant="contained" onClick={handleSave} disabled={saving}>
                    Save customer links
                  </Button>
                </>
              )}
            </Stack>

            <Card>
              <TableContainer>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell>Customer in Jigged</TableCell>
                      <TableCell>Customer in QuickBooks</TableCell>
                      <TableCell>Match</TableCell>
                      <TableCell align="right" />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {visible.map((r) => {
                      const tooLong = exceedsQuickBooksNameLimit(r.customer.name);
                      return (
                        <TableRow
                          key={r.customer.id}
                          sx={{
                            borderLeft: 3,
                            borderColor: r.dirty ? 'warning.main' : 'transparent',
                          }}
                        >
                          <TableCell>
                            <Typography variant="body2" fontWeight={500}>
                              {r.customer.name}
                            </Typography>
                            {tooLong && (
                              <Typography variant="caption" color="warning.main" display="block">
                                QuickBooks would shorten this to “{truncateForQuickBooks(r.customer.name)}”.
                              </Typography>
                            )}
                          </TableCell>
                          <TableCell sx={{ minWidth: 280 }}>
                            <Autocomplete
                              size="small"
                              options={qbCustomers}
                              getOptionLabel={(o) => o.full_name ?? o.name ?? o.qb_id}
                              isOptionEqualToValue={(o, v) => o.qb_id === v.qb_id}
                              value={qbCustomers.find((q) => q.qb_id === r.effective) ?? null}
                              onChange={(_, v) => stage(r.customer.id, v?.qb_id ?? null)}
                              renderInput={(p) => <TextField {...p} placeholder="Not linked" />}
                            />
                          </TableCell>
                          <TableCell>
                            {r.linked ? (
                              <StatusChip label="Linked" color="success" />
                            ) : r.suggestion?.confidence === 'exact' ? (
                              <StatusChip label="Exact match" color="info" />
                            ) : r.suggestion?.confidence === 'close' ? (
                              <StatusChip label="Close match" color="warning" />
                            ) : (
                              <StatusChip label="Not linked" color="default" />
                            )}
                          </TableCell>
                          <TableCell align="right">
                            {r.effective && (
                              <IconButton
                                size="small"
                                aria-label={`Unlink ${r.customer.name}`}
                                onClick={() => stage(r.customer.id, null)}
                              >
                                <LinkOffIcon fontSize="small" />
                              </IconButton>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>

            {rows.length > PAGE_SIZE && (
              <Stack direction="row" spacing={1} justifyContent="center" sx={{ mt: 2 }}>
                <Button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Typography variant="body2" sx={{ alignSelf: 'center' }}>
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, rows.length)} of{' '}
                  {rows.length}
                </Typography>
                <Button
                  disabled={(page + 1) * PAGE_SIZE >= rows.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </Stack>
            )}
          </>
        )}
      </Box>
    </AdminGuard>
  );
}
