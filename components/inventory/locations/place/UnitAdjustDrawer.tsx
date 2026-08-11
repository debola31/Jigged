'use client';

/**
 * Bulk Adjust — the audit of a whole unit, in a drawer beside the grid it audits.
 *
 * ## Why this is not the worksheet any more
 *
 * `Bulk Adjust` navigated to `/inventory/count?location={unit}`, which meant leaving Storage to do
 * the thing Storage exists for. Everything else on this page had already stopped navigating: a unit
 * is a selection, a place is a drawer, and the four verbs open in place. This was the last control
 * that threw the screen away, and it did it for the operation you are most likely to run *while
 * looking at the cabinet*.
 *
 * The worksheet still exists and is still reached from Parts as `Count Inventory` — the shop-wide
 * sheet over every stocked part, which is a genuinely different job with a genuinely different
 * shape (a choose step, paging over hundreds of parts, and a bulk put-away panel). What moved here
 * is the *place-scoped* half of it.
 *
 * ## The same write, from both doors
 *
 * `commitCount`, exactly as the worksheet does — one `adjustStockAtLocation` per line, committed
 * line by line, each against its own bin. So the `adjustment` rows and their notes are identical
 * whichever door you came through, and the split is in the surface only.
 *
 * ## Rows are (part, place), never (part)
 *
 * A part in two bins gets two rows. Aggregating would re-create the ambiguity the shop-wide sheet
 * has to skip parts for: if a part holds 380 in one bin and 200 in another and you count 560, no
 * bin defensibly absorbs the −20. Two rows means each number is an assertion about one shelf you
 * are standing at, which is also how you would physically do it.
 *
 * ## A blank is not a zero
 *
 * Only rows with a number typed into them commit. A missing entry means *"not counted"* and leaves
 * the balance alone — never coerced to 0, so walking past a bin cannot empty it. A typed **0** IS
 * an assertion, and says the bin is empty. Same rule as the worksheet's `CountEntries`; the two
 * doors must not disagree about what an untouched row means.
 */

import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';

import ErrorAlert from '@/components/common/ErrorAlert';
import { useLoad } from '@/hooks/useLoad';
import { getCurrentMember } from '@/utils/operatorAccess';
import { commitCount, loadCountCandidatesForPlaces } from '@/utils/inventoryCountAccess';
import { countRowKey } from '@/lib/inventoryCountPlan';
import type { CountCandidate, CountVariance } from '@/types/inventoryCount';
import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { compareLocationNames } from '@/lib/locationTree';
import PlaceViewHeader from './PlaceViewHeader';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * How many rows one open of this drawer will hold.
 *
 * The worksheet pages at 100 and offers search. Here the whole point is one uninterrupted pass down
 * a cabinet, so it loads the lot and says so when there is more — a pager inside a drawer you are
 * walking a shop with is a way to lose your place.
 */
const ROW_LIMIT = 300;

/** Every bin under a unit, in the order you would walk them. */
function leavesOf(unit: InventoryLocationNode): Array<{ id: string; name: string; path: string }> {
  const out: Array<{ id: string; name: string; path: string }> = [];
  const walk = (node: InventoryLocationNode, trail: string[]) => {
    const here = [...trail, node.name];
    if (node.children.length === 0) {
      // The path drops the unit's own name: the drawer header already says which cabinet, and
      // repeating it down 180 rows is 180 restatements of the one thing that cannot change.
      out.push({ id: node.id, name: node.name, path: here.slice(1).join(' › ') || node.name });
      return;
    }
    [...node.children]
      .sort((a, b) => a.sort_order - b.sort_order || compareLocationNames(a.name, b.name))
      .forEach((c) => walk(c, here));
  };
  walk(unit, []);
  return out;
}

export interface UnitAdjustDrawerProps {
  /** The unit being audited. `null` closes the drawer. */
  unit: InventoryLocationNode | null;
  companyId: string;
  onClose: () => void;
  /** A count landed. The board reloads so fill state and the grid agree with the ledger. */
  onChanged: () => void | Promise<void>;
}

