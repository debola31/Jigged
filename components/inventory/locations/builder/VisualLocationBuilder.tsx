'use client';

import { useMemo, useState } from 'react';
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

import type { LevelSpec, LocationContent, LocationSpecNode } from '@/types/inventoryLocations';
import {
  buildSpecFromLevels,
  collectSpecLeaves,
  removeSpecNode,
  addChildUnder,
  duplicateNode,
} from '@/utils/locationSpec';
import {
  getLocationContents,
  materializeLocationSpec,
  subdivideLocation,
} from '@/utils/inventoryLocationsAccess';
import LevelConfigStep from './LevelConfigStep';
import DistributeContentsStep, {
  isDistributionComplete,
  type AssignmentMap,
} from './DistributeContentsStep';
import { cloneLevels } from './storageTypes';

/**
 * What the generator opens on: five rows, each split left and right.
 *
 * A starting point you edit, not a choice you make — it is the shape `SUBDIVISION_TYPES` led with,
 * and both numbers are editable on the same screen. Landing on something concrete beats landing on
 * an empty form and having to guess what the fields want.
 */
const DEFAULT_LEVELS: LevelSpec[] = [
  { kind: 'row', count: 5, namePattern: 'Row {n}' },
  { kind: 'bin', names: ['Left', 'Right'] },
];

interface VisualLocationBuilderProps {
  open: boolean;
  companyId: string;
  /**
   * Build under this node (null = top-level).
   *
   * The whole nested-create path existed and was never called — the wizard only ever built at the
   * top level. Passing a parent is what turns the wizard into "Subdivide this unit".
   */
  parentId?: string | null;
  /** Human path of the parent, for the dialog title. */
  parentPath?: string[];
  /**
   * Names already at the top level, so the new unit's name can be checked before it is typed into
   * a 23505. Only meaningful when `parentId` is null.
   */
  siblingNames?: string[];
  /**
   * Names the parent already holds, so a repeat subdivide continues the numbering (Row 4–6)
   * instead of regenerating Row 1–3 and colliding.
   */
  existingSiblingNames?: string[];
  /**
   * Where the new children's `sort_order` should start.
   *
   * Without it they default to 0 and **interleave** with what's already inside: subdividing a
   * cabinet holding Shelf A/B into three Rows drew `Row 1 · Row 2 · Shelf A · Row 3 · Shelf B`,
   * because `getLocations` orders by `sort_order` then `name`. Same fix `duplicateLocation`
   * already applies to a copied sibling (max + 1).
   */
  startSortOrder?: number;
  onClose: () => void;
  onCreated: (count: number) => void;
}

