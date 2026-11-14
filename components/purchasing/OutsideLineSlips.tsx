'use client';

import { useId, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MuiLink from '@mui/material/Link';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import ErrorAlert from '@/components/common/ErrorAlert';
import LoadFailedState from '@/components/common/LoadFailedState';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import { useLoad } from '@/hooks/useLoad';
import { formatDateOnly } from '@/lib/localDate';
import { formatUnitQuantity } from '@/lib/purchasing/purchaseUnits';
import { listUnlinkedOutsideSlips, relinkOutsideShipment } from '@/utils/vendorPoAccess';
import type { VendorPoDetail, VendorPoLine, VendorPoOutsideSlip, VendorPoUnlinkedSlip } from '@/types/vendorPo';

export interface OutsideLineSlipsProps {
  po: VendorPoDetail;
  /** The outside-service line the slips ship against. */
  line: VendorPoLine;
  /** Its linked slips, oldest first — voided ones included, shown as voided. */
  slips: readonly VendorPoOutsideSlip[];
  /** The PO can change — not archived, not closed: the gate every other line action uses. */
  canCorrect: boolean;
  /** Open a slip in its preview, where Void lives. */
  onOpenSlip: (slipId: string) => void;
  /** After a link or an unlink lands, with the sentence to show: the page runs its one refresh. */
  onChanged: (message: string) => void;
}

/** "100 sent 11/4/2026 · 60 back · due 11/25/2026" — what a slip says, as the line lists it. */
function slipSummary(slip: VendorPoUnlinkedSlip): string {
  const shipped = formatDateOnly(slip.shippedAt.slice(0, 10));
  const parts = [`${formatUnitQuantity(slip.quantity)} sent ${shipped}`, `${formatUnitQuantity(slip.receivedQuantity)} back`];
  if (slip.voidedAt) parts.push('voided');
  else if (slip.closedAt) parts.push('closed');
  else if (slip.dueBackOn) parts.push(`due ${formatDateOnly(slip.dueBackOn)}`);
  return parts.join(' · ');
}

/** What an unlink changes, said before it happens — and what it leaves alone, and the way back. */
function unlinkConsequence(slip: VendorPoOutsideSlip, line: VendorPoLine): string {
  const n = line.lineNumber;
  const back =
    slip.receivedQuantity > 0
      ? ` — the ${formatUnitQuantity(slip.receivedQuantity)} back on it come off what line ${n} has received`
      : '';
  const wayBack = line.closedAt === null ? 'Link a slip… puts it back.' : `To link it back, reopen line ${n} first.`;
  return (
    `${slip.slipNumber} stops counting toward line ${n}'s received quantity${back}. ` +
    `The slip itself and the step on the job don't change. ${wayBack}`
  );
}

/**
 * An outside-service line's vendor packing slips on the PO page (plan §3.6, §3.13), and the
 * explicit correction of which slips the line counts.
 *
 * The slip stays the only record of movement; the line's sent, back and at-vendor figures are read
 * from the slips linked to it. Slips link THEMSELVES — at the send, to the step's one open line, and
 * when a line is inserted, picking up the step's live unlinked slips — so a hand correction is
 * rare, and it lives here, beside the slips it changes (the send dialog points here):
 *
 * - **Unlink** on a live slip asks first, in a light confirm that says what changes: the slip stops
 *   counting toward this line's received quantity. It is not destructive — nothing is deleted and it
 *   links back — so it is an ordinary button, not a red one.
 * - **Link a slip…** reads, only when asked, the step's live slips to this vendor that ship against
 *   no line (`listUnlinkedOutsideSlips`). A slip on another PO's line is unlinked there first, where
 *   the person can see what leaving costs that line.
 *
 * Both go through `relinkOutsideShipment`; a refusal's sentence shows in the dialog, which stays open;
 * success hands the page a sentence and its one refresh. Neither is offered on an archived or closed
 * PO (`canCorrect`), and Link not on a closed line — the database refuses a link there.
 *
 * NOT INSTRUMENTED, deliberately (plan §3.14): slip relink is a rare correction, not a behaviour
 * worth counting.
 */
export default function OutsideLineSlips({ po, line, slips, canCorrect, onOpenSlip, onChanged }: OutsideLineSlipsProps) {
  // The slip stays while the confirm fades out, so its title never flashes to a placeholder.
  const [unlink, setUnlink] = useState<{ slip: VendorPoOutsideSlip; open: boolean } | null>(null);
  const [unlinkSaving, setUnlinkSaving] = useState(false);
  const [unlinkError, setUnlinkError] = useState<unknown>(null);
  const [linking, setLinking] = useState(false);
  // Held here, not in the body, so neither dialog can be dismissed mid-write and swallow a refusal.
  const [linkSaving, setLinkSaving] = useState(false);
  const unlinkTitleId = useId();
  const linkTitleId = useId();

  const jobOperationId = line.jobOperationId;
  const canLink = canCorrect && line.closedAt === null && jobOperationId !== null;

  const startUnlink = (slip: VendorPoOutsideSlip) => {
    setUnlink({ slip, open: true });
    setUnlinkError(null);
  };
  const closeUnlink = () => setUnlink((u) => (u ? { ...u, open: false } : u));

  const confirmUnlink = async () => {
    if (!unlink) return;
    const { slip } = unlink;
    setUnlinkSaving(true);
    setUnlinkError(null);
    try {
      await relinkOutsideShipment(slip.id, null);
      closeUnlink();
      onChanged(`${slip.slipNumber} no longer counts toward line ${line.lineNumber}.`);
    } catch (err) {
      setUnlinkError(err);
    } finally {
      setUnlinkSaving(false);
    }
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        Sent {formatUnitQuantity(line.sentQuantity ?? 0)} · back {formatUnitQuantity(line.receivedQuantity)} · at
        vendor {formatUnitQuantity(line.atVendorQuantity ?? 0)}
      </Typography>
      <Stack spacing={0.25} sx={{ mt: 0.5 }}>
        {slips.map((slip) => (
          <Box key={slip.id} sx={{ display: 'flex', alignItems: 'center', columnGap: 1, flexWrap: 'wrap' }}>
            <MuiLink component="button" type="button" onClick={() => onOpenSlip(slip.id)} sx={{ fontWeight: 600 }}>
              {slip.slipNumber}
            </MuiLink>
            <Typography variant="caption" color="text.secondary">
              {slipSummary(slip)}
            </Typography>
            {/* A voided slip counts for nothing already, and the database refuses to move one. */}
            {canCorrect && !slip.voidedAt && (
              <Button size="small" onClick={() => startUnlink(slip)} aria-label={`Unlink ${slip.slipNumber}`}>
                Unlink
              </Button>
            )}
          </Box>
        ))}
        {slips.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            No slips yet — sending from the job links them here.
          </Typography>
        )}
      </Stack>
      {canLink && (
        <Button size="small" onClick={() => setLinking(true)} sx={{ mt: 0.5 }}>
          Link a slip…
        </Button>
      )}

      {unlink && (
        <Dialog
          open={unlink.open}
          onClose={() => !unlinkSaving && closeUnlink()}
          maxWidth="xs"
          fullWidth
          aria-labelledby={unlinkTitleId}
        >
          <DialogTitle id={unlinkTitleId}>
            Unlink {unlink.slip.slipNumber} from line {line.lineNumber}?
          </DialogTitle>
          <DialogContent>
            <Typography variant="body2">{unlinkConsequence(unlink.slip, line)}</Typography>
            {unlinkError != null && (
              <ErrorAlert error={unlinkError} entity="slip" onClose={() => setUnlinkError(null)} sx={{ mt: 2 }} />
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={closeUnlink} disabled={unlinkSaving}>
              Keep it linked
            </Button>
            <Button variant="contained" onClick={() => void confirmUnlink()} disabled={unlinkSaving}>
              {unlinkSaving ? 'Unlinking…' : 'Unlink'}
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {jobOperationId !== null && (
        <Dialog
          open={linking}
          onClose={() => !linkSaving && setLinking(false)}
          maxWidth="sm"
          fullWidth
          aria-labelledby={linkTitleId}
        >
          <DialogTitle id={linkTitleId}>Link a slip to line {line.lineNumber}</DialogTitle>
          {linking && (
            <LinkSlipBody
              po={po}
              line={line}
              jobOperationId={jobOperationId}
              saving={linkSaving}
              onSavingChange={setLinkSaving}
              onClose={() => setLinking(false)}
              onLinked={(done) => {
                setLinking(false);
                onChanged(done);
              }}
            />
          )}
        </Dialog>
      )}
    </Box>
  );
}

/**
 * The Link dialog's body, mounted only while it is open: the candidates are read when asked, never
 * with the page, and a reopened dialog starts clean.
 */
function LinkSlipBody({
  po,
  line,
  jobOperationId,
  saving,
  onSavingChange,
  onClose,
  onLinked,
}: {
  po: VendorPoDetail;
  line: VendorPoLine;
  jobOperationId: string;
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onLinked: (done: string) => void;
}) {
  const { companyId, vendorId, vendorName } = po.header;
  const { data: slips, loading, error, reload } = useLoad(
    () => listUnlinkedOutsideSlips(companyId, jobOperationId, vendorId),
    [companyId, jobOperationId, vendorId],
  );
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const listLabelId = useId();

  if (loading && !slips) {
    return (
      <DialogContent sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Loading the slips" />
      </DialogContent>
    );
  }
  // "Couldn't load" must never read as "nothing to link".
  if (!slips) {
    return (
      <>
        <DialogContent sx={{ textAlign: 'center' }}>
          <LoadFailedState error={error} entity="the slips to link" onRetry={() => void reload()} />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </>
    );
  }

  // The only candidate is the choice already; with several, the person picks.
  const picked = slips.find((s) => s.id === chosenId) ?? (slips.length === 1 ? slips[0] : null);
  const step = [line.operationLabel ?? 'this step', line.jobNumber ? `on ${line.jobNumber}` : null].filter(Boolean).join(' ');

  const link = async () => {
    if (!picked) return;
    onSavingChange(true);
    setSaveError(null);
    try {
      await relinkOutsideShipment(picked.id, line.id);
      onLinked(`${picked.slipNumber} now counts toward line ${line.lineNumber}.`);
    } catch (err) {
      setSaveError(err);
    } finally {
      onSavingChange(false);
    }
  };

  return (
    <>
      <DialogContent dividers>
        {slips.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nothing to link. Every slip sent to {vendorName} for {step} is on a purchase order line already,
            or voided. To move one here from another PO, unlink it there first.
          </Typography>
        ) : (
          <>
            <Typography id={listLabelId} variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Slips for {step} sent to {vendorName} that ship against no purchase order line. The one you link
              counts toward line {line.lineNumber}&apos;s received quantity.
            </Typography>
            <RadioGroup
              aria-labelledby={listLabelId}
              value={picked?.id ?? ''}
              onChange={(e) => setChosenId(e.target.value)}
            >
              {slips.map((s) => (
                <FormControlLabel
                  key={s.id}
                  value={s.id}
                  control={<Radio />}
                  label={
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {s.slipNumber}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {slipSummary(s)}
                      </Typography>
                    </Box>
                  }
                />
              ))}
            </RadioGroup>
          </>
        )}
        {saveError != null && (
          <ErrorAlert error={saveError} entity="slip" onClose={() => setSaveError(null)} sx={{ mt: 2 }} />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, flexDirection: 'column', alignItems: 'stretch', gap: 1 }}>
        <MissingFieldsNotice
          title="Before you can link:"
          items={slips.length > 0 && !picked ? ['Choose the slip to link.'] : []}
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button onClick={onClose} disabled={saving}>
            {slips.length === 0 ? 'Close' : 'Cancel'}
          </Button>
          {slips.length > 0 && (
            <Button variant="contained" onClick={() => void link()} disabled={!picked || saving}>
              {saving ? 'Linking…' : picked ? `Link ${picked.slipNumber}` : 'Link the slip'}
            </Button>
          )}
        </Box>
      </DialogActions>
    </>
  );
}
