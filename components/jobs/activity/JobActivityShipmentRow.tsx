'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';

import JobActivityRow from './JobActivityRow';
import type { JobActivityItem } from './jobActivityTimeline';

type ShipmentItem = Extract<JobActivityItem, { kind: 'shipment' }>;

function formatShipDate(iso: string): string {
  // A DATE column arrives as YYYY-MM-DD, which `new Date` reads as UTC midnight
  // and then prints back a day early west of Greenwich. Split it instead.
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** The local day of a timestamp, for comparing against a backdated ship date. */
function localDayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function meta(item: ShipmentItem): string {
  const parts = [item.packingSlipNumber];
  if (item.shippedBy) parts.push(item.shippedBy);
  // THE SHIP DATE ONLY WHEN IT DISAGREES with the day this was recorded. The
  // row sorts on created_at (ship_date is a DATE and would land at midnight),
  // so a slip written up on Friday for a Wednesday shipment would otherwise
  // read as having shipped Friday. Printing it is how the row stays honest;
  // printing it always would be noise on the normal case, where they match.
  if (item.shipDate && item.shipDate !== localDayOf(item.at)) {
    parts.push(`shipped ${formatShipDate(item.shipDate)}`);
  }
  if (item.voided) parts.push('voided');
  return parts.join(' · ');
}

/**
 * One packing slip sent to the customer.
 *
 * The slip number is the affordance, exactly as it is on a vendor movement:
 * pressing it opens the packing-slip preview — the SAME dialog the Shipments
 * menu opens, mounted once by the job page, so Void is offered here exactly as
 * it is there.
 *
 * This row briefly reached a second mount that omitted `onVoided`, which made
 * the slip un-voidable from the feed alone. "A feed is only for reading" was the
 * excuse, and it does not survive contact with this rail: notes carry edit and
 * delete, and a completion carries Undo. A document that behaves differently
 * depending on which control you used to reach it is a bug, not a policy.
 */
export default function JobActivityShipmentRow({
  item,
  onViewPackingSlip,
}: {
  item: ShipmentItem;
  onViewPackingSlip?: (shipmentId: string) => void;
}) {
  return (
    <JobActivityRow
      tone="document"
      struck={item.voided}
      at={item.at}
      title={`Shipped ${item.quantity} ${item.quantity === 1 ? 'pc' : 'pcs'}`}
      meta={meta(item)}
    >
      {onViewPackingSlip ? (
        <Box sx={{ mt: 0.5 }}>
          <Button
            size="small"
            onClick={() => onViewPackingSlip(item.shipmentId)}
            aria-label={`Open packing slip ${item.packingSlipNumber}`}
            sx={{ minHeight: 32, px: 1, py: 0.25, fontFamily: 'monospace', fontSize: '0.75rem' }}
          >
            {item.packingSlipNumber}
          </Button>
        </Box>
      ) : null}
    </JobActivityRow>
  );
}
