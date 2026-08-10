'use client';

/**
 * Adjust — the audit of ONE place, in a dialog.
 *
 * ## Why this is not the worksheet
 *
 * `Adjust` navigated to the count worksheet at every scope, and at a single bin that was a page
 * transition, a two-step wizard, a search field over two rows, a *"found something not listed?"*
 * picker and a bulk put-away panel — to say that the Yard holds 175 blanks rather than 180. The
 * other three verbs are dialogs that leave the grid where it is; this one threw the screen away.
 *
 * The rule the split follows, which is the same one `Move` already obeys:
 *
 * > **One place is a dialog. Many places are the worksheet.**
 *
 * A leaf opens this. A container still opens the worksheet, because auditing a 12 × 15 cabinet is a
 * walk of the shop with search, paging and per-line commit reporting — a bounded task that earns
 * its own screen. Nothing about the write differs: both paths end in `commitCount`, so both produce
 * the same `adjustment` rows with the same note.
 *
 * ## Every part at once, not one at a time
 *
 * The operator's `Adjust` is single-part, because a phone user arrives from a part's own card. Here
 * you arrive from the *place*, having just counted what is in it — so the dialog lists everything
 * there and takes a number per row. A bin holding one part renders one row, which is the
 * single-part case for free.
 *
 * ## A blank is not a zero
 *
 * Only rows with a number typed into them are committed. A missing entry means *"not counted"* and
 * leaves the balance alone — never coerced to 0, so walking past a part cannot empty it. This is
 * the worksheet's own rule (`CountEntries`) and breaking it here would make the two doors disagree
 * about what an untouched row means.
 */

