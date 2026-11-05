'use client';

import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import { DISPLAY_FONT, EYEBROW_COLOR } from '@/components/marketing/marketingStyles';
import { toError } from '@/lib/supabaseErrors';
import { CATEGORY_LABELS, gatherList, stepsUsing, type Catalog } from './catalog';
import PilotRequest from './PilotRequest';
import { mediaUrl, ready, type LivePart, type Use } from './showcaseData';
import { useShowcase } from './store';

// three.js comes with it, so it loads only where a model is shown: on a desktop.
const ModelView = dynamic(() => import('./ModelView'), { ssr: false });

const FINE_POINTER = '(hover: hover) and (pointer: fine)';

function subscribeFinePointer(change: () => void) {
  const query = window.matchMedia(FINE_POINTER);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
}

/** A mouse, so a model can be turned without taking the panel's scroll from a finger. */
function useFinePointer(): boolean {
  return useSyncExternalStore(subscribeFinePointer, () => window.matchMedia(FINE_POINTER).matches, () => false);
}

const statusSx = { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 3, textAlign: 'center', color: 'text.secondary' } as const;

function Heading({ eyebrow, title, onClose, closeLabel }: { eyebrow: string; title: string; onClose?(): void; closeLabel?: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ color: EYEBROW_COLOR, fontWeight: 600, fontSize: '0.9rem', letterSpacing: '0.04em' }}>{eyebrow}</Typography>
        <Typography component="h2" sx={{ mt: 0.75, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.6rem', lineHeight: 1.15 }}>
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box component="section" sx={{ mt: 3 }}>
      <Typography component="h3" sx={{ color: 'text.secondary', fontWeight: 600, fontSize: '0.8rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
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
function Uses({ cat, uses }: { cat: Catalog; uses: Use[] }) {
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

// --- the plan -----------------------------------------------------------------------------------

function PlanPanel({ cat, part }: { cat: Catalog; part: LivePart }) {
  const openStep = useShowcase((s) => s.openStep);
  const openItem = useShowcase((s) => s.openItem);
  const gather = gatherList(part, cat, (id) => cat.shop.surfaces[id] ?? id);
  // The stations in the order the steps reach them, each with the first step done there.
  const stations = [...new Map(part.steps.map((s, i) => [s.where.name, { where: s.where, first: i }])).values()].map((st) => ({
    ...st,
    count: part.steps.filter((s) => s.where.name === st.where.name).length,
  }));

  return (
    <>
      <Heading eyebrow="Before you start" title="What you'll need" />
      <Section title="Stock">
        <Typography sx={{ fontSize: '1.05rem', lineHeight: 1.5 }}>
          {part.stock.material}, {part.stock.size} in: a {part.stock.from}.
        </Typography>
      </Section>
      <Section title="Stations">
        {stations.map((st, n) => (
          <Box key={st.where.name} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.75 }}>
            <Typography sx={{ color: 'text.secondary', width: '1.5em' }}>{n + 1}</Typography>
            <Box sx={{ flex: 1 }}>
              <Typography sx={{ fontWeight: 600 }}>{st.where.name}</Typography>
              <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem' }}>
                {st.count} {st.count === 1 ? 'step' : 'steps'}
              </Typography>
            </Box>
            <Button size="small" onClick={() => (st.where.item ? openItem(st.where.item) : openStep(st.first))}>
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
      <Button variant="contained" size="large" fullWidth onClick={() => openStep(0)} sx={{ mt: 4 }}>
        Start with step 1
      </Button>
      <PilotRequest sx={{ mt: 4 }} />
    </>
  );
}

// --- a step -------------------------------------------------------------------------------------

function StepPanel({ cat, part, index }: { cat: Catalog; part: LivePart; index: number }) {
  const step = part.steps[index];
  const group = part.groups.find((g) => g.id === step.group);
  const openStep = useShowcase((s) => s.openStep);
  const showPlan = useShowcase((s) => s.showPlan);
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
  const go = (i: number) => {
    openStep(i);
    posthog.capture('showcase step opened', { part: part.id, step_number: i + 1, kind: part.steps[i].kind });
  };
  const onModel = useCallback(() => setModelShown(step.id), [step.id]);

  return (
    <>
      <Heading eyebrow={`Step ${index + 1} of ${part.steps.length}${group ? ` · ${group.title}` : ''}`} title={step.title} onClose={showPlan} closeLabel="Back to the plan" />
      <Box sx={{ mt: 2, position: 'relative', aspectRatio: '16 / 9', borderRadius: 2, overflow: 'hidden', bgcolor: 'common.black' }}>
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
              <Typography sx={{ position: 'absolute', left: 12, bottom: 10, fontSize: '0.85rem', color: 'text.secondary', pointerEvents: 'none' }}>
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
      <Box sx={{ mt: 2 }} aria-live="polite">
        {step.kind === 'cycle' && <Chip label="Machine cycle" size="small" variant="outlined" sx={{ mb: 1 }} />}
        <Typography sx={{ fontSize: '1.1rem', lineHeight: 1.6 }}>{step.caption}</Typography>
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
      <Box sx={{ mt: 4, display: 'flex', gap: 1.5 }}>
        <Button variant="outlined" disabled={index === 0} onClick={() => go(index - 1)} sx={{ flex: 1 }}>
          Previous step
        </Button>
        <Button variant="contained" disabled={index === part.steps.length - 1} onClick={() => go(index + 1)} sx={{ flex: 1 }}>
          Next step
        </Button>
      </Box>
    </>
  );
}

// --- a thing ------------------------------------------------------------------------------------

function ItemPanel({ cat, part, id }: { cat: Catalog; part: LivePart; id: string }) {
  const thing = cat.spots.get(id)?.[0];
  const closeItem = useShowcase((s) => s.closeItem);
  const step = useShowcase((s) => s.step);
  const openStep = useShowcase((s) => s.openStep);
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
        closeLabel={step === null ? 'Back to the plan' : 'Back to the step'}
      />
      <Typography sx={{ mt: 1, color: 'text.secondary' }}>
        {[makeModel, cat.zoneName(thing.zone), surface].filter(Boolean).join(' · ')}
      </Typography>
      {finePointer && (
        <Box sx={{ mt: 2, position: 'relative', aspectRatio: '4 / 3', borderRadius: 2, overflow: 'hidden', bgcolor: 'common.black' }}>
          <ModelView key={id} url={mediaUrl(asset.model)} onLoad={onLoad} onError={(e) => Sentry.captureException(toError(e, `Showcase: the model of ${id} failed to load`))} />
          <Typography sx={{ position: 'absolute', left: 12, bottom: 10, fontSize: '0.85rem', color: 'text.secondary', pointerEvents: 'none' }}>
            {shown === id ? 'Drag to turn · scroll to zoom' : 'Loading the model…'}
          </Typography>
        </Box>
      )}
      {used.length > 0 && (
        <Section title={`In this part's plan`}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {used.map((n) => (
              <Chip key={n} label={`Step ${n}`} onClick={() => openStep(n - 1)} variant={step === n - 1 ? 'filled' : 'outlined'} />
            ))}
          </Box>
        </Section>
      )}
      <Section title="About it">
        <Typography sx={{ lineHeight: 1.6 }}>{asset.description}</Typography>
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

/** The right panel: a thing when one is open, else the open step, else the plan's "what you'll need". */
export default function Panel({ cat, part }: { cat: Catalog; part: LivePart }) {
  const item = useShowcase((s) => s.item);
  const step = useShowcase((s) => s.step);
  return (
    <Box
      component="aside"
      aria-label={item ? 'The thing' : step === null ? 'The plan' : 'The step'}
      sx={{ minHeight: 0, overflowY: 'auto', colorScheme: 'dark', p: 2.5, borderLeft: '1px solid rgba(255, 255, 255, 0.09)', bgcolor: 'rgba(17, 20, 57, 0.55)' }}
    >
      {item ? <ItemPanel cat={cat} part={part} id={item} /> : step === null ? <PlanPanel cat={cat} part={part} /> : <StepPanel cat={cat} part={part} index={step} />}
    </Box>
  );
}
