'use client';

import { useEffect, useMemo, useRef } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { DISPLAY_FONT, EYEBROW_COLOR, eyebrowSx } from '@/components/marketing/marketingStyles';
import { CATEGORY_LABELS, matches, type Catalog } from './catalog';
import { ready, type LivePart, type Step } from './showcaseData';
import { useShowcase } from './store';

const SUBHEADER_BG = 'rgba(17, 20, 57, 0.98)';

function stepNote(s: Step): string | undefined {
  const coming = s.media.type === 'cut' ? 'Picture coming' : 'Video coming';
  const notes = [s.kind === 'cycle' && 'Machine cycle', !ready(s) && coming].filter(Boolean);
  return notes.length ? notes.join(' · ') : undefined;
}

/** The part's plan: what it is, what to gather, and every step grouped by setup. */
function PlanTab({ part }: { part: LivePart }) {
  const index = useShowcase((s) => s.step);
  const item = useShowcase((s) => s.item);
  const openStep = useShowcase((s) => s.openStep);
  const showPlan = useShowcase((s) => s.showPlan);
  const current = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Keep the open step in view inside the rail, without scrolling the page (which scrollIntoView
    // would). Measured against the rail's scroll box, since each group's List is its own offsetParent.
    const c = current.current;
    const box = c?.closest<HTMLElement>('[data-rail-scroll]');
    if (!c || !box) return;
    const top = c.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    if (top < box.scrollTop + 48 || top + c.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top - box.clientHeight / 3;
  }, [index]);

  const open = (i: number) => {
    openStep(i);
    posthog.capture('showcase step opened', { part: part.id, step_number: i + 1, kind: part.steps[i].kind });
  };

  return (
    <>
      <Box sx={{ px: 2.5, pt: 2.5, pb: 2 }}>
        <Typography component="span" sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
          Research preview
        </Typography>
        <Typography component="h1" sx={{ mt: 1, fontFamily: DISPLAY_FONT, fontWeight: 600, fontSize: '1.45rem', lineHeight: 1.15 }}>
          {part.name}
        </Typography>
        <Typography sx={{ mt: 1, color: 'text.secondary', fontSize: '0.95rem', lineHeight: 1.5 }}>
          {part.stock.material} · {part.stock.size} in · {part.steps.length} steps
        </Typography>
      </Box>
      <List disablePadding>
        <ListItemButton selected={index === null && item === null} onClick={showPlan} sx={{ px: 2.5 }}>
          <ListItemText primary="What you'll need" secondary="The stock, the stations and the tools" />
        </ListItemButton>
      </List>
      {part.groups.map((g) => (
        <List
          key={g.id}
          dense
          disablePadding
          subheader={
            <ListSubheader sx={{ bgcolor: SUBHEADER_BG, color: 'text.secondary', fontWeight: 600, lineHeight: 2.6, px: 2.5 }}>
              {g.title}
            </ListSubheader>
          }
        >
          {part.steps.map((s, i) =>
            s.group !== g.id ? null : (
              <ListItemButton
                key={s.id}
                ref={i === index ? current : undefined}
                selected={i === index}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => open(i)}
                sx={{ px: 2.5 }}
              >
                <ListItemText primary={`${i + 1}. ${s.title}`} secondary={stepNote(s)} slotProps={{ primary: { sx: { fontSize: '0.98rem' } } }} />
              </ListItemButton>
            ),
          )}
        </List>
      ))}
    </>
  );
}

/** Everything in the shop, searchable and filtered by kind, grouped by zone. */
function ShopTab({ cat }: { cat: Catalog }) {
  const category = useShowcase((s) => s.category);
  const query = useShowcase((s) => s.query);
  const selected = useShowcase((s) => s.item);
  const hovered = useShowcase((s) => s.hovered);
  const { setCategory, setQuery, openItem, hover } = useShowcase.getState();
  const counts = useMemo(() => new Map(cat.shop.categories.map((c) => [c, cat.things.filter((t) => t.category === c).length])), [cat]);
  const shown = cat.things.filter((t) => (category === 'all' || t.category === category) && matches(t, query, cat.zoneName(t.zone)));
  const zones = cat.shop.zones.filter((z) => shown.some((t) => t.zone === z.id));

  return (
    <>
      <Box sx={{ px: 2.5, pt: 2.5, pb: 1.5 }}>
        <TextField
          type="search"
          size="small"
          fullWidth
          placeholder="Search machines, tools, gauges…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          slotProps={{ htmlInput: { 'aria-label': 'Search the shop' } }}
        />
        <Box role="group" aria-label="Kind of thing" sx={{ mt: 1.5, display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          <Chip label={`All ${cat.things.length}`} size="small" color={category === 'all' ? 'primary' : 'default'} onClick={() => setCategory('all')} />
          {cat.shop.categories.map((c) => (
            <Chip
              key={c}
              label={`${CATEGORY_LABELS[c] ?? c} ${counts.get(c) ?? 0}`}
              size="small"
              color={category === c ? 'primary' : 'default'}
              onClick={() => setCategory(c)}
            />
          ))}
        </Box>
      </Box>
      {zones.map((z) => (
        <List
          key={z.id}
          dense
          disablePadding
          subheader={
            <ListSubheader sx={{ bgcolor: SUBHEADER_BG, color: 'text.secondary', fontWeight: 600, lineHeight: 2.6, px: 2.5 }}>
              {z.name}
            </ListSubheader>
          }
        >
          {shown
            .filter((t) => t.zone === z.id)
            .map((t) => (
              <ListItemButton
                key={t.item}
                selected={selected === t.item}
                onClick={() => {
                  openItem(t.item);
                  posthog.capture('showcase item opened', { category: t.category, source: 'list' });
                }}
                onMouseEnter={() => hover(t.item)}
                onMouseLeave={() => hover(null)}
                sx={{ px: 2.5, ...(hovered === t.item && selected !== t.item && { bgcolor: 'action.hover' }) }}
              >
                <ListItemText primary={t.name} secondary={CATEGORY_LABELS[t.category] ?? t.category} />
              </ListItemButton>
            ))}
        </List>
      ))}
      {shown.length === 0 && <Typography sx={{ px: 2.5, py: 2, color: 'text.secondary' }}>Nothing matches “{query}”.</Typography>}
    </>
  );
}

/** The left rail: the part's plan, or the shop's things. */
export default function Rail({ cat, part }: { cat: Catalog; part: LivePart }) {
  const tab = useShowcase((s) => s.tab);
  const setTab = useShowcase((s) => s.setTab);
  return (
    <Box
      component="nav"
      aria-label="The plan and the shop"
      sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: '1px solid rgba(255, 255, 255, 0.09)', bgcolor: 'rgba(17, 20, 57, 0.55)' }}
    >
      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="fullWidth" sx={{ borderBottom: '1px solid rgba(255, 255, 255, 0.09)', flexShrink: 0 }}>
        <Tab value="plan" label="The plan" />
        <Tab value="shop" label="The shop" />
      </Tabs>
      {/* A dark scrollbar, not the browser's light one. */}
      <Box data-rail-scroll sx={{ flex: 1, minHeight: 0, overflowY: 'auto', colorScheme: 'dark' }}>
        {tab === 'plan' ? <PlanTab part={part} /> : <ShopTab cat={cat} />}
      </Box>
    </Box>
  );
}
