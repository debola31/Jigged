'use client';

/**
 * What has happened in this place lately.
 *
 * Until now there was **no operator-side ledger view at all** — the movements existed in
 * `inventory_transactions` and could only be read from the admin part page. That is what made a
 * photo on a put-away write-only: worth taking, impossible to look at. This is the surface that
 * makes taking one worth the tap.
 *
 * It also answers a question the docs had listed as having no surface: *"who took the last one?"*
 *
 * ## Deliberately not a full ledger
 *
 * The most recent handful, newest first, with no paging and no filters. An operator standing at a
 * shelf wants to know what just happened here, not to audit the quarter — and the admin part page
 * already owns the auditable view. A "load more" here would be a second, worse version of it.
 *
 * ## An unattributed movement says so
 *
 * `operator_id` is only populated going forward; `created_by` holds an `auth.users` id the browser
 * cannot read. Older rows therefore have no author, and they render without one rather than
 * inventing "Unknown" — the absence is honest and self-explaining once you know that anything
 * recent does have a name.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { LocationHistoryEntry } from '@/types/inventoryLocations';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/** "3 Aug, 14:20" — a shelf's history is recent, so the year is noise. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Direction is carried by the sign AND the colour, never colour alone — the shop floor is bright
 * and some of these operators are 50–60. `adjustment` is neither in nor out, so it gets no sign.
 */
function movement(e: LocationHistoryEntry): { label: string; color: string } {
  if (e.type === 'addition') return { label: `+${num(e.quantity)} ${e.unit}`, color: 'success.light' };
  if (e.type === 'depletion') return { label: `−${num(e.quantity)} ${e.unit}`, color: 'warning.light' };
  return { label: `set to ${num(e.quantity)} ${e.unit}`, color: 'text.secondary' };
}

export interface BinHistoryProps {
  entries: LocationHistoryEntry[] | null;
  loading: boolean;
  error?: string | null;
}

export default function BinHistory({ entries, loading, error }: BinHistoryProps) {
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
        <CircularProgress size={22} />
      </Box>
    );
  }
  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }
  if (!entries || entries.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Nothing recorded here yet.
      </Typography>
    );
  }

  return (
    <Stack component="ul" spacing={1} sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {entries.map((e) => {
        const m = movement(e);
        return (
          <Card component="li" key={e.id} elevation={2}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Stack direction="row" spacing={1} alignItems="flex-start">
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap">
                    <Typography sx={{ fontWeight: 700, color: m.color }}>{m.label}</Typography>
                    <Typography sx={{ fontWeight: 600 }} noWrap>
                      {e.itemName}
                    </Typography>
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {when(e.createdAt)}
                    {/* No author on older rows — see the note at the top of this file. */}
                    {e.actorName ? ` · ${e.actorName}` : ''}
                  </Typography>
                  {e.notes && (
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      {e.notes}
                    </Typography>
                  )}
                  {e.hasDiscrepancy && (
                    <Chip
                      size="small"
                      color="warning"
                      variant="outlined"
                      label="Shortfall recorded"
                      sx={{ mt: 0.5 }}
                    />
                  )}
                </Box>
                {e.photoUrl && (
                  <Box
                    component="img"
                    src={e.photoUrl}
                    alt={`Photo taken when ${e.itemName} was moved`}
                    sx={{
                      width: 64,
                      height: 64,
                      flexShrink: 0,
                      borderRadius: 1,
                      // `contain`, as everywhere else photos appear: a cropped thumbnail of a shelf
                      // can hide the very thing the photo was taken to show.
                      objectFit: 'contain',
                      bgcolor: 'action.hover',
                      border: 1,
                      borderColor: 'divider',
                    }}
                  />
                )}
              </Stack>
            </CardContent>
          </Card>
        );
      })}
    </Stack>
  );
}
