'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Section from './Section';
import SectionHeading from './SectionHeading';
import Reveal from './Reveal';
import RequestQuoteOutlinedIcon from '@mui/icons-material/RequestQuoteOutlined';
import WorkOutlineIcon from '@mui/icons-material/WorkOutline';
import PhoneIphoneIcon from '@mui/icons-material/PhoneIphone';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined';
import { CAPABILITIES } from '@/lib/constants/marketing';
import type { Capability } from '@/lib/constants/marketing';
import { DISPLAY_FONT, EYEBROW_COLOR } from './marketingStyles';

/**
 * The compression that makes this page possible.
 *
 * The old Features section gave three capabilities a full screen each — about 717px per
 * feature. Carrying the real product that way would have added ~8,600px. This carries
 * twenty feature names for roughly the height of one of those old rows.
 *
 * THE RULE IS: hide depth, never breadth. The word "mill certs" has to be readable
 * without a click; the paragraph explaining mill certs does not. So every cell states a
 * claim, explains it in one sentence, and then LISTS what is in it — the list is the
 * point, and nothing here is behind an interaction.
 *
 * LAYOUT. `display: grid` with the cells authored in reading order and the mosaic done
 * with column spans only — never `order`, never a rearranging `gridArea`. Those detach
 * the visual order from the DOM order, which breaks tab sequence and fails WCAG 2.1
 * SC 1.3.2. Five cells into a 6-column track: three across, then two wide ones.
 *
 * NO IMAGERY, deliberately. This is a breadth audit, not a demo; a screenshot in here
 * would cost more height than the cell it illustrates and the two showcase sections
 * below already carry the proof.
 */
/** Keyed by `Capability.icon` — keep this map in step with the union in marketing.ts. */
const ICONS: Record<Capability['icon'], typeof WorkOutlineIcon> = {
  quote: RequestQuoteOutlinedIcon,
  job: WorkOutlineIcon,
  phone: PhoneIphoneIcon,
  shelf: WarehouseOutlinedIcon,
  books: AccountBalanceOutlinedIcon,
};

export default function Capabilities() {
  return (
    <Section id="features" surface="raised" maxWidth="lg" grid>
      <Reveal distance={28}>
        <SectionHeading
          index="What you get"
          heading="Everything the shop needs. None of the enterprise weight."
          subhead="One system from the customer’s purchase order to the packing slip — and one price for all of it."
        />
      </Reveal>

      <Box
        sx={{
          mt: { xs: 4, md: 6 },
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(6, 1fr)' },
          gap: { xs: 1.5, md: 2.5 },
        }}
      >
        {CAPABILITIES.map((cell, i) => {
          const Icon = ICONS[cell.icon];
          return (
          <Reveal
            key={cell.key}
            delay={i * 70}
            distance={24}
            sx={{
              // First three cells take two of six columns; the last two take three each,
              // so the bottom row reads as a wider pair rather than an orphan.
              gridColumn: { md: i < 3 ? 'span 2' : 'span 3' },
              // A lone third cell in a 2-up layout spans the full width at sm.
              ...(i === CAPABILITIES.length - 1 ? { gridColumn: { sm: 'span 2', md: 'span 3' } } : {}),
            }}
          >
            <Box
              component="section"
              sx={{
                height: '100%',
                p: { xs: 2.5, md: 3.5 },
                borderRadius: 2,
                bgcolor: 'rgba(17, 20, 57, 0.42)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.75, mb: 2 }}>
                <Box
                  aria-hidden
                  sx={{
                    flexShrink: 0,
                    width: 40,
                    height: 40,
                    borderRadius: 1.5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'rgba(127, 179, 224, 0.1)',
                    border: '1px solid rgba(127, 179, 224, 0.24)',
                  }}
                >
                  <Icon sx={{ fontSize: 22, color: EYEBROW_COLOR }} />
                </Box>
                <Typography
                  component="h3"
                  sx={{
                    fontFamily: DISPLAY_FONT,
                    fontWeight: 600,
                    fontSize: { xs: '1.18rem', md: '1.35rem' },
                    lineHeight: 1.2,
                    letterSpacing: '-0.02em',
                    mt: 0.5,
                  }}
                >
                  {cell.heading}
                </Typography>
              </Box>

              {/* Same list, two paints. As chips from sm up; below that the chip chrome
                  is dropped and the items flow as one dot-separated line.
                  MEASURED: at 390px four chips wrap to four rows, and five cells of that
                  cost ~300px of pure padding. The words are the point, not the boxes —
                  and the DOM is identical either way, so nothing is duplicated or hidden
                  from a screen reader. */}
              <Box
                component="ul"
                sx={{
                  listStyle: 'none',
                  p: 0,
                  m: 0,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: { xs: 0, sm: 0.75 },
                  rowGap: { xs: 0.25, sm: 0.75 },
                }}
              >
                {cell.items.map((item, n) => (
                  <Typography
                    component="li"
                    key={item}
                    sx={{
                      px: { xs: 0, sm: 1.25 },
                      py: { xs: 0, sm: 0.5 },
                      borderRadius: { sm: 1 },
                      bgcolor: { xs: 'transparent', sm: 'rgba(127, 179, 224, 0.09)' },
                      border: { xs: 'none', sm: '1px solid rgba(127, 179, 224, 0.22)' },
                      color: EYEBROW_COLOR,
                      fontSize: { xs: '0.92rem', sm: '0.85rem' },
                      fontWeight: 500,
                      lineHeight: 1.45,
                      '&::after': {
                        content: n < cell.items.length - 1 ? '" \u00b7 "' : '""',
                        display: { xs: 'inline', sm: 'none' },
                        color: 'rgba(127, 179, 224, 0.45)',
                      },
                    }}
                  >
                    {item}
                  </Typography>
                ))}
              </Box>
            </Box>
          </Reveal>
          );
        })}
      </Box>
    </Section>
  );
}
