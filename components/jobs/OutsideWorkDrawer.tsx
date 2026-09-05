'use client';

import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import { useRouter } from 'next/navigation';

import { useLoad } from '@/hooks/useLoad';
import { formatDateOnly, isDateOnlyPast } from '@/lib/localDate';
import {
  listOutsideShipmentsForCompany,
  outstandingOn,
} from '@/utils/outsideShipmentsAccess';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';

export interface OutsideWorkDrawerProps {
  companyId: string;
  onClose: () => void;
  /** Opens the slip preview for reprinting. */
  onViewSlip: (shipmentId: string) => void;
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}

/**
 * What is at a vendor right now, grouped by vendor, oldest first.
 *
 * VENDOR-SHAPED ON PURPOSE. The question a shop owner actually asks is "what has
 * PerformCoat got?", not "which jobs have parts out" — so the grouping is the
 * answer rather than a sort applied to one.
 *
 * READ AND REPRINT ONLY. There is no send, no receive and no undo here, and that
 * is not an omission. The outside-work TAB was deleted in Aug 2026 because it was
 * a second place to ACT on an operation, and every one of those actions has
 * carried full fidelity on the operation card throughout. This lists documents
 * and points at rows; a slip's Void lives inside its own preview, where the
 * customer packing slip already puts it.
 *
 * LOADED ON OPEN, not with the page. The strip that opens this is free — it reads
 * the queue the Jobs page already has — so the detail should not be paid for by
 * every visit to a list most people came to for something else. The caller
 * mounts this component only while it is open, which makes "on mount" and "on
 * open" the same moment and lets the fetch go through `useLoad` rather than an
 * effect that sets state.
 *
 * Rows deep-link to `?op=` on the job, which OperationsPanel scroll-highlights.
 * Landing at the top of a job with fourteen operations and being told to find the
 * anodize step is how a read-only view becomes a dead end.
 */
export default function OutsideWorkDrawer({
  companyId,
  onClose,
  onViewSlip,
}: OutsideWorkDrawerProps) {
  const router = useRouter();
  const { data, loading, error } = useLoad(
    () => listOutsideShipmentsForCompany(companyId, { openOnly: true }),
    [companyId],
  );
  // "Couldn't load" must never render as "nothing is out" — that reads as the
  // parts having come back. Keep the two states apart.
  const rows = error ? null : data;

  const byVendor = useMemo(() => {
    const groups = new Map<string, { name: string; slips: OutsideShipmentWithRelations[] }>();
    for (const s of rows ?? []) {
      const key = s.vendor_id;
      if (!groups.has(key)) groups.set(key, { name: s.vendor_name, slips: [] });
      groups.get(key)!.slips.push(s);
    }
    // Oldest slip first inside a vendor, and vendors ordered by their oldest —
    // chase order, which is the order the phone calls get made in.
    for (const g of groups.values()) {
      g.slips.sort((a, b) => Date.parse(a.shipped_at) - Date.parse(b.shipped_at));
    }
    return [...groups.values()].sort(
      (a, b) => Date.parse(a.slips[0].shipped_at) - Date.parse(b.slips[0].shipped_at),
    );
  }, [rows]);

  const totalOut = (rows ?? []).reduce((n, s) => n + outstandingOn(s), 0);

  return (
    <Drawer anchor="right" open onClose={onClose}>
      <Box sx={{ width: { xs: '100vw', sm: 420 }, p: 2.5, height: '100%', overflow: 'auto' }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 0.5 }}>
          <Typography variant="h6" sx={{ flex: 1 }}>
            Out at vendors
          </Typography>
          <IconButton aria-label="Close" onClick={onClose} size="small" sx={{ mt: -0.5, mr: -1 }}>
            <CloseIcon />
          </IconButton>
        </Box>

        {rows && rows.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            {totalOut} {totalOut === 1 ? 'piece' : 'pieces'} on {rows.length}{' '}
            {rows.length === 1 ? 'slip' : 'slips'} · {byVendor.length}{' '}
            {byVendor.length === 1 ? 'vendor' : 'vendors'}
          </Typography>
        )}

        {error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            Couldn&apos;t load what&apos;s at a vendor. Close this and try again.
          </Alert>
        ) : null}

        {loading && !error && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress size={26} />
          </Box>
        )}

        {rows && rows.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 4 }}>
            Nothing is at a vendor right now.
          </Typography>
        )}

        {byVendor.map((group) => (
          <Box key={group.name} sx={{ mb: 3 }}>
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'text.secondary',
                mb: 1,
              }}
            >
              {group.name}
            </Typography>

            {group.slips.map((s) => {
              const out = outstandingOn(s);
              const days = daysSince(s.shipped_at);
              // Both sides on the READER's calendar. Date.parse on a plain
              // date is UTC midnight, which calls a job overdue all evening.
              const overdue = isDateOnlyPast(s.due_back_on);
              return (
                <Box
                  key={s.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 1,
                    flexWrap: 'wrap',
                    py: 1,
                    borderTop: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {s.job?.job_number ?? '—'}
                  </Typography>
                  <Typography variant="body2" sx={{ color: 'warning.light' }}>
                    {out}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
                    {s.service_name}
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Typography
                    variant="caption"
                    // Red only for a MISSED PROMISE, never for age alone: a
                    // 30-day plating run that is on schedule is not a problem,
                    // and colouring it like one teaches people to ignore the red.
                    sx={{ color: overdue ? 'error.light' : 'text.secondary', whiteSpace: 'nowrap' }}
                  >
                    {days === 0 ? 'today' : `${days}d`}
                    {s.due_back_on ? ` · due ${formatDateOnly(s.due_back_on)}` : ''}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 0.5, width: '100%', justifyContent: 'flex-end' }}>
                    <Button size="small" onClick={() => onViewSlip(s.id)}>
                      {s.slip_number}
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        onClose();
                        router.push(
                          `/dashboard/${companyId}/jobs/${s.job_id}?op=${s.job_operation_id}`,
                        );
                      }}
                    >
                      Open step
                    </Button>
                  </Box>
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    </Drawer>
  );
}