import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import ErrorAlert from '@/components/common/ErrorAlert';
import { getCurrentMember } from '@/utils/operatorAccess';
import { getLocationContents } from '@/utils/inventoryLocationsAccess';
import { commitCount } from '@/utils/inventoryCountAccess';
import type { CountVariance } from '@/types/inventoryCount';
import type { LocationContent } from '@/types/inventoryLocations';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface PlaceAdjustModalProps {
  open: boolean;
  companyId: string;
  locationId: string;
  /** The bare name. This dialog only ever spans one place, so a full path would repeat itself. */
  locationName: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

export default function PlaceAdjustModal({
  open,
  companyId,
  locationId,
  locationName,
  onClose,
  onDone,
}: PlaceAdjustModalProps) {
  const [rows, setRows] = useState<LocationContent[]>([]);
  const [clipped, setClipped] = useState(0);
  const [loading, setLoading] = useState(false);
  /** part id → what was typed, verbatim. Kept as strings so a half-typed "1." is not a number yet. */
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ partName: string; message: string }>>([]);
  const [error, setError] = useState<unknown>(null);
  const [operatorId, setOperatorId] = useState<string | null>(null);

  /** House convention: load on `Dialog` enter, never a setState-in-effect. */
  const handleEnter = async () => {
    setEntries({});
    setFailures([]);
    setProgress(null);
    setError(null);
    setLoading(true);

    getCurrentMember(companyId)
      .then((m) => setOperatorId(m?.id ?? null))
      .catch(() => setOperatorId(null));

    try {
      const page = await getLocationContents(locationId);
      setRows(page.contents);
      setClipped(Math.max(0, page.total - page.contents.length));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  /** Rows carrying a usable number. A blank, a stray minus, a half-typed decimal are all "not counted". */
  const counted = useMemo(
    () =>
      rows
        .map((r) => ({ row: r, value: parseFloat(entries[r.part_id] ?? '') }))
        .filter((c) => Number.isFinite(c.value) && c.value >= 0),
    [rows, entries],
  );

  const save = async () => {
    if (counted.length === 0) return;
    setSaving(true);
    setError(null);
    setFailures([]);
    try {
      /*
       * Re-read before building the variances.
       *
       * The delta has to be measured against what the balance is NOW, not against the snapshot this
       * dialog opened with — an operator may have moved something out of this bin while it sat
       * open. The worksheet re-reads for the same reason at its own save.
       */
      const fresh = await getLocationContents(locationId);
      const nowByPart = new Map(fresh.contents.map((c) => [c.part_id, c.quantity] as const));

      const variances: CountVariance[] = counted.map(({ row, value }) => {
        const systemQuantity = nowByPart.get(row.part_id) ?? row.quantity;
        return {
          candidate: {
            partId: row.part_id,
            partName: row.part_name,
            description: null,
            unit: row.primary_unit || 'ea',
            systemQuantity,
            target: {
              locationId,
              locationName,
              // One place, so the path IS the name — the dialog title already says where.
              locationPath: locationName,
            },
          },
          counted: value,
          delta: value - systemQuantity,
          movedSinceOpened: systemQuantity !== row.quantity,
        };
      });

      setProgress({ done: 0, total: variances.length });
      const result = await commitCount(variances, {
        operatorId,
        onProgress: (p) => setProgress({ done: p.done, total: p.total }),
      });

      if (result.failures.length > 0) {
        // A partial save is reported, never rolled back: the lines that committed are real
        // observations about a shelf and re-counting them would be asking twice.
        setFailures(result.failures.map((f) => ({ partName: f.partName, message: f.message })));
        setProgress(null);
        await onDone();
        return;
      }
      await onDone();
      onClose();
    } catch (e) {
      setError(e);
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
      slotProps={{ transition: { onEnter: handleEnter } }}
    >
      <DialogTitle>Adjust what&apos;s in {locationName}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Type what you actually counted. Anything you leave blank is left alone.
          </Typography>

          {error != null && <ErrorAlert error={error} />}

          {failures.length > 0 && (
            <Alert severity="warning">
              {counted.length - failures.length} saved. These did not:{' '}
              {failures.map((f) => `${f.partName} (${f.message})`).join('; ')}
            </Alert>
          )}

          {clipped > 0 && (
            <Alert severity="info">
              Showing the {rows.length} largest of {num(rows.length + clipped)} parts here.
            </Alert>
          )}

          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          ) : rows.length === 0 ? (
            <Alert severity="info">
              Nothing is recorded at {locationName} yet, so there is nothing to adjust. Use{' '}
              <strong>Add</strong> to put something here.
            </Alert>
          ) : (
            <Stack spacing={1.5}>
              {rows.map((r) => {
                const typed = entries[r.part_id] ?? '';
                const value = parseFloat(typed);
                const has = Number.isFinite(value) && value >= 0;
                const delta = has ? value - r.quantity : 0;
                const unit = r.primary_unit || 'ea';
                return (
                  <Stack
                    key={r.part_id}
                    direction="row"
                    spacing={2}
                    alignItems="center"
                    sx={{ minHeight: 48 }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" noWrap title={r.part_name}>
                        {r.part_name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Recorded {num(r.quantity)} {unit}
                      </Typography>
                    </Box>
                    <TextField
                      size="small"
                      type="number"
                      label="Counted"
                      value={typed}
                      onChange={(e) =>
                        setEntries((s) => ({ ...s, [r.part_id]: e.target.value }))
                      }
                      sx={{ width: 130 }}
                      slotProps={{ htmlInput: { min: 0, step: 'any' } }}
                      /*
                       * The variance, on the row, as it is typed.
                       *
                       * A review step used to restate these on a screen of their own and was
                       * removed: it repeated what the counter had understood the instant they typed
                       * it. Showing the delta here is what made that step redundant, and it has to
                       * keep doing that job in this dialog too.
                       */
                      helperText={has && delta !== 0 ? `${delta > 0 ? '+' : ''}${num(delta)}` : ' '}
                    />
                  </Stack>
                );
              })}
            </Stack>
          )}

          {progress && progress.total > 0 && (
            <Box>
              <LinearProgress
                variant="determinate"
                value={(progress.done / progress.total) * 100}
              />
              <Typography variant="caption" color="text.secondary">
                Saving {progress.done} of {progress.total}…
              </Typography>
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          {failures.length > 0 ? 'Close' : 'Cancel'}
        </Button>
        <Button variant="contained" onClick={save} disabled={saving || counted.length === 0}>
          {saving
            ? 'Saving…'
            : counted.length === 0
              ? 'Save'
              : `Save ${counted.length} count${counted.length === 1 ? '' : 's'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
