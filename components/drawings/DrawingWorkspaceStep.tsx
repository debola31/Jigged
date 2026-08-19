'use client';

/**
 * One screen instead of a wizard.
 *
 * The old flow was four steps for two decisions — what work each part takes, and
 * what its materials cost. Steps are a tax: "Review the parts" was a full screen
 * on which, for a healthy package, there was nothing to do, and its primary button
 * said "Create 31 parts" while actually navigating to a screen that asked more
 * questions.
 *
 * So everything a part needs lives on the part's own row. Open a row and you get
 * its work and its materials together, because that is the unit someone actually
 * thinks in: *this* pedestal takes these three operations and that tube.
 *
 * ## Work is entered once and spread
 *
 * The unit of entry is ONE part, then "apply to the rest". Starting from a concrete
 * part rather than an abstract routing is the whole trick — people reason far more
 * reliably from *this part works like so* than from *define a routing*, and it is
 * the same instinct behind copying an existing part. Thirty-one routings still cost
 * one entry, but a part that differs is now edited rather than exempted.
 *
 * ## Materials are pooled, and shown where they are used
 *
 * A cut list appears under the part that lists it, not in a panel above everything.
 * But the COST is shared: twelve cut-list rows across two weldments collapse to
 * three materials, so entering a price under one part fills it under the other and
 * the row says so. Locality for understanding, pooling for entry.
 *
 * ## Nothing here waits on the AI
 *
 * The title-block read fills descriptions in behind whoever is working. It is never
 * on the path to a button.
 */

import { Fragment, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import CloseIcon from '@mui/icons-material/Close';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';

import RoutingOperationsList from '@/components/routings/RoutingOperationsList';
import StationStrip from '@/components/drawings/StationStrip';
import DrawingFilePanel from '@/components/drawings/DrawingFilePanel';
import type { OperationRowData } from '@/components/routings/RoutingOperationRow';
import { valueOf, type DrawingRowValues } from '@/types/drawingImport';
import { unreadableMessage, type BuiltRow } from '@/lib/drawingImportExtract';
import { summariseFiles } from '@/lib/drawingFileSummary';
import MaterialLines, {
  newMaterialLine,
  isUsable,
  type MaterialLine,
} from '@/components/drawings/MaterialLines';

/** What work each part takes. Keyed by stem — one entry per part, not one plan. */
export type WorkByStem = Map<string, OperationRowData[]>;

interface Props {
  companyId: string;
  rows: BuiltRow[];
  onRowsChange: (rows: BuiltRow[]) => void;
  fileCount: number;
  work: WorkByStem;
  onWorkChange: (next: WorkByStem) => void;
  /** What each part is made of, keyed by stem — the user's own lines. */
  materials: Map<string, MaterialLine[]>;
  onMaterialsChange: (next: Map<string, MaterialLine[]>) => void;
  defaultUnit: string;
  onBack: () => void;
  onCreate: () => void;
  creating: boolean;
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
    default:
      return null;
  }
}

