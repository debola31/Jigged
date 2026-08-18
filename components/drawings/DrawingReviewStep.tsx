'use client';

/**
 * Step 2 — one row per part, reviewed by exception.
 *
 * A healthy row carries NO decoration. Only rows needing a decision get an amber
 * chip with words on it, and there are no confidence scores anywhere: verified
 * across every competitor, nobody ships one, and a number invites trust the
 * extraction has not earned.
 *
 * `Create N parts` is never disabled — keep-visible-and-explain, per
 * docs/interaction-standards.md §4. One bad row cannot block the other thirty.
 */

import { useMemo } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

import { unreadableMessage, type BuiltRow } from '@/lib/drawingImportExtract';
import { needsAssist } from '@/utils/drawingFieldsAssist';
import { valueOf, type DrawingRowValues } from '@/types/drawingImport';

interface Props {
  rows: BuiltRow[];
  onRowsChange: (rows: BuiltRow[]) => void;
  onBack: () => void;
  onCreate: () => void;
  creating: boolean;
  onAssist: () => void;
  assisted: boolean;
  /** True while the title blocks are being read. Not the same as `creating`. */
  reading: boolean;
  /** Null when the user did not say whose drawings these are. */
  customerId: string | null;
}

/** What this row needs a human for, in words. `null` when it needs nothing. */
function attention(row: BuiltRow): string | null {
  const unreadable = unreadableMessage(row);
  if (unreadable) return unreadable;
  switch (row.identity.kind) {
    case 'name_taken':
      return `Another customer's part is called "${row.identity.partName}" — renamed`;
    case 'unknown':
      return `We couldn't check this one — ${row.identity.reason}`;
    case 'known':
      return null;
    default:
      return null;
  }
}

export default function DrawingReviewStep({
  rows,
  onRowsChange,
  onBack,
  onCreate,
  creating,
  onAssist,
  assisted,
  reading,
  customerId,
}: Props) {
  const update = (stem: string, change: (row: BuiltRow) => BuiltRow) =>
    onRowsChange(rows.map((r) => (r.stem === stem ? change(r) : r)));

  const edit = (stem: string, key: keyof DrawingRowValues, value: string) =>
    update(stem, (r) => ({ ...r, edits: { ...r.edits, [key]: value } }));

  const needsAttention = useMemo(() => rows.filter((r) => attention(r) !== null), [rows]);
  const assistCandidates = useMemo(() => rows.filter(needsAssist).length, [rows]);
  const willUpdate = useMemo(
    () => rows.filter((r) => !r.excluded && r.identity.kind === 'known').length,
    [rows],
  );

  return (
    <>
      {needsAttention.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>
            {needsAttention.length} of {rows.length} need a look
          </AlertTitle>
          Everything else is ready. You can create these now and fix the rest later — nothing here
          blocks the others.
        </Alert>
      )}

      {assistCandidates > 0 && !assisted && !reading && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button
              size="small"
              variant="contained"
              startIcon={<AutoAwesomeIcon />}
              onClick={onAssist}
              disabled={creating}
            >
              Read the title blocks
            </Button>
          }
        >
          <AlertTitle>Add more detail from the drawings?</AlertTitle>
          We can read the drawings more closely and add what they say — material, finish, and the
          rest of the title block — to the part descriptions. Nothing is sent until you press the
          button.
        </Alert>
      )}

      <Card>
        <CardContent sx={{ p: 0 }}>
          <TableContainer sx={{ maxHeight: '60vh' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" />
                  <TableCell>Part name</TableCell>
                  <TableCell>Description</TableCell>
                  {/* Only meaningful once a customer is chosen: the column exists so
                      a second customer using the same number does not collide with the
                      first. With nobody selected there is nothing to keep apart. */}
                  {customerId && (
                    <Tooltip
                      title="The number as this customer writes it. Kept separate from the part name so two customers can both use it."
                    >
                      <TableCell>Their number</TableCell>
                    </Tooltip>
                  )}
                  <TableCell>Files</TableCell>
                  <TableCell>Components</TableCell>
                  <TableCell>Needs a look</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => {
                  const note = attention(row);
                  return (
                    <TableRow
                      key={row.stem}
                      hover
                      sx={{ opacity: row.excluded ? 0.4 : 1 }}
                      data-testid="drawing-row"
                    >
                      <TableCell padding="checkbox">
                        <Tooltip title={row.excluded ? 'Include this part' : 'Leave this one out'}>
                          <Checkbox
                            checked={!row.excluded}
                            onChange={(e) =>
                              update(row.stem, (r) => ({ ...r, excluded: !e.target.checked }))
                            }
                            inputProps={{ 'aria-label': `Include ${row.stem}` }}
                          />
                        </Tooltip>
                      </TableCell>
                      <TableCell sx={{ minWidth: 200 }}>
                        <TextField
                          variant="standard"
                          fullWidth
                          value={valueOf(row, 'part_name')}
                          onChange={(e) => edit(row.stem, 'part_name', e.target.value)}
                          inputProps={{ 'aria-label': `Part name for ${row.stem}` }}
                        />
                      </TableCell>
                      <TableCell sx={{ minWidth: 220 }}>
                        <TextField
                          variant="standard"
                          fullWidth
                          placeholder="—"
                          value={valueOf(row, 'description')}
                          onChange={(e) => edit(row.stem, 'description', e.target.value)}
                        />
                      </TableCell>
                      {customerId && (
                        <TableCell sx={{ minWidth: 140 }}>
                          <TextField
                            variant="standard"
                            fullWidth
                            placeholder="—"
                            value={valueOf(row, 'customer_part_number')}
                            onChange={(e) => edit(row.stem, 'customer_part_number', e.target.value)}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                          {row.group.files.map((f) => (
                            <Chip key={f.name} size="small" label={f.kind} variant="outlined" />
                          ))}
                        </Box>
                      </TableCell>
                      <TableCell>
                        {/* Information, not a problem — it belongs beside the files it
                            came from, not in the column that means "act on this". */}
                        {row.cutList ? (
                          <Chip
                            size="small"
                            variant="outlined"
                            label={`${row.cutList.rows.length}`}
                            title={`This drawing lists ${row.cutList.rows.length} components`}
                          />
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            —
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell sx={{ maxWidth: 300 }}>
                        {/* Review by exception: a healthy row renders nothing at all. */}
                        {note && <Chip size="small" color="warning" label={note} />}

                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 3 }}>
        <Button onClick={onBack} disabled={creating}>
          Back
        </Button>
        <Box sx={{ flex: 1 }}>
          {willUpdate > 0 && (
            <Typography variant="caption" color="text.secondary">
              {willUpdate} of these already exist and will be updated rather than created.
            </Typography>
          )}
        </Box>
        {/*
          This advances to the work step — it does not create anything, and saying
          "Create 31 parts" here promised something the next screen then asked more
          questions about. Never disabled: reading title blocks in the background is
          not a reason to trap someone on this page.
        */}
        <Button variant="contained" size="large" onClick={onCreate} disabled={creating}>
          Next — how they are made
        </Button>
      </Box>
    </>
  );
}
