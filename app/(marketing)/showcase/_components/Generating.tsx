'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { Heading } from './content';
import type { Catalog } from './catalog';
import type { LivePart } from './showcaseData';
import { useShowcase, type View } from './store';

const STAGE_MS = 1500;

interface Stage {
  title: string;
  detail: string;
  /** Where the camera goes while this stage runs. */
  view?: View;
}

/** The part's instructions coming together, told from its real plan, as the camera gathers what it needs. */
function stages(part: LivePart, cat: Catalog): Stage[] {
  const setups = part.groups.filter((g) => g.id !== 'finish');
  // Each machine in the order the setups reach it (a bar is sawn before it's milled); the camera
  // goes to the one most steps are at.
  const machines = [...new Set(setups.flatMap((g) => (g.where ? [g.where] : [])))];
  const stepsAt = (item?: string) => part.steps.filter((s) => s.where.item === item).length;
  const machineStep = part.steps.filter((s) => s.where.item).sort((a, b) => stepsAt(b.where.item) - stepsAt(a.where.item))[0];
  const uses = (category: string, filter: (kind: string) => boolean = () => true) => [
    ...new Map(
      part.steps
        .filter((s) => filter(s.kind))
        .flatMap((s) => s.uses)
        .filter((u) => (u.item ? cat.spots.get(u.item)?.[0].category === category : category === 'tools'))
        .map((u) => [u.name, u]),
    ).values(),
  ];
  const holding = uses('workholding');
  const tools = uses('tools', (k) => k === 'cycle');
  const at = (items: { item?: string }[]): View | undefined => {
    const id = items.find((u) => u.item)?.item;
    return id ? { kind: 'item', id } : undefined;
  };
  return [
    { title: 'Reading the part', detail: `${part.stock.size} in, ${part.stock.material}`, view: { kind: 'overview' } },
    {
      title: 'Planning the setups',
      detail: `${setups.length} ${setups.length === 1 ? 'setup' : 'setups'} on the ${machines.join(' and the ') || 'mill'}`,
      view: machineStep?.where.item ? { kind: 'item', id: machineStep.where.item } : undefined,
    },
    { title: 'Choosing the workholding', detail: holding.map((u) => u.name).join(', '), view: at(holding) },
    { title: 'Picking the tools', detail: `${tools.length} ${tools.length === 1 ? 'cutter' : 'cutters'}: ${tools.map((u) => u.name).join(', ')}`, view: at(tools) },
    { title: 'Writing the steps', detail: `${part.steps.length} steps, each shown being done`, view: { kind: 'step', index: 0 } },
  ];
}

/**
 * The instructions being made for the picked part: a few seconds that walk through what the plan
 * holds, with the camera visiting the machine, the bench and the crib. The plan was made ahead of
 * time; this shows what making it involves. Skippable.
 */
export default function Generating({ part, cat, onDone }: { part: LivePart; cat: Catalog; onDone(skipped: boolean): void }) {
  const list = useMemo(() => stages(part, cat), [part, cat]);
  const [at, setAt] = useState(0);

  useEffect(() => {
    if (at >= list.length) {
      onDone(false);
      return;
    }
    const v = list[at].view;
    if (v) useShowcase.getState().look(v);
    const t = window.setTimeout(() => setAt((n) => n + 1), STAGE_MS);
    return () => window.clearTimeout(t);
  }, [at, list, onDone]);

  return (
    <Box role="status" aria-live="polite">
      <Heading eyebrow={part.name} title="Making the instructions" />
      <LinearProgress variant="determinate" value={(Math.min(at, list.length) / list.length) * 100} sx={{ mt: 2, borderRadius: 1 }} />
      <Box component="ol" sx={{ listStyle: 'none', p: 0, m: 0, mt: 2 }}>
        {list.map((s, i) => (
          <Box component="li" key={s.title} sx={{ display: 'flex', gap: 1.5, py: 1, opacity: i > at ? 0.35 : 1, transition: 'opacity 0.3s' }}>
            <Box sx={{ width: 24, display: 'grid', placeItems: 'center', pt: 0.25 }}>
              {i < at ? <CheckCircleIcon color="success" fontSize="small" /> : i === at ? <CircularProgress size={16} /> : null}
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600 }}>{s.title}</Typography>
              {i <= at && <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem', lineHeight: 1.45 }}>{s.detail}</Typography>}
            </Box>
          </Box>
        ))}
      </Box>
      <Button size="small" onClick={() => onDone(true)} sx={{ mt: 1 }}>
        Skip
      </Button>
    </Box>
  );
}
