'use client';

import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { findVariantGroups, type VariantGroup } from '@/lib/dataImportActions';
import type { WorkingFile } from '@/lib/dataImportEditing';

interface MergeVariantsDialogProps {
  open: boolean;
  onClose: () => void;
  file: WorkingFile;
  defaultColId: string;
  onMerge: (colId: string, canonical: string, variants: string[]) => void;
}

/**
 * "These look like the same thing spelled differently — which one is right?" The owner picks
 * the canonical spelling per group; merge rewrites the rest to it (one undoable step). Groups
 * recompute from the working set, so a merged group disappears as soon as it's applied.
 */
export default function MergeVariantsDialog({
  open,
  onClose,
  file,
  defaultColId,
  onMerge,
}: MergeVariantsDialogProps) {
  const [colId, setColId] = useState(defaultColId || file.headers[0] || '');
  const groups = useMemo(() => (colId ? findVariantGroups(file, colId) : []), [file, colId]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Merge look-alikes</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2">Look for look-alike spellings in</Typography>
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <Select value={colId} onChange={(e) => setColId(e.target.value as string)}>
              {file.headers.map((h) => (
                <MenuItem key={h} value={h}>
                  {h}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

        {groups.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No look-alike spellings found in this column.
          </Typography>
        ) : (
          <Stack spacing={2} divider={<Divider />}>
            {groups.map((g) => (
              <MergeGroupRow
                key={g.key}
                group={g}
                onMerge={(canonical, variants) => onMerge(colId, canonical, variants)}
              />
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}

function MergeGroupRow({
  group,
  onMerge,
}: {
  group: VariantGroup;
  onMerge: (canonical: string, variants: string[]) => void;
}) {
  const [canonical, setCanonical] = useState(group.variants[0]?.value ?? '');

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
        {group.variants.map((v) => (
          <Chip
            key={v.value}
            size="small"
            label={`${v.value} (${v.count})`}
            color={v.value === canonical ? 'primary' : 'default'}
            variant={v.value === canonical ? 'filled' : 'outlined'}
            onClick={() => setCanonical(v.value)}
          />
        ))}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="body2" color="text.secondary">
          Keep as
        </Typography>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <Select value={canonical} onChange={(e) => setCanonical(e.target.value as string)}>
            {group.variants.map((v) => (
              <MenuItem key={v.value} value={v.value}>
                {v.value}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          size="small"
          variant="contained"
          onClick={() => onMerge(canonical, group.variants.map((v) => v.value))}
        >
          Merge {group.variants.length}
        </Button>
      </Box>
    </Box>
  );
}
