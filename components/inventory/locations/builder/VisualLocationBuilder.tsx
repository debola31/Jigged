'use client';

import { useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stepper from '@mui/material/Stepper';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';

import type { LevelSpec, LocationSpecNode } from '@/types/inventoryLocations';
import {
  buildSpecFromLevels,
  countSpecNodes,
  removeSpecNode,
  addChildUnder,
  duplicateNode,
} from '@/utils/locationSpec';
import { materializeLocationSpec } from '@/utils/inventoryLocationsAccess';
import StorageTypePalette from './StorageTypePalette';
import LevelConfigStep from './LevelConfigStep';
import LocationBoardPreview from './LocationBoardPreview';
import { cloneLevels, STORAGE_TYPES, SUBDIVISION_TYPES, type StorageType } from './storageTypes';

const STEPS = ['Type', 'Build'];

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
  parentCode?: string | null;
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
  parentCode = null,
  parentPath,
  existingSiblingNames,
  startSortOrder = 0,
  onClose,
  onCreated,
}: VisualLocationBuilderProps) {
  // Subdividing offers a different palette: level 0 must be what goes INSIDE the container, or
  // "Cabinet" while subdividing Cabinet 3 creates Cabinet 3 › Cabinet 1 › Row 1 › Left.
  const subdividing = parentId !== null;
  const types = subdividing ? SUBDIVISION_TYPES : STORAGE_TYPES;
  const [activeStep, setActiveStep] = useState(0);
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [levels, setLevels] = useState<LevelSpec[]>([]);
  // Once a single branch is fine-tuned, the tree is hand-edited directly and no
  // longer regenerated from `levels` (which becomes the "Start over" template).
  const [customized, setCustomized] = useState(false);
  const [editedTree, setEditedTree] = useState<LocationSpecNode[]>([]);
  const [startOverOpen, setStartOverOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setActiveStep(0);
    setSelectedTypeId(null);
    setLevels([]);
    setCustomized(false);
    setEditedTree([]);
    setStartOverOpen(false);
    setCreating(false);
    setError(null);
  };

  const uniformTree = useMemo(
    () => buildSpecFromLevels(levels, { parentCode, existingSiblingNames }),
    [levels, parentCode, existingSiblingNames],
  );
  const tree = customized ? editedTree : uniformTree;
  const total = countSpecNodes(tree);

  const pickType = (type: StorageType) => {
    setSelectedTypeId(type.id);
    setLevels(cloneLevels(type.defaultLevels));
    setCustomized(false);
    setEditedTree([]);
    setActiveStep(1);
  };

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

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await materializeLocationSpec(companyId, parentId, tree, startSortOrder);
      onCreated(created.length);
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
          ? `Subdivide ${parentPath?.length ? parentPath.join(' › ') : 'this unit'}`
          : 'Build storage visually'}
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 460 }}>
        <Stepper activeStep={activeStep} sx={{ mb: 3, maxWidth: 360 }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {activeStep === 0 && (
          <StorageTypePalette
            selectedId={selectedTypeId}
            onSelect={pickType}
            types={types}
            prompt={
              subdividing
                ? 'How is this unit divided up inside?'
                : 'What kind of storage are you setting up?'
            }
          />
        )}

        {activeStep === 1 && (
          <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 3 }}>
            {/* Configure (the only editor) */}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: 'block', mb: 1.5, letterSpacing: 1 }}
              >
                Configure
              </Typography>
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

            <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', md: 'block' } }} />
            <Divider sx={{ display: { xs: 'block', md: 'none' } }} />

            {/* Read-only type-aware preview */}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: 'block', mb: 1.5, letterSpacing: 1 }}
              >
                Preview
              </Typography>
              <LocationBoardPreview nodes={tree} />
            </Box>
          </Box>
        )}

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
        {activeStep === 1 && (
          <>
            <Button onClick={() => setActiveStep(0)} disabled={creating}>
              Back
            </Button>
            <Button variant="contained" onClick={handleCreate} disabled={creating || total === 0}>
              Create {total} location{total === 1 ? '' : 's'}
            </Button>
          </>
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
