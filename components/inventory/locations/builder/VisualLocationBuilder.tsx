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
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';

import type { LevelSpec, LocationSpecNode } from '@/types/inventoryLocations';
import {
  buildSpecFromLevels,
  countSpecNodes,
  removeSpecNode,
  addChildUnder,
  applyQrAnchorByDepth,
} from '@/utils/locationSpec';
import { materializeLocationSpec } from '@/utils/inventoryLocationsAccess';
import StorageTypePalette from './StorageTypePalette';
import LevelConfigStep from './LevelConfigStep';
import LocationBoardPreview from './LocationBoardPreview';
import { cloneLevels, type StorageType } from './storageTypes';

const STEPS = ['Type', 'Build'];

interface VisualLocationBuilderProps {
  open: boolean;
  companyId: string;
  /** Build under this node (null = top-level). */
  parentId?: string | null;
  parentCode?: string | null;
  onClose: () => void;
  onCreated: (count: number) => void;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export default function VisualLocationBuilder({
  open,
  companyId,
  parentId = null,
  parentCode = null,
  onClose,
  onCreated,
}: VisualLocationBuilderProps) {
  const [activeStep, setActiveStep] = useState(0);
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [levels, setLevels] = useState<LevelSpec[]>([]);
  const [qrAnchorDepth, setQrAnchorDepth] = useState(0);
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
    setQrAnchorDepth(0);
    setCustomized(false);
    setEditedTree([]);
    setStartOverOpen(false);
    setCreating(false);
    setError(null);
  };

  const uniformTree = useMemo(
    () => buildSpecFromLevels(levels, { qrAnchorDepth, parentCode }),
    [levels, qrAnchorDepth, parentCode],
  );
  const tree = customized ? editedTree : uniformTree;
  const total = countSpecNodes(tree);

  const pickType = (type: StorageType) => {
    setSelectedTypeId(type.id);
    setLevels(cloneLevels(type.defaultLevels));
    setQrAnchorDepth(0);
    setCustomized(false);
    setEditedTree([]);
    setActiveStep(1);
  };

  const changeQrDepth = (depth: number) => {
    setQrAnchorDepth(depth);
    if (customized) setEditedTree((t) => applyQrAnchorByDepth(t, depth));
  };

  // Editing lives in the config; the preview is read-only.
  const enterCustomize = () => {
    setEditedTree(applyQrAnchorByDepth(tree, qrAnchorDepth));
    setCustomized(true);
  };
  const editRemove = (key: string) => {
    setEditedTree(applyQrAnchorByDepth(removeSpecNode(tree, key), qrAnchorDepth));
    setCustomized(true);
  };
  const editAdd = (parentKey: string) => {
    setEditedTree(applyQrAnchorByDepth(addChildUnder(tree, parentKey), qrAnchorDepth));
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
      const created = await materializeLocationSpec(companyId, parentId, tree);
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
      <DialogTitle>Build storage visually</DialogTitle>
      <DialogContent dividers sx={{ minHeight: 460 }}>
        <Stepper activeStep={activeStep} sx={{ mb: 3, maxWidth: 360 }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {activeStep === 0 && <StorageTypePalette selectedId={selectedTypeId} onSelect={pickType} />}

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
                onStartOver={() => setStartOverOpen(true)}
              />
            </Box>

            <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', md: 'block' } }} />
            <Divider sx={{ display: { xs: 'block', md: 'none' } }} />

            {/* Read-only type-aware preview */}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1.5, flexWrap: 'wrap' }}>
                <Typography variant="overline" color="text.secondary" sx={{ flex: 1, letterSpacing: 1 }}>
                  Preview
                </Typography>
                <TextField
                  select
                  label="QR labels at"
                  value={qrAnchorDepth}
                  onChange={(e) => changeQrDepth(Number(e.target.value))}
                  size="small"
                  sx={{ minWidth: 160 }}
                >
                  {levels.map((l, i) => (
                    <MenuItem key={i} value={i}>
                      {capitalize(l.kind)}
                    </MenuItem>
                  ))}
                </TextField>
              </Box>
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
