'use client';

import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Popover from '@mui/material/Popover';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { DISPLAY_FONT, EYEBROW_COLOR } from '@/components/marketing/marketingStyles';
import { toError } from '@/lib/supabaseErrors';
import { CATEGORY_LABELS, gatherList, stepsUsing, type Catalog } from './catalog';
import { mediaUrl, ready, type LivePart, type Step, type Use } from './showcaseData';
import { useShowcase } from './store';

// three.js comes with it, so it loads only where a model is shown: on a desktop.
const ModelView = dynamic(() => import('./ModelView'), { ssr: false });

const FINE_POINTER = '(hover: hover) and (pointer: fine)';
export const CARD_BG = 'rgba(17, 20, 57, 0.92)';
export const SUBHEADER_BG = 'rgba(17, 20, 57, 0.98)';

function subscribeFinePointer(change: () => void) {
  const query = window.matchMedia(FINE_POINTER);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
}

/** A mouse, so a model can be turned without taking the card's scroll from a finger. */
function useFinePointer(): boolean {
  return useSyncExternalStore(subscribeFinePointer, () => window.matchMedia(FINE_POINTER).matches, () => false);
}

const statusSx = { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 3, textAlign: 'center', color: 'text.secondary' } as const;

export function Heading({ eyebrow, title, onClose, closeLabel }: { eyebrow: ReactNode; title: string; onClose?(): void; closeLabel?: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography component="div" sx={{ color: EYEBROW_COLOR, fontWeight: 600, fontSize: '0.85rem', letterSpacing: '0.04em' }}>
          {eyebrow}
        </Typography>
        <Typography component="h2" sx={{ mt: 0.5, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.45rem', lineHeight: 1.15 }}>
          {title}
        </Typography>
      </Box>
      {onClose && (
        <IconButton onClick={onClose} aria-label={closeLabel} sx={{ mt: -0.5, mr: -1 }}>
          <CloseIcon />
        </IconButton>
      )}
    </Box>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box component="section" sx={{ mt: 2.5 }}>
      <Typography component="h3" sx={{ color: 'text.secondary', fontWeight: 600, fontSize: '0.78rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {title}
      </Typography>
      <Box sx={{ mt: 1 }}>{children}</Box>
    </Box>
  );
}

/** Label and value rows. */
function Facts({ rows }: { rows: string[][] }) {
  return (
    <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 2, rowGap: 0.75, fontSize: '0.95rem' }}>
      {rows.map(([label, value]) => (
        <Box key={label} sx={{ display: 'contents' }}>
          <Box component="dt" sx={{ color: 'text.secondary' }}>
            {label}
          </Box>
          <Box component="dd" sx={{ m: 0, textAlign: 'right' }}>
            {value}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** What a step or the plan uses: a thing the shop has placed opens it, and the camera flies there. */
export function Uses({ cat, uses }: { cat: Catalog; uses: Use[] }) {
  const openItem = useShowcase((s) => s.openItem);
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
      {uses.map((u) =>
        u.item ? (
          <Chip
            key={u.item}
            label={u.name}
            variant="outlined"
            onClick={() => {
              openItem(u.item!);
              posthog.capture('showcase item opened', { category: cat.spots.get(u.item!)?.[0].category ?? 'unknown', source: 'step' });
            }}
            sx={{ borderColor: 'secondary.main' }}
          />
        ) : (
          <Chip key={u.name} label={u.name} variant="outlined" />
        ),
      )}
    </Box>
  );
}

export function stepNote(s: Step): string | undefined {
  const coming = s.media.type === 'cut' ? 'Picture coming' : 'Video coming';
  const notes = [s.kind === 'cycle' && 'Machine cycle', !ready(s) && coming].filter(Boolean);
  return notes.length ? notes.join(' · ') : undefined;
}

export function openStepTracked(part: LivePart, i: number) {
  useShowcase.getState().openStep(i);
  posthog.capture('showcase step opened', { part: part.id, step_number: i + 1, kind: part.steps[i].kind });
}

/** Every step, grouped by setup; the open one is marked. */
export function StepList({ part, onPick, dense = true }: { part: LivePart; onPick(i: number): void; dense?: boolean }) {
  const index = useShowcase((s) => s.step);
  const sheet = useShowcase((s) => s.sheet);
  return (
    <>
      {part.groups.map((g) => (
        <List
          key={g.id}
          dense={dense}
          disablePadding
          subheader={
            <ListSubheader sx={{ bgcolor: SUBHEADER_BG, color: 'text.secondary', fontWeight: 600, lineHeight: 2.4 }}>{g.title}</ListSubheader>
          }
        >
          {part.steps.map((s, i) =>
            s.group !== g.id ? null : (
              <ListItemButton
                key={s.id}
                data-step={i}
                selected={sheet === 'step' && i === index}
                aria-current={sheet === 'step' && i === index ? 'step' : undefined}
                onClick={() => onPick(i)}
              >
                <ListItemText primary={`${i + 1}. ${s.title}`} secondary={stepNote(s)} />
              </ListItemButton>
            ),
          )}
        </List>
      ))}
    </>
  );
}

/** "Step 5 of 61 · Find X and Y ▾": opens the whole list, to jump to any step. */
export function StepPicker({ part }: { part: LivePart }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const index = useShowcase((s) => s.step);
  const sheet = useShowcase((s) => s.sheet);
  const label = sheet === 'step' && index !== null ? `Step ${index + 1} of ${part.steps.length}` : `All ${part.steps.length} steps`;
  return (
    <>
      <Button
        size="small"
        variant="outlined"
        endIcon={<ExpandMoreIcon />}
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-haspopup="listbox"
        sx={{ color: 'common.white', borderColor: 'rgba(255, 255, 255, 0.3)' }}
      >
        {label}
      </Button>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: { sx: { width: 380, maxHeight: '60vh', bgcolor: SUBHEADER_BG, colorScheme: 'dark' } },
          transition: {
            onEntered: (node: HTMLElement) => node.querySelector<HTMLElement>(`[data-step="${index ?? 0}"]`)?.scrollIntoView({ block: 'center' }),
          },
        }}
      >
        <StepList
          part={part}
          onPick={(i) => {
            setAnchor(null);
            openStepTracked(part, i);
          }}
        />
      </Popover>
    </>
  );
}

// --- what you'll need ---------------------------------------------------------------------------

export function NeedContent({ cat, part }: { cat: Catalog; part: LivePart }) {
  const openItem = useShowcase((s) => s.openItem);
  const look = useShowcase((s) => s.look);
  const gather = gatherList(part, cat, (id) => cat.shop.surfaces[id] ?? id);
  // The stations in the order the steps reach them.
  const stations = [...new Map(part.steps.map((s) => [s.where.name, s.where])).values()].map((where) => ({
    where,
    count: part.steps.filter((s) => s.where.name === where.name).length,
  }));
  const setups = part.groups.filter((g) => g.id !== 'finish').length;

  return (
    <>
      <Heading eyebrow={part.name} title="What you'll need" />
      <Typography sx={{ mt: 1.5, lineHeight: 1.55 }}>
        {part.stock.material}, {part.stock.size} in: a {part.stock.from}. {setups} setups, {part.steps.length} steps.
      </Typography>
      <Section title="Stations, in order">
        {stations.map((st, n) => (
          <Box key={st.where.name} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.5 }}>
            <Typography sx={{ color: 'text.secondary', width: '1.25em' }}>{n + 1}</Typography>
            <Box sx={{ flex: 1 }}>
              <Typography sx={{ fontWeight: 600 }}>{st.where.name}</Typography>
              <Typography sx={{ color: 'text.secondary', fontSize: '0.88rem' }}>
                {st.count} {st.count === 1 ? 'step' : 'steps'}
              </Typography>
            </Box>
            <Button size="small" onClick={() => (st.where.item ? openItem(st.where.item) : look({ kind: 'zone', where: st.where }))}>
              Show me
            </Button>
          </Box>
        ))}
      </Section>
      {gather.map((g) => (
        <Section key={g.place} title={g.place}>
          <Uses cat={cat} uses={g.uses} />
        </Section>
      ))}
      <Button variant="contained" size="large" fullWidth onClick={() => openStepTracked(part, 0)} sx={{ mt: 3 }}>
        Start with step 1
      </Button>
    </>
  );
}

// --- a step -------------------------------------------------------------------------------------

/** One step: its video (or the cut part), what it says, where, what it uses, and previous / next. */
export function StepContent({ cat, part, index, header = true }: { cat: Catalog; part: LivePart; index: number; header?: boolean }) {
  const step = part.steps[index];
  const group = part.groups.find((g) => g.id === step.group);
  const openStep = useShowcase((s) => s.openStep);
  const [failed, setFailed] = useState<string | null>(null);
  const [modelShown, setModelShown] = useState<string | null>(null);
  const reported = useRef(new Set<string>());
  const finePointer = useFinePointer();
  const what = step.media.type === 'cut' ? 'picture' : 'video';
  const report = (error: unknown) => {
    // Published media that won't load is a fault; unpublished media never gets here.
    if (reported.current.has(step.id)) return;
    reported.current.add(step.id);
    Sentry.captureException(toError(error, `Showcase: the ${what} for ${part.id} ${step.id} failed to load`));
  };
  const onModel = useCallback(() => setModelShown(step.id), [step.id]);

  return (
    <>
      {header && <Heading eyebrow={group?.title ?? ''} title={step.title} />}
      <Box sx={{ mt: header ? 1.5 : 0, position: 'relative', aspectRatio: '16 / 9', borderRadius: 1.5, overflow: 'hidden', bgcolor: 'common.black' }}>
        {!ready(step) ? (
          <Typography role="status" sx={statusSx}>
            This step&apos;s {what} is still being made.
          </Typography>
        ) : step.media.type === 'cut' ? (
          <>
            <Box
              component="img"
              key={step.id}
              src={mediaUrl(step.media.still)}
              alt={`The part after this step: ${step.title}`}
              onError={() => {
                setFailed(step.id);
                report(new Error('still failed to load'));
              }}
              sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transition: 'opacity 0.4s', opacity: modelShown === step.id ? 0 : 1 }}
            />
            {finePointer && (
              <Box sx={{ position: 'absolute', inset: 0 }}>
                <ModelView key={step.id} url={mediaUrl(step.media.model)} part onLoad={onModel} onError={report} />
              </Box>
            )}
            {modelShown === step.id && (
              <Typography sx={{ position: 'absolute', left: 10, bottom: 8, fontSize: '0.8rem', color: 'text.secondary', pointerEvents: 'none' }}>
                Drag to turn the part
              </Typography>
            )}
          </>
        ) : (
          <Box
            component="video"
            key={step.id}
            src={mediaUrl(step.media.path)}
            controls
            muted
            playsInline
            autoPlay
            preload="metadata"
            aria-label={`Video: ${step.title}`}
            onError={() => {
              setFailed(step.id);
              report(new Error('video failed to load'));
            }}
            sx={{ width: '100%', height: '100%', display: 'block' }}
          />
        )}
        {failed === step.id && (
          <Typography role="status" sx={{ ...statusSx, bgcolor: 'common.black' }}>
            This step&apos;s {what} couldn&apos;t be loaded. Reload the page to try again.
          </Typography>
        )}
      </Box>
      <Box sx={{ mt: 1.5 }} aria-live="polite">
        {step.kind === 'cycle' && <Chip label="Machine cycle" size="small" variant="outlined" sx={{ mb: 1 }} />}
        <Typography sx={{ fontSize: '1.05rem', lineHeight: 1.55 }}>{step.caption}</Typography>
      </Box>
      <Section title="Where">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ flex: 1 }}>
            {step.where.name}
            {step.where.at === 'pendant' ? ', at the control' : step.where.at === 'table' ? ', at the table' : ''}
          </Typography>
          <Button size="small" onClick={() => openStep(index)}>
            Show me
          </Button>
        </Box>
      </Section>
      {step.uses.length > 0 && (
        <Section title="Uses">
          <Uses cat={cat} uses={step.uses} />
        </Section>
      )}
      <Box sx={{ mt: 2.5, display: 'flex', gap: 1.5 }}>
        <Button variant="outlined" disabled={index === 0} onClick={() => openStepTracked(part, index - 1)} sx={{ flex: 1 }}>
          Previous
        </Button>
        <Button variant="contained" disabled={index === part.steps.length - 1} onClick={() => openStepTracked(part, index + 1)} sx={{ flex: 1 }}>
          Next step
        </Button>
      </Box>
    </>
  );
}

