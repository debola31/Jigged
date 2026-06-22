'use client';

import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import type { LevelSpec } from '@/types/inventoryLocations';

const MAX_LEVELS = 4;

interface LevelConfigStepProps {
  levels: LevelSpec[];
  onChange: (levels: LevelSpec[]) => void;
  /** Live total node count for the "will create N" hint. */
  total: number;
}

export default function LevelConfigStep({ levels, onChange, total }: LevelConfigStepProps) {
  const update = (i: number, patch: Partial<LevelSpec>) =>
    onChange(levels.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const setMode = (i: number, mode: 'count' | 'names') => {
    if (mode === 'names') {
      update(i, { names: levels[i].names ?? ['Left', 'Right'], count: undefined, namePattern: undefined });
    } else {
      update(i, { count: levels[i].count ?? 4, namePattern: levels[i].namePattern ?? 'Item {n}', names: undefined });
    }
  };

  const removeLevel = (i: number) => onChange(levels.filter((_, idx) => idx !== i));
  const addLevel = () =>
    onChange([...levels, { kind: 'bin', count: 2, namePattern: 'Bin {n}' }]);

  return (
    <Box>
      <Typography variant="body1" sx={{ mb: 2 }}>
        How is it divided up? Each level nests inside the one above. The deepest level holds the stock.
      </Typography>

      <Stack spacing={2}>
        {levels.map((level, i) => {
          const mode: 'count' | 'names' = level.names ? 'names' : 'count';
          return (
            <Paper key={i} variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                <Typography variant="subtitle2" color="text.secondary" sx={{ flex: 1 }}>
                  Level {i + 1}
                  {i === levels.length - 1 ? ' · holds stock' : ''}
                </Typography>
                {levels.length > 1 && (
                  <IconButton size="small" aria-label="Remove level" onClick={() => removeLevel(i)}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                )}
              </Stack>

              <Stack spacing={1.5}>
                <TextField
                  label="Kind"
                  value={level.kind}
                  onChange={(e) => update(i, { kind: e.target.value })}
                  size="small"
                  fullWidth
                />

                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={mode}
                  onChange={(_, v) => v && setMode(i, v)}
                >
                  <ToggleButton value="count">By count</ToggleButton>
                  <ToggleButton value="names">By names</ToggleButton>
                </ToggleButtonGroup>

                {mode === 'count' ? (
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField
                      label="How many"
                      type="number"
                      value={level.count ?? 0}
                      onChange={(e) => update(i, { count: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                      size="small"
                      inputProps={{ min: 0 }}
                      sx={{ width: { xs: '100%', sm: 140 } }}
                    />
                    <TextField
                      label="Name pattern"
                      value={level.namePattern ?? '{n}'}
                      onChange={(e) => update(i, { namePattern: e.target.value })}
                      helperText="{n} = the number"
                      size="small"
                      fullWidth
                    />
                  </Stack>
                ) : (
                  <TextField
                    label="Names"
                    value={(level.names ?? []).join(', ')}
                    onChange={(e) =>
                      update(i, { names: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
                    }
                    helperText="Comma-separated, e.g. Left, Right"
                    size="small"
                    fullWidth
                  />
                )}
              </Stack>
            </Paper>
          );
        })}
      </Stack>

      <Stack direction="row" alignItems="center" sx={{ mt: 2 }}>
        <Button
          startIcon={<AddIcon />}
          onClick={addLevel}
          disabled={levels.length >= MAX_LEVELS}
        >
          Add a deeper level
        </Button>
        <Box sx={{ flex: 1 }} />
        <Typography variant="body2" color="text.secondary">
          Will create <strong>{total}</strong> location{total === 1 ? '' : 's'}
        </Typography>
      </Stack>
    </Box>
  );
}
