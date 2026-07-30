'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import type { MachineDetails } from '@/types/machineMaintenance';

/**
 * Make, model, serial, year, purchase date — when somebody has bothered to type
 * them in.
 *
 * WHEN THEY ARE ALL EMPTY THIS RENDERS NOTHING AT ALL. Not an empty state, not
 * an "add machine details" prompt, not a progress meter, not a hint. Asset data
 * entry is a leading cause of CMMS abandonment: the tool arrives, the shop is
 * asked to describe its equipment before it can do anything, and the project
 * dies in the describing. The enforceable form of §4.5 is that no surface may
 * render one machine as less ready than another because somebody typed a serial
 * number into it — which means a machine with nothing filled in has to look
 * finished, because it IS finished.
 *
 * Read-only on the floor. Editing lives on the work-center page in the office,
 * where somebody with a spec sheet in front of them is doing paperwork on
 * purpose.
 */

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

export default function MachineDetailsCard({ details }: { details: MachineDetails | null }) {
  if (!details) return null;

  const rows: Array<[string, string]> = [];
  if (details.make) rows.push(['Make', details.make]);
  if (details.model) rows.push(['Model', details.model]);
  if (details.serial_number) rows.push(['Serial', details.serial_number]);
  if (details.year_built) rows.push(['Year', String(details.year_built)]);
  const purchased = formatDate(details.purchased_on);
  if (purchased) rows.push(['Purchased', purchased]);

  if (rows.length === 0) return null;

  return (
    <Card elevation={2} sx={{ ...cardSx, mb: 2 }}>
      <CardContent sx={{ py: 1.5 }}>
        {rows.map(([label, value]) => (
          <Box key={label} sx={{ display: 'flex', gap: 2, py: 0.25 }}>
            <Typography variant="body2" color="text.secondary" sx={{ minWidth: 84 }}>
              {label}
            </Typography>
            <Typography variant="body2">{value}</Typography>
          </Box>
        ))}
      </CardContent>
    </Card>
  );
}
