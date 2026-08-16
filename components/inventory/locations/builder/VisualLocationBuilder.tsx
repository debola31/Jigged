'use client';

import { useEffect, useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import posthog from 'posthog-js';

import type {
  InventoryLocationNode,
  LevelSpec,
  LocationContent,
  LocationSpecNode,
} from '@/types/inventoryLocations';
import {
  buildSpecFromLevels,
  collectSpecLeaves,
  removeSpecNode,
  renameSpecNode,
  addChildUnder,
  duplicateNode,
} from '@/utils/locationSpec';
import {
  PARENT_REF,
  describeRedistribution,
  describeReshape,
  inferLevelsFromSubtree,
  isExistingKey,
  locationIdOf,
  numbersCanDescribe,
  planReshape,
  readSubtreeAsSpec,
  reconcileLevelsWithExisting,
  serializeReshape,
  type ReshapePlan,
} from '@/utils/locationReshape';
import { occupancyFor, type OccupancyMap } from '@/utils/locationOccupancy';
import {
  applyLocationLayout,
  getContentsPageForLocations,
  materializeLocationSpec,
  type ReshapeMove,
} from '@/utils/inventoryLocationsAccess';
import LevelConfigStep from './LevelConfigStep';
import DistributeContentsStep, {
  assignedDestinations,
  isDistributionComplete,
  sourceKey,
  type AssignmentMap,
} from './DistributeContentsStep';
import ReshapeImpactDialog from './ReshapeImpactDialog';
import { cloneLevels } from './storageTypes';

/**
 * What the generator opens on: five rows, each split left and right.
 *
 * A starting point you edit, not a choice you make — and both numbers are editable on the same
 * screen. Landing on something concrete beats landing on an empty form and having to guess what the
 * fields want. Only reachable when there is nothing to seed from.
 */
const DEFAULT_LEVELS: LevelSpec[] = [
  { kind: 'row', count: 5, namePattern: 'Row {n}' },
  { kind: 'bin', names: ['Left', 'Right'] },
];

/**
 * Most parts one reshape will re-place. Mirrors `LOCATION_CONTENTS_LIMIT`.
 *
 * Past it the flow REFUSES rather than showing a clipped table: a distribution that silently
 * omitted half its rows would look complete and roll the whole reshape back at COMMIT.
 */
const RESHAPE_DISTRIBUTE_MAX = 200;

/** A stable identity, so `planReshape`'s memo does not recompute on every render. */
const NO_OCCUPANCY: OccupancyMap = new Map();

interface VisualLocationBuilderProps {
  open: boolean;
  companyId: string;
  /**
   * The unit being reshaped, with its children — **this is what makes it a reshape**.
   *
   * Null means creating a new unit at the top level. Passing one switches the whole dialog: it
   * seeds from the real subtree, diffs what you do to it, and writes through
   * `apply_location_layout` instead of `create_location_tree`.
   */
  unit?: InventoryLocationNode | null;
  /** Human path of the unit, for the dialog title. */
  parentPath?: string[];
  /**
   * Names already at the top level, so a new unit's name can be checked before it is typed into a
   * 23505. Only meaningful when `unit` is null.
   */
  siblingNames?: string[];
  /**
   * Fill state, already rolled up on the Storage page.
   *
   * Passed in rather than fetched because it is what makes "3 of these hold stock" appear as you
   * type instead of one round trip later — and the page has had it all along without ever handing
   * it to this dialog, which is part of why the old flow could not warn about anything.
   */
  occupancy?: OccupancyMap;
  onClose: () => void;
  onDone: (message: string) => void;
}

export default function VisualLocationBuilder({
  open,
  companyId,
  unit = null,
  parentPath,
  siblingNames,
  occupancy,
  onClose,
  onDone,
}: VisualLocationBuilderProps) {
  /**
   * Two modes, and the difference is not cosmetic.
   *
   * `create` builds a unit that does not exist. `reshape` edits one that does — so it starts from
   * that unit's real layout, every node it did not touch keeps its id (and therefore its stock and
   * its printed label), and what it writes is a diff.
   *
   * The old dialog had only the first, aimed at an existing parent. That is why `Change layout`
   * could only ever append.
   */
  const reshaping = unit !== null;

  const [unitName, setUnitName] = useState('');
  const [levels, setLevels] = useState<LevelSpec[]>(() => cloneLevels(DEFAULT_LEVELS));
  /**
   * Once a branch is fine-tuned the tree is hand-edited directly and no longer regenerated from
   * `levels`. Both modes start seeded from reality on a reshape; which one you land in is decided
   * by `numbersCanDescribe` — see `reset`.
   */
  const [customized, setCustomized] = useState(false);
  const [editedTree, setEditedTree] = useState<LocationSpecNode[]>([]);
  const [startOverOpen, setStartOverOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contents, setContents] = useState<LocationContent[]>([]);
  const [loadingContents, setLoadingContents] = useState(false);
  const [overflow, setOverflow] = useState(0);
  const [assignments, setAssignments] = useState<AssignmentMap>({});
  const [step, setStep] = useState<'layout' | 'distribute'>('layout');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const reset = () => {
    setUnitName('');
    setStartOverOpen(false);
    setConfirmOpen(false);
    setWorking(false);
    setError(null);
    setContents([]);
    setOverflow(0);
    setAssignments({});
    setStep('layout');
    setLoadingContents(false);

    if (!unit || unit.children.length === 0) {
      // Nothing to seed from — a new unit, or one that is a single location (the Yard, a bench).
      setCustomized(false);
      setEditedTree([]);
      setLevels(cloneLevels(DEFAULT_LEVELS));
      return;
    }

    /*
     * **The numbers, pre-filled with what this unit already is.**
     *
     * The first version opened on the per-location editor, reasoning that a real cabinet is rarely
     * uniform. That buried the case people actually have. The founder, on seeing it: *"I was
     * expecting that it would bring up the same modal you use when creating a storage unit and just
     * let you change it. So let's say you created something that was 5x5, you could just change it
     * to 4x4."* Which is right — and it is what `inferLevelsFromSubtree` was written for.
     *
     * A unit the numbers cannot describe falls back to the per-location editor, because opening
     * THAT on the numbers would greet you with "Creating 15 locations" before you touched anything.
     * `numbersCanDescribe` decides by round-tripping through the same two functions the editor
     * uses, so the fallback cannot disagree with what the editor would actually do.
     */
    setEditedTree(readSubtreeAsSpec(unit));
    setLevels(inferLevelsFromSubtree(unit));
    setCustomized(!numbersCanDescribe(unit));
  };

  const uniformTree = useMemo(
    () =>
      // Reshape reconciles the numbers against what is really there — the i-th name lands on the
      // i-th existing child, KEEPING its key. Creating has nothing to reconcile against.
      reshaping
        ? reconcileLevelsWithExisting(unit ? readSubtreeAsSpec(unit) : [], levels)
        : buildSpecFromLevels(levels),
    [reshaping, unit, levels],
  );
  const tree = customized ? editedTree : uniformTree;

  /** What a create writes: the levels wrapped in a root node named by the field above. */
  const createSpec = useMemo(
    () => [{ key: 'unit', name: unitName.trim(), kind: null, children: tree }],
    [tree, unitName],
  );
  const leaves = useMemo(
    () => collectSpecLeaves(reshaping ? tree : createSpec),
    [reshaping, tree, createSpec],
  );

  /**
   * The diff, recomputed as you edit.
   *
   * Pure and network-free, so "2 locations to remove, 1 of them holds stock" is on screen the
   * moment you change a number rather than after a round trip.
   */
  const plan: ReshapePlan | null = useMemo(
    () => (unit ? planReshape({ unit, spec: tree, occupancy: occupancy ?? NO_OCCUPANCY }) : null),
    [unit, tree, occupancy],
  );

  /** Destinations a part may be sent to. `PARENT_REF` when the unit flattens to one location. */
  const destinations = useMemo(
    () => plan?.destinations ?? leaves.map((l) => ({ ref: l.key, label: l.label })),
    [plan, leaves],
  );

  /**
   * Read what has to move, when the plan says something does.
   *
   * Lazily, scoped to the source locations, and only on reaching the distribute step: the plan
   * already knows WHETHER a step is needed (from occupancy), so the button's label never changes
   * after a round trip — only its contents wait.
   */
  const sources = plan?.stockSources ?? [];
  const needsDistribution = sources.length > 0;

  useEffect(() => {
    if (step !== 'distribute' || !needsDistribution) return;
    let cancelled = false;
    setLoadingContents(true);
    getContentsPageForLocations(
      sources.map((s) => s.locationId),
      { limit: RESHAPE_DISTRIBUTE_MAX },
    )
      .then((page) => {
        if (cancelled) return;
        setContents(page.contents);
        setOverflow(Math.max(0, page.total - page.contents.length));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read what is there.');
      })
      .finally(() => !cancelled && setLoadingContents(false));
    return () => {
      cancelled = true;
    };
    // The source SET, not its identity — the array is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, needsDistribution, sources.map((s) => s.locationId).sort().join(',')]);

  /**
   * Drop assignments whose destination the latest edit removed.
   *
   * Stepping back to the layout and deleting the bin you had just sent forty bearings to would
   * otherwise leave an assignment pointing at a ref the payload no longer contains, and the RPC
   * would refuse it with "Move targets unknown ref" after the confirmation.
   */
  useEffect(() => {
    const valid = new Set(destinations.map((d) => d.ref));
    setAssignments((current) => {
      let changed = false;
      const next: AssignmentMap = {};
      for (const [key, lines] of Object.entries(current)) {
        const kept = lines.filter((l) => l.toRef === '' || valid.has(l.toRef));
        if (kept.length !== lines.length) changed = true;
        next[key] = kept;
      }
      return changed ? next : current;
    });
  }, [destinations]);

  const editRemove = (key: string) => {
    setEditedTree(removeSpecNode(tree, key));
    setCustomized(true);
  };
  const editAdd = (parentKey: string) => {
    setEditedTree(addChildUnder(tree, parentKey));
    setCustomized(true);
  };
  const editDuplicate = (key: string) => {
    setEditedTree(duplicateNode(tree, key));
    setCustomized(true);
  };
  const editRename = (key: string, name: string) => {
    setEditedTree(renameSpecNode(tree, key, name));
    setCustomized(true);
  };
  const enterCustomize = () => {
    setEditedTree(tree);
    setCustomized(true);
  };

  const confirmStartOver = () => {
    setCustomized(false);
    setEditedTree([]);
    setStartOverOpen(false);
  };

  const distributionReady = isDistributionComplete(contents, assignments);
  const trimmedName = unitName.trim();
  const duplicateName = trimmedName
    ? (siblingNames ?? []).find((n) => n.trim().toLowerCase() === trimmedName.toLowerCase())
    : undefined;

  const structuralBlocker = plan?.blockers[0];
  const tooMuchToPlace = overflow > 0;

  /** A unit needs a name; its levels are optional. A reshape needs to actually change something. */
  const canProceed = reshaping
    ? Boolean(plan && !plan.isNoop && plan.blockers.length === 0)
    : Boolean(trimmedName) && !duplicateName && leaves.length > 0;

  // ── The impact summary ──────────────────────────────────────────────────────

  const impactLines = useMemo(() => {
    if (!plan || !unit) return [];
    const lines = describeReshape(plan, unit.name);
    const moved = describeRedistribution(
      assignedDestinations(assignments),
      Object.values(assignments).filter((l) => l.length > 0).length,
      (ref) => destinations.find((d) => d.ref === ref)?.label,
    );
    return moved ? [...lines, moved] : lines;
  }, [plan, unit, assignments, destinations]);

  /**
   * Locations that keep exactly what they hold — the reassurance half of the summary.
   *
   * Existing final leaves that are not losing their stock. A renamed one still counts: it holds
   * what it held, under a different name.
   */
  const untouched = useMemo(() => {
    if (!plan) return 0;
    const losing = new Set(plan.stockSources.map((s) => s.locationId));
    return plan.destinations.filter(
      (d) => isExistingKey(d.ref) && !losing.has(locationIdOf(d.ref)),
    ).length;
  }, [plan]);

  // ── Writing ─────────────────────────────────────────────────────────────────

  const runCreate = async () => {
    const created = await materializeLocationSpec(companyId, null, createSpec, 0);
    onDone(`Created ${created.length} location${created.length === 1 ? '' : 's'}.`);
  };

  const runReshape = async () => {
    if (!unit || !plan) return;
    const payload = serializeReshape(unit, tree);
    const byKey = new Map(contents.map((c) => [sourceKey(c), c]));
    const moves: ReshapeMove[] = Object.entries(assignments).flatMap(([key, lines]) => {
      const content = byKey.get(key);
      if (!content) return [];
      return lines
        .filter((l) => l.toRef && l.quantity > 0)
        .map((l) => ({
          partId: content.part_id,
          fromLocationId: content.location_id,
          // `PARENT_REF` passes through untouched: the RPC reserves it for the unit itself.
          toRef: l.toRef === PARENT_REF ? PARENT_REF : l.toRef,
          quantity: l.quantity,
          unit: content.primary_unit || 'ea',
        }));
    });

    await applyLocationLayout(unit.id, payload, moves);

    /*
     * One event for the whole reshape, and deliberately NOT a `stock updated` per moved part: the
     * redistribution happens server-side inside one RPC, so firing one per part would attribute
     * dozens of writes to a single click and inflate that event's denominator. Counts, a boolean
     * and a depth — no location names, no part ids, no quantities (#702).
     */
    posthog.capture('location layout changed', {
      locations_created: plan.created.length,
      locations_renamed: plan.renamed.length,
      locations_moved: plan.moved.length,
      locations_removed: plan.removed.length,
      locations_with_stock_removed: plan.removed.filter((r) => r.directParts > 0).length,
      parts_redistributed: moves.length,
      used_levels_editor: !customized,
      final_depth: plan.finalDepth,
    });

    /*
     * "Cabinet 3: 1 location removed." / "Cabinet 3: 4 locations added, 2 removed, 1 renamed."
     *
     * The noun rides on the FIRST clause and agrees with its number, which is how anyone would say
     * it out loud. An earlier version composed `Removed 1 in Cabinet 3.` — grammatical, and it
     * never said WHAT was removed.
     */
    const counts: Array<[number, string]> = [
      [plan.created.filter((c) => c.isLeaf).length, 'added'],
      [plan.removed.filter((r) => r.isLeaf).length, 'removed'],
      [plan.renamed.length, 'renamed'],
    ];
    const clauses = counts.filter(([n]) => n > 0);
    const noun = clauses[0]?.[0] === 1 ? 'location' : 'locations';
    onDone(
      `${unit.name}: ${clauses
        .map(([n, verb], i) => (i === 0 ? `${n} ${noun} ${verb}` : `${n} ${verb}`))
        .join(', ')}.`,
    );
  };

  const run = async () => {
    setWorking(true);
    setError(null);
    try {
      if (reshaping) await runReshape();
      else await runCreate();
      setConfirmOpen(false);
      onClose();
    } catch (e) {
      setConfirmOpen(false);
      setError(e instanceof Error ? e.message : 'Could not apply the change.');
    } finally {
      setWorking(false);
    }
  };

  // ── The primary button, which is three different buttons ────────────────────

  const onDistributeStep = step === 'distribute';
  const readyToApply = !needsDistribution || (onDistributeStep && distributionReady);

  const primary = !reshaping
    ? {
        label: `Create ${leaves.length} location${leaves.length === 1 ? '' : 's'}`,
        disabled: working || !canProceed,
        onClick: run,
      }
    : needsDistribution && !onDistributeStep
      ? {
          label: 'Next: where does the stock go?',
          disabled: working || !canProceed || tooMuchToPlace,
          onClick: () => setStep('distribute'),
        }
      : {
          label: 'Review changes',
          disabled:
            working || !canProceed || loadingContents || !readyToApply || tooMuchToPlace,
          onClick: () => setConfirmOpen(true),
        };

  return (
    <Dialog
      open={open}
      onClose={working ? undefined : onClose}
      maxWidth="lg"
      fullWidth
      TransitionProps={{ onEnter: reset }}
    >
      <DialogTitle>
        {reshaping
          ? `Change the layout of ${parentPath?.length ? parentPath.join(' › ') : 'this unit'}`
          : 'Add storage'}
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 420 }}>
        <Box>
          <Box sx={{ minWidth: 0, display: step === 'layout' ? 'block' : 'none' }}>
            {!reshaping && (
              <Box sx={{ mb: 3 }}>
                {/* freeSolo, so it stays a name field that happens to suggest — picking an existing
                    name is how you avoid typing a second spelling of it. Same control and the same
                    case-insensitive match the sibling-name index uses, so the warning and the
                    constraint cannot disagree. */}
                <Autocomplete
                  freeSolo
                  options={siblingNames ?? []}
                  value={unitName}
                  onInputChange={(_, v) => setUnitName(v)}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="What is it called?"
                      // `shelf` survives HERE and in the empty state, and nowhere else. Naming one
                      // as an example of furniture a shop owns is doing work; using it as the
                      // generic word for a location is what was wrong — a bin inside Cabinet 3 is
                      // not a shelf, and neither is the yard.
                      placeholder="Cabinet 1, the shelf by the welder, the yard…"
                      autoFocus
                      required
                      error={Boolean(duplicateName)}
                      helperText={
                        duplicateName
                          ? `You already have a ${duplicateName}.`
                          : 'Then say how it is divided up — or leave it as one location.'
                      }
                    />
                  )}
                />
              </Box>
            )}

            {/* The running impact, above the editor rather than behind the confirm. The whole
                complaint about the old dialog was that it never said what it was about to do. */}
            {reshaping && plan && <ImpactStrip plan={plan} unit={unit!} occupancy={occupancy} />}

            {/* Kept mounted rather than unmounted when the distribute step is showing: the config
                holds the hand-edited tree, and stepping back must not reset it. */}
            <LevelConfigStep
              levels={levels}
              onChange={setLevels}
              total={leaves.length}
              customized={customized}
              tree={tree}
              onCustomize={enterCustomize}
              onRemove={editRemove}
              onAdd={editAdd}
              onDuplicate={editDuplicate}
              onRename={reshaping ? editRename : undefined}
              onStartOver={() => setStartOverOpen(true)}
              duplicateKeys={
                plan?.blockers.find((b) => b.code === 'duplicate-sibling-name')?.keys ?? []
              }
              startOverLabel={reshaping ? 'Use rows and bins instead…' : 'Start over'}
              customizeLabel={
                reshaping ? 'Edit locations one by one…' : 'Customize individual spots'
              }
              customizedNote={
                reshaping
                  ? `${unit?.name} isn't a regular grid — its rows don't all divide the same way — so it is shown location by location.`
                  : undefined
              }
            />
          </Box>

          {step === 'distribute' && (
            <DistributeContentsStep
              sources={sources}
              contents={contents}
              leaves={destinations.map((d) => ({ key: d.ref, label: d.label }))}
              assignments={assignments}
              onChange={setAssignments}
              loading={loadingContents}
            />
          )}
        </Box>

        {/* A blocker is stated where it is created, never saved up for the confirm — a dialog that
            ends in an error is the shape `docs/interaction-standards.md` forbids outright. */}
        {structuralBlocker && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {structuralBlocker.message}
          </Alert>
        )}
        {tooMuchToPlace && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            This would empty locations holding {(contents.length + overflow).toLocaleString()} parts
            between them, which is more than one change can re-place. Reshape it in smaller
            sections, or move some stock out first.
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={working}>
          Cancel
        </Button>
        <Box sx={{ flex: 1 }} />

        {onDistributeStep && (
          <Button onClick={() => setStep('layout')} disabled={working}>
            Back
          </Button>
        )}

        <Button variant="contained" onClick={primary.onClick} disabled={primary.disabled}>
          {primary.label}
        </Button>
      </DialogActions>

      <Dialog open={startOverOpen} onClose={() => setStartOverOpen(false)}>
        <DialogTitle>{reshaping ? 'Use rows and bins instead?' : 'Start over?'}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {reshaping
              ? `Rows and bins describe a regular grid, so every row of ${unit?.name} would end up divided the same way. Rows that differ now will be evened out — you will see exactly how many locations that adds or removes before anything is saved.`
              : 'This clears your individual tweaks and goes back to editing the layout by the numbers.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setStartOverOpen(false)}>Keep editing</Button>
          <Button onClick={confirmStartOver} color="error" variant="contained">
            {reshaping ? 'Use rows and bins' : 'Start over'}
          </Button>
        </DialogActions>
      </Dialog>

      {reshaping && unit && plan && (
        <ReshapeImpactDialog
          open={confirmOpen}
          unitName={unit.name}
          impactLines={impactLines}
          untouched={untouched}
          destructive={plan.removed.length > 0}
          loading={working}
          onClose={() => setConfirmOpen(false)}
          onConfirm={run}
        />
      )}
    </Dialog>
  );
}

