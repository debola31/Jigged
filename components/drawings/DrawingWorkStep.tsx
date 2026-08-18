'use client';

/**
 * Step 3 — the work, entered once and applied to many parts.
 *
 * THE WHOLE POINT. A made part has no cost until it has priced operations, so
 * without this step every part the import creates lands incomplete and cannot be
 * quoted — which is the thing the feature exists to reach. But typing a routing
 * per part is the manual work being removed, so the unit here is ONE routing
 * applied to a SELECTION.
 *
 * NO ROUTING-TEMPLATE ENTITY. It would be a routing without a part, and it
 * duplicates something the shop can already say: *this part works like that one*.
 * So the two ways in are "copy it from a part that already has one" — the shop's
 * own history is the template library — and "build it here once".
 *
 * Skippable on purpose. `Create N parts` never becomes a gate; a shop that wants
 * the drawings filed and nothing else should not be made to invent a routing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

import RoutingOperationsList from '@/components/routings/RoutingOperationsList';
import type { OperationRowData } from '@/components/routings/RoutingOperationRow';
import { getRoutingForPart } from '@/utils/routingsAccess';
import { getAllParts } from '@/utils/partsAccess';
import type { Part } from '@/types/part';
import { valueOf } from '@/types/drawingImport';
import type { BuiltRow } from '@/lib/drawingImportExtract';

export interface WorkPlan {
  /** Stems this routing applies to. */
  stems: Set<string>;
  operations: OperationRowData[];
}

interface Props {
  companyId: string;
  rows: BuiltRow[];
  plan: WorkPlan;
  onPlanChange: (plan: WorkPlan) => void;
  onBack: () => void;
  onCreate: () => void;
  creating: boolean;
  includedCount: number;
}

const newTempId = () => `tmp-${Math.random().toString(36).slice(2)}`;

