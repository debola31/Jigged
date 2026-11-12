'use client';

/**
 * "Use as part cost" — set a bought part's cost from one vendor's price sheet (plan §3.8; criteria
 * V3, V4). The ONE purchasing action that changes what a part costs, and it is explicit on purpose:
 * a price on a PO is a frozen term of that document and never becomes a cost by itself.
 *
 * The DATABASE does the maths. `preview_part_cost_from_vendor` proposes each existing tier's new
 * cost (writing nothing); this dialog only puts that into words, through lib/purchasing/sourcing.ts,
 * so it can never show a number the database did not compute. Confirming sends the preview back
 * EXACTLY as the database returned it (`preview.expected`), and `apply_part_cost_from_vendor`
 * refuses — "changed since you previewed" — unless what it would write is still what was shown.
 * Tier ids, quantities and markups stay as they are, so a quote flags "Pricing changed" only where
 * a price really moved.
 *
 * The consequences are counted separately, and a count that could not be taken reads "couldn't
 * count" — never 0, which would claim that nothing is affected.
 */
import { useState } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import ErrorAlert from '@/components/common/ErrorAlert';
import { useLoad } from '@/hooks/useLoad';
import { formatShortDate } from '@/lib/purchasing/priceDefault';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import { sourcingConsequences, sourcingPreviewRows } from '@/lib/purchasing/sourcing';
import {
  applyPartCostFromVendor,
  countBomParents,
  countOpenQuotesWithPart,
  previewPartCostFromVendor,
  toSourcingPreview,
} from '@/utils/partVendorsAccess';

export interface UseAsPartCostDialogProps {
  open: boolean;
  /** The approved-vendor row whose price sheet becomes the cost. */
  partVendorId: string | null;
  partId: string;
  partName: string;
  vendorName: string;
  /** The reader's local date: an expired sheet is refused by it. */
  today: string;
  onClose: () => void;
  /** After the apply: the part's cost changed. */
  onApplied: () => void;
}

