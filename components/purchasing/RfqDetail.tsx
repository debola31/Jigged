'use client';

/**
 * One RFQ (plan §3.9, §3.13; Pattern B in docs/design-system.md): the number, status and dates
 * inline; what is being priced; the vendors asked; the comparison and the award.
 *
 * ONE REFRESH. Every write on the page — a vendor marked sent, a quote recorded, an award, close,
 * reopen — calls `refreshAfterWrite`, which re-reads the RFQ in place through `useLoad.refresh`, so
 * nothing blanks to a spinner and no surface is left stale (interaction-standards §2, invariant 3).
 *
 * Read-only states are explicit: an ARCHIVED RFQ opened by id renders with a banner and no actions;
 * a CLOSED one keeps preview and email, says how to reopen, and offers nothing that would be refused.
 */
import { useCallback, useState } from 'react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';

import DeleteImpactDialog from '@/components/common/DeleteImpactDialog';
import ErrorAlert from '@/components/common/ErrorAlert';
import LoadFailedState from '@/components/common/LoadFailedState';
import StatusChip from '@/components/common/StatusChip';
import { useLoad } from '@/hooks/useLoad';
import { formatDateOnly, todayLocalISODate } from '@/lib/localDate';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import { VENDOR_RFQ_STATUS_CONFIG } from '@/lib/purchasing/vendorPoStatus';
import { purchasingHubPath } from '@/lib/purchasingRoutes';
import { getVendorRfq, setVendorRfqState } from '@/utils/vendorRfqAccess';
import type { VendorRfqDetail } from '@/types/vendorRfq';

import RfqCompareMatrix from './RfqCompareMatrix';
import RfqForm from './RfqForm';
import RfqPreviewDialog from './RfqPreviewDialog';
import RfqResponseEditor from './RfqResponseEditor';
import RfqVendorsCard from './RfqVendorsCard';

export interface RfqDetailProps {
  companyId: string;
  rfqId: string;
}

function archiveImpact(rfq: VendorRfqDetail): string[] {
  const lines: string[] = [];
  if (rfq.awardedLineCount > 0) lines.push('Draft POs made from it stay as they are.');
  if (rfq.sentCount > 0) {
    lines.push(
      rfq.sentCount === 1
        ? 'The vendor you sent it to still has their copy.'
        : `The ${rfq.sentCount} vendors you sent it to still have their copies.`,
    );
  }
  lines.push('To stop asking for prices but keep it on the list, close it instead.');
  return lines;
}

