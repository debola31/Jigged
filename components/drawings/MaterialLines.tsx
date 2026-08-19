'use client';

/**
 * What a part is made of, said by the person who knows.
 *
 * This used to be driven entirely by the cut list on the drawing, which meant it
 * only appeared for the two weldments in a package of thirty-one and did nothing
 * at all for the rest — ticking "Add materials" looked broken because for
 * twenty-nine parts there was nothing it could offer.
 *
 * A shop knows what its parts are made of whether or not the drawing spells it
 * out, so materials are entered here rather than inferred. An existing part can be
 * picked, or a new material typed; either way it becomes a BOM line.
 *
 * A COST IS ONLY ASKED FOR WHEN IT IS NEEDED. Picking a part the shop already
 * buys brings its own price with it. Typing a new material means nothing knows
 * what it costs, and a BOM line to a child with no cost basis takes its parent
 * from quotable to not — so the field appears exactly then, and the row says why
 * if it is left empty.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';

import PartAutocomplete from '@/components/parts/PartAutocomplete';
import type { PartSelectOption } from '@/utils/partsAccess';

/** One thing a part is made of, as the user entered it. */
export interface MaterialLine {
  id: string;
  /** An existing part, when one was picked. */
  part: PartSelectOption | null;
  /** A new material's name, when nothing was picked. */
  name: string;
  quantity: string;
  unit: string;
  /** Only meaningful for a NEW material — an existing part carries its own. */
  costPerUnit: string;
}

export const newMaterialLine = (unit: string): MaterialLine => ({
  id: `mat-${Math.random().toString(36).slice(2)}`,
  part: null,
  name: '',
  quantity: '1',
  unit,
  costPerUnit: '',
});

/** Ready to write: it names something and says how much. */
export const isUsable = (line: MaterialLine) =>
  (line.part !== null || line.name.trim().length > 0) && Number(line.quantity) > 0;

interface Props {
  companyId: string;
  lines: MaterialLine[];
  onChange: (next: MaterialLine[]) => void;
  defaultUnit: string;
  disabled?: boolean;
}

export default function MaterialLines({
  companyId,
  lines,
  onChange,
  defaultUnit,
  disabled = false,
}: Props) {
  const set = (id: string, patch: Partial<MaterialLine>) =>
    onChange(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  return (
    <Box>
      {lines.map((line) => {
        // Only a brand-new material needs a price from us.
        const isNew = line.part === null && line.name.trim().length > 0;
        return (
          <Box
            key={line.id}
            data-testid="material-line"
            sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', mb: 1.5, flexWrap: 'wrap' }}
          >
            <Box sx={{ minWidth: 240, flex: 1 }}>
              <PartAutocomplete
                companyId={companyId}
                value={line.part}
                onChange={(part) => set(line.id, { part, name: part ? '' : line.name })}
                label="Material"
                size="small"
                disabled={disabled}
                excludeIds={lines.map((l) => l.part?.id).filter((id): id is string => !!id)}
              />
              {!line.part && (
                <TextField
                  size="small"
                  fullWidth
                  sx={{ mt: 1 }}
                  placeholder="…or type a new material"
                  value={line.name}
                  onChange={(e) => set(line.id, { name: e.target.value })}
                  disabled={disabled}
                  inputProps={{ 'aria-label': 'New material name' }}
                />
              )}
            </Box>

            <TextField
              size="small"
              label="Qty"
              sx={{ width: 90 }}
              value={line.quantity}
              onChange={(e) => set(line.id, { quantity: e.target.value })}
              disabled={disabled}
              inputProps={{ 'aria-label': 'Quantity' }}
            />
            <TextField
              size="small"
              label="Unit"
              sx={{ width: 100 }}
              value={line.unit}
              onChange={(e) => set(line.id, { unit: e.target.value })}
              disabled={disabled}
              inputProps={{ 'aria-label': 'Unit' }}
            />

            {isNew && (
              <TextField
                size="small"
                label="Cost per unit"
                sx={{ width: 150 }}
                value={line.costPerUnit}
                onChange={(e) => set(line.id, { costPerUnit: e.target.value })}
                disabled={disabled}
                inputProps={{ 'aria-label': `Cost per unit for ${line.name}` }}
                helperText={line.costPerUnit.trim() ? undefined : 'Without one, this part cannot be quoted'}
              />
            )}

            <Tooltip title="Remove this material">
              <IconButton
                size="small"
                sx={{ mt: 0.5, '&:hover': { color: 'error.light' } }}
                onClick={() => onChange(lines.filter((l) => l.id !== line.id))}
                disabled={disabled}
                aria-label={`Remove material ${line.part?.part_name || line.name || 'row'}`}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        );
      })}

      <Button
        size="small"
        startIcon={<AddIcon />}
        onClick={() => onChange([...lines, newMaterialLine(defaultUnit)])}
        disabled={disabled}
      >
        Add a material
      </Button>

      {lines.length === 0 && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          Pick something you already buy, or type a new material and give it a cost.
        </Typography>
      )}
    </Box>
  );
}
