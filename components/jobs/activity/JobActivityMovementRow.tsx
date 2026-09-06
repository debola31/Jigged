'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

import JobActivityRow from './JobActivityRow';
import type { JobActivityMovement } from './jobActivityTimeline';

/** The row's headline, per movement kind. Kept together so the wording stays parallel. */
function headline(m: JobActivityMovement): string {
  switch (m.kind) {
    case 'sent':
      return `Sent ${m.quantity} to ${m.vendorName}`;
    case 'received':
      return `Received ${m.quantityGood} from ${m.vendorName}`;
    case 'short_closed':
      // "Closed short" is the trade term the slip and the drawer already use;
      // it is NOT a void, and saying "cancelled" here would imply the send
      // never counted.
      return `Closed ${m.slipNumber} short`;
  }
}

function meta(m: JobActivityMovement): string {
  const step = m.operationName || 'Outside';
  if (m.kind === 'short_closed') {
    return `${step} · ${m.outstanding} not coming back`;
  }
  return `${step}${m.voided ? ' · voided' : ''}`;
}

/**
 * One movement of parts to or from a vendor.
 *
 * The slip number is the affordance, not a label: pressing it opens the same
 * preview dialog the step card used to offer, which is where voiding a slip
 * lives. That placement is unchanged — only the route to it moved.
 */
export default function JobActivityMovementRow({
  movement,
  onViewSlip,
}: {
  movement: JobActivityMovement;
  onViewSlip?: (shipmentId: string) => void;
}) {
  const voided = movement.kind !== 'short_closed' && movement.voided;

  return (
    <JobActivityRow
      tone={movement.kind === 'short_closed' ? 'muted' : 'vendor'}
      struck={voided}
      at={movement.at}
      title={headline(movement)}
      meta={meta(movement)}
    >
      {movement.kind === 'received' && movement.note ? (
        <Typography
          variant="body2"
          sx={{ mt: 0.5, color: 'text.secondary', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {movement.note}
        </Typography>
      ) : null}

      {onViewSlip ? (
        <Box sx={{ mt: 0.5 }}>
          <Button
            size="small"
            onClick={() => onViewSlip(movement.shipmentId)}
            aria-label={`Open vendor packing slip ${movement.slipNumber}`}
            sx={{ minHeight: 32, px: 1, py: 0.25, fontFamily: 'monospace', fontSize: '0.75rem' }}
          >
            {movement.slipNumber}
          </Button>
        </Box>
      ) : null}
    </JobActivityRow>
  );
}
