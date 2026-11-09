'use client';

import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Popover from '@mui/material/Popover';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HourglassEmptyOutlinedIcon from '@mui/icons-material/HourglassEmptyOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { DISPLAY_FONT, EYEBROW_COLOR } from '@/components/marketing/marketingStyles';
import { gatherList, stepsUsing, type Catalog } from './catalog';
import { CategoryIcon, KindIcon, PartFacts, setupColour, shortName } from './glyphs';
import { PartMenu, PilotDialog, UPLOADS_OPEN, type PickSource } from './PartChoice';
import { useRealisticModel } from './realisticManifest';
import { reportLoadFailure } from './reportLoad';
import { finishedStill, mediaUrl, ready, type LivePart, type Use } from './showcaseData';
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

/** What a step or the plan uses, each with its kind's icon: a thing the shop has placed opens it, and the camera flies there. */
export function Uses({ cat, uses }: { cat: Catalog; uses: Use[] }) {
  const openItem = useShowcase((s) => s.openItem);
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
      {uses.map((u) => {
        const category = u.item ? cat.spots.get(u.item)?.[0].category : 'tools';
        const icon = <CategoryIcon category={category} sx={{ fontSize: 18 }} />;
        return u.item ? (
          <Chip
            key={u.item}
            icon={icon}
            label={u.name}
            variant="outlined"
            onClick={() => {
              openItem(u.item!);
              posthog.capture('showcase item opened', { item: u.item!, category: category ?? 'unknown', source: 'step' });
            }}
            sx={{ borderColor: 'secondary.main' }}
          />
        ) : (
          <Chip key={u.name} icon={icon} label={u.name} variant="outlined" />
        );
      })}
    </Box>
  );
}

/** Text the visitor asks for: folded until they open it, then open as they step on. */
function Details({ open, onToggle, children }: { open: boolean; onToggle(): void; children: ReactNode }) {
  return (
    <>
      <Button size="small" startIcon={<InfoOutlinedIcon />} endIcon={open ? <ExpandLessIcon /> : <ExpandMoreIcon />} onClick={onToggle} aria-expanded={open} sx={{ mt: 1.5 }}>
        Details
      </Button>
      <Collapse in={open}>{children}</Collapse>
    </>
  );
}

export function openStepTracked(part: LivePart, i: number) {
  useShowcase.getState().openStep(i);
  posthog.capture('showcase step opened', { part: part.id, step_number: i + 1, kind: part.steps[i].kind });
}

/** A setup's name after its colour, as the step card's eyebrow and the step list's headings show it. */
export function SetupLabel({ part, group }: { part: LivePart; group: string }) {
  const title = part.groups.find((g) => g.id === group)?.title ?? '';
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      <Box component="span" sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: setupColour(part, group), flexShrink: 0 }} />
      {title}
    </Box>
  );
}

