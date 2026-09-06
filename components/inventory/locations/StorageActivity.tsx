'use client';

/**
 * What has moved anywhere in storage lately — the office half of the shop floor's feed.
 *
 * ## Why it exists (2026-09-04)
 *
 * The two Storage surfaces had drifted into different capabilities under different names. The
 * shop floor's home IS this feed; the office's home is a grid of furniture, and the same question
 * — *what changed while I was not looking?* — could only be answered by leaving for
 * `/activity`, a mixed feed of jobs, quotes and notes where stock is one filter among six. Same
 * job, two homes, and one of them a detour.
 *
 * ## Collapsed, and read only when opened
 *
 * `PlaceHistory` on a single bin set the pattern and the reason holds harder here: the office
 * lands on this page to find a place, not to read history, so the request is the consequence of
 * asking for it rather than a cost every visit pays.
 *
 * ## Reuses `BinHistory`, like the bin-level one does
 *
 * Same rows, same folding of a transfer pair into one line, same "who did it". `showPlace` is on,
 * because a shop-wide feed whose rows do not say where they happened is a list of quantities. A
 * row's tap-through selects the unit that place belongs to and opens it, which is the office's
 * equivalent of the operator's navigate — and the one thing this feed does that the grid cannot:
 * reach a bin you can name but not find.
 */

import { useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import { useLoad } from '@/hooks/useLoad';
import { getRecentActivity } from '@/utils/inventoryLocationsAccess';
import BinHistory from '@/components/operator/BinHistory';

export interface StorageActivityProps {
  companyId: string;
  /** Walk to the place a row happened in: select its unit and open it. */
  onOpenPlace: (locationId: string) => void;
}

export default function StorageActivity({ companyId, onOpenPlace }: StorageActivityProps) {
  const [open, setOpen] = useState(false);

  return (
    <Accordion
      expanded={open}
      onChange={(_, isOpen) => setOpen(isOpen)}
      disableGutters
      elevation={0}
      sx={{ bgcolor: 'transparent', '&::before': { display: 'none' }, mt: 2 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
        <Typography variant="overline" color="text.secondary">
          Recent movements
        </Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 0 }}>
        {open && <StorageActivityBody companyId={companyId} onOpenPlace={onOpenPlace} />}
      </AccordionDetails>
    </Accordion>
  );
}

function StorageActivityBody({ companyId, onOpenPlace }: StorageActivityProps) {
  const { data, loading, error } = useLoad(() => getRecentActivity(companyId), [companyId]);

  return (
    <BinHistory
      entries={data}
      loading={loading}
      error={
        error
          ? error instanceof Error
            ? error.message
            : 'Could not load recent movements.'
          : null
      }
      showPlace
      onOpenLocation={onOpenPlace}
      emptyText="Nothing has moved in storage yet."
    />
  );
}