function BeforeAfter({ before, after, changed }: { before: string; after: string; changed: boolean }) {
  if (!changed) {
    return (
      <Typography variant="body2" component="span">
        {after}{' '}
        <Typography variant="caption" component="span" color="text.secondary">
          (no change)
        </Typography>
      </Typography>
    );
  }
  return (
    <Box component="span" sx={{ display: 'inline-flex', gap: 0.75, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <Typography variant="body2" component="span" color="text.secondary">
        {before}
      </Typography>
      <Typography variant="body2" component="span" color="text.secondary" aria-hidden>
        →
      </Typography>
      <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
        {after}
      </Typography>
    </Box>
  );
}

export default function UseAsPartCostDialog({
  open,
  partVendorId,
  partId,
  partName,
  vendorName,
  today,
  onClose,
  onApplied,
}: UseAsPartCostDialogProps) {
  // Bumped by "Preview again" — a refused apply means the numbers on screen are no longer true.
  const [attempt, setAttempt] = useState(0);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);

  const { data, loading, error } = useLoad(async () => {
    if (!open || !partVendorId) return null;
    const [preview, openQuotes, bomParents] = await Promise.all([
      previewPartCostFromVendor(partVendorId, today),
      // A consequence that could not be counted is null — said as "couldn't count", never as 0.
      countOpenQuotesWithPart(partId, today).catch(() => null),
      countBomParents(partId).catch(() => null),
    ]);
    return { preview, openQuotes, bomParents };
  }, [open, partVendorId, partId, today, attempt]);

  // A failed re-preview must not leave the OLD numbers on screen with an Apply button under them:
  // useLoad keeps the previous data when a load rejects, so the latest error wins here.
  const preview = error ? null : (data?.preview ?? null);
  const rows = preview ? sourcingPreviewRows(toSourcingPreview(preview)) : [];
  const consequences = data
    ? sourcingConsequences({ openQuoteCount: data.openQuotes, bomParentCount: data.bomParents })
    : [];

  const handleApply = async () => {
    if (!preview || !partVendorId) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyPartCostFromVendor(partVendorId, today, preview.expected);
      posthog.capture('part cost sourced', {
        tiers_updated: result.updatedTierIds.length,
        tiers_added: result.insertedTierIds.length,
        unit_converted: preview.stockFactor !== 1,
        below_minimum: preview.tiers.some((t) => t.belowVendorMinimum),
      });
      onApplied();
      onClose();
    } catch (err) {
      setApplyError(err);
    } finally {
      setApplying(false);
    }
  };

  const previewAgain = () => {
    setApplyError(null);
    setAttempt((a) => a + 1);
  };

  const stock = preview?.stockUnit ? unitLabel(preview.stockUnit) : null;
  const sheetDates = preview
    ? [
        preview.quotedOn ? `quoted ${formatShortDate(preview.quotedOn)}` : null,
        preview.validUntil ? `good until ${formatShortDate(preview.validUntil)}` : null,
      ].filter((s): s is string => s !== null)
    : [];

  return (
    <Dialog open={open} onClose={() => !applying && onClose()} maxWidth="md" fullWidth>
      <DialogTitle>Use {vendorName}&apos;s price as the part cost</DialogTitle>
      <DialogContent dividers>
        {loading && !data && !error && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}
        {error ? (
          <Alert severity="error">
            {error instanceof Error ? error.message : "Couldn't preview the new cost. Try again."}
          </Alert>
        ) : null}

        {preview && (
          <>
            <Typography variant="body2" sx={{ mb: 1 }}>
              This sets {partName}&apos;s cost from {preview.vendorName}&apos;s price sheet
              {sheetDates.length > 0 ? ` (${sheetDates.join(', ')})` : ''}. Nothing changes until you press Use as
              part cost.
            </Typography>
            {preview.stockFactor !== 1 && stock && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {preview.vendorName} prices per {unitLabel(preview.purchaseUnit)} (1 {unitLabel(preview.purchaseUnit)} ={' '}
                {formatUnitQuantity(preview.stockFactor)} {stock}); the costs below are per {stock}.
              </Typography>
            )}

            {preview.inserts.length > 0 && (
              <Alert severity="info" sx={{ my: 1.5 }}>
                {partName} has no price breaks yet, so these are added at 0% markup. Set the markups on the Pricing
                card before you quote it.
              </Alert>
            )}

            <Table size="small" sx={{ my: 1.5 }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>Quantity</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Cost{stock ? ` per ${stock}` : ''}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Markup</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Price{stock ? ` per ${stock}` : ''}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell component="th" scope="row">
                      <Typography variant="body2">{r.quantityLabel}</Typography>
                      {r.note && (
                        <Typography variant="caption" color="text.secondary" component="div">
                          {r.note}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.isNew ? (
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {r.costAfter}
                        </Typography>
                      ) : (
                        <BeforeAfter before={r.costBefore} after={r.costAfter} changed={r.costChanged} />
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{r.markupLabel}</Typography>
                    </TableCell>
                    <TableCell>
                      {r.isNew ? (
                        <Typography variant="body2">{r.priceAfter}</Typography>
                      ) : (
                        <BeforeAfter before={r.priceBefore} after={r.priceAfter} changed={r.priceChanged} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
              What this changes
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 3 }}>
              {consequences.map((line) => (
                <Typography component="li" variant="body2" key={line} sx={{ mb: 0.5 }}>
                  {line}
                </Typography>
              ))}
            </Box>

            <ErrorAlert error={applyError} entity="part cost" sx={{ mt: 2 }} />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={applying}>
          Cancel
        </Button>
        {applyError ? (
          <Button variant="outlined" onClick={previewAgain} disabled={applying}>
            Preview again
          </Button>
        ) : null}
        {preview && (
          <Button variant="contained" onClick={handleApply} disabled={applying}>
            {applying ? 'Saving…' : 'Use as part cost'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
