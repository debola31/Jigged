'use client';

/**
 * "Where does each part go?" — the second step of a subdivide, shown only when the place being
 * divided already holds stock.
 *
 * ## Why this step exists at all
 *
 * Since 20260806160053 a place with sub-locations holds no stock, so dividing up a loaded shelf has
 * to say what happens to what is on it. Three answers were considered:
 *
 * - **Refuse until it is empty.** Honest, and it makes the common case ("I just built these bins,
 *   now let me use them") a detour through a separate put-away worksheet.
 * - **Sweep it all into `Unassigned`.** Never blocks, and silently declares stock homeless — the
 *   shelf you were organising becomes a pile someone else has to re-place.
 * - **Ask.** Which is this, because the person subdividing is standing at the shelf and is the only
 *   one who knows which side the bearings ended up on.
 *
 * ## Splitting is the point, not a nicety
 *
 * Assigning each part to exactly one bin would be the easy version and would be wrong for the case
 * that motivates subdividing in the first place: you divide a shelf *because* what is on it is
 * already in two piles. So a part can be split across several destinations, and the sum is checked
 * against what is actually on hand.
 *
 * The check is not politeness. `subdivide_location` defers the invariant to COMMIT, so an
 * incomplete distribution does not half-apply — it rolls the whole subdivide back, sub-locations
 * and all. Catching it here turns a mystifying failure into an arithmetic hint.
 *
 * ## "Send everything to…" is required, not a shortcut
 *
 * `getLocationContents` returns up to `LOCATION_CONTENTS_LIMIT` (200) parts, and a 200-row table
 * where every row needs a decision is not a UI, it is a punishment. One picker that fills every row
 * makes the overwhelmingly common intent — "it all goes in Bin 1, I will sort it later" — a single
 * interaction, and leaves the per-part table for the rows that differ.
 */

import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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

/** One part's stock going to one spec leaf. Several lines per part means a split. */
export interface Assignment {
  toRef: string;
  quantity: number;
}

export type AssignmentMap = Record<string, Assignment[]>;

export interface SpecLeaf {
  key: string;
  label: string;
}

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * Quantities are `numeric` in Postgres and floats here, so `0.1 + 0.2 !== 0.3` decides whether the
 * Create button is enabled. The tolerance is well below any real unit's meaningful precision and
 * well above float noise.
 */
const EPSILON = 1e-9;

export function assignedTotal(lines: Assignment[] = []): number {
  return lines.reduce((sum, l) => sum + (Number.isFinite(l.quantity) ? l.quantity : 0), 0);
}

/** Every part fully placed, and nothing sent to a destination that was never chosen. */
export function isDistributionComplete(
  contents: LocationContent[],
  assignments: AssignmentMap,
): boolean {
  return contents.every((c) => {
    const lines = assignments[c.part_id] ?? [];
    return (
      lines.length > 0 &&
      lines.every((l) => l.toRef !== '' && l.quantity > 0) &&
      Math.abs(assignedTotal(lines) - c.quantity) < EPSILON
    );
  });
}

export interface DistributeContentsStepProps {
  parentName: string;
  contents: LocationContent[];
  leaves: SpecLeaf[];
  assignments: AssignmentMap;
  onChange: (next: AssignmentMap) => void;
}

export default function DistributeContentsStep({
  parentName,
  contents,
  leaves,
  assignments,
  onChange,
}: DistributeContentsStepProps) {
  const complete = useMemo(
    () => isDistributionComplete(contents, assignments),
    [contents, assignments],
  );

  /** Put every part's whole balance in one place. The "I'll sort it later" path. */
  const sendEverythingTo = (toRef: string) => {
    const next: AssignmentMap = {};
    for (const c of contents) next[c.part_id] = [{ toRef, quantity: c.quantity }];
    onChange(next);
  };

  const setLine = (partId: string, index: number, patch: Partial<Assignment>) => {
    const lines = [...(assignments[partId] ?? [])];
    lines[index] = { ...lines[index], ...patch };
    onChange({ ...assignments, [partId]: lines });
  };

  const addLine = (partId: string) => {
    const lines = assignments[partId] ?? [];
    const remaining =
      (contents.find((c) => c.part_id === partId)?.quantity ?? 0) - assignedTotal(lines);
    onChange({
      ...assignments,
      // Pre-filled with what is left over, which is the amount you are almost always about to type.
      [partId]: [...lines, { toRef: '', quantity: Math.max(remaining, 0) }],
    });
  };

  const removeLine = (partId: string, index: number) => {
    const lines = (assignments[partId] ?? []).filter((_, i) => i !== index);
    onChange({ ...assignments, [partId]: lines });
  };

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {parentName} holds {contents.length} {contents.length === 1 ? 'part' : 'parts'}. A place with
        sub-locations can&apos;t hold stock itself, so each one needs somewhere to go.
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
          {contents.map((content) => {
            const lines = assignments[content.part_id] ?? [];
            const assigned = assignedTotal(lines);
            const short = content.quantity - assigned;
            const balanced = Math.abs(short) < EPSILON && lines.length > 0;

            return (
              <TableRow key={content.part_id} sx={{ verticalAlign: 'top' }}>
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
                          label="Place"
                          value={line.toRef}
                          onChange={(e) => setLine(content.part_id, index, { toRef: e.target.value })}
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
                            setLine(content.part_id, index, { quantity: Number(e.target.value) })
                          }
                          sx={{ width: 110 }}
                          inputProps={{ min: 0, step: 'any' }}
                        />
                        {/* Only offered on a split — removing the last line would leave the part
                            unassigned, which the Create button forbids anyway. */}
                        {lines.length > 1 && (
                          <IconButton
                            aria-label={`Remove this destination for ${content.part_name}`}
                            onClick={() => removeLine(content.part_id, index)}
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
                        onClick={() => addLine(content.part_id)}
                      >
                        {lines.length === 0 ? 'Choose a place' : 'Split'}
                      </Button>
                      {/* The arithmetic, said plainly. Silence when it balances — a green tick on
                          every row of a long table is noise that hides the one row that doesn't. */}
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

      {!complete && (
        <Alert severity="info" sx={{ mt: 2 }}>
          Every part needs a place, and the amounts have to add up to what is on the shelf.
        </Alert>
      )}
    </Box>
  );
}