// --- a thing ------------------------------------------------------------------------------------

export function ItemContent({ cat, part, id }: { cat: Catalog; part: LivePart; id: string }) {
  const thing = cat.spots.get(id)?.[0];
  const closeItem = useShowcase((s) => s.closeItem);
  const step = useShowcase((s) => s.step);
  const sheet = useShowcase((s) => s.sheet);
  const finePointer = useFinePointer();
  const [shown, setShown] = useState<string | null>(null);
  const onLoad = useCallback(() => setShown(id), [id]);
  if (!thing) return null;
  const asset = cat.shop.assets[thing.asset];
  const surface = thing.on && cat.shop.surfaces[thing.on];
  const makeModel = [thing.make, thing.model].filter(Boolean).join(' ');
  const used = stepsUsing(part, id);
  const specs = asset.key_specs.map((s) => [s.name, `${String(s.value)}${s.unit ? ` ${s.unit}` : ''}`]);

  return (
    <>
      <Heading
        eyebrow={CATEGORY_LABELS[thing.category] ?? thing.category}
        title={thing.name}
        onClose={closeItem}
        closeLabel={sheet === 'step' && step !== null ? 'Back to the step' : 'Close'}
      />
      <Typography sx={{ mt: 0.75, color: 'text.secondary', fontSize: '0.95rem' }}>
        {[makeModel, cat.zoneName(thing.zone), surface].filter(Boolean).join(' · ')}
      </Typography>
      {finePointer && (
        <Box sx={{ mt: 1.5, position: 'relative', aspectRatio: '4 / 3', borderRadius: 1.5, overflow: 'hidden', bgcolor: 'common.black' }}>
          <ModelView key={id} url={mediaUrl(asset.model)} onLoad={onLoad} onError={(e) => Sentry.captureException(toError(e, `Showcase: the model of ${id} failed to load`))} />
          <Typography sx={{ position: 'absolute', left: 10, bottom: 8, fontSize: '0.8rem', color: 'text.secondary', pointerEvents: 'none' }}>
            {shown === id ? 'Drag to turn · scroll to zoom' : 'Loading the model…'}
          </Typography>
        </Box>
      )}
      {used.length > 0 && (
        <Section title={`In ${part.name.split(' (')[0]}'s steps`}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {used.map((n) => (
              <Chip key={n} size="small" label={`Step ${n}`} onClick={() => openStepTracked(part, n - 1)} variant={sheet === 'step' && step === n - 1 ? 'filled' : 'outlined'} />
            ))}
          </Box>
        </Section>
      )}
      <Section title="About it">
        <Typography sx={{ lineHeight: 1.55 }}>{asset.description}</Typography>
      </Section>
      {specs.length > 0 && (
        <Section title="Key specs">
          <Facts rows={specs} />
        </Section>
      )}
      {thing.facts.length > 0 && (
        <Section title="In this shop">
          <Facts rows={thing.facts} />
        </Section>
      )}
    </>
  );
}
