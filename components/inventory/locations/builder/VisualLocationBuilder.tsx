'use client';

import { useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stepper from '@mui/material/Stepper';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';

import type { LevelSpec } from '@/types/inventoryLocations';
import { buildSpecFromLevels, countSpecNodes, removeSpecNode } from '@/utils/locationSpec';
import { materializeLocationSpec } from '@/utils/inventoryLocationsAccess';
import StorageTypePalette from './StorageTypePalette';
import LevelConfigStep from './LevelConfigStep';
import LocationBoardPreview from './LocationBoardPreview';
import { cloneLevels, type StorageType } from './storageTypes';

const STEPS = ['Type', 'Layout', 'Review'];

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
  const [prunedKeys, setPrunedKeys] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setActiveStep(0);
    setSelectedTypeId(null);
    setLevels([]);
    setQrAnchorDepth(0);
    setPrunedKeys([]);
    setCreating(false);
    setError(null);
  };

  const baseSpec = useMemo(
    () => buildSpecFromLevels(levels, { qrAnchorDepth, parentCode }),
    [levels, qrAnchorDepth, parentCode],
  );
  const spec = useMemo(
    () => prunedKeys.reduce((s, k) => removeSpecNode(s, k), baseSpec),
    [baseSpec, prunedKeys],
  );
  const total = countSpecNodes(spec);

  const pickType = (type: StorageType) => {
    setSelectedTypeId(type.id);
    setLevels(cloneLevels(type.defaultLevels));
    setQrAnchorDepth(0);
    setPrunedKeys([]);
    setActiveStep(1);
  };

  const changeLevels = (next: LevelSpec[]) => {
    setLevels(next);
    setPrunedKeys([]); // keys shift with layout; drop stale prunes
    if (qrAnchorDepth > next.length - 1) setQrAnchorDepth(Math.max(0, next.length - 1));
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await materializeLocationSpec(companyId, parentId, spec);
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
      maxWidth="md"
      fullWidth
      TransitionProps={{ onEnter: reset }}
    >
      <DialogTitle>Build storage visually</DialogTitle>
      <DialogContent dividers sx={{ minHeight: 420 }}>
        <Stepper activeStep={activeStep} sx={{ mb: 3 }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {activeStep === 0 && <StorageTypePalette selectedId={selectedTypeId} onSelect={pickType} />}

        {activeStep === 1 && (
          <LevelConfigStep levels={levels} onChange={changeLevels} total={countSpecNodes(baseSpec)} />
        )}

        {activeStep === 2 && (
          <Box>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              alignItems={{ sm: 'center' }}
              sx={{ mb: 2 }}
            >
              <TextField
                select
                label="Print QR labels at"
                value={qrAnchorDepth}
                onChange={(e) => setQrAnchorDepth(Number(e.target.value))}
                size="small"
                sx={{ minWidth: 220 }}
                helperText="Scanning drills down to what's inside"
              >
                {levels.map((l, i) => (
                  <MenuItem key={i} value={i}>
                    {capitalize(l.kind)} (level {i + 1})
                  </MenuItem>
                ))}
              </TextField>
              <Box sx={{ flex: 1 }} />
            </Stack>
            <LocationBoardPreview
              nodes={spec}
              onPrune={(key) => setPrunedKeys((keys) => [...keys, key])}
            />
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
        {activeStep > 0 && (
          <Button onClick={() => setActiveStep((s) => s - 1)} disabled={creating}>
            Back
          </Button>
        )}
        {activeStep === 1 && (
          <Button variant="contained" onClick={() => setActiveStep(2)} disabled={total === 0}>
            Review
          </Button>
        )}
        {activeStep === 2 && (
          <Button variant="contained" onClick={handleCreate} disabled={creating || total === 0}>
            Create {total} location{total === 1 ? '' : 's'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
