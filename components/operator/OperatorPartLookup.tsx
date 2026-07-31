'use client';

/**
 * "Is this part in storage, and where?" — for an operator, on a phone.
 *
 * ## Why this exists
 *
 * It is journey **J11**, and until now it had no tool at all on the operator side. The board let
 * you browse place by place, which only helps if you already know which place to open — and the
 * one screen that admitted it was hiding parts told you to *"scan or search a part"*, two routes
 * that did not exist. That copy is now honest, and this is the surface that makes it unnecessary.
 *
 * Nothing here needed a migration or a policy change: `parts`, `inventory_locations` and
 * `part_location_stock` all have membership-only SELECT policies with no role predicate, so an
 * operator could always read this. Only the UI was missing.
 *
 * ## Why the shared picker, not a bespoke search box
 *
 * The first version was a plain search field with its own debounce and result list, and it was
 * worse in a way that only shows on a real screen: type one character and **nothing happens** —
 * no spinner, no hint, no options — until enough characters land to clear a minimum-query floor.
 * The screen looked broken while it was working correctly.
 *
 * [`PartAutocomplete`](../parts/PartAutocomplete.tsx) is what quotes and jobs already use, so an
 * operator meets one control rather than two, and it solves the feedback problem structurally
 * rather than by adding another message: `openOnFocus` shows matches the moment the field is
 * tapped, before a key is pressed, and the fetch carries a spinner.
 *
 * **`onCreateNew` is deliberately omitted**, which removes the "Create New Part" row. Creating
 * parts is not an operator's job — same reasoning as the board withholding "Add storage".
 *
 * ## The distinction this screen must not blur
 *
 * A part with **no rows** in `part_location_stock` is one of two very different things:
 *
 * - **not location-tracked** — its stock is the single `parts.quantity`, and "where?" has no
 *   answer because nobody ever assigned it one. Saying "not in any place" would read as *missing*.
 * - **tracked, but empty everywhere** — genuinely nowhere, which is a real answer.
 *
 * `is_location_tracked` is what tells them apart, which is why `searchPartsForSelect` was widened
 * to return it.
 */

import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';

import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import { getBalancesForPart } from '@/utils/inventoryLocationsAccess';
import type { PartLocationBalanceWithLocation } from '@/types/inventoryLocations';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface OperatorPartLookupProps {
  companyId: string;
  /** Tapping a place navigates there — the whole point is to end up at the shelf. */
  onOpenLocation: (locationId: string) => void;
}

export default function OperatorPartLookup({ companyId, onOpenLocation }: OperatorPartLookupProps) {
  const [selected, setSelected] = useState<PartSelectOption | null>(null);
  const [balances, setBalances] = useState<PartLocationBalanceWithLocation[] | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (part: PartSelectOption | null) => {
    setSelected(part);
    setBalances(null);
    setError(null);
    if (!part) return;
    // An untracked part has no per-place rows by definition — asking would always return [] and
    // the empty state below would have to guess which kind of empty it was.
    if (!part.is_location_tracked) return;
    setLoadingBalances(true);
    getBalancesForPart(part.id)
      .then(setBalances)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not read where this is.'))
      .finally(() => setLoadingBalances(false));
  };

  const total = useMemo(
    () => (balances ?? []).reduce((n, b) => n + Number(b.quantity ?? 0), 0),
    [balances],
  );

  const places = balances ?? [];

  return (
    <Box sx={{ mb: 3 }}>
      <PartAutocomplete
        companyId={companyId}
        value={selected}
        onChange={pick}
        // Stocked only: an operator looking for material means something the shop holds. A made
        // top-level product has no on-hand and would only pad the list.
        kind="stocked"
        label="Find a part"
        // `medium`, not the shared default `small` — this is a phone in a workshop.
        size="medium"
      />

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}

      {selected && (
        <Box sx={{ mt: 2 }}>
          {!selected.is_location_tracked ? (
            /* NOT "nowhere". This part's stock simply isn't held per place, so the honest answer
               is the total and why there's no shelf — an empty list would imply it's missing. */
            <Alert severity="info">
              <strong>
                {num(selected.quantity)} {selected.primary_unit ?? ''}
              </strong>{' '}
              on hand. This part isn&apos;t tracked by place, so there&apos;s no shelf to send you
              to — ask the office if you need it binned.
            </Alert>
          ) : loadingBalances ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          ) : places.length === 0 ? (
            <Alert severity="warning">None in any place right now.</Alert>
          ) : (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                {num(total)} {selected.primary_unit ?? ''} across{' '}
                {places.length === 1 ? '1 place' : `${places.length} places`}
              </Typography>
              <Stack spacing={1}>
                {places.map((b) => (
                  <Card key={b.location_id} elevation={2}>
                    <CardActionArea
                      onClick={() => onOpenLocation(b.location_id)}
                      sx={{ minHeight: 56 }}
                    >
                      <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography sx={{ fontWeight: 600 }}>{b.location_name}</Typography>
                          {/* The full path, because "Left" means nothing without "Cabinet 1 › Row 3". */}
                          {b.path.length > 1 && (
                            <Typography variant="caption" color="text.secondary">
                              {b.path.join(' › ')}
                            </Typography>
                          )}
                        </Box>
                        <Chip
                          size="small"
                          label={`${num(b.quantity)} ${selected.primary_unit ?? ''}`.trim()}
                        />
                        <KeyboardArrowRightIcon color="action" />
                      </CardContent>
                    </CardActionArea>
                  </Card>
                ))}
              </Stack>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}
