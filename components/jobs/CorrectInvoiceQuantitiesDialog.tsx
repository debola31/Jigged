'use client';

import { useCallback, useState } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import BusyButton from '@/components/common/BusyButton';
import { isValidQuantityInput } from '@/lib/quantityInput';
import {
  correctInvoiceRecordedQuantities,
  getJobPartInvoiceSummaries,
  type JobPartInvoiceSummary,
  type QuickBooksInvoiceView,
} from '@/utils/quickbooksAccess';

function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Correct the per-part quantities Jigged RECORDED against one invoice.
 *
 * WHY THIS EXISTS. Before partial invoicing, billing half a job meant pushing the
 * whole invoice from Jigged and editing it down in QuickBooks. The 2026-07-02
 * backfill (20260702011324 §7b) then recorded every legacy invoice as having billed
 * the FULL ordered quantity, so those jobs read as fully invoiced and the remainder
 * could never be billed — reported live on J-0018. The shop is the only party that
 * knows what its QuickBooks document actually billed, which is why this is a tool
 * rather than a migration.
 *
 * It corrects JIGGED'S NOTE, never the QuickBooks document: the invoice keeps its
 * number, its date and its payment status. Lowering a recorded quantity reopens the
 * un-billed remainder through the existing triggers, and the ordinary Create invoice
 * flow bills it.
 *
 * The dialog shows the real document rather than guessing at the discrepancy for
 * her. `qb_total_amt` is tax-inclusive and so not comparable with Jigged's line
 * total (docs/modules/invoicing.md:102, 121-124) — it cannot prove anything is
 * wrong — so the honest affordance is a link to the invoice she can read the
 * quantities off.
 */
