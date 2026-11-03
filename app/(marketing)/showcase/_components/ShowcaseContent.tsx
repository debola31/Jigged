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
import type { LivePart, Showcase } from './showcaseData';

// three.js only loads in the browser, and only on this page.
const ShopView = dynamic(() => import('./ShopView'), {
  ssr: false,
  loading: () => <Box sx={{ aspectRatio: '4 / 3', borderRadius: 2, bgcolor: 'rgba(17, 20, 57, 0.55)' }} />,
});

/**
 * The showcase (plan §1 "Website"): the shop in 3D, a part picker, and a step player for the
 * picked part. Everything on it was made ahead of time; nothing a visitor does generates anything
 * or changes the simulation.
 */
export default function ShowcaseContent({ data }: { data: Showcase }) {
  const live = data.parts.filter((p): p is LivePart => p.status === 'live');
  const [partId, setPartId] = useState(live[0].id);
  const [index, setIndex] = useState(0);
  // How many steps the visitor has moved to: the shop flies and the video plays only after the first.
  const [moves, setMoves] = useState(0);
  const part = live.find((p) => p.id === partId) ?? live[0];
  const step = part.steps[index];

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
        <Typography sx={{ mt: 3, maxWidth: 760, color: 'rgba(255, 255, 255, 0.78)', fontSize: { xs: '1.05rem', md: '1.2rem' }, lineHeight: 1.6 }}>
          This is a mock-up of what Jigged would hand a machinist: a plan for each part, broken into steps, with a video
          of every step being done. We made all of it ahead of time, for {data.parts.length} real parts in one shop, so
          nothing here is generated when you click. Every motion in the videos is simulated on a model of the human
          arm and hand.
        </Typography>
      </Section>

      <Section size="minor">
        <SectionHeading index="01" eyebrow="Pick a part" heading="Start with the first part." subhead={`The other ${data.parts.length - live.length} follow as their videos are finished.`} />
        <Box sx={{ mt: 4 }}>
          <PartPicker
            parts={data.parts}
            selected={part.id}
            onSelect={(id) => {
              if (id === part.id) return;
              setPartId(id);
              setIndex(0);
            }}
          />
        </Box>
      </Section>

      <Section size="major" surface="raised">
        <SectionHeading
          index="02"
          eyebrow={part.name}
          heading={`${part.steps.length} steps, each one shown being done.`}
          subhead={`${part.size} · ${part.material} · ${[...new Set(part.steps.map((s) => s.where.name))].join(' → ')}`}
        />
        <Box sx={{ mt: { xs: 4, md: 6 }, display: 'grid', gap: { xs: 4, md: 5 }, gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '7fr 5fr' } }}>
          <StepPlayer part={part} index={index} autoPlay={moves > 0} onSelect={select} />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <ShopView shop={data.shop} where={step.where} fly={moves} />
            <StepList part={part} index={index} onSelect={select} />
          </Box>
        </Box>
      </Section>
    </>
  );
}