/** Every step, grouped by setup in its colour, each with its kind's icon; the open one is marked. */
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
            <ListSubheader sx={{ bgcolor: SUBHEADER_BG, color: 'text.secondary', fontWeight: 600, lineHeight: 2.4 }}>
              <SetupLabel part={part} group={g.id} />
            </ListSubheader>
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
                sx={{ opacity: ready(s) ? 1 : 0.6 }}
              >
                <ListItemIcon sx={{ minWidth: 32, color: setupColour(part, g.id) }}>
                  <KindIcon kind={s.kind} sx={{ fontSize: 18 }} />
                </ListItemIcon>
                <ListItemText primary={`${i + 1}. ${s.title}`} />
                {!ready(s) && <HourglassEmptyOutlinedIcon aria-label={s.media.type === 'video' ? 'Video coming' : 'Picture coming'} sx={{ fontSize: 16, color: 'text.secondary', ml: 1 }} />}
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
  const label = sheet === 'step' && index !== null ? `Step ${index + 1} of ${part.steps.length}` : `All ${part.steps.length} steps`;  return (
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

/** The part's plan at a glance: start it, the stations in order, and what to gather under Details. */
export function NeedContent({ cat, part }: { cat: Catalog; part: LivePart }) {
  const openItem = useShowcase((s) => s.openItem);
  const look = useShowcase((s) => s.look);
  const [details, setDetails] = useState(false);
  const gather = gatherList(part, cat, (id) => cat.shop.surfaces[id] ?? id);
  // The stations in the order the steps reach them.
  const stations = [...new Map(part.steps.map((s) => [s.where.name, s.where])).values()].map((where) => ({
    where,
    count: part.steps.filter((s) => s.where.name === where.name).length,
  }));

  return (
    <>
      <Heading eyebrow={shortName(part)} title="What you'll need" />
      <Box sx={{ mt: 1.5 }}>
        <PartFacts part={part} />
      </Box>
      <Button variant="contained" size="large" fullWidth startIcon={<PlayArrowIcon />} onClick={() => openStepTracked(part, 0)} sx={{ mt: 2.5 }}>
        Start with step 1
      </Button>
      <Section title="Stations, in order">
        <List dense disablePadding>
          {stations.map((st) => (
            <ListItemButton
              key={st.where.name}
              onClick={() => (st.where.item ? openItem(st.where.item) : look({ kind: 'zone', where: st.where }))}
              sx={{ borderRadius: 1, px: 1 }}
            >
              <ListItemIcon sx={{ minWidth: 36, color: EYEBROW_COLOR }}>
                {st.where.item ? <CategoryIcon category={cat.spots.get(st.where.item)?.[0].category} /> : <PlaceOutlinedIcon />}
              </ListItemIcon>
              <ListItemText primary={st.where.name} slotProps={{ primary: { sx: { fontWeight: 600 } } }} />
              <Chip size="small" label={`${st.count} ${st.count === 1 ? 'step' : 'steps'}`} />
            </ListItemButton>
          ))}
        </List>
      </Section>
      <Details open={details} onToggle={() => setDetails((d) => !d)}>
        {gather.map((g) => (
          <Section key={g.place} title={g.place}>
            <Uses cat={cat} uses={g.uses} />
          </Section>
        ))}
      </Details>
    </>
  );
}

// --- a step -------------------------------------------------------------------------------------

/**
 * A step: its setup's colour and its kind's icon, its title, then its video (or the part after a
 * machine cycle) as large as the card. What it says, where and with what are under Details: the shop
 * already marks the station and the tools. A step shown as a still has what it says under the still.
 */
export function StepContent({ cat, part, index }: { cat: Catalog; part: LivePart; index: number }) {
  const step = part.steps[index];
  const openStep = useShowcase((s) => s.openStep);
  // Kept as the visitor steps on: this component stays mounted from step to step.
  const [details, setDetails] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [modelShown, setModelShown] = useState<string | null>(null);
  const reported = useRef(new Set<string>());
  const finePointer = useFinePointer();
  const what = step.media.type === 'video' ? 'video' : 'picture';
  // A step shown as a still has its caption under the picture, not under Details: the two are the step.
  const captioned = ready(step) && step.media.type === 'still';
  const report = (error: unknown) => {
    // Published media that won't load is a fault; unpublished media never gets here.
    if (reported.current.has(step.id)) return;
    if (reportLoadFailure(error, `Showcase: the ${what} for ${part.id} ${step.id} failed to load`)) reported.current.add(step.id);
  };
  const onModel = useCallback(() => setModelShown(step.id), [step.id]);

  return (
    <>
      <Heading
        eyebrow={
          <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <SetupLabel part={part} group={step.group} />
            <KindIcon kind={step.kind} sx={{ fontSize: 18, color: 'text.secondary' }} />
          </Box>
        }
        title={step.title}
      />
      <Box sx={{ mt: 1.5, position: 'relative', aspectRatio: '16 / 9', borderRadius: 1.5, overflow: 'hidden', bgcolor: 'common.black' }}>
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
        ) : step.media.type === 'still' ? (
          <Box
            component="img"
            key={step.id}
            src={mediaUrl(step.media.still)}
            alt={`This step as it starts: ${step.title}`}
            onError={() => {
              setFailed(step.id);
              report(new Error('still failed to load'));
            }}
            sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
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
      {captioned && (
        <Typography aria-live="polite" sx={{ mt: 1.5, fontSize: '1.05rem', lineHeight: 1.55 }}>
          {step.caption}
        </Typography>
      )}
      <Details open={details} onToggle={() => setDetails((d) => !d)}>
        {/* Side by side once the card is wide enough. */}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', columnGap: 3, alignItems: 'start' }}>
          {!captioned && (
            <Box sx={{ mt: 1.5 }} aria-live="polite">
              <Typography sx={{ fontSize: '1.05rem', lineHeight: 1.55 }}>{step.caption}</Typography>
            </Box>
          )}
          <Box>
            <Section title="Where">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography sx={{ flex: 1 }}>
                  {step.where.name}
                  {step.where.at === 'pendant' && ', at the control'}
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
          </Box>
        </Box>
      </Details>
    </>
  );
}

// --- the part made ------------------------------------------------------------------------------

/** Past the last step: the part as it leaves the shop, then the visitor's own part or another of ours. */
export function DoneContent({ part, parts, onPick }: { part: LivePart; parts: LivePart[]; onPick(id: string, source: PickSource): void }) {
  const [pilot, setPilot] = useState(false);
  const still = finishedStill(part);
  return (
    <>
      <Heading
        eyebrow={
          <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CheckCircleIcon sx={{ fontSize: 18, color: 'success.main' }} />
            {shortName(part)}
          </Box>
        }
        title="That's the part made"
      />
      {still && <Box component="img" src={still} alt={`${shortName(part)}, made`} sx={{ mt: 1.5, display: 'block', width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 1.5, bgcolor: 'common.black' }} />}
      <Box sx={{ mt: 1.5 }}>
        <PartFacts part={part} />
      </Box>
      <Button variant="contained" size="large" fullWidth startIcon={<UploadFileOutlinedIcon />} disabled={!UPLOADS_OPEN} onClick={() => setPilot(true)} sx={{ mt: 3 }}>
        {UPLOADS_OPEN ? 'Try it with your own part' : 'Upload your own part: coming soon'}
      </Button>
      <PartMenu
        parts={parts}
        current={part.id}
        onPick={onPick}
        source="finished"
        label="Try another part"
        buttonProps={{ variant: UPLOADS_OPEN ? 'outlined' : 'contained', size: 'large', fullWidth: true, sx: { mt: 1.5 } }}
      />
      {UPLOADS_OPEN && <PilotDialog open={pilot} onClose={() => setPilot(false)} />}
    </>
  );
}

// --- a thing ------------------------------------------------------------------------------------

/** A thing: its name, the thing itself to turn, and the steps it is in; where it is and its specs under Details. */
export function ItemContent({ cat, part, id }: { cat: Catalog; part: LivePart; id: string }) {
  const thing = cat.spots.get(id)?.[0];
  const step = useShowcase((s) => s.step);
  const sheet = useShowcase((s) => s.sheet);
  // Before a part is picked (a machine opened from the example shop's list), no part's steps apply.
  const picked = useShowcase((s) => s.phase) === 'plan';
  const finePointer = useFinePointer();
  const [shown, setShown] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const onLoad = useCallback(() => setShown(id), [id]);
  // Its realistic model where one is published, as the shop shows close up; undefined while asked.
  const full = useRealisticModel(thing?.asset, finePointer);
  const onFullError = useCallback((e: unknown) => void reportLoadFailure(e, `Showcase: the realistic model of ${id} failed to load in its card`), [id]);
  if (!thing) return null;
  const asset = cat.shop.assets[thing.asset];
  const surface = thing.on && cat.shop.surfaces[thing.on];
  const makeModel = [thing.make, thing.model].filter(Boolean).join(' ');
  const used = stepsUsing(part, id);
  const specs = asset.key_specs.map((s) => [s.name, `${String(s.value)}${s.unit ? ` ${s.unit}` : ''}`]);

  return (
    <>
      <Typography component="h2" sx={{ fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.35rem', lineHeight: 1.15 }}>
        {thing.name}
      </Typography>
      {finePointer && (
        <Box sx={{ mt: 1.5, position: 'relative', aspectRatio: '4 / 3', borderRadius: 1.5, overflow: 'hidden', bgcolor: 'common.black' }}>
          {full !== undefined && (
            <ModelView
              key={id}
              url={mediaUrl(asset.model)}
              full={full}
              onLoad={onLoad}
              onError={(e) => void reportLoadFailure(e, `Showcase: the model of ${id} failed to load`)}
              onFullError={onFullError}
            />
          )}
          <Typography sx={{ position: 'absolute', left: 10, bottom: 8, fontSize: '0.8rem', color: 'text.secondary', pointerEvents: 'none' }}>
            {shown === id ? 'Drag to turn · scroll to zoom' : 'Loading the model…'}
          </Typography>
        </Box>
      )}
      {picked && used.length > 0 && (
        <Section title={`In ${shortName(part)}'s steps`}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {used.map((n) => (
              <Chip
                key={n}
                size="small"
                icon={<KindIcon kind={part.steps[n - 1].kind} sx={{ fontSize: 16 }} />}
                label={`Step ${n}`}
                onClick={() => openStepTracked(part, n - 1)}
                variant={sheet === 'step' && step === n - 1 ? 'filled' : 'outlined'}
                sx={{ borderColor: setupColour(part, part.steps[n - 1].group) }}
              />
            ))}
          </Box>
        </Section>
      )}
      <Details open={details} onToggle={() => setDetails((d) => !d)}>
        <Typography sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 0.75, color: 'text.secondary', fontSize: '0.95rem' }}>
          <PlaceOutlinedIcon sx={{ fontSize: 18 }} />
          {[makeModel, cat.zoneName(thing.zone), surface].filter(Boolean).join(' · ')}
        </Typography>
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
      </Details>
    </>
  );
}
