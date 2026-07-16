'use client';

import { useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ENTITY_LABELS, fieldLabel, norm } from '@/lib/dataImportSchema';
import type { WorkingFile } from '@/lib/dataImportEditing';

interface FillGapDialogProps {
  file: WorkingFile;
  fieldKey: string;
  onFill: (colId: string, value: string) => void;
  onEditByHand: () => void;
  onClose: () => void;
}

/**
 * "7,672 parts have no unit of measure" — resolved here, in one decision, instead of sending
 * the owner to a toolbar somewhere below the fold.
 *
 * The dialog leads with what their OWN rows already say for this column, because that's
 * evidence they can judge; the dropdown defaults to their most common value. A default is
 * safe here precisely because it's a fact derived from their data rather than a guess about
 * their intent — and nothing is written until they press the button.
 */
export default function FillGapDialog({ file, fieldKey, onFill, onEditByHand, onClose }: FillGapDialogProps) {
  const colId = file.columnRoles[fieldKey];
  const label = fieldLabel(file.entityType, fieldKey);

  // What the rows that DO have a value say — most common first.
  const known = useMemo(() => {
    const counts = new Map<string, number>();
    if (!colId) return [];
    for (const row of file.rows) {
      const v = (row[colId] ?? '').trim();
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n);
  }, [file, colId]);

  const blanks = useMemo(
    () => (colId ? file.rows.filter((r) => !norm(r[colId])).length : 0),
    [file, colId],
  );

  const [value, setValue] = useState(known[0]?.value ?? '');
  const most = known.length ? known.reduce((s, k) => s + k.n, 0) : 0;
  const entity = ENTITY_LABELS[file.entityType].toLowerCase();

  if (!colId) return null;

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        Give {blanks.toLocaleString()} {entity} a {label}
      </DialogTitle>
      <DialogContent dividers>
        <Typography sx={{ mb: 2 }}>
          Without one they can&apos;t be created, so they&apos;d be left behind. Pick what most of them
          should be — you can change any of them later.
        </Typography>

        {known.length > 0 && (
          <Box
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              p: 2,
              mb: 2.5,
              bgcolor: 'action.hover',
            }}
          >
            <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: 0.5 }}>
              WHAT YOUR OTHER {most.toLocaleString()} {entity.toUpperCase()} SAY
            </Typography>
            <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
              {known.slice(0, 5).map((k) => (
                <Box key={k.value} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 64 }}>
                    {k.value}
                  </Typography>
                  <LinearProgress
                    variant="determinate"
                    value={(k.n / known[0].n) * 100}
                    sx={{ flex: 1, height: 7, borderRadius: 4 }}
                  />
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 52, textAlign: 'right' }}>
                    {k.n.toLocaleString()}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        )}

        <Autocomplete
          freeSolo
          options={known.map((k) => k.value)}
          value={value}
          onInputChange={(_, v) => setValue(v)}
          renderInput={(params) => (
            <TextField
              {...params}
              label={`Set the other ${blanks.toLocaleString()} to`}
              helperText={
                known.length
                  ? "Defaulted to the one you use most — change it if that's not right."
                  : 'Type the value these should have.'
              }
            />
          )}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onEditByHand}>Set them by hand instead</Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Not now</Button>
        <Button variant="contained" disabled={!value.trim()} onClick={() => onFill(colId, value.trim())}>
          Set {blanks.toLocaleString()} {entity}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
