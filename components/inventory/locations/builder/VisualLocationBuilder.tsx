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

import type { LevelSpec, LocationContent, LocationSpecNode } from '@/types/inventoryLocations';
import {
  buildSpecFromLevels,
  collectSpecLeaves,
  countSpecNodes,
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
  const total = countSpecNodes(tree);

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
  const leaves = useMemo(() => collectSpecLeaves(tree), [tree]);
  const distributionReady = isDistributionComplete(contents, assignments);

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
        const created = await materializeLocationSpec(companyId, parentId, tree, startSortOrder);
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
          ? `Divide up ${parentPath?.length ? parentPath.join(' › ') : 'this unit'}`
          : 'Add several places at once'}
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 420 }}>
        <Box>
          <Box sx={{ minWidth: 0, display: step === 'layout' ? 'block' : 'none' }}>
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
            disabled={creating || total === 0}
          >
            Next: where does the stock go?
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={
              creating ||
              total === 0 ||
              loadingContents ||
              (needsDistribution && !distributionReady)
            }
          >
            Create {total} location{total === 1 ? '' : 's'}
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