export default function DrawingWorkspaceStep({
  companyId,
  rows,
  onRowsChange,
  fileCount,
  work,
  onWorkChange,
  materials,
  onMaterialsChange,
  defaultUnit,
  onBack,
  onCreate,
  creating,
  customerId,
}: Props) {
  const [openStem, setOpenStem] = useState<string | null>(null);
  /**
   * Filing is the whole job for most people, so the screen opens as a plain list
   * of parts and descriptions — nothing to expand, no columns about work.
   *
   * Operations and materials are each a separate decision with a separate cost:
   * stations are recall, material costs are a lookup, and TIMES are a consensus
   * nobody reaches at an import screen. Asking for them up front made a two-minute
   * job look like an afternoon. Ticking a box is the user saying "I want to do
   * that part now", and only then does the table grow the column and the rows
   * become expandable.
   */
  const [wantWork, setWantWork] = useState(false);
  const [wantMaterials, setWantMaterials] = useState(false);
  const expandable = wantWork || wantMaterials;

  /**
   * A row opens only if opening it shows something.
   *
   * "Add materials" put a chevron on all thirty-one parts when two of them have a
   * cut list, so twenty-nine of them expanded to an empty box and the feature
   * looked broken. Work applies to every part; materials apply to the parts that
   * list components.
   */
  const canOpen = () => expandable;

  /**
   * Unticking the last one closes whatever row was open — otherwise a panel stays
   * expanded with nothing in it. Done here rather than in an effect watching the
   * flags: this IS the moment the decision is made.
   */
  const setWants = (work: boolean, materials: boolean) => {
    setWantWork(work);
    setWantMaterials(materials);
    if (!work && !materials) setOpenStem(null);
  };
  /**
   * Times are opt-in, per editor.
   *
   * Which stations a part visits is recall; how long it takes there is a
   * consensus the shop may not have reached. Defaulting to the six-field editor
   * asked the slow question first and invited a made-up number, so the strip is
   * the default and the full editor is a link away for anyone who does know.
   */
  const [rowTimes, setRowTimes] = useState<Set<string>>(new Set());
  /**
   * Which row's drawing is on screen. One panel, not one per row: the question is
   * always "does THIS row match its sheet", so it follows the selection and
   * checking a package becomes clicking down the table.
   */
  const [viewingStem, setViewingStem] = useState<string | null>(null);

  /**
   * Every row on screen is going to be created. Leaving one out removes it from
   * the table outright, so there is no excluded-but-visible state to render — and
   * no row that looks half-in.
   */
  const included = rows;
  const summary = useMemo(
    () => summariseFiles(rows.map((r) => ({ kinds: r.group.files.map((f) => f.kind) })), fileCount),
    [rows, fileCount],
  );
  const needsAttention = useMemo(() => rows.filter((r) => attention(r) !== null), [rows]);
  const viewing = useMemo(
    () => rows.find((r) => r.stem === viewingStem) ?? null,
    [rows, viewingStem],
  );

  /**
   * The file signature the card just promised. A row prints its own files only
   * when it breaks that promise — otherwise the column was the same three chips
   * thirty-one times, which is how a table teaches people to stop reading it.
   */
  const commonFiles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const key = [...new Set(r.group.files.map((f) => f.kind))].sort().join('+');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  }, [rows]);

  const update = (stem: string, change: (row: BuiltRow) => BuiltRow) =>
    onRowsChange(rows.map((r) => (r.stem === stem ? change(r) : r)));

  const edit = (stem: string, key: keyof DrawingRowValues, value: string) =>
    update(stem, (r) => ({ ...r, edits: { ...r.edits, [key]: value } }));

  const setWork = (stem: string, operations: OperationRowData[]) => {
    const next = new Map(work);
    if (operations.length === 0) next.delete(stem);
    else next.set(stem, operations);
    onWorkChange(next);
  };

  /**
   * Spread one part's work across the others.
   *
   * Fresh temp ids per part: these become NEW operation rows on each routing, not
   * shared references, and reusing one id across 31 parts would have them collide
   * in the editor's own keying.
   */
  const applyToAll = (fromStem: string) => {
    const source = work.get(fromStem);
    if (!source || source.length === 0) return;
    const next = new Map(work);
    for (const row of included) {
      if (row.stem === fromStem) continue;
      next.set(
        row.stem,
        source.map((op) => ({ ...op, tempId: `tmp-${row.stem}-${op.tempId}` })),
      );
    }
    onWorkChange(next);
  };

  const withWork = included.filter((r) => (work.get(r.stem)?.length ?? 0) > 0).length;

  const setLines = (stem: string, lines: MaterialLine[]) => {
    const next = new Map(materials);
    if (lines.length === 0) next.delete(stem);
    else next.set(stem, lines);
    onMaterialsChange(next);
  };

  const materialCount = (stem: string) => (materials.get(stem) ?? []).filter(isUsable).length;
  const totalMaterials = [...materials.values()].reduce(
    (n, lines) => n + lines.filter(isUsable).length,
    0,
  );
  const unpricedMaterials = [...materials.values()].reduce(
    (n, lines) =>
      n + lines.filter((l) => isUsable(l) && !l.part && l.costPerUnit.trim() === '').length,
    0,
  );

  return (
    <>
      {/* What we made of the folder, before anything asks for attention. */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6">{summary.headline}</Typography>
          <Typography variant="body2" color="text.secondary">
            {summary.majority}
            {summary.exceptions.length > 0 && ` ${summary.exceptions.join('; ')}.`}
          </Typography>
        </CardContent>
      </Card>

      {needsAttention.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>
            {needsAttention.length} of {rows.length} need a look
          </AlertTitle>
          Everything else is ready. You can create these now and fix the rest later — nothing here
          blocks the others.
        </Alert>
      )}

      <Card sx={{ mb: 2 }}>
        <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
          {/*
            Two decisions, each opt-in. Ticking one grows the rows a chevron; the
            work itself is entered on a part, because "apply this to the other 30"
            reads as a consequence of something concrete and "set the work for
            every part" was a second, abstract way in for the same thing.
          */}
          <FormGroup row sx={{ gap: 3 }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={wantWork}
                  onChange={(e) => setWants(e.target.checked, wantMaterials)}
                  disabled={creating}
                />
              }
              label="Add operations"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={wantMaterials}
                  onChange={(e) => setWants(wantWork, e.target.checked)}
                  disabled={creating}
                />
              }
              label="Add materials"
            />
          </FormGroup>
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'stretch', flexDirection: { xs: 'column', md: 'row' } }}>
      <Card sx={{ flex: 1, minWidth: 0 }}>
        <CardContent sx={{ p: 0 }}>
          <TableContainer sx={{ maxHeight: '58vh' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {/* No caret column until something can open. */}
                  {expandable && <TableCell padding="checkbox" />}
                  <TableCell>Part</TableCell>
                  <TableCell>Description</TableCell>
                  {/* What each row carries lives in the row, not in a column of
                      its own — thirty-one rows of "Add work" was a column that
                      said the same thing thirty-one times. */}
                  <TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => {
                  const note = attention(row);
                  const ops = work.get(row.stem) ?? [];
                  const open = openStem === row.stem;
                  const theirNumber = valueOf(row, 'customer_part_number');
                  const name = valueOf(row, 'part_name');
                  const oddFiles =
                    [...new Set(row.group.files.map((f) => f.kind))].sort().join('+') !==
                    commonFiles;

                  return (
                    <Fragment key={row.stem}>
                      <TableRow
                        hover
                        data-testid="drawing-row"
                      >
                        {expandable && (
                          <TableCell padding="checkbox">
                            {canOpen() && (
                              <IconButton
                                size="small"
                                onClick={() => setOpenStem(open ? null : row.stem)}
                                aria-label={`Set up ${row.stem}`}
                              >
                                {open ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
                              </IconButton>
                            )}
                          </TableCell>
                        )}
                        <TableCell sx={{ minWidth: 180 }}>
                          <TextField
                            variant="standard"
                            fullWidth
                            value={name}
                            onChange={(e) => edit(row.stem, 'part_name', e.target.value)}
                            inputProps={{ 'aria-label': `Part name for ${row.stem}` }}
                          />
                          {/*
                            Their number only when it DIFFERS. On the real package it
                            matched the part name on 31 of 31 rows, and a column that
                            repeats its neighbour teaches people to stop reading both.
                          */}
                          {customerId && theirNumber && theirNumber !== name && (
                            <Typography variant="caption" color="text.secondary" display="block">
                              They call it {theirNumber}
                            </Typography>
                          )}
                          {/*
                            Files and warnings live UNDER the name rather than in
                            columns of their own. The card above already says what
                            the package is made of, so a per-row column repeated it
                            thirty-one times; here they appear only when this row
                            differs from what the card promised.
                          */}
                          {oddFiles && (
                            <Typography variant="caption" color="text.secondary" display="block">
                              {row.group.files.map((f) => f.kind).join(' · ') || 'no readable file'}
                            </Typography>
                          )}
                          {note && (
                            <Chip size="small" color="warning" label={note} sx={{ mt: 0.5 }} />
                          )}
                        </TableCell>
                        <TableCell sx={{ minWidth: 220 }}>
                          <TextField
                            variant="standard"
                            fullWidth
                            placeholder="—"
                            value={valueOf(row, 'description')}
                            onChange={(e) => edit(row.stem, 'description', e.target.value)}
                            inputProps={{ 'aria-label': `Description for ${row.stem}` }}
                          />
                        </TableCell>
                        <TableCell align="right">
                          <Box
                            sx={{ display: 'flex', gap: 1, alignItems: 'center', justifyContent: 'flex-end' }}
                          >
                            {wantWork && ops.length > 0 && (
                              <Chip
                                size="small"
                                color="success"
                                label={`${ops.length} station${ops.length === 1 ? '' : 's'}`}
                                onClick={() => setOpenStem(row.stem)}
                              />
                            )}
                            {wantMaterials && materialCount(row.stem) > 0 && (
                              <Chip
                                size="small"
                                variant="outlined"
                                label={`${materialCount(row.stem)} material${materialCount(row.stem) === 1 ? '' : 's'}`}
                                onClick={() => setOpenStem(row.stem)}
                              />
                            )}
                            <Tooltip title="Look at the drawing">
                              <IconButton
                                size="small"
                                onClick={() =>
                                  setViewingStem(viewingStem === row.stem ? null : row.stem)
                                }
                                aria-label={`Open the drawing for ${name}`}
                                color={viewingStem === row.stem ? 'primary' : 'default'}
                              >
                                <DescriptionOutlinedIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            {/*
                              An X, not a bin. Nothing has been created yet, so
                              this drops a row from a list rather than deleting a
                              part — a bin would claim stakes the screen does not
                              have. It reads destructive on APPROACH instead: the
                              hover turns it red, and the panel's own X became a
                              collapse so the two cannot be confused.
                            */}
                            <Tooltip title="Leave this one out">
                              <IconButton
                                size="small"
                                onClick={() => onRowsChange(rows.filter((r) => r.stem !== row.stem))}
                                disabled={creating}
                                aria-label={`Remove ${name}`}
                                sx={{ '&:hover': { color: 'error.light' } }}
                              >
                                <CloseIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Box>
                        </TableCell>
                      </TableRow>

                      <TableRow sx={{ display: canOpen() ? undefined : 'none' }}>
                        <TableCell colSpan={4} sx={{ py: 0, border: 0 }}>
                          <Collapse in={open && canOpen()} unmountOnExit>
                            <Box sx={{ py: 2, px: 1 }}>
                              {wantWork && (
                                <>
                              {rowTimes.has(row.stem) ? (
                                <RoutingOperationsList
                                  rows={ops}
                                  onChange={(next) => setWork(row.stem, next)}
                                  companyId={companyId}
                                  disabled={creating}
                                />
                              ) : (
                                <StationStrip
                                  companyId={companyId}
                                  value={ops}
                                  onChange={(next) => setWork(row.stem, next)}
                                  disabled={creating}
                                  subject={name}
                                />
                              )}
                              <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mt: 1.5, flexWrap: 'wrap' }}>
                                {/*
                                  THE fast path, and it looks like it. One part is
                                  routed and the same answer covers the other
                                  thirty — a package is nearly always one kind of
                                  part made one way.
                                */}
                                {ops.length > 0 && included.length > 1 && (
                                  <Button variant="contained" onClick={() => applyToAll(row.stem)}>
                                    Apply this routing to the other {included.length - 1} part
                                    {included.length - 1 === 1 ? '' : 's'}
                                  </Button>
                                )}
                                <Button
                                  size="small"
                                  onClick={() =>
                                    setRowTimes((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(row.stem)) next.delete(row.stem);
                                      else next.add(row.stem);
                                      return next;
                                    })
                                  }
                                  disabled={creating}
                                >
                                  {rowTimes.has(row.stem) ? 'Just the stations' : 'Set times and rates'}
                                </Button>
                              </Box>
                                </>
                              )}

                              {wantMaterials && (
                                <>
                                  {wantWork && <Divider sx={{ my: 2 }} />}
                                  <MaterialLines
                                    companyId={companyId}
                                    lines={
                                      materials.get(row.stem) ?? [newMaterialLine(defaultUnit)]
                                    }
                                    onChange={(next) => setLines(row.stem, next)}
                                    defaultUnit={defaultUnit}
                                    disabled={creating}
                                  />
                                </>
                              )}
                            </Box>
                          </Collapse>
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      {viewing && (
        <DrawingFilePanel
          key={viewing.stem}
          row={viewing}
          onClose={() => setViewingStem(null)}
        />
      )}
      </Box>

      {/*
        One line of consequence, where the decision is made. Not a banner at the
        top: by the time someone reaches the button they have scrolled past it.
      */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 3, flexWrap: 'wrap' }}>
        <Button onClick={onBack} disabled={creating}>
          Back
        </Button>
        <Box sx={{ flex: 1, minWidth: 280 }}>
          {/*
            Filing IS the outcome, and the copy says so rather than reporting a
            shortfall. Getting thirty-one parts in with their drawings attached is
            the work this feature removes; times are a consensus the shop may not
            have reached today, and a screen that reads as incomplete until they
            have is a screen that invites a made-up number.
          */}
          <Typography variant="caption" color="text.secondary" display="block">
            {included.length} part{included.length === 1 ? '' : 's'} with their drawings attached.
            {withWork > 0 && ` ${withWork} routed.`}
            {totalMaterials > 0 &&
              ` ${totalMaterials} material${totalMaterials === 1 ? '' : 's'}${
                unpricedMaterials > 0 ? `, ${unpricedMaterials} without a cost` : ''
              }.`}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block">
            You can add work and materials now or later — nothing here has to be finished today.
          </Typography>
        </Box>
        {/* Never disabled — interaction-standards §4. */}
        <Button
          variant="contained"
          size="large"
          onClick={onCreate}
          disabled={creating}
        >
          {creating
            ? 'Creating…'
            : `Create ${included.length} part${included.length === 1 ? '' : 's'}`}
        </Button>
      </Box>
    </>
  );
}
