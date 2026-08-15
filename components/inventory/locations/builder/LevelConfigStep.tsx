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
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

import type { LevelSpec, LocationSpecNode } from '@/types/inventoryLocations';
import { planLevelNames } from '@/utils/locationSpec';

const MAX_LEVELS = 4;

const stripPattern = (p?: string) => (p ?? '').replace(/\s*\{n\}\s*/g, ' ').trim();
const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function labelOf(level: LevelSpec): string {
  return level.names ? capitalize(level.kind) : stripPattern(level.namePattern);
}

/**
 * The *"→ Row 4, Row 5, Row 6, …"* hint under a level's controls.
 *
 * Goes through `planLevelNames` rather than substituting `{n}` itself, so the hint and the preview
 * beside it can't disagree. They did: this used to hardcode `i + 1`, so on a repeat subdivide the
 * hint said `Row 1, Row 2, Row 3` while the preview correctly showed `Row 4, Row 5, Row 6`.
 */
function exampleOf(level: LevelSpec, existingSiblingNames: string[] = []): string {
  if (level.names) return planLevelNames(level, existingSiblingNames).names.join(', ') || '—';
  if ((level.count ?? 0) === 0) return 'none';
  const { names } = planLevelNames(level, existingSiblingNames);
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '');
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

/**
 * One editable spot.
 *
 * A read-only `Chip` when there is no rename to offer (the create path — a name that does not
 * exist yet is edited by changing the pattern that generates it), and a compact field when there
 * is. Reshape needs the field: it opens on the unit's REAL layout, which is where you would go to
 * fix `Rght` or to call Left "Outer", and the numbers editor cannot do it without also flattening
 * a ragged unit to uniform.
 */
function LeafChip({
  node,
  onRemove,
  onRename,
  collides,
}: {
  node: LocationSpecNode;
  onRemove: (key: string) => void;
  onRename?: (key: string, name: string) => void;
  collides: boolean;
}) {
  if (!onRename) {
    return (
      <Chip size="small" label={node.name} variant="outlined" onDelete={() => onRemove(node.key)} />
    );
  }
  return (
    <Stack direction="row" alignItems="center" spacing={0.25}>
      <TextField
        value={node.name}
        onChange={(e) => onRename(node.key, e.target.value)}
        size="small"
        variant="outlined"
        error={collides}
        inputProps={{ 'aria-label': `Name of ${node.name}`, style: { padding: '6px 8px' } }}
        sx={{ width: 120 }}
      />
      <IconButton
        size="small"
        aria-label={`Remove ${node.name}`}
        onClick={() => onRemove(node.key)}
      >
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>
    </Stack>
  );
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
  onDuplicate: (key: string) => void;
  onStartOver: () => void;
  /**
   * Rename one node in place.
   *
   * Reshape is half about renaming — the whole reason the key is preserved through
   * `renameSpecNode` is that a rename must not read as a remove-then-create — and the customized
   * branch was read-only chips with a delete. Absent on the create path, where a name that does
   * not exist yet is edited by changing the pattern that generates it.
   */
  onRename?: (key: string, name: string) => void;
  /** Names the parent already holds, so the top level's hint continues rather than restarting. */
  existingSiblingNames?: string[];
  /** Spec keys the plan says collide, so the offending chips can say so where you can point at them. */
  duplicateKeys?: string[];
  /** Reshape says "Reshape by the numbers…"; a fresh build says "Start over". */
  startOverLabel?: string;
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
  onDuplicate,
  onStartOver,
  onRename,
  existingSiblingNames = [],
  duplicateKeys = [],
  startOverLabel = 'Start over',
}: LevelConfigStepProps) {
  const collides = (key: string) => duplicateKeys.includes(key);

  // ----- Customized: reflect the real per-branch structure as editable chips ---
  if (customized) {
    const leafParents = collectLeafParents(tree);
    return (
      <Box>
        <Alert
          severity="info"
          action={
            <Button color="inherit" size="small" startIcon={<ReplayIcon />} onClick={onStartOver}>
              {startOverLabel}
            </Button>
          }
          sx={{ mb: 2 }}
        >
          Fine-tuning individual spots. Branches can differ now.
        </Alert>

        {/* Top-level entries: duplicate one to make another like it, or remove it. */}
        <Box sx={{ mb: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Top-level
          </Typography>
          <Stack spacing={0.5}>
            {tree.map((container) => (
              <Stack key={container.key} direction="row" alignItems="center" spacing={0.5}>
                {onRename ? (
                  <TextField
                    value={container.name}
                    onChange={(e) => onRename(container.key, e.target.value)}
                    size="small"
                    variant="standard"
                    error={collides(container.key)}
                    inputProps={{ 'aria-label': `Name of ${container.name}` }}
                    sx={{ flex: 1, minWidth: 0 }}
                  />
                ) : (
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                    {container.name}
                  </Typography>
                )}
                <IconButton
                  size="small"
                  aria-label={`Duplicate ${container.name}`}
                  onClick={() => onDuplicate(container.key)}
                >
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={`Remove ${container.name}`}
                  onClick={() => onRemove(container.key)}
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Stack>
            ))}
          </Stack>
        </Box>

        {/*
          A flat unit gets the `Top-level` list ABOVE and nothing here.

          This used to render `tree` a second time as chips, which on a flat unit is the same set
          of nodes with a second delete button each. Harmless while one was a label and the other a
          chip; not harmless once reshape made both of them editable name fields, at which point a
          three-row cabinet showed six inputs for three rows. The list above already carries
          rename, duplicate and remove, which is every action a top-level entry has.
        */}
        {leafParents.length > 0 && (
          <Stack spacing={1.5}>
            {leafParents.map(({ node, path }) => (
              <Box key={node.key}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                  {path.join(' › ')}
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
                  {node.children.map((leaf) => (
                    <LeafChip
                      key={leaf.key}
                      node={leaf}
                      onRemove={onRemove}
                      onRename={onRename}
                      collides={collides(leaf.key)}
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
        Each level nests inside the one above.
      </Typography>

      <Stack spacing={2}>
        {levels.map((level, i) => {
          const mode: 'count' | 'names' = level.names ? 'names' : 'count';
          return (
            <Paper key={i} variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                <Typography variant="subtitle2" color="text.secondary" sx={{ flex: 1 }}>
                  Level {i + 1}
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
                  {/* Only the TOP level continues past existing siblings — deeper levels sit
                      under containers this spec is creating fresh. */}
                  → {exampleOf(level, i === 0 ? existingSiblingNames : [])}
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
