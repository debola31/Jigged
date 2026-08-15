'use client';

/**
 * "Where does each part go?" — shown when a layout change empties or divides up a loaded location.
 *
 * ## Why this step exists
 *
 * Since 20260806160053 a location with sub-locations holds no stock, so dividing up a loaded shelf
 * has to say what happens to what is on it. Three answers were considered:
 *
 * - **Refuse until it is empty.** Honest, and it makes the common case ("I just built these bins,
 *   now let me use them") a detour through a separate worksheet.
 * - **Sweep it all into `Unassigned`.** Never blocks, and silently declares stock homeless — the
 *   shelf you were organising becomes a pile someone else has to re-place.
 * - **Ask.** Which is this, because the person changing the layout is standing at the shelf and is
 *   the only one who knows which side the bearings ended up on.
 *
 * **The reshape work made the second answer worse, not better.** Someone reshaping a cabinet has
 * just told you they still want it. Emptying its contents into the put-away pile mid-reorganisation
 * is the opposite of what they asked for, and it would be the one step of the operation nobody
 * could undo.
 *
 * ## N sources, not one
 *
 * It used to take a single parent and the stock sitting directly on it — the only shape a subdivide
 * could produce. A reshape has two kinds of source at once: locations being **removed**, and
 * surviving locations that are **being divided up** and so may no longer hold anything. Both are
 * derived from the occupancy map the Storage page already has, with no extra round trip.
 *
 * Rows are keyed `part@location`, so the same part in two doomed bins is **two independent
 * decisions** — which is the point. Aggregating them would re-create exactly the ambiguity that
 * makes the company-wide count sheet skip split parts.
 *
 * ## Splitting is the point, not a nicety
 *
 * Assigning each part to exactly one bin would be the easy version and would be wrong for the case
 * that motivates dividing a shelf in the first place: you divide it *because* what is on it is
 * already in two piles. So a part can be split across several destinations, and the sum is checked
 * against what is actually on hand.
 *
 * The check is not politeness. `apply_location_layout` defers the invariant to COMMIT, so an
 * incomplete distribution does not half-apply — it rolls the whole reshape back, deletions and all.
 * Catching it here turns a mystifying failure into an arithmetic hint.
 *
 * ## "Send everything to…" is required, not a shortcut
 *
 * The read caps at `RESHAPE_DISTRIBUTE_MAX` parts, and a table that long where every row needs a
 * decision is not a UI, it is a punishment. One picker that fills every row makes the
 * overwhelmingly common intent — "it all goes in Bin 1, I will sort it later" — a single
 * interaction, and leaves the per-part table for the rows that differ.
 */

import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';

import type { LocationContent } from '@/types/inventoryLocations';

/** One part's stock going to one destination. Several lines per row means a split. */
export interface Assignment {
  toRef: string;
  quantity: number;
}

/** Keyed by `sourceKey(content)` — one entry per (part, location it is leaving). */
export type AssignmentMap = Record<string, Assignment[]>;

export interface SpecLeaf {
  key: string;
  label: string;
}

/** A location the stock has to leave, and why. */
export interface DistributeSource {
  locationId: string;
  label: string;
  reason: 'removed' | 'subdivided';
}

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * Quantities are `numeric` in Postgres and floats here, so `0.1 + 0.2 !== 0.3` decides whether the
 * confirm button is enabled. The tolerance is well below any real unit's meaningful precision and
 * well above float noise.
 */
const EPSILON = 1e-9;

/**
 * One row of the table: a part AND the location it is leaving.
 *
 * Keyed by both because a part sitting in three bins that are all being removed is three separate
 * decisions with three separate quantities. Keying by part alone would have them share one number,
 * which is the same defect the count sheet fixed when it moved to `partId::locationId`.
 */
export function sourceKey(content: Pick<LocationContent, 'part_id' | 'location_id'>): string {
  return `${content.part_id}@${content.location_id}`;
}

export function assignedTotal(lines: Assignment[] = []): number {
  return lines.reduce((sum, l) => sum + (Number.isFinite(l.quantity) ? l.quantity : 0), 0);
}

/** Every row fully placed, and nothing sent to a destination that was never chosen. */
export function isDistributionComplete(
  contents: LocationContent[],
  assignments: AssignmentMap,
): boolean {
  return contents.every((c) => {
    const lines = assignments[sourceKey(c)] ?? [];
    return (
      lines.length > 0 &&
      lines.every((l) => l.toRef !== '' && l.quantity > 0) &&
      Math.abs(assignedTotal(lines) - c.quantity) < EPSILON
    );
  });
}

/** What the confirmation says about where things ended up. */
export function assignedDestinations(assignments: AssignmentMap): string[] {
  return Object.values(assignments).flatMap((lines) => lines.map((l) => l.toRef).filter(Boolean));
}

export interface DistributeContentsStepProps {
  sources: DistributeSource[];
  /** Rows across every source; each carries its own `location_id`. */
  contents: LocationContent[];
  leaves: SpecLeaf[];
  assignments: AssignmentMap;
  onChange: (next: AssignmentMap) => void;
  loading?: boolean;
}