export default function VisualLocationBuilder({
  open,
  companyId,
  parentId = null,
  parentPath,
  siblingNames,
  existingSiblingNames,
  startSortOrder = 0,
  onClose,
  onCreated,
}: VisualLocationBuilderProps) {
  /**
   * One step now: the level generator. The type palette is gone.
   *
   * It asked you to pick a picture of a cabinet before you could say "5 rows, each split left and
   * right" — and all the picture ever did was pre-fill those numbers, which the next screen let
   * you edit anyway. The generator is the valuable half; the drawing was never load-bearing, and
   * for a top-level unit the palette was literally unreachable (`subdividing` is always true,
   * because the only caller passes a parent).
   *
   * The category agrees on the generator and not on the pictures: PartsBox ships Single / Row /
   * Grid with a name-pattern preview, Zoho ships Level + Location + Delimiter + Total, Fishbowl
   * an "Auto Create" wizard. None of them makes you choose an icon first.
   */
  const subdividing = parentId !== null;
  /**
   * The unit's own name, when this is creating one.
   *
   * Storage used to be two steps: name a place in one modal, then find `Divide it up…` inside its
   * detail sheet to give it any structure. Nobody creating a cabinet wants a cabinet with nothing
   * in it, and the second step was buried behind a drawer — so the shop ended up with an empty
   * cabinet and no obvious way to say what was inside it. Naming and shaping are one decision, so
   * they are one screen, and `create_location_tree` writes the whole thing in one transaction.
   */
  const [unitName, setUnitName] = useState('');
  const [levels, setLevels] = useState<LevelSpec[]>(() => cloneLevels(DEFAULT_LEVELS));
  // Once a single branch is fine-tuned, the tree is hand-edited directly and no
  // longer regenerated from `levels` (which becomes the "Start over" template).
  const [customized, setCustomized] = useState(false);
  const [editedTree, setEditedTree] = useState<LocationSpecNode[]>([]);
  const [startOverOpen, setStartOverOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * What the parent currently holds, and where each part is going.
   *
   * Loaded on open rather than lazily on reaching step 2: whether a second step exists at all
   * depends on the answer, and a "Create" button that turns into "Next" after a round trip is worse
   * than a brief moment where it is disabled.
   */
  const [contents, setContents] = useState<LocationContent[]>([]);
  const [loadingContents, setLoadingContents] = useState(false);
  const [assignments, setAssignments] = useState<AssignmentMap>({});
  const [step, setStep] = useState<'layout' | 'distribute'>('layout');

  const reset = () => {
    setUnitName('');
    setLevels(cloneLevels(DEFAULT_LEVELS));
    setCustomized(false);
    setEditedTree([]);
    setStartOverOpen(false);
    setCreating(false);
    setError(null);
    setContents([]);
    setAssignments({});
    setStep('layout');

    if (!parentId) return;
    setLoadingContents(true);
    getLocationContents(parentId)
      .then((page) => setContents(page.contents))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not read what is here.'))
      .finally(() => setLoadingContents(false));
  };

  const uniformTree = useMemo(
    () => buildSpecFromLevels(levels, { existingSiblingNames }),
    [levels, existingSiblingNames],
  );
  const tree = customized ? editedTree : uniformTree;
  /**
   * What actually gets written.
   *
   * Subdividing sends the levels straight under the existing parent. Creating a unit wraps them in
   * a root node named by the field above, so the unit and everything inside it land in ONE
   * `create_location_tree` call rather than a create followed by a subdivide.
   */
  const spec = useMemo(
    () =>
      subdividing
        ? tree
        : [{ key: 'unit', name: unitName.trim(), kind: null, children: tree }],
    [subdividing, tree, unitName],
  );
  const leaves = useMemo(() => collectSpecLeaves(spec), [spec]);
  /**
   * **Places**, not nodes.
   *
   * This counted every node the spec would insert, so "4 rows × 2" reported **12** — four rows plus
   * eight bins — and the operator then found eight places. The rows are structure: the
   * container/bin invariant means stock cannot sit in one, so counting them told someone they were
   * getting half again as much storage as they were. Leaves are what you can put something in, and
   * `places` is the word the Storage screen already uses for them.
   */
  const total = leaves.length;

  // Editing lives in the config; the preview is read-only.
  const enterCustomize = () => {
    setEditedTree(tree);
    setCustomized(true);
  };
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

  const confirmStartOver = () => {
    setCustomized(false);
    setEditedTree([]);
    setStartOverOpen(false);
  };

  /** Only a loaded parent needs the second step; an empty one keeps the original single screen. */
  const needsDistribution = contents.length > 0;
  const distributionReady = isDistributionComplete(contents, assignments);

  /** Matched the way the sibling-name index does, so the warning and the constraint agree. */
  const trimmedName = unitName.trim();
  const duplicateName = trimmedName
    ? (siblingNames ?? []).find((n) => n.trim().toLowerCase() === trimmedName.toLowerCase())
    : undefined;
  /** A unit needs a name. Its levels are optional — "the yard" is one place and that is fine. */
  const canCreate = subdividing ? total > 0 : Boolean(trimmedName) && !duplicateName;

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      if (needsDistribution) {
        // One transaction: the sub-locations and the stock that moves into them. Doing it in two
        // steps is not merely slower, it is impossible — see `subdivideLocation`.
        const created = await subdivideLocation(
          parentId!,
          tree,
          Object.entries(assignments).flatMap(([partId, lines]) =>
            lines.map((line) => ({
              partId,
              toRef: line.toRef,
              quantity: line.quantity,
              unit: contents.find((c) => c.part_id === partId)?.primary_unit || 'ea',
            })),
          ),
          startSortOrder,
        );
        onCreated(created.length);
      } else {
        const created = await materializeLocationSpec(companyId, parentId, spec, startSortOrder);
        onCreated(created.length);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create locations.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={creating ? undefined : onClose}
      maxWidth="lg"
      fullWidth
      TransitionProps={{ onEnter: reset }}
    >
      <DialogTitle>
        {subdividing
          ? `Change the layout of ${parentPath?.length ? parentPath.join(' › ') : 'this unit'}`
          : 'Add storage'}
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 420 }}>
        <Box>
          <Box sx={{ minWidth: 0, display: step === 'layout' ? 'block' : 'none' }}>
            {!subdividing && (
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
                      placeholder="Cabinet 1, the shelf by the welder, the yard…"
                      autoFocus
                      required
                      error={Boolean(duplicateName)}
                      helperText={
                        duplicateName
                          ? `You already have a ${duplicateName}.`
                          : 'Then say how it is divided up — or leave it as one place.'
                      }
                    />
                  )}
                />
              </Box>
            )}
            {/* Kept mounted rather than unmounted when the distribute step is showing: the level
                config holds the hand-edited tree, and stepping back to fix a name must not reset
                it to the generated default. */}
            <LevelConfigStep
              levels={levels}
              onChange={setLevels}
              total={total}
              customized={customized}
              tree={tree}
              onCustomize={enterCustomize}
              onRemove={editRemove}
              onAdd={editAdd}
              onDuplicate={editDuplicate}
              onStartOver={() => setStartOverOpen(true)}
              existingSiblingNames={existingSiblingNames}
            />
          </Box>

          {step === 'distribute' && (
            <DistributeContentsStep
              parentName={parentPath?.length ? parentPath[parentPath.length - 1] : 'This place'}
              contents={contents}
              leaves={leaves}
              assignments={assignments}
              onChange={setAssignments}
            />
          )}
        </Box>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        <Box sx={{ flex: 1 }} />

        {step === 'distribute' && (
          <Button onClick={() => setStep('layout')} disabled={creating}>
            Back
          </Button>
        )}

        {/*
          A loaded shelf gets Next → Create; an empty one keeps the single click it always had.
          `loadingContents` disables Create rather than hiding the dialog behind a spinner: the
          layout step is usable while the read is in flight, and it is only the branch between the
          two buttons that has to wait.
        */}
        {needsDistribution && step === 'layout' ? (
          <Button
            variant="contained"
            onClick={() => setStep('distribute')}
            disabled={creating || !canCreate}
          >
            Next: where does the stock go?
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={
              creating ||
              !canCreate ||
              loadingContents ||
              (needsDistribution && !distributionReady)
            }
          >
            Create {total} place{total === 1 ? '' : 's'}
          </Button>
        )}
      </DialogActions>

      <Dialog open={startOverOpen} onClose={() => setStartOverOpen(false)}>
        <DialogTitle>Start over?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This clears your individual tweaks and goes back to editing the layout by the numbers.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setStartOverOpen(false)}>Keep editing</Button>
          <Button onClick={confirmStartOver} color="error" variant="contained">
            Start over
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