export default function RfqDetail({ companyId, rfqId }: RfqDetailProps) {
  const router = useRouter();
  const [today] = useState(() => todayLocalISODate());
  const { data: rfq, loading, error, reload, refresh } = useLoad(
    () => getVendorRfq(rfqId, { today }),
    [rfqId, today],
  );
  const refreshAfterWrite = useCallback(() => {
    void refresh();
  }, [refresh]);

  const [editing, setEditing] = useState(false);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [quoteFor, setQuoteFor] = useState<string | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const hubHref = purchasingHubPath(companyId, 'rfqs');

  if (loading && !rfq) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (error && !rfq) {
    return (
      <Card>
        <CardContent sx={{ textAlign: 'center', py: 6 }}>
          <LoadFailedState error={error} entity="this RFQ" onRetry={() => void reload()} />
        </CardContent>
      </Card>
    );
  }
  if (!rfq) {
    return (
      <Box>
        <Button component={NextLink} href={hubHref} startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
          Back to RFQs
        </Button>
        <Alert severity="error">RFQ not found. It may have been removed, or the link is wrong.</Alert>
      </Box>
    );
  }

  if (editing) {
    return (
      <RfqForm
        companyId={companyId}
        rfq={rfq}
        onSaved={() => {
          setEditing(false);
          refreshAfterWrite();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const { header } = rfq;
  const archived = header.isArchived;
  const closed = header.closedAt !== null;
  const readOnly = archived || closed;
  const status = VENDOR_RFQ_STATUS_CONFIG[rfq.status];

  const runState = async (action: 'close' | 'reopen' | 'archive') => {
    setActing(true);
    setActionError(null);
    try {
      if (action === 'close') await setVendorRfqState(header.id, 'close', closeReason.trim() || null);
      else await setVendorRfqState(header.id, action);
      if (action === 'archive') {
        setArchiveOpen(false);
        router.push(hubHref);
        return;
      }
      setCloseOpen(false);
      setCloseReason('');
      refreshAfterWrite();
    } catch (err) {
      setActionError(err);
    } finally {
      setActing(false);
    }
  };

  const dates = [
    header.respondByOn ? `Respond by ${formatDateOnly(header.respondByOn)}` : 'No respond-by date',
    header.neededByOn ? `Needed by ${formatDateOnly(header.neededByOn)}` : null,
    `Created ${formatDateOnly(header.createdAt)}`,
  ].filter((s): s is string => s !== null);

  return (
    <Box>
      {/* Back, then the document's actions; delete (archive) sits rightmost. */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <Button component={NextLink} href={hubHref} startIcon={<ArrowBackIcon />} sx={{ color: 'text.secondary' }}>
          Back to RFQs
        </Button>
        {!archived && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            {!closed && (
              <Button variant="outlined" startIcon={<EditIcon />} onClick={() => setEditing(true)} disabled={acting}>
                Edit
              </Button>
            )}
            {closed ? (
              <Button variant="outlined" onClick={() => runState('reopen')} disabled={acting}>
                Reopen
              </Button>
            ) : (
              <Button variant="outlined" onClick={() => setCloseOpen(true)} disabled={acting}>
                Close RFQ
              </Button>
            )}
            <Tooltip title="Delete RFQ">
              <span>
                <IconButton
                  color="error"
                  aria-label="Delete RFQ"
                  onClick={() => setArchiveOpen(true)}
                  disabled={acting}
                  sx={{ minWidth: 48, minHeight: 48 }}
                >
                  <DeleteIcon />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        )}
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1 }}>
        <Typography variant="h5" component="h1" sx={{ fontWeight: 600 }}>
          {header.rfqNumber}
        </Typography>
        <StatusChip label={status.label} color={status.color} />
        {archived && <StatusChip label="Archived" color="default" />}
      </Box>
      {header.title && (
        <Typography variant="body1" sx={{ mb: 0.5 }}>
          {header.title}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {dates.join(' · ')}
      </Typography>

      {archived && (
        <Alert severity="info" sx={{ mb: 2 }}>
          This RFQ is archived. It&apos;s shown read-only.
        </Alert>
      )}
      {!archived && closed && (
        <Alert severity="info" sx={{ mb: 2 }}>
          This RFQ is closed{header.closedAt ? ` (${formatDateOnly(header.closedAt)})` : ''}
          {header.closedReason ? ` — ${header.closedReason}` : ''}. Reopen it to send it, record quotes or award.
        </Alert>
      )}
      <ErrorAlert error={actionError} entity="RFQ" onClose={() => setActionError(null)} sx={{ mb: 2 }} />

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
            What&apos;s being priced
          </Typography>
          {rfq.lines.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No lines yet.
            </Typography>
          ) : (
            <Box component="ol" sx={{ m: 0, pl: 3 }}>
              {[...rfq.lines]
                .sort((a, b) => a.lineNumber - b.lineNumber)
                .map((line) => (
                  <Box component="li" key={line.id} sx={{ mb: 1 }}>
                    {line.partName ? (
                      <>
                        <Typography variant="body1" component="span" sx={{ fontWeight: 600 }}>
                          {line.partName}
                        </Typography>
                        {line.description !== line.partName && (
                          <Typography variant="body2" color="text.secondary" component="div">
                            {line.description}
                          </Typography>
                        )}
                      </>
                    ) : (
                      <Typography variant="body1" component="span" sx={{ fontWeight: 600 }}>
                        {line.description}
                      </Typography>
                    )}
                    <Typography variant="body2" component="div">
                      {line.quantities.map((q) => formatUnitQuantity(q)).join(', ')} {unitLabel(line.unit)}
                      {line.certRequired ? ' · Certs required' : ''}
                      {line.jobNumber ? ` · For ${line.jobNumber}` : ''}
                    </Typography>
                    {line.notes && (
                      <Typography variant="body2" color="text.secondary" component="div">
                        Note: {line.notes}
                      </Typography>
                    )}
                  </Box>
                ))}
            </Box>
          )}
          {(header.notesToVendors || header.internalNotes) && (
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, mt: 2 }}>
              {header.notesToVendors && (
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                    Notes to vendors (printed)
                  </Typography>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {header.notesToVendors}
                  </Typography>
                </Box>
              )}
              {header.internalNotes && (
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                    Internal notes (never printed)
                  </Typography>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {header.internalNotes}
                  </Typography>
                </Box>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      <Box sx={{ mb: 3 }}>
        <RfqVendorsCard
          companyId={companyId}
          rfq={rfq}
          readOnly={readOnly}
          onPreview={setPreviewFor}
          onRecordQuote={setQuoteFor}
          onChanged={refreshAfterWrite}
        />
      </Box>

      <RfqCompareMatrix
        companyId={companyId}
        rfq={rfq}
        today={today}
        readOnly={readOnly}
        onAwarded={refreshAfterWrite}
      />

      <RfqPreviewDialog
        open={previewFor !== null}
        rfq={rfq}
        invitationId={previewFor}
        onClose={() => setPreviewFor(null)}
        onMarkedSent={refreshAfterWrite}
        readOnly={readOnly}
      />

      {quoteFor && (
        <RfqResponseEditor
          key={quoteFor}
          open
          rfq={rfq}
          invitationId={quoteFor}
          onClose={() => setQuoteFor(null)}
          onSaved={refreshAfterWrite}
        />
      )}

      <Dialog open={closeOpen} onClose={() => !acting && setCloseOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Close {header.rfqNumber}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            A closed RFQ stays on the list with its quotes, but takes no more quotes or awards. You can reopen it
            later.
          </Typography>
          <TextField
            label="Reason (optional)"
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            fullWidth
            disabled={acting}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCloseOpen(false)} disabled={acting}>
            Keep it open
          </Button>
          <Button variant="contained" onClick={() => runState('close')} disabled={acting}>
            Close it
          </Button>
        </DialogActions>
      </Dialog>

      <DeleteImpactDialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onConfirm={() => runState('archive')}
        loading={acting}
        entityLabel="RFQ"
        count={1}
        impactLines={archiveImpact(rfq)}
        revivableByName={false}
      />
    </Box>
  );
}
