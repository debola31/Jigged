'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Section from '@/components/marketing/Section';
import SectionHeading from '@/components/marketing/SectionHeading';
import { DISPLAY_FONT, EYEBROW_COLOR, eyebrowSx } from '@/components/marketing/marketingStyles';
import PartPicker from './PartPicker';
import { StepList, StepPlayer } from './StepPlayer';
import { ready, type LivePart, type Showcase } from './showcaseData';

// three.js only loads in the browser, and only on this page.
const ShopView = dynamic(() => import('./ShopView'), {
  ssr: false,
  loading: () => <Box sx={{ aspectRatio: '4 / 3', borderRadius: 2, bgcolor: 'rgba(17, 20, 57, 0.55)' }} />,
});

/**
 * A part opens on its first step with a video to play, or else its first with anything to show,
 * rather than on a "coming" placeholder.
 */
function firstShown(part: LivePart): number {
  const video = part.steps.findIndex((s) => ready(s) && s.media.type === 'video');
  return video >= 0 ? video : Math.max(0, part.steps.findIndex(ready));
}

/**
 * The showcase (plan §1 "Website"): the shop in 3D, a part picker once more than one part is live,
 * and a step player for the picked part. Everything on it was made ahead of time; nothing a
 * visitor does generates anything or changes the simulation.
 */
export default function ShowcaseContent({ data }: { data: Showcase }) {
  const live = data.parts.filter((p): p is LivePart => p.status === 'live');
  const [partId, setPartId] = useState(live[0].id);
  const [index, setIndex] = useState(() => firstShown(live[0]));
  // How many steps the visitor has moved to: the shop flies and the video plays only after the first.
  const [moves, setMoves] = useState(0);
  const part = live.find((p) => p.id === partId) ?? live[0];
  const step = part.steps[index];
  // The part's stations in the order its steps visit them, for the shop walk.
  const route = [...new Map(part.steps.map((s) => [s.where.name, s.where])).values()];

  const select = (i: number) => {
    setIndex(i);
    setMoves((m) => m + 1);
    posthog.capture('showcase step opened', { part: part.id, step_number: i + 1, kind: part.steps[i].kind });
  };

  return (
    <>
      <Section grid sx={{ pt: { xs: 7, md: 10 } }} size="minor">
        <Typography component="span" sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
          Research preview
        </Typography>
        <Typography
          component="h1"
          sx={{
            mt: 2,
            fontFamily: DISPLAY_FONT,
            fontWeight: 600,
            fontSize: 'clamp(2.25rem, 5vw, 3.75rem)',
            lineHeight: 1.04,
            letterSpacing: '-0.03em',
            maxWidth: 900,
          }}
        >
          Work instructions you can watch, one step at a time.
        </Typography>
        <Typography sx={{ mt: 3, maxWidth: 680, color: 'rgba(255, 255, 255, 0.78)', fontSize: { xs: '1.05rem', md: '1.2rem' }, lineHeight: 1.6 }}>
          A mock-up of what Jigged would hand a machinist: a real part&apos;s plan, step by step, each step shown being
          done. Every motion is simulated on a model of the human hand.
        </Typography>
      </Section>

      {/* Only the parts that are on the page; a picker once there is more than one. */}
      {live.length > 1 && (
        <Section size="minor">
          <SectionHeading index="01" eyebrow="Pick a part" heading="Pick a part." />
          <Box sx={{ mt: 4 }}>
            <PartPicker
              parts={live}
              selected={part.id}
              onSelect={(id) => {
                if (id === part.id) return;
                const next = live.find((p) => p.id === id) ?? live[0];
                setPartId(id);
                setIndex(firstShown(next));
              }}
            />
          </Box>
        </Section>
      )}

      <Section size="major" surface="raised">
        <SectionHeading
          index={live.length > 1 ? '02' : '01'}
          eyebrow={part.name}
          heading={`${part.steps.length} steps, start to finish.`}
          subhead={`${part.size} · ${part.material} · ${[...new Set(part.steps.map((s) => s.where.name))].join(' → ')}`}
        />
        <Box sx={{ mt: { xs: 4, md: 6 }, display: 'grid', gap: { xs: 4, md: 5 }, gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '7fr 5fr' } }}>
          <StepPlayer part={part} index={index} autoPlay={moves > 0} onSelect={select} />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <ShopView shop={data.shop} where={step.where} route={route} fly={moves} />
            <StepList part={part} index={index} onSelect={select} />
          </Box>
        </Box>
      </Section>
    </>
  );
}