function UnitAdjustBody({
  unit,
  companyId,
  onClose,
  onChanged,
}: UnitAdjustDrawerProps & { unit: InventoryLocationNode }) {
  /** row key → what was typed, verbatim. Strings, so a half-typed "1." is not yet a number. */
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ partName: string; locationName: string; message: string }>>([]);
  const [error, setError] = useState<unknown>(null);

  const places = useMemo(() => leavesOf(unit), [unit]);

  const { data, loading, error: loadError } = useLoad(
    () => loadCountCandidatesForPlaces(places, { limit: ROW_LIMIT }),
    [places],
  );

  /** Best-effort author: a failed lookup writes no name rather than blocking a count. */
  const { data: member } = useLoad(() => getCurrentMember(companyId).catch(() => null), [companyId]);
  const operatorId = member?.id ?? null;

  const rows: CountCandidate[] = useMemo(() => data?.candidates ?? [], [data]);
  const clipped = data ? Math.max(0, data.total - data.candidates.length) : 0;

  /** Filtering is client-side because the whole cabinet is already in hand. */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.partName.toLowerCase().includes(q) || r.target.locationPath.toLowerCase().includes(q),
    );
  }, [rows, search]);

  /** Rows carrying a usable number. A blank, a stray minus, a half-typed decimal are not counts. */
  const counted = useMemo(
    () =>
      rows
        .map((r) => ({ row: r, value: parseFloat(entries[countRowKey(r)] ?? '') }))
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
       * The delta has to be measured against what the balance is NOW, not the snapshot this drawer
       * opened with — a cabinet audit takes long enough that an operator may move something out of
       * a bin while it sits open. The worksheet re-reads at its own save for the same reason.
       */
      const fresh = await loadCountCandidatesForPlaces(places, { limit: ROW_LIMIT });
      const nowByRow = new Map(fresh.candidates.map((c) => [countRowKey(c), c.systemQuantity]));

      const variances: CountVariance[] = counted.map(({ row, value }) => {
        const systemQuantity = nowByRow.get(countRowKey(row)) ?? row.systemQuantity;
        return {
          candidate: { ...row, systemQuantity },
          counted: value,
          delta: value - systemQuantity,
          movedSinceOpened: systemQuantity !== row.systemQuantity,
        };
      });

      setProgress({ done: 0, total: variances.length });
      const result = await commitCount(variances, {
        operatorId,
        onProgress: (p) => setProgress({ done: p.done, total: p.total }),
      });

      await onChanged();
      setProgress(null);

      if (result.failures.length > 0) {
        // Reported, never rolled back: the lines that committed are real observations about a
        // shelf, and re-counting them would be asking twice.
        setFailures(result.failures);
        return;
      }
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PlaceViewHeader
        title={`Bulk Adjust ${unit.name}`}
        subtitle={`${places.length} ${places.length === 1 ? 'place' : 'places'}`}
        action={
          <IconButton aria-label="Close" onClick={onClose} sx={{ width: 48, height: 48 }}>
            <CloseIcon />
          </IconButton>
        }
      />

      <Box sx={{ p: 2, overflowY: 'auto' }}>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Type what you actually counted, bin by bin. Anything you leave blank is left alone.
          </Typography>

          {(error ?? loadError) != null && <ErrorAlert error={error ?? loadError} />}

          {failures.length > 0 && (
            <Alert severity="warning">
              {counted.length - failures.length} saved. These did not:{' '}
              {failures
                .map((f) => `${f.partName} at ${f.locationName} (${f.message})`)
                .join('; ')}
            </Alert>
          )}

          {clipped > 0 && (
            <Alert severity="info">
              Showing {rows.length} of {num(rows.length + clipped)} rows in this unit. Count a bin at
              a time from its own drawer to reach the rest.
            </Alert>
          )}

          {rows.length > 8 && (
            <TextField
              size="small"
              placeholder="Filter by part or place…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}

          {loading && rows.length === 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          ) : rows.length === 0 ? (
            <Alert severity="info">
              Nothing is recorded anywhere in {unit.name} yet, so there is nothing to adjust.
            </Alert>
          ) : (
            <Box>
              {/* Headings only where there ARE columns; under `sm` the row stacks and each number
                  carries its own inline label. Same treatment as a single place's Adjust. */}
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
                {visible.map((row) => {
                  const key = countRowKey(row);
                  const typed = entries[key] ?? '';
                  const value = parseFloat(typed);
                  const has = Number.isFinite(value) && value >= 0;
                  const delta = has ? value - row.systemQuantity : 0;
                  return (
                    <Stack
                      key={key}
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={{ xs: 0.5, sm: 1.5 }}
                      alignItems={{ xs: 'stretch', sm: 'center' }}
                      sx={{ minHeight: 48, py: { xs: 1, sm: 0 } }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body2" noWrap title={row.partName}>
                          {row.partName}
                        </Typography>
                        {/* WHICH BIN, on every row. The whole unit is on screen, so the place is
                            what tells two rows of the same part apart. */}
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {row.target.locationPath} · {row.unit}
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
                          <Box component="span" sx={{ display: { sm: 'none' }, mr: 0.5 }}>
                            Recorded
                          </Box>
                          {num(row.systemQuantity)}
                        </Typography>

                        <TextField
                          size="small"
                          type="number"
                          value={typed}
                          onChange={(e) =>
                            setEntries((s) => ({ ...s, [key]: e.target.value }))
                          }
                          sx={{ width: 96 }}
                          slotProps={{
                            htmlInput: {
                              min: 0,
                              step: 'any',
                              // The name has to carry the PLACE too: one part legitimately appears
                              // on several rows, and "Counted BUY-ORING-214" would name three.
                              'aria-label': `Counted ${row.partName} at ${row.target.locationPath}`,
                            },
                          }}
                        />

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

              {visible.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Nothing in {unit.name} matches &ldquo;{search}&rdquo;.
                </Typography>
              )}
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
          </Stack>
        </Stack>
      </Box>
    </>
  );
}

export default function UnitAdjustDrawer(props: UnitAdjustDrawerProps) {
  const { unit, onClose } = props;
  return (
    <Drawer
      anchor="right"
      open={Boolean(unit)}
      onClose={onClose}
      sx={{
        '& .MuiDrawer-paper': {
          // Wider than the place drawer: this one carries a place on every row as well as the four
          // columns, and truncating the bin is truncating the coordinate.
          width: { xs: '100%', sm: 560 },
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
        },
      }}
    >
      {/* Keyed by unit: opening a different cabinet starts a fresh sheet rather than carrying the
          last one's typed counts under a new name. */}
      {unit && <UnitAdjustBody {...props} key={unit.id} unit={unit} />}
    </Drawer>
  );
}
