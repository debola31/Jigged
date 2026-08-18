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
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

import RoutingOperationsList from '@/components/routings/RoutingOperationsList';
import type { OperationRowData } from '@/components/routings/RoutingOperationRow';
import { valueOf, type DrawingRowValues } from '@/types/drawingImport';
import { unreadableMessage, type BuiltRow } from '@/lib/drawingImportExtract';
import { summariseFiles } from '@/lib/drawingFileSummary';
import { quantityFor, type ComponentPlan } from '@/lib/drawingComponents';

/** What work each part takes. Keyed by stem — one entry per part, not one plan. */
export type WorkByStem = Map<string, OperationRowData[]>;

interface Props {
  companyId: string;
  rows: BuiltRow[];
  onRowsChange: (rows: BuiltRow[]) => void;
  fileCount: number;
  work: WorkByStem;
  onWorkChange: (next: WorkByStem) => void;
  components: ComponentPlan;
  onComponentsChange: (next: ComponentPlan) => void;
  onBack: () => void;
  onCreate: (thenQuote: boolean) => void;
  creating: boolean;
  /** True while title blocks are still being read. Never blocks anything. */
  reading: boolean;
  readProgress: { done: number; total: number } | null;
  onAssist: () => void;
  assistFailed: boolean;
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
  components,
  onComponentsChange,
  onBack,
  onCreate,
  creating,
  reading,
  readProgress,
  onAssist,
  assistFailed,
  customerId,
}: Props) {
  const [openStem, setOpenStem] = useState<string | null>(null);
  /** The bulk editor, above the table — see the button that opens it. */
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkOps, setBulkOps] = useState<OperationRowData[]>([]);

  const included = useMemo(() => rows.filter((r) => !r.excluded), [rows]);
  const summary = useMemo(
    () => summariseFiles(rows.map((r) => ({ kinds: r.group.files.map((f) => f.kind) })), fileCount),
    [rows, fileCount],
  );
  const needsAttention = useMemo(() => rows.filter((r) => attention(r) !== null), [rows]);

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

  /**
   * Set the work for everything, without opening a row first.
   *
   * The common case by a distance is *these 31 parts are made the same way*, and
   * making someone expand a row to say so put a click and a scroll in front of the
   * one thing the whole screen exists for. Per-row editing stays for the outlier,
   * which is what a row is good at.
   */
  const applyBulk = () => {
    if (bulkOps.length === 0) return;
    const next = new Map(work);
    for (const row of included) {
      next.set(
        row.stem,
        bulkOps.map((op) => ({ ...op, tempId: `tmp-${row.stem}-${op.tempId}` })),
      );
    }
    onWorkChange(next);
    setBulkOpen(false);
  };

  const withWork = included.filter((r) => (work.get(r.stem)?.length ?? 0) > 0).length;
  const withCutList = included.filter((r) => r.cutList).length;

  /** The pooled materials this particular part is built from. */
  const materialsFor = (stem: string) =>
    components.materials.filter((m) => m.usedBy.some((u) => u.stem === stem));

  const setMaterial = (key: string, patch: Partial<ComponentPlan['materials'][number]>) =>
    onComponentsChange({
      ...components,
      materials: components.materials.map((m) => (m.key === key ? { ...m, ...patch } : m)),
    });

  const setMade = (key: string, include: boolean) =>
    onComponentsChange({
      ...components,
      made: components.made.map((m) => (m.key === key ? { ...m, include } : m)),
    });

  const unpricedMaterials = components.materials.filter(
    (m) => m.include && m.costPerUnit === null,
  ).length;

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

          {/*
            A LINE, not a progress bar. Nothing here waits on it — descriptions
            arrive while people work — and a bar reads as "wait for me".
          */}
          {reading && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              <AutoAwesomeIcon sx={{ fontSize: 14, verticalAlign: 'text-bottom', mr: 0.5 }} />
              Filling in material and finish
              {readProgress ? ` — ${readProgress.done} of ${readProgress.total}` : ''}. Carry on.
            </Typography>
          )}

          {assistFailed && !reading && (
            <Button size="small" startIcon={<AutoAwesomeIcon />} onClick={onAssist} sx={{ mt: 1 }}>
              Read the title blocks again
            </Button>
          )}
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
        <CardContent>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="outlined" onClick={() => setBulkOpen((o) => !o)} disabled={creating}>
              {withWork > 0 ? 'Change the work for every part' : 'Set the work for every part'}
            </Button>
            <Typography variant="caption" color="text.secondary">
              Most packages are one kind of part made one way. Set it once here, then adjust any
              part that differs on its own row.
            </Typography>
          </Box>

          <Collapse in={bulkOpen} unmountOnExit>
            <Box sx={{ mt: 2 }}>
              <RoutingOperationsList
                rows={bulkOps}
                onChange={setBulkOps}
                companyId={companyId}
                disabled={creating}
              />
              <Button
                variant="contained"
                sx={{ mt: 1 }}
                onClick={applyBulk}
                disabled={creating || bulkOps.length === 0}
              >
                Apply to all {included.length} part{included.length === 1 ? '' : 's'}
              </Button>
            </Box>
          </Collapse>
        </CardContent>
      </Card>

      <Card>
        <CardContent sx={{ p: 0 }}>
          <TableContainer sx={{ maxHeight: '58vh' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" />
                  <TableCell padding="checkbox" />
                  <TableCell>Part</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell>Work</TableCell>
                  <TableCell>Made of</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => {
                  const note = attention(row);
                  const ops = work.get(row.stem) ?? [];
                  const open = openStem === row.stem;
                  const materials = materialsFor(row.stem);
                  const made = components.made.filter((m) => m.parentStem === row.stem);
                  const theirNumber = valueOf(row, 'customer_part_number');
                  const name = valueOf(row, 'part_name');
                  const oddFiles =
                    [...new Set(row.group.files.map((f) => f.kind))].sort().join('+') !==
                    commonFiles;

                  return (
                    <Fragment key={row.stem}>
                      <TableRow
                        hover
                        sx={{ opacity: row.excluded ? 0.4 : 1 }}
                        data-testid="drawing-row"
                      >
                        <TableCell padding="checkbox">
                          <IconButton
                            size="small"
                            onClick={() => setOpenStem(open ? null : row.stem)}
                            aria-label={`Set up ${row.stem}`}
                          >
                            {open ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
                          </IconButton>
                        </TableCell>
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
                        <TableCell>
                          {ops.length > 0 ? (
                            <Chip
                              size="small"
                              color="success"
                              label={`${ops.length} operation${ops.length === 1 ? '' : 's'}`}
                              onClick={() => setOpenStem(row.stem)}
                            />
                          ) : (
                            <Button size="small" onClick={() => setOpenStem(row.stem)}>
                              Add work
                            </Button>
                          )}
                        </TableCell>
                        <TableCell>
                          {row.cutList ? (
                            <Chip
                              size="small"
                              variant="outlined"
                              label={`${row.cutList.rows.length}`}
                              title={`This drawing lists ${row.cutList.rows.length} components`}
                              onClick={() => setOpenStem(row.stem)}
                            />
                          ) : (
                            <Typography variant="caption" color="text.secondary">
                              —
                            </Typography>
                          )}
                        </TableCell>
                      </TableRow>

                      <TableRow>
                        <TableCell colSpan={6} sx={{ py: 0, border: 0 }}>
                          <Collapse in={open} unmountOnExit>
                            <Box sx={{ py: 2, px: 1 }}>
                              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                                How {name} is made
                              </Typography>
                              <RoutingOperationsList
                                rows={ops}
                                onChange={(next) => setWork(row.stem, next)}
                                companyId={companyId}
                                disabled={creating}
                              />
                              {ops.length > 0 && included.length > 1 && (
                                <Button
                                  size="small"
                                  sx={{ mt: 1 }}
                                  onClick={() => applyToAll(row.stem)}
                                >
                                  Apply this work to the other {included.length - 1} part
                                  {included.length - 1 === 1 ? '' : 's'}
                                </Button>
                              )}

                              {(materials.length > 0 || made.length > 0) && (
                                <>
                                  <Divider sx={{ my: 2 }} />
                                  <Typography variant="subtitle2" sx={{ mb: 1 }}>
                                    What {name} is made of
                                  </Typography>

                                  {materials.map((m) => {
                                    const otherParts = new Set(
                                      m.usedBy.map((u) => u.stem).filter((s) => s !== row.stem),
                                    );
                                    return (
                                      <Box
                                        key={m.key}
                                        data-testid="material-row"
                                        sx={{
                                          display: 'flex',
                                          gap: 2,
                                          alignItems: 'center',
                                          flexWrap: 'wrap',
                                          mb: 1,
                                        }}
                                      >
                                        <Checkbox
                                          checked={m.include}
                                          onChange={(e) =>
                                            setMaterial(m.key, { include: e.target.checked })
                                          }
                                          inputProps={{ 'aria-label': `Include ${m.description}` }}
                                        />
                                        <Box sx={{ minWidth: 200 }}>
                                          <Typography variant="body2">{m.description}</Typography>
                                          <Typography variant="caption" color="text.secondary">
                                            {quantityFor(m, row.stem)} needed here
                                            {otherParts.size > 0 &&
                                              ` · also used by ${otherParts.size} other part${
                                                otherParts.size === 1 ? '' : 's'
                                              }`}
                                          </Typography>
                                        </Box>
                                        <TextField
                                          size="small"
                                          label="Unit"
                                          sx={{ width: 110 }}
                                          value={m.unit ?? ''}
                                          onChange={(e) =>
                                            setMaterial(m.key, { unit: e.target.value || null })
                                          }
                                          inputProps={{
                                            'aria-label': `Unit for ${m.description}`,
                                          }}
                                        />
                                        <TextField
                                          size="small"
                                          label="Cost per unit"
                                          sx={{ width: 150 }}
                                          value={m.costPerUnit ?? ''}
                                          onChange={(e) => {
                                            const raw = e.target.value.trim();
                                            const n = Number(raw);
                                            setMaterial(m.key, {
                                              costPerUnit:
                                                raw === '' || !Number.isFinite(n) ? null : n,
                                            });
                                          }}
                                          inputProps={{
                                            'aria-label': `Cost per unit for ${m.description}`,
                                          }}
                                        />
                                      </Box>
                                    );
                                  })}

                                  {made.map((c) => (
                                    <Box
                                      key={c.key}
                                      sx={{ display: 'flex', gap: 1, alignItems: 'center' }}
                                    >
                                      <Checkbox
                                        checked={c.include}
                                        onChange={(e) => setMade(c.key, e.target.checked)}
                                        inputProps={{ 'aria-label': c.description }}
                                      />
                                      <Typography variant="body2">{c.description}</Typography>
                                      <Typography variant="caption" color="text.secondary">
                                        made here — no work yet, so it holds this part back
                                      </Typography>
                                    </Box>
                                  ))}
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

      {/*
        One line of consequence, where the decision is made. Not a banner at the
        top: by the time someone reaches the button they have scrolled past it.
      */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 3, flexWrap: 'wrap' }}>
        <Button onClick={onBack} disabled={creating}>
          Back
        </Button>
        <Box sx={{ flex: 1, minWidth: 260 }}>
          <Typography variant="caption" color="text.secondary" display="block">
            {withWork === 0
              ? 'No work set yet — parts will be created, but none will be quotable.'
              : `${withWork} of ${included.length} have work.`}
            {withCutList > 0 &&
              ` ${withCutList} list components${
                unpricedMaterials > 0
                  ? `, ${unpricedMaterials} material${unpricedMaterials === 1 ? '' : 's'} still need a cost`
                  : ''
              }.`}
          </Typography>
        </Box>
        <Button size="large" onClick={() => onCreate(false)} disabled={creating}>
          {creating ? 'Creating…' : 'Create without quoting'}
        </Button>
        {/* The goal was never parts. Never disabled — interaction-standards §4. */}
        <Button
          variant="contained"
          size="large"
          onClick={() => onCreate(true)}
          disabled={creating}
        >
          {creating
            ? 'Creating…'
            : `Create ${included.length} part${included.length === 1 ? '' : 's'} & start a quote`}
        </Button>
      </Box>
    </>
  );
}
