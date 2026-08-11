'use client';

/**
 * Adjust — the audit of ONE place, in a dialog.
 *
 * ## Three columns: recorded, counted, changed
 *
 * The worksheet's own shape, brought here. `Recorded` is what the system believes, `Counted` is what
 * you found, `Changed` is the delta — and the third column is not decoration. A review step used to
 * restate these on a screen of its own and was deleted because it repeated what the counter had
 * already understood the instant they typed it; the delta on the row is what made that step
 * redundant, so it has to keep doing that job here.
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
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import ErrorAlert from '@/components/common/ErrorAlert';
import { getCurrentMember } from '@/utils/operatorAccess';
import { getLocationContents } from '@/utils/inventoryLocationsAccess';
import { useLoad } from '@/hooks/useLoad';
import { commitCount } from '@/utils/inventoryCountAccess';
import type { CountVariance } from '@/types/inventoryCount';
import type { LocationContent } from '@/types/inventoryLocations';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface PlaceAdjustFormProps {
  companyId: string;
  locationId: string;
  /** The bare name. This dialog only ever spans one place, so a full path would repeat itself. */
  locationName: string;
  /** Back to the place overview. The drawer stays open. */
  onCancel: () => void;
  onDone: () => void | Promise<void>;
}

export default function PlaceAdjustForm({
  companyId,
  locationId,
  locationName,
  onCancel,
  onDone,
}: PlaceAdjustFormProps) {
  /** part id → what was typed, verbatim. Kept as strings so a half-typed "1." is not a number yet. */
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ partName: string; message: string }>>([]);
  const [error, setError] = useState<unknown>(null);

  /*
   * `useLoad` rather than a mount effect: the house hook already handles the stale-response race
   * and keeps the fetch out of an effect body that would otherwise setState synchronously.
   */
  const { data, loading, error: loadError } = useLoad(
    () => getLocationContents(locationId),
    [locationId],
  );
  const rows: LocationContent[] = useMemo(() => data?.contents ?? [], [data]);
  /** Set when the bin holds more than one read returns, so the cap is said rather than hidden. */
  const clipped = data ? Math.max(0, data.total - data.contents.length) : 0;

  /** Best-effort author: a failed lookup writes no name rather than blocking a count. */
  const { data: member } = useLoad(() => getCurrentMember(companyId).catch(() => null), [companyId]);
  const operatorId = member?.id ?? null;

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
      onCancel();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box
      sx={{
        mt: 1.5,
        p: 1.5,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'action.hover',
      }}
    >
      <Box>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Type what you actually counted. Anything you leave blank is left alone.
          </Typography>

          {(error ?? loadError) != null && <ErrorAlert error={error ?? loadError} />}

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
            <Box>
              {/* Column headings, once. Three columns is the worksheet's shape and the reason the
                  deleted review step is not missed: recorded, counted, and what that changes. */}
              {/*
                Headings only where there ARE columns. Under `sm` the row stacks — the part name
                takes a line of its own, because four columns across 390px truncated
                `BUY-BEARING-608ZZ` to `BUY-BEA…`, and a part you cannot identify is not a row you
                can count. Each number carries its own inline label there instead.
              */}
              <Stack
                direction="row"
                spacing={1.5}
                sx={{
                  display: { xs: 'none', sm: 'flex' },
                  pb: 0.5,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Typography variant="overline" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
                  Part
                </Typography>
                <Typography
                  variant="overline"
                  color="text.secondary"
                  sx={{ width: 72, textAlign: 'right' }}
                >
                  Recorded
                </Typography>
                <Typography variant="overline" color="text.secondary" sx={{ width: 96 }}>
                  Counted
                </Typography>
                <Typography
                  variant="overline"
                  color="text.secondary"
                  sx={{ width: 84, textAlign: 'right' }}
                >
                  Changed
                </Typography>
              </Stack>

              <Stack spacing={1} sx={{ mt: 1 }}>
                {rows.map((r) => {
                  const typed = entries[r.part_id] ?? '';
                  const value = parseFloat(typed);
                  const has = Number.isFinite(value) && value >= 0;
                  const delta = has ? value - r.quantity : 0;
                  const unit = r.primary_unit || 'ea';
                  return (
                    <Stack
                      key={r.part_id}
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={{ xs: 0.5, sm: 1.5 }}
                      alignItems={{ xs: 'stretch', sm: 'center' }}
                      sx={{ minHeight: 48, py: { xs: 1, sm: 0 } }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body2" noWrap title={r.part_name}>
                          {r.part_name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {unit}
                        </Typography>
                      </Box>

                      <Stack
                        direction="row"
                        spacing={1.5}
                        alignItems="center"
                        justifyContent={{ xs: 'space-between', sm: 'flex-start' }}
                      >
                      <Typography
                        variant="body2"
                        sx={{
                          width: 72,
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          color: 'text.secondary',
                        }}
                      >
                        {/* The heading is off screen under `sm`, so the number says what it is. */}
                        <Box component="span" sx={{ display: { sm: 'none' }, mr: 0.5 }}>
                          Recorded
                        </Box>
                        {num(r.quantity)}
                      </Typography>

                      <TextField
                        size="small"
                        type="number"
                        value={typed}
                        onChange={(e) =>
                          setEntries((s) => ({ ...s, [r.part_id]: e.target.value }))
                        }
                        sx={{ width: 96 }}
                        /*
                         * The name goes on the INPUT, not on the TextField.
                         *
                         * An `aria-label` prop on `TextField` lands on the wrapping FormControl, so
                         * a screen reader — and `getByLabelText` — resolves to a div you cannot
                         * type into. The column heading alone is not enough here either: forty rows
                         * share it, and "Counted" repeated forty times names none of them.
                         */
                        slotProps={{
                          htmlInput: {
                            min: 0,
                            step: 'any',
                            'aria-label': `Counted ${r.part_name}`,
                          },
                        }}
                      />

                      {/*
                        The third column, and the one that earns its place: a delta of zero renders
                        as an em dash rather than "0", because "you counted what we thought" and "you
                        changed it by nothing" are different statements and only the first is true.
                      */}
                      <Typography
                        variant="body2"
                        sx={{
                          width: 84,
                          textAlign: 'right',
                          whiteSpace: 'nowrap',
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: has && delta !== 0 ? 700 : 400,
                          color: !has
                            ? 'text.disabled'
                            : delta > 0
                              ? 'success.main'
                              : delta < 0
                                ? 'warning.main'
                                : 'text.secondary',
                        }}
                      >
                        {!has ? '—' : delta === 0 ? 'same' : `${delta > 0 ? '+' : ''}${num(delta)}`}
                      </Typography>
                      </Stack>
                    </Stack>
                  );
                })}
              </Stack>
            </Box>
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
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
            <Button onClick={onCancel} disabled={saving}>
              {failures.length > 0 ? 'Close' : 'Cancel'}
            </Button>
            <Button variant="contained" onClick={save} disabled={saving || counted.length === 0}>
              {saving
                ? 'Saving…'
                : counted.length === 0
                  ? 'Save'
                  : `Save ${counted.length} count${counted.length === 1 ? '' : 's'}`}
            </Button>
          </Stack>
        </Stack>
      </Box>
    </Box>
  );
}
