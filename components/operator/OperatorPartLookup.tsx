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

import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ClearIcon from '@mui/icons-material/Close';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import SearchIcon from '@mui/icons-material/Search';

import { searchPartsForSelect, type PartSelectOption } from '@/utils/partsAccess';
import { getBalancesForPart } from '@/utils/inventoryLocationsAccess';
import type { PartLocationBalanceWithLocation } from '@/types/inventoryLocations';

/** Long enough that a typing operator isn't firing a query per keystroke on shop wifi. */
const DEBOUNCE_MS = 300;
/** Below this a search matches most of the catalogue and tells you nothing. */
const MIN_QUERY = 2;

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface OperatorPartLookupProps {
  companyId: string;
  /** Tapping a place navigates there — the whole point is to end up at the shelf. */
  onOpenLocation: (locationId: string) => void;
}

export default function OperatorPartLookup({ companyId, onOpenLocation }: OperatorPartLookupProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<PartSelectOption[]>([]);
  /** The query whose search has come back. Compared against `debounced` to derive the spinner. */
  const [answered, setAnswered] = useState('');
  const [selected, setSelected] = useState<PartSelectOption | null>(null);
  const [balances, setBalances] = useState<PartLocationBalanceWithLocation[] | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const active = debounced.length >= MIN_QUERY;

  /**
   * Request-id guard, not just a cancelled flag: two searches in flight can resolve out of order
   * and the slower, older one would overwrite the newer results with stale matches.
   */
  const reqId = useRef(0);
  useEffect(() => {
    // Every setState below happens inside the async callback, never synchronously in the effect
    // body — the shape `hooks/useLoad.ts` documents, and what `react-hooks/set-state-in-effect`
    // is guarding. "Searching" and "no results yet" are DERIVED (see `searching` / `visible`)
    // rather than written here, which is what makes the early return state-free.
    if (!active) return;
    const id = ++reqId.current;
    // 'stocked' — an operator looking for material means something the shop holds. A made
    // top-level product has no on-hand and would only pad the list.
    searchPartsForSelect(companyId, debounced, 'stocked', 25)
      .then((rows) => {
        if (id !== reqId.current) return;
        setResults(rows);
        setError(null);
      })
      .catch((e) => {
        if (id !== reqId.current) return;
        setResults([]);
        setError(e instanceof Error ? e.message : 'Could not search parts.');
      })
      .finally(() => {
        // Marks THIS query answered, which is what ends the derived spinner. Set even on failure,
        // or an error would spin forever.
        if (id === reqId.current) setAnswered(debounced);
      });
  }, [companyId, debounced, active]);

  /** Derived, so the effect never writes it: this query is in flight until it has been answered. */
  const searching = active && answered !== debounced;
  /** Stale matches from a previous query must not show under a query too short to have run. */
  const visible = active && !searching ? results : [];

  const openPart = (part: PartSelectOption) => {
    setSelected(part);
    setBalances(null);
    // An untracked part has no per-place rows by definition — asking would always return [] and
    // the empty state below would have to guess which kind of empty it was.
    if (!part.is_location_tracked) return;
    setLoadingBalances(true);
    getBalancesForPart(part.id)
      .then(setBalances)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not read where this is.'))
      .finally(() => setLoadingBalances(false));
  };

  const reset = () => {
    setQuery('');
    setSelected(null);
    setBalances(null);
    setError(null);
  };

  const total = useMemo(
    () => (balances ?? []).reduce((n, b) => n + Number(b.quantity ?? 0), 0),
    [balances],
  );

  return (
    <Box sx={{ mb: 3 }}>
      <TextField
        fullWidth
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(null);
        }}
        placeholder="Find a part…"
        // `htmlInput`, not a top-level `aria-label`: MUI puts top-level props on the FormControl
        // wrapper, so the <input> itself would have no accessible name — a placeholder is not one.
        slotProps={{ htmlInput: { 'aria-label': 'Find a part' } }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon color="action" />
            </InputAdornment>
          ),
          endAdornment: query ? (
            <InputAdornment position="end">
              <IconButton aria-label="Clear search" onClick={reset} edge="end" size="small">
                <ClearIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ) : null,
        }}
        sx={{ '& .MuiInputBase-root': { minHeight: 52 } }}
      />

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}

      {/* A selected part replaces the result list — on a phone, showing both means neither fits. */}
      {selected ? (
        <Box sx={{ mt: 2 }}>
          <Typography sx={{ fontWeight: 700 }}>{selected.part_name}</Typography>
          {selected.description && (
            <Typography variant="body2" color="text.secondary">
              {selected.description}
            </Typography>
          )}

          {!selected.is_location_tracked ? (
            /* NOT "nowhere". This part's stock simply isn't held per place, so the honest answer
               is the total and where it isn't recorded — not an empty list implying it's missing. */
            <Alert severity="info" sx={{ mt: 1.5 }}>
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
          ) : (balances ?? []).length === 0 ? (
            <Alert severity="warning" sx={{ mt: 1.5 }}>
              None in any place right now.
            </Alert>
          ) : (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, mb: 0.5 }}>
                {num(total)} {selected.primary_unit ?? ''} across{' '}
                {(balances ?? []).length === 1 ? '1 place' : `${(balances ?? []).length} places`}
              </Typography>
              <Stack spacing={1}>
                {(balances ?? []).map((b) => (
                  <Card key={b.location_id} elevation={2}>
                    <CardActionArea
                      onClick={() => onOpenLocation(b.location_id)}
                      sx={{ minHeight: 56 }}
                    >
                      <CardContent
                        sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}
                      >
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
      ) : (
        <>
          {searching && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size={22} />
            </Box>
          )}
          {!searching && active && visible.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              No stocked part matches “{debounced}”.
            </Typography>
          )}
          {visible.length > 0 && (
            <Stack spacing={1} sx={{ mt: 1.5 }}>
              {visible.map((p) => (
                <Card key={p.id} elevation={2}>
                  <CardActionArea onClick={() => openPart(p)} sx={{ minHeight: 56 }}>
                    <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 600 }} noWrap>
                          {p.part_name}
                        </Typography>
                        {p.description && (
                          <Typography variant="caption" color="text.secondary" noWrap
                            sx={{ display: 'block' }}
                          >
                            {p.description}
                          </Typography>
                        )}
                      </Box>
                      <KeyboardArrowRightIcon color="action" />
                    </CardContent>
                  </CardActionArea>
                </Card>
              ))}
            </Stack>
          )}
        </>
      )}
    </Box>
  );
}
