'use client';

import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ReplayIcon from '@mui/icons-material/Replay';
import TuneIcon from '@mui/icons-material/Tune';

import type { LevelSpec, LocationSpecNode } from '@/types/inventoryLocations';

const MAX_LEVELS = 4;

const stripPattern = (p?: string) => (p ?? '').replace(/\s*\{n\}\s*/g, ' ').trim();
const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function labelOf(level: LevelSpec): string {
  return level.names ? capitalize(level.kind) : stripPattern(level.namePattern);
}

function exampleOf(level: LevelSpec): string {
  if (level.names) return level.names.join(', ') || '—';
  const count = level.count ?? 0;
  if (count === 0) return 'none';
  const pattern = level.namePattern || '{n}';
  const shown = Array.from({ length: Math.min(3, count) }, (_, i) => pattern.replace('{n}', String(i + 1)));
  return shown.join(', ') + (count > 3 ? ', …' : '');
}

/** Branches whose children are all leaves — the rows you'd fine-tune per side. */
function collectLeafParents(
  nodes: LocationSpecNode[],
  trail: string[] = [],
): { node: LocationSpecNode; path: string[] }[] {
  const out: { node: LocationSpecNode; path: string[] }[] = [];
  for (const n of nodes) {
    const path = [...trail, n.name];
    if (n.children.length > 0 && n.children.every((c) => c.children.length === 0)) {
      out.push({ node: n, path });
    } else if (n.children.length > 0) {
      out.push(...collectLeafParents(n.children, path));
    }
  }
  return out;
}

interface LevelConfigStepProps {
  levels: LevelSpec[];
  onChange: (levels: LevelSpec[]) => void;
  total: number;
  customized: boolean;
  tree: LocationSpecNode[];
  onCustomize: () => void;
  onRemove: (key: string) => void;
  onAdd: (parentKey: string) => void;
  onStartOver: () => void;
}

export default function LevelConfigStep({
  levels,
  onChange,
  total,
  customized,
  tree,
  onCustomize,
  onRemove,
  onAdd,
  onStartOver,
}: LevelConfigStepProps) {
  // ----- Customized: reflect the real per-branch structure as editable chips ---
  if (customized) {
    const leafParents = collectLeafParents(tree);
    return (
      <Box>
        <Alert
          severity="info"
          action={
            <Button color="inherit" size="small" startIcon={<ReplayIcon />} onClick={onStartOver}>
              Start over
            </Button>
          }
          sx={{ mb: 2 }}
        >
          Fine-tuning individual spots. Branches can differ now.
        </Alert>

        {leafParents.length === 0 ? (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {tree.map((n) => (
              <Chip key={n.key} size="small" label={n.name} onDelete={() => onRemove(n.key)} />
            ))}
          </Box>
        ) : (
          <Stack spacing={1.5}>
            {leafParents.map(({ node, path }) => (
              <Box key={node.key}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                  {path.join(' › ')}
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
                  {node.children.map((leaf) => (
                    <Chip
                      key={leaf.key}
                      size="small"
                      label={leaf.name}
                      color={leaf.is_qr_anchor ? 'info' : 'default'}
                      variant={leaf.is_qr_anchor ? 'filled' : 'outlined'}
                      onDelete={() => onRemove(leaf.key)}
                    />
                  ))}
                  <Chip
                    size="small"
                    variant="outlined"
                    icon={<AddIcon />}
                    label="Add"
                    onClick={() => onAdd(node.key)}
                  />
                </Box>
              </Box>
            ))}
          </Stack>
        )}

        <Typography variant="body2" color="text.secondary" sx={{ mt: 2, textAlign: 'right' }}>
          <strong>{total}</strong> location{total === 1 ? '' : 's'}
        </Typography>
      </Box>
    );
  }

  // ----- Uniform: friendly per-level controls ---------------------------------
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
      update(i, { count: levels[i].count ?? 4, namePattern: `${label} {n}`, names: undefined });
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
                    <IconButton size="small" aria-label="Fewer" onClick={() => setCount(i, (level.count ?? 0) - 1)}>
                      <RemoveIcon fontSize="small" />
                    </IconButton>
                    <TextField
                      value={level.count ?? 0}
                      onChange={(e) => setCount(i, parseInt(e.target.value, 10) || 0)}
                      type="number"
                      size="small"
                      inputProps={{ min: 0, style: { textAlign: 'center', width: 56 } }}
                    />
                    <IconButton size="small" aria-label="More" onClick={() => setCount(i, (level.count ?? 0) + 1)}>
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

      <Button
        fullWidth
        variant="outlined"
        startIcon={<TuneIcon />}
        onClick={onCustomize}
        disabled={total === 0}
        sx={{ mt: 2 }}
      >
        Customize individual spots
      </Button>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, textAlign: 'center' }}>
        Give specific branches different bins (e.g. a gap, or one extra).
      </Typography>
    </Box>
  );
}
