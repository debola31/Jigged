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
import RemoveIcon from '@mui/icons-material/Remove';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import type { LevelSpec } from '@/types/inventoryLocations';

const MAX_LEVELS = 4;

const stripPattern = (p?: string) => (p ?? '').replace(/\s*\{n\}\s*/g, ' ').trim();
const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The friendly word for this level (no "{n}" jargon). */
function labelOf(level: LevelSpec): string {
  return level.names ? capitalize(level.kind) : stripPattern(level.namePattern);
}

/** A live example of the names this level will produce. */
function exampleOf(level: LevelSpec): string {
  if (level.names) return level.names.join(', ') || '—';
  const count = level.count ?? 0;
  if (count === 0) return 'none';
  const pattern = level.namePattern || '{n}';
  const shown = Array.from({ length: Math.min(3, count) }, (_, i) =>
    pattern.replace('{n}', String(i + 1)),
  );
  return shown.join(', ') + (count > 3 ? ', …' : '');
}

interface LevelConfigStepProps {
  levels: LevelSpec[];
  onChange: (levels: LevelSpec[]) => void;
  total: number;
}

export default function LevelConfigStep({ levels, onChange, total }: LevelConfigStepProps) {
  const update = (i: number, patch: Partial<LevelSpec>) =>
    onChange(levels.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const setLabel = (i: number, label: string) => {
    const kind = label.trim().toLowerCase() || 'level';
    if (levels[i].names) update(i, { kind });
    else update(i, { kind, namePattern: label.trim() ? `${label.trim()} {n}` : '{n}' });
  };

  const setCount = (i: number, count: number) => update(i, { count: Math.max(0, count) });

  const setMode = (i: number, mode: 'count' | 'names') => {
    const label = labelOf(levels[i]) || 'Bin';
    if (mode === 'names') {
      update(i, { names: levels[i].names ?? ['Left', 'Right'], count: undefined, namePattern: undefined });
    } else {
      update(i, {
        count: levels[i].count ?? 4,
        namePattern: `${label} {n}`,
        names: undefined,
      });
    }
  };

  const removeLevel = (i: number) => onChange(levels.filter((_, idx) => idx !== i));
  const addLevel = () => onChange([...levels, { kind: 'bin', count: 4, namePattern: 'Bin {n}' }]);

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Each level nests inside the one above. The deepest level holds the stock.
      </Typography>

      <Stack spacing={2}>
        {levels.map((level, i) => {
          const mode: 'count' | 'names' = level.names ? 'names' : 'count';
          const deepest = i === levels.length - 1;
          return (
            <Paper key={i} variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                <Typography variant="subtitle2" color="text.secondary" sx={{ flex: 1 }}>
                  Level {i + 1}
                  {deepest ? ' · holds stock' : ''}
                </Typography>
                {levels.length > 1 && (
                  <IconButton size="small" aria-label="Remove level" onClick={() => removeLevel(i)}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                )}
              </Stack>

              <Stack spacing={1.5}>
                <TextField
                  label="Call them"
                  value={labelOf(level)}
                  onChange={(e) => setLabel(i, e.target.value)}
                  placeholder="Cabinet, Row, Bin…"
                  size="small"
                  fullWidth
                />

                <ToggleButtonGroup exclusive size="small" value={mode} onChange={(_, v) => v && setMode(i, v)}>
                  <ToggleButton value="count" sx={{ textTransform: 'none' }}>
                    A set number
                  </ToggleButton>
                  <ToggleButton value="names" sx={{ textTransform: 'none' }}>
                    Specific names
                  </ToggleButton>
                </ToggleButtonGroup>

                {mode === 'count' ? (
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Typography variant="body2" color="text.secondary">
                      How many?
                    </Typography>
                    <IconButton
                      size="small"
                      aria-label="Fewer"
                      onClick={() => setCount(i, (level.count ?? 0) - 1)}
                    >
                      <RemoveIcon fontSize="small" />
                    </IconButton>
                    <TextField
                      value={level.count ?? 0}
                      onChange={(e) => setCount(i, parseInt(e.target.value, 10) || 0)}
                      type="number"
                      size="small"
                      inputProps={{ min: 0, style: { textAlign: 'center', width: 56 } }}
                    />
                    <IconButton
                      size="small"
                      aria-label="More"
                      onClick={() => setCount(i, (level.count ?? 0) + 1)}
                    >
                      <AddIcon fontSize="small" />
                    </IconButton>
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

                <Typography variant="caption" color="text.secondary">
                  → {exampleOf(level)}
                </Typography>
              </Stack>
            </Paper>
          );
        })}
      </Stack>

      <Stack direction="row" alignItems="center" sx={{ mt: 2 }}>
        <Button startIcon={<AddIcon />} onClick={addLevel} disabled={levels.length >= MAX_LEVELS}>
          Add a deeper level
        </Button>
        <Box sx={{ flex: 1 }} />
        <Typography variant="body2" color="text.secondary">
          <strong>{total}</strong> location{total === 1 ? '' : 's'}
        </Typography>
      </Stack>
    </Box>
  );
}
