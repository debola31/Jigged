'use client';

/**
 * "What happened in Cabinet 3 this week?" — for the owner, at a desk.
 *
 * ## Why this exists at all
 *
 * `getLocationHistory` and `getRecentActivity` shipped with the operator surface and had exactly
 * one caller each, both under `/operator`. So an operator with a phone could see a place's
 * movements and the person who pays for the software could not — they could only reach the ledger
 * one part at a time, from the part page. That is backwards for the one question an owner asks
 * about a shelf.
 *
 * ## Reuses `BinHistory` verbatim
 *
 * Not a desk-specific variant. The rows carry the same six facts either way, and a second
 * implementation would drift the first time one of them learned something — which is exactly what
 * happened between the operator's history and the owner's part ledger before
 * `resolveMovementAttribution` merged their lookups.
 *
 * The device argument that usually forces a split does not apply here: `BinHistory` is a card
 * list with 48px targets and generous type, which is *required* on a phone and merely roomy on a
 * monitor. Roomy is not a defect. What a desk would genuinely want — sorting, filters, a date
 * range, export — is a different component for a different job, and the part page's
 * `PartTransactionHistoryTable` already occupies that shape.
 *
 * ## Lazy, and collapsed by default
 *
 * The sheet opens on a tap and is mostly used for setup — rename, print, subdivide. Fetching a
 * ledger every time somebody opens it to print a label would be a read per tap for a panel nobody
 * looked at. Mounting only on expand also means the fetch is keyed to a deliberate act, and
 * `key={node.id}` on the caller's side keeps two different places from sharing one loaded state.
 */

import { useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import { useLoad } from '@/hooks/useLoad';
import { getLocationHistory } from '@/utils/inventoryLocationsAccess';
import BinHistory from '@/components/operator/BinHistory';

export interface PlaceHistoryProps {
  locationId: string;
  locationName: string;
}

export default function PlaceHistory({ locationId, locationName }: PlaceHistoryProps) {
  const [open, setOpen] = useState(false);

  return (
    <Accordion
      expanded={open}
      onChange={(_, isOpen) => setOpen(isOpen)}
      disableGutters
      elevation={0}
      sx={{ bgcolor: 'transparent', '&::before': { display: 'none' } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
        <Typography variant="overline" color="text.secondary">
          Recent activity
        </Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 0 }}>
        {/* Mounted only while expanded, so the read is the consequence of asking for it. */}
        {open && <PlaceHistoryBody locationId={locationId} locationName={locationName} />}
      </AccordionDetails>
    </Accordion>
  );
}

function PlaceHistoryBody({ locationId, locationName }: PlaceHistoryProps) {
  const { data, loading, error } = useLoad(() => getLocationHistory(locationId), [locationId]);

  return (
    <BinHistory
      entries={data}
      loading={loading}
      error={error ? (error instanceof Error ? error.message : 'Could not load this location’s history.') : null}
      // No place line and no tap-through: you are already looking at this one place, and the
      // sheet has nowhere further to go.
      emptyText={`Nothing has moved in ${locationName} yet.`}
    />
  );
}
