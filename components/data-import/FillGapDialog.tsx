'use client';

import { useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ENTITY_LABELS, fieldLabel, norm } from '@/lib/dataImportSchema';
import { ALL_UNITS, UNITS_BY_CATEGORY, resolveUnitAlias } from '@/lib/unitPresets';
import type { WorkingFile } from '@/lib/dataImportEditing';

interface FillGapDialogProps {
  file: WorkingFile;
  fieldKey: string;
  onFill: (colId: string, value: string) => void;
  onEditByHand: () => void;
  onClose: () => void;
}

// Fields that hold a unit of measure — these get the standard-unit picker, not free text.
const UNIT_FIELDS = new Set(['primary_unit', 'unit']);
const OTHER = '__other__';

/** Sentence-case a canonical unit name for display: "each" → "Each", "fluid ounces" → "Fluid ounces". */
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

interface Tally {
  value: string;
  n: number;
}

/**
 * "7,672 parts have no unit of measure" — resolved here, in one decision, instead of sending
 * the owner to a toolbar somewhere below the fold.
 *
 * The dialog leads with what their OWN rows already say for this column, because that's
 * evidence they can judge; the default is their most common value. A default is safe here
 * because it's a fact derived from their data, not a guess about intent — and nothing is
 * written until they press the button.
 *
 * For unit fields we present STANDARD units ("Each", "Inches") rather than whatever raw code
 * their export happened to use ("EA", "IN"): the code is resolved to its standard form and
 * pre-selected, with a free-text fallback only for genuinely non-standard units.
 */
export default function FillGapDialog({ file, fieldKey, onFill, onEditByHand, onClose }: FillGapDialogProps) {
  const colId = file.columnRoles[fieldKey];
  const label = fieldLabel(file.entityType, fieldKey);
  const isUnit = UNIT_FIELDS.has(fieldKey);

  // What the rows that DO have a value say. For units we fold each raw code into its standard
  // name first ("EA" and "ea" both count toward "each"), so the evidence and the options speak
  // the same standard language.
  const known = useMemo<Tally[]>(() => {
    const counts = new Map<string, number>();
    if (!colId) return [];
    for (const row of file.rows) {
      const raw = (row[colId] ?? '').trim();
      if (!raw) continue;
      const key = isUnit ? resolveUnitAlias(raw.toLowerCase()) : raw;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n);
  }, [file, colId, isUnit]);

  const blanks = useMemo(
    () => (colId ? file.rows.filter((r) => !norm(r[colId])).length : 0),
    [file, colId],
  );

  // The default: their most-common value. For units, only if it's a standard unit — otherwise
  // start on "Other" pre-filled with it, so a non-standard code still isn't lost.
  const topKnown = known[0]?.value ?? '';
  const topIsStandard = isUnit && ALL_UNITS.includes(topKnown);
  const [selected, setSelected] = useState(isUnit ? (topIsStandard ? topKnown : topKnown ? OTHER : '') : topKnown);
  const [custom, setCustom] = useState(isUnit && !topIsStandard ? topKnown : '');
  const [freeText, setFreeText] = useState(topKnown);

  const most = known.reduce((s, k) => s + k.n, 0);
  const entity = ENTITY_LABELS[file.entityType].toLowerCase();

  if (!colId) return null;

  const resolved = isUnit ? (selected === OTHER ? custom.trim() : selected) : freeText.trim();

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        {`Give ${blanks.toLocaleString()} ${entity} a ${label}`}
      </DialogTitle>
      <DialogContent dividers>
        <Typography sx={{ mb: 2 }}>
          Without one they can&apos;t be created, so they&apos;d be left behind. Pick what most of them
          should be — you can change any of them later.
        </Typography>

        {known.length > 0 && (
          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, mb: 2.5, bgcolor: 'action.hover' }}>
            <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: 0.5 }}>
              WHAT YOUR OTHER {most.toLocaleString()} {entity.toUpperCase()} SAY
            </Typography>
            <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
              {known.slice(0, 5).map((k) => (
                <Box key={k.value} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 80 }}>
                    {isUnit ? cap(k.value) : k.value}
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

        {isUnit ? (
          <>
            <FormControl fullWidth>
              <InputLabel id="unit-pick-label">{`Set the other ${blanks.toLocaleString()} to`}</InputLabel>
              <Select
                labelId="unit-pick-label"
                label={`Set the other ${blanks.toLocaleString()} to`}
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                {UNITS_BY_CATEGORY.flatMap((g) => [
                  <ListSubheader key={g.category}>{g.category}</ListSubheader>,
                  ...g.units.map((u) => (
                    <MenuItem key={u} value={u}>
                      {cap(u)}
                    </MenuItem>
                  )),
                ])}
                <ListSubheader>Something else</ListSubheader>
                <MenuItem value={OTHER}>Other — type it in…</MenuItem>
              </Select>
            </FormControl>
            {selected === OTHER && (
              <TextField
                fullWidth
                sx={{ mt: 2 }}
                label="Enter the unit"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                helperText="Use this only if none of the standard units fit."
              />
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {topIsStandard
                ? 'Defaulted to the standard match for the one you use most — change it if that’s not right.'
                : 'Pick a standard unit so everything measures the same way.'}
            </Typography>
          </>
        ) : (
          <Autocomplete
            freeSolo
            options={known.map((k) => k.value)}
            value={freeText}
            onInputChange={(_, v) => setFreeText(v)}
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
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onEditByHand}>Set them by hand instead</Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Not now</Button>
        <Button variant="contained" disabled={!resolved} onClick={() => onFill(colId, resolved)}>
          Set {blanks.toLocaleString()} {entity}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