/**
 * What this edit costs, live, above the editor.
 *
 * Counts LOCATIONS YOU CAN PUT SOMETHING IN, not table rows — removing a row of fifteen bins
 * deletes sixteen rows and takes away fifteen places, and reporting sixteen would overstate the
 * loss by every container the unit owns.
 */
function ImpactStrip({
  plan,
  unit,
  occupancy,
}: {
  plan: ReshapePlan;
  unit: InventoryLocationNode;
  occupancy?: OccupancyMap;
}) {
  /*
   * Nothing at all until something changes.
   *
   * This used to open with "test is unchanged so far. Edit the names, add or remove locations, or
   * reshape it by the numbers." — an instruction nobody needs beside controls that are already on
   * screen, sitting above a SECOND info alert about the editing mode. Two boxes of prose before
   * one number had been touched. The disabled `Review changes` button already says nothing has
   * changed, and the live location count already says what the numbers add up to.
   */
  if (plan.isNoop) return null;

  const lines = describeReshape(plan, unit.name);
  const stocked = plan.stockSources.reduce(
    (n, s) => n + occupancyFor(occupancy ?? NO_OCCUPANCY, s.locationId).directParts,
    0,
  );

  return (
    <Alert severity={plan.removed.length > 0 ? 'warning' : 'info'} sx={{ mb: 2 }}>
      {lines.join(' · ')}
      {stocked > 0 && ` · ${stocked} part${stocked === 1 ? '' : 's'} will need somewhere to go`}
    </Alert>
  );
}