export default function DistributeContentsStep({
  sources,
  contents,
  leaves,
  assignments,
  onChange,
  loading = false,
}: DistributeContentsStepProps) {
  const complete = useMemo(
    () => isDistributionComplete(contents, assignments),
    [contents, assignments],
  );

  /**
   * Grouped by the location the stock is leaving, not columned by it.
   *
   * A `From` column repeats the same bin name down every row and pushes the part name — the thing
   * that differs — off the end of a narrow screen. A sub-header says it once.
   */
  const groups = useMemo(() => {
    const byLocation = new Map<string, LocationContent[]>();
    for (const c of contents) {
      byLocation.set(c.location_id, [...(byLocation.get(c.location_id) ?? []), c]);
    }
    return sources
      .map((source) => ({ source, rows: byLocation.get(source.locationId) ?? [] }))
      .filter((g) => g.rows.length > 0);
  }, [contents, sources]);

  /** Put every row's whole balance in one location. The "I'll sort it later" path. */
  const sendEverythingTo = (toRef: string) => {
    const next: AssignmentMap = {};
    for (const c of contents) next[sourceKey(c)] = [{ toRef, quantity: c.quantity }];
    onChange(next);
  };

  const setLine = (key: string, index: number, patch: Partial<Assignment>) => {
    const lines = [...(assignments[key] ?? [])];
    lines[index] = { ...lines[index], ...patch };
    onChange({ ...assignments, [key]: lines });
  };

  const addLine = (key: string, onHand: number) => {
    const lines = assignments[key] ?? [];
    const remaining = onHand - assignedTotal(lines);
    onChange({
      ...assignments,
      // Pre-filled with what is left over, which is the amount you are almost always about to type.
      [key]: [...lines, { toRef: '', quantity: Math.max(remaining, 0) }],
    });
  };

  const removeLine = (key: string, index: number) => {
    onChange({ ...assignments, [key]: (assignments[key] ?? []).filter((_, i) => i !== index) });
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  const removedCount = sources.filter((s) => s.reason === 'removed').length;
  const dividedCount = sources.filter((s) => s.reason === 'subdivided').length;

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {[
          removedCount > 0 &&
            `${removedCount} ${removedCount === 1 ? 'location is' : 'locations are'} going away`,
          dividedCount > 0 &&
            `${dividedCount} ${dividedCount === 1 ? 'is' : 'are'} being divided up`,
        ]
          .filter(Boolean)
          .join(' and ')}
        . Nothing can be left behind, so say where each part goes.
      </Typography>

      <TextField
        select
        fullWidth
        size="small"
        label="Send everything to…"
        value=""
        onChange={(e) => sendEverythingTo(e.target.value)}
        helperText="Fills every row below. Change individual parts afterwards."
        sx={{ mb: 3, maxWidth: 420 }}
      >
        {leaves.map((leaf) => (
          <MenuItem key={leaf.key} value={leaf.key}>
            {leaf.label}
          </MenuItem>
        ))}
      </TextField>

      <Stack spacing={3}>
        {groups.map(({ source, rows }) => (
          <Box key={source.locationId}>
            <Typography variant="overline" color="text.secondary">
              {source.label} — {source.reason === 'removed' ? 'going away' : 'being divided up'}
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>Part</TableCell>
                  <TableCell sx={{ fontWeight: 600 }} align="right">
                    On hand
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Goes to</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((content) => {
                  const key = sourceKey(content);
                  const lines = assignments[key] ?? [];
                  const short = content.quantity - assignedTotal(lines);
                  const balanced = Math.abs(short) < EPSILON && lines.length > 0;

                  return (
                    <TableRow key={key} sx={{ verticalAlign: 'top' }}>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {content.part_name}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2">
                          {num(content.quantity)} {content.primary_unit ?? ''}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Stack spacing={1}>
                          {lines.map((line, index) => (
                            <Stack key={index} direction="row" spacing={1} alignItems="center">
                              <TextField
                                select
                                size="small"
                                label="Location"
                                value={line.toRef}
                                onChange={(e) => setLine(key, index, { toRef: e.target.value })}
                                sx={{ minWidth: 200 }}
                              >
                                {leaves.map((leaf) => (
                                  <MenuItem key={leaf.key} value={leaf.key}>
                                    {leaf.label}
                                  </MenuItem>
                                ))}
                              </TextField>
                              <TextField
                                size="small"
                                type="number"
                                label="Qty"
                                value={Number.isFinite(line.quantity) ? line.quantity : ''}
                                onChange={(e) =>
                                  setLine(key, index, { quantity: Number(e.target.value) })
                                }
                                sx={{ width: 110 }}
                                inputProps={{ min: 0, step: 'any' }}
                              />
                              {/* Only offered on a split — removing the last line would leave the
                                  row unassigned, which the confirm button forbids anyway. */}
                              {lines.length > 1 && (
                                <IconButton
                                  aria-label={`Remove this destination for ${content.part_name}`}
                                  onClick={() => removeLine(key, index)}
                                  sx={{ width: 40, height: 40 }}
                                >
                                  <CloseIcon fontSize="small" />
                                </IconButton>
                              )}
                            </Stack>
                          ))}

                          <Stack direction="row" spacing={1} alignItems="center">
                            <Button
                              size="small"
                              startIcon={<AddIcon />}
                              onClick={() => addLine(key, content.quantity)}
                            >
                              {lines.length === 0 ? 'Choose a location' : 'Split'}
                            </Button>
                            {/* The arithmetic, said plainly, as VISIBLE text — a disabled confirm
                                has to say why somewhere you can read without hovering. Silence
                                when it balances: a green tick on every row of a long table is
                                noise that hides the one row that doesn't. */}
                            {!balanced && lines.length > 0 && (
                              <Typography variant="caption" color="warning.main">
                                {short > 0
                                  ? `${num(short)} ${content.primary_unit ?? ''} still to place`
                                  : `${num(-short)} ${content.primary_unit ?? ''} more than is here`}
                              </Typography>
                            )}
                          </Stack>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        ))}
      </Stack>

      {!complete && (
        <Alert severity="info" sx={{ mt: 2 }}>
          Every part needs a location, and the amounts have to add up to what is there now.
        </Alert>
      )}
    </Box>
  );
}