export default function CorrectInvoiceQuantitiesDialog({
  open,
  jobId,
  jobNumber,
  invoices,
  onClose,
  onCorrected,
}: {
  open: boolean;
  jobId: string;
  jobNumber: string;
  invoices: QuickBooksInvoiceView[];
  onClose: () => void;
  onCorrected: (message: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [qtyById, setQtyById] = useState<Record<string, string>>({});
  const [summaries, setSummaries] = useState<JobPartInvoiceSummary[] | null>(null);
  const [capUnknown, setCapUnknown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A voided invoice already counts for nothing, so it has no recorded quantity to
  // correct and the RPC refuses it. Filtered here so it is never offered.
  const correctable = invoices.filter((inv) => inv.voidedAt === null && inv.lines.length > 0);

  const selectLines = (inv: QuickBooksInvoiceView) => {
    const initial: Record<string, string> = {};
    for (const l of inv.lines) initial[l.jobPartId] = String(l.quantity);
    setQtyById(initial);
    setSelectedId(inv.id);
  };

  // House convention: load on dialog enter, not in a useEffect.
  const onEnter = useCallback(async () => {
    setError(null);
    setSelectedId(null);
    setQtyById({});
    setCapUnknown(false);
    setLoading(true);
    try {
      setSummaries(await getJobPartInvoiceSummaries(jobId));
    } catch {
      // Not fatal -- the invoice's own lines come from the list this dialog was
      // handed, and the server enforces the cap regardless. But it is SAID, not
      // swallowed: without the ordered quantities the field cannot refuse a
      // too-high number up front, and a Save that ends in a refusal is the
      // confirm-then-error dead end interaction-standards.md §4 rules out.
      setSummaries(null);
      setCapUnknown(true);
    } finally {
      setLoading(false);
    }
    if (correctable.length === 1) selectLines(correctable[0]);
  }, [jobId, correctable.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = correctable.find((inv) => inv.id === selectedId) ?? null;
  const orderedFor = (jobPartId: string): number | null =>
    summaries?.find((s) => s.job_part_id === jobPartId)?.qty_ordered ?? null;
  const invoicedFor = (jobPartId: string): number | null =>
    summaries?.find((s) => s.job_part_id === jobPartId)?.qty_invoiced ?? null;

  /** The most this invoice may record of a part: what the job ordered, less what
   *  OTHER invoices already record against it. Mirrors the server's cap. */
  const ceilingFor = (jobPartId: string, recorded: number): number | null => {
    const ordered = orderedFor(jobPartId);
    const invoiced = invoicedFor(jobPartId);
    if (ordered === null || invoiced === null) return null;
    return ordered - invoiced + recorded;
  };

  const typed = (jobPartId: string): number => {
    const n = parseFloat(qtyById[jobPartId] ?? '');
    return Number.isFinite(n) ? n : 0;
  };

  const lineError = (jobPartId: string, recorded: number): string | null => {
    const raw = qtyById[jobPartId] ?? '';
    if (raw.trim() === '') return 'Enter what this invoice billed.';
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) return 'Enter a quantity of zero or more.';
    const ceiling = ceilingFor(jobPartId, recorded);
    if (ceiling !== null && n > ceiling + 1e-9) {
      return `That is more than the job ordered — at most ${ceiling}.`;
    }
    return null;
  };

  const anyError = selected?.lines.some((l) => !!lineError(l.jobPartId, l.quantity)) ?? false;
  const changed =
    selected?.lines.some((l) => Math.abs(typed(l.jobPartId) - l.quantity) > 1e-9) ?? false;
  const allZero = selected?.lines.every((l) => typed(l.jobPartId) <= 0) ?? false;
  const newTotal =
    selected?.lines.reduce((sum, l) => sum + typed(l.jobPartId) * l.unitPrice, 0) ?? 0;

  /** What the shop gets back, named part by part — the consequence stated before
   *  the commit rather than discovered after it. */
  const reopening = (selected?.lines ?? [])
    .map((l) => ({ name: l.partName, qty: l.quantity - typed(l.jobPartId) }))
    .filter((r) => r.qty > 1e-9);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const result = await correctInvoiceRecordedQuantities(
        selected.id,
        selected.lines.map((l) => ({ jobPartId: l.jobPartId, quantity: typed(l.jobPartId) })),
      );
      posthog.capture('invoice record corrected', {
        provider: selected.provider,
        line_count: selected.lines.length,
        lines_changed: result.linesChanged,
        lines_removed: result.linesRemoved,
        reopened_a_part: reopening.length > 0,
      });
      onCorrected(
        `Updated what invoice ${selected.docNumber ? `#${selected.docNumber}` : ''} billed.`.replace(
          '  ',
          ' ',
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That correction could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      TransitionProps={{ onEnter: () => void onEnter() }}
    >
      <DialogTitle>
        {selected
          ? `Correct what invoice ${selected.docNumber ? `#${selected.docNumber}` : ''} billed`.replace(
              '  ',
              ' ',
            )
          : `Correct what an invoice billed on ${jobNumber}`}
      </DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : correctable.length === 0 ? (
          <Alert severity="info">
            There is no invoice on this job whose recorded quantities can be corrected.
          </Alert>
        ) : !selected ? (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Which invoice recorded the wrong quantity?
            </Typography>
            <List disablePadding>
              {correctable.map((inv) => (
                <ListItemButton key={inv.id} onClick={() => selectLines(inv)} divider>
                  <ListItemText
                    primary={`#${inv.docNumber ?? '—'} · ${formatCurrency(inv.total)}`}
                    secondary={
                      inv.correctedAt
                        ? `${formatDate(inv.createdAt)} · already corrected ${formatDate(inv.correctedAt)}`
                        : formatDate(inv.createdAt)
                    }
                  />
                </ListItemButton>
              ))}
            </List>
          </>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Jigged keeps its own note of how much of each part an invoice billed. If that note is
              too high, the rest of the job can never be invoiced. Enter what this invoice actually
              billed and the remainder opens back up.
            </Typography>

            {selected.url ? (
              <Typography variant="body2" sx={{ mb: 2 }}>
                <Link href={selected.url} target="_blank" rel="noopener">
                  Open #{selected.docNumber ?? ''} in QuickBooks
                  <OpenInNewIcon fontSize="inherit" sx={{ ml: 0.5, verticalAlign: 'middle' }} />
                </Link>{' '}
                to check the quantities against the invoice itself.
              </Typography>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                In QuickBooks press Ctrl+F, search Invoice # {selected.docNumber ?? ''}, and read the
                quantities off the invoice itself.
              </Typography>
            )}

            {capUnknown && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                Jigged couldn&apos;t read this job&apos;s ordered quantities just now, so it can&apos;t
                check your numbers against them here. A quantity above what was ordered will be
                refused when you save.
              </Alert>
            )}

            {selected.correctedAt && (
              <Alert severity="info" sx={{ mb: 2 }}>
                These quantities were already corrected on {formatDate(selected.correctedAt)}.
              </Alert>
            )}

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Part</TableCell>
                  <TableCell align="right">Jigged recorded</TableCell>
                  <TableCell align="right">Actually billed</TableCell>
                  <TableCell align="right">Amount</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {selected.lines.map((l) => {
                  const err = lineError(l.jobPartId, l.quantity);
                  const ordered = orderedFor(l.jobPartId);
                  return (
                    <TableRow key={l.jobPartId}>
                      <TableCell>
                        {l.partName}
                        <Typography variant="caption" color="text.secondary" display="block">
                          {ordered !== null ? `${ordered} ordered · ` : ''}
                          {formatCurrency(l.unitPrice)}/ea
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{l.quantity}</TableCell>
                      <TableCell align="right">
                        <TextField
                          value={qtyById[l.jobPartId] ?? ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === '' || isValidQuantityInput(v)) {
                              setQtyById((prev) => ({ ...prev, [l.jobPartId]: v }));
                            }
                          }}
                          size="small"
                          error={!!err}
                          helperText={err ?? ' '}
                          sx={{ width: 120 }}
                          slotProps={{
                            htmlInput: { inputMode: 'decimal', style: { textAlign: 'right' } },
                          }}
                        />
                      </TableCell>
                      <TableCell align="right">
                        {formatCurrency(typed(l.jobPartId) * l.unitPrice)}
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow>
                  <TableCell colSpan={3} align="right" sx={{ fontWeight: 600, border: 0 }}>
                    This invoice recorded
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, border: 0 }}>
                    {formatCurrency(newTotal)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            <Divider sx={{ my: 2 }} />

            {allZero ? (
              <Alert severity="warning">
                <AlertTitle>An invoice has to record at least some quantity</AlertTitle>
                To make this invoice count for nothing at all, void it in QuickBooks instead. Jigged
                picks that up and reopens the whole quantity.
              </Alert>
            ) : reopening.length > 0 ? (
              <Alert severity="info">
                {reopening.map((r) => `${r.qty} ${r.name}`).join(', ')} will reopen for invoicing.
                The QuickBooks invoice is not changed.
              </Alert>
            ) : (
              <Typography variant="body2" color="text.secondary">
                The QuickBooks invoice itself is never changed — only Jigged&apos;s note of what it
                billed.
              </Typography>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        {selected && (
          <BusyButton
            variant="contained"
            onClick={handleSave}
            pending={saving}
            pendingLabel="Saving correction…"
            disabled={saving || anyError || !changed || allZero}
          >
            Save correction
          </BusyButton>
        )}
      </DialogActions>
    </Dialog>
  );
}