export default function DrawingWorkStep({
  companyId,
  rows,
  plan,
  onPlanChange,
  onBack,
  onCreate,
  creating,
  includedCount,
}: Props) {
  const included = useMemo(() => rows.filter((r) => !r.excluded), [rows]);
  const [copyFrom, setCopyFrom] = useState<Part | null>(null);
  const [parts, setParts] = useState<Part[]>([]);
  const [loadingParts, setLoadingParts] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  // Every part starts selected: the common case is one package of similar parts,
  // and making someone tick 31 boxes to reach the default is the wrong way round.
  useEffect(() => {
    if (plan.stems.size === 0 && included.length > 0) {
      onPlanChange({ ...plan, stems: new Set(included.map((r) => r.stem)) });
    }
    // Only seeds the initial selection; later edits are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [included.length]);

  const loadParts = useCallback(async () => {
    if (parts.length > 0 || loadingParts) return;
    setLoadingParts(true);
    try {
      setParts(await getAllParts(companyId));
    } finally {
      setLoadingParts(false);
    }
  }, [companyId, parts.length, loadingParts]);

  /** Pull an existing part's routing in as the starting point. */
  const applyCopy = useCallback(
    async (part: Part | null) => {
      setCopyFrom(part);
      setCopyError(null);
      if (!part) return;
      try {
        const routing = await getRoutingForPart(part.id);
        const ops = routing?.operations ?? [];
        if (ops.length === 0) {
          setCopyError(`${part.part_name} has no operations to copy.`);
          return;
        }
        onPlanChange({
          ...plan,
          // Fresh temp ids: these become NEW rows on each part, not references to
          // the source part's operations.
          operations: ops.map((op) => ({
            tempId: newTempId(),
            workCenterId: op.work_center_id,
            workCenterName: op.work_center?.name ?? '',
            workCenterKind: op.work_center?.kind ?? 'internal',
            vendorName: op.work_center?.vendor?.name ?? null,
            setupMinutes: op.setup_minutes,
            cycleMinutesPerUnit: op.cycle_minutes_per_unit,
            laborRateOverride: op.labor_rate_override,
            workCenterLaborRate: op.work_center?.labor_rate ?? null,
            externalUnitPrice: op.external_unit_price,
            instructions: op.instructions,
          })) as OperationRowData[],
        });
      } catch (err) {
        setCopyError(err instanceof Error ? err.message : 'Could not read that routing.');
      }
    },
    [plan, onPlanChange],
  );

  const toggle = (stem: string) => {
    const next = new Set(plan.stems);
    if (next.has(stem)) next.delete(stem);
    else next.add(stem);
    onPlanChange({ ...plan, stems: next });
  };

  const allSelected = included.length > 0 && plan.stems.size === included.length;
  const opCount = plan.operations.length;
  const willGetWork = included.filter((r) => plan.stems.has(r.stem)).length;

  /** An operation nobody can price leaves the part incomplete anyway — say so here. */
  const unpricedOps = plan.operations.filter((o) =>
    o.workCenterKind === 'internal'
      ? o.laborRateOverride == null && o.workCenterLaborRate == null
      : o.externalUnitPrice == null,
  ).length;

  return (
    <>
      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>How are these parts made?</AlertTitle>
        A part needs at least one priced operation before it can be costed or quoted. Set the work
        once and it applies to every part you tick — you can adjust individual parts afterwards.
        Skipping is fine; the parts are still created, just not yet quotable.
      </Alert>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap', mb: 2 }}>
            <Box sx={{ minWidth: 320, flex: 1 }}>
              <Autocomplete
                options={parts}
                loading={loadingParts}
                value={copyFrom}
                onOpen={loadParts}
                onChange={(_, next) => void applyCopy(next)}
                getOptionLabel={(p) => p.part_name}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    size="small"
                    label="Start from a part you already make"
                  />
                )}
              />
              <Typography variant="caption" color="text.secondary">
                Copies that part&apos;s operations in. Your own parts are the template library.
              </Typography>
            </Box>
            {copyFrom && (
              <Chip
                icon={<ContentCopyIcon />}
                label={`Copied from ${copyFrom.part_name}`}
                onDelete={() => setCopyFrom(null)}
              />
            )}
          </Box>

          {copyError && (
            <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setCopyError(null)}>
              {copyError}
            </Alert>
          )}

          <Divider sx={{ my: 2 }} />

          <RoutingOperationsList
            rows={plan.operations}
            onChange={(next) => onPlanChange({ ...plan, operations: next })}
            companyId={companyId}
            disabled={creating}
          />

          {unpricedOps > 0 && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {unpricedOps} operation{unpricedOps === 1 ? '' : 's'} {unpricedOps === 1 ? 'has' : 'have'}{' '}
              no rate, so the parts will still read as incomplete. Set a labour rate on the work
              centre, or a price on the operation.
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent sx={{ p: 0 }}>
          <TableContainer sx={{ maxHeight: '38vh' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={allSelected}
                      indeterminate={plan.stems.size > 0 && !allSelected}
                      onChange={() =>
                        onPlanChange({
                          ...plan,
                          stems: allSelected ? new Set() : new Set(included.map((r) => r.stem)),
                        })
                      }
                      inputProps={{ 'aria-label': 'Apply to every part' }}
                    />
                  </TableCell>
                  <TableCell>Part</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell>Gets this work</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {included.map((row) => {
                  const on = plan.stems.has(row.stem);
                  return (
                    <TableRow key={row.stem} hover data-testid="work-row">
                      <TableCell padding="checkbox">
                        <Checkbox
                          checked={on}
                          onChange={() => toggle(row.stem)}
                          inputProps={{ 'aria-label': `Apply work to ${row.stem}` }}
                        />
                      </TableCell>
                      <TableCell>{valueOf(row, 'part_name')}</TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">
                          {valueOf(row, 'description') || '—'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {on && opCount > 0 ? (
                          <Chip
                            size="small"
                            color="success"
                            label={`${opCount} operation${opCount === 1 ? '' : 's'}`}
                          />
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            —
                          </Typography>
                        )}
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
          <Typography variant="caption" color="text.secondary">
            {opCount === 0
              ? 'No operations set — parts will be created without a routing.'
              : `${opCount} operation${opCount === 1 ? '' : 's'} on ${willGetWork} of ${included.length} parts.`}
          </Typography>
        </Box>
        {/* Never disabled — interaction-standards §4. Skipping is a legitimate choice. */}
        <Button variant="contained" size="large" onClick={onCreate} disabled={creating}>
          {creating ? 'Creating…' : `Create ${includedCount} part${includedCount === 1 ? '' : 's'}`}
        </Button>
      </Box>
    </>
  );
}
