'use client';

import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import CircularProgress from '@mui/material/CircularProgress';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import { useRouter } from 'next/navigation';

import { useLoad } from '@/hooks/useLoad';
import { formatDateOnly, isDateOnlyPast } from '@/lib/localDate';
import posthog from 'posthog-js';
import {
  listOutsideShipmentsForCompany,
  outsideShipmentPoNumber,
  outstandingOn,
  receiveOutsideShipment,
} from '@/utils/outsideShipmentsAccess';
import ReceiveFromVendorDialog, { closePoLineAfterReceipt, receivePoLineFor } from './ReceiveFromVendorDialog';
import { daysAtVendorBucket } from './outsideWorkMetrics';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';

export interface OutsideWorkDrawerProps {
  companyId: string;
  onClose: () => void;
  /** Fired after a receipt so the caller can re-pull its own outside queue. */
  onReceived?: () => void;
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
 * READ ONLY. There is no send, no receive and no undo here, and that is not an
 * omission. The outside-work TAB was deleted in Aug 2026 because it was
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
 * Each row names the vendor PO the slip ships against ("PO-1042"), as TEXT: it is
 * what the plater quotes back on the phone, and a second link would break the
 * one-target row below.
 *
 * Each row is ONE link -- the job number -- deep-linking to `?op=` on the job,
 * which OperationsPanel scroll-highlights. Landing at the top of a job with
 * fourteen operations and being told to find the anodize step is how a read-only
 * view becomes a dead end. The slip itself is reachable from that step, which is
 * where someone deciding to reprint it is already standing.
 */
export default function OutsideWorkDrawer({
  companyId,
  onClose,
  onReceived,
}: OutsideWorkDrawerProps) {
  const router = useRouter();
  const [receiving, setReceiving] = useState<OutsideShipmentWithRelations | null>(null);
  const [busy, setBusy] = useState(false);
  /** What the last receive could not finish (a refused receipt, or a PO line left open). */
  const [notice, setNotice] = useState<{ severity: 'error' | 'warning'; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useLoad(
    () => listOutsideShipmentsForCompany(companyId, { openOnly: true }),
    [companyId, reloadKey],
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

        {notice && (
          <Alert severity={notice.severity} sx={{ mb: 2 }} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}

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
              const poNumber = outsideShipmentPoNumber(s);
              const what = poNumber ? `${s.service_name} · ${poNumber}` : s.service_name;
              const days = daysSince(s.shipped_at);
              const overdue = isDateOnlyPast(s.due_back_on);
              return (
                <Box
                  key={s.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    columnGap: 1,
                    rowGap: 0.5,
                    // A last resort, not the layout: the "service · PO" text gives way first. Only
                    // when the job number, count, age and button alone are wider than the drawer
                    // does the age-and-Receive pair drop to its own line — never off the edge.
                    flexWrap: 'wrap',
                    py: 1,
                    borderTop: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  {/* THE JOB NUMBER IS THE LINK, and it is the only one. It used
                      to sit beside a slip-number button and an "Open step"
                      button -- three targets on a row whose whole job is to get
                      you to one place. The number is what the shop says out
                      loud, so it is what you click. */}
                  <Link
                    component="button"
                    type="button"
                    underline="hover"
                    onClick={() => {
                      onClose();
                      router.push(
                        `/dashboard/${companyId}/jobs/${s.job_id}?op=${s.job_operation_id}`,
                      );
                    }}
                    sx={{ fontWeight: 500, fontSize: '0.875rem', flexShrink: 0 }}
                  >
                    {s.job?.job_number ?? 'Open job'}
                  </Link>
                  <Typography variant="body2" sx={{ color: 'warning.light', flexShrink: 0 }}>
                    {out}
                  </Typography>
                  {/* THE ONE COLUMN THAT GIVES WAY. A zero basis and min-width 0 let it shrink
                      to whatever the row leaves, on one line with an ellipsis; the title keeps
                      the whole "service · PO" reachable when the ellipsis cuts it. Without
                      `minWidth: 0` a flex item cannot shrink below its content, and with it but
                      no ellipsis the text collapsed to nothing beside long names. */}
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    noWrap
                    title={what}
                    sx={{ flex: '1 1 0', minWidth: 0 }}
                  >
                    {what}
                  </Typography>
                  <Box
                    sx={{ display: 'flex', alignItems: 'baseline', columnGap: 1, flexShrink: 0, ml: 'auto' }}
                  >
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
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => setReceiving(s)}
                      sx={{ flexShrink: 0 }}
                    >
                      Receive
                    </Button>
                  </Box>
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>

      {receiving && (
        <ReceiveFromVendorDialog
          open
          vendorName={receiving.vendor_name}
          operationName={receiving.service_name}
          partName={receiving.job?.job_number ?? ''}
          openSlips={[
            {
              id: receiving.id,
              slip_number: receiving.slip_number,
              shipped_at: receiving.shipped_at,
              outstanding: outstandingOn(receiving),
              poLine: receivePoLineFor(receiving),
            },
          ]}
          busy={busy}
          onClose={() => setReceiving(null)}
          onSubmit={async (v) => {
            setBusy(true);
            setNotice(null);
            try {
              // The SAME function the operation card calls. Two surfaces, one
              // write path -- which is what stops them drifting.
              await receiveOutsideShipment(receiving.id, {
                quantityGood: v.quantityGood,
                closeShipment: v.closeShipment,
              });
              posthog.capture('outside shipment received', {
                surface: 'office',
                is_full: v.quantityGood >= outstandingOn(receiving),
                short_closed: Boolean(v.closeShipment),
                was_backfilled: false,
                days_at_vendor_bucket: daysAtVendorBucket(receiving.shipped_at),
              });
              // The same after-the-receipt step as the operation card: the receipt stands either way.
              // This drawer reads slips only, so it cannot tell a receipt that completes the line;
              // the step itself counts the database's "nothing left to receive" as done.
              const lineClose = await closePoLineAfterReceipt(v.closePoLine, v.quantityGood);
              if (lineClose?.kind === 'failed') setNotice({ severity: 'warning', text: lineClose.message });
              setReceiving(null);
              setReloadKey((n) => n + 1);
              onReceived?.();
            } catch (err) {
              // A refused receipt closes the dialog and says why here: the dialog has no error
              // slot of its own, and a failure nobody sees reads as a click that did nothing.
              setReceiving(null);
              setNotice({
                severity: 'error',
                text: err instanceof Error && err.message ? err.message : 'Failed to record the receipt.',
              });
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </Drawer>
  );
}
