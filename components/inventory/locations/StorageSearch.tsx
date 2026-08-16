'use client';

/**
 * One box that finds a place OR a part. The page-level search on Storage.
 *
 * ## The dead end it closes
 *
 * Storage is place-first: you pick a cabinet, then a bin. That is the right default, and it left
 * one question unanswerable from the page — the one where you know the PART and not the place. The
 * only search on the screen filtered storage-unit NAMES, so typing a part number into it produced
 * *"Nothing matches"*: a dead end wearing the clothes of an answer, in the box a person would
 * obviously try first.
 *
 * **One box rather than two.** A separate `Find a part` beside `Find a place` would have fixed the
 * capability and kept the trap — the failure is not that part search is missing, it is that people
 * type a part into the box that is there. A box that answers whatever you type cannot be the wrong
 * box.
 *
 * ## Two kinds of answer, said apart
 *
 * Results are grouped, because a place and a part are different things to have found:
 *
 *   PLACES   Cabinet 3        → selects the unit
 *   PARTS    BUY-ORING-214    → opens a drawer listing every place it is
 *
 * **One row per part, not per place.** The first cut listed a row per (part, place) — the same
 * part repeated once per shelf, each carrying a path and a quantity — which answered the question
 * inside a menu. That made you choose a shelf before you had seen what the choices were, and put
 * the answer somewhere that vanishes the moment you look away. A dropdown is for picking a thing;
 * the thing here is the part. Where it lives is what you came to find out, so it goes on a surface
 * that stays: {@link PartPlacesDrawer}, the same kind of surface a place opens into.
 *
 * ## Where it sits, and why that matters
 *
 * In the page bar, above the list/detail split, with `Print all labels`. It is the one control on
 * this screen that acts on neither the list nor the selection, so it belongs to neither column —
 * the same reason `Add storage` moved down into the list's own header, where the thing it adds to
 * lives.
 */

import { useEffect, useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';

import { searchPartPlacements, type PartPlacement } from '@/utils/inventoryLocationsAccess';
import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { orderUnits } from '@/lib/locationGrid';

/** A hit: a unit to select, or a part to locate. */
export type StorageHit =
  | { kind: 'place'; id: string; label: string }
  | { kind: 'part'; id: string; label: string; unit: string | null };

export interface StorageSearchProps {
  companyId: string;
  /** Roots, for matching unit names without another read. */
  tree: InventoryLocationNode[];
  /** A place hit selects the unit; a part hit selects its unit and opens that place. */
  onPick: (hit: StorageHit) => void;
}

export default function StorageSearch({ companyId, tree, onPick }: StorageSearchProps) {
  const [text, setText] = useState('');
  const [placements, setPlacements] = useState<PartPlacement[]>([]);
  const [loading, setLoading] = useState(false);

  /*
   * Debounced, because every keystroke would otherwise query every stock row in the company. The
   * unit list is already in memory and is matched live below — only the part read waits.
   *
   * `setLoading` sits INSIDE the timeout rather than in the effect body, matching
   * `PartAutocomplete`: it keeps the spinner tied to the fetch rather than to the wait, and keeps
   * the effect off the set-state-in-effect rule.
   */
  useEffect(() => {
    const q = text.trim();
    let active = true;
    // EVERY setState below sits inside the callback, including the clear — a synchronous one in
    // the effect body is what the cascading-render rule is about.
    const timer = setTimeout(async () => {
      if (q.length < 2) {
        if (active) setPlacements([]);
        return;
      }
      setLoading(true);
      try {
        const rows = await searchPartPlacements(companyId, q);
        if (active) setPlacements(rows);
      } catch (e) {
        // A failed lookup is not worth a dialog over a search box; the empty state already says
        // nothing matched, and the console carries the reason.
        console.error('Storage search failed:', e);
        if (active) setPlacements([]);
      } finally {
        if (active) setLoading(false);
      }
      // Clearing needs no wait; only a real query does.
    }, text.trim().length < 2 ? 0 : 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [companyId, text]);

  const options: StorageHit[] = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];

    const places: StorageHit[] = orderUnits(tree)
      .filter((u) => u.name.toLowerCase().includes(q))
      .map((u) => ({ kind: 'place' as const, id: u.id, label: u.name }));

    /*
     * ONE ROW PER PART. The read returns one row per (part, place), because that is what stock is,
     * and several of those rows are the same part on different shelves. Collapsing them here also
     * makes the list immune to a duplicate row arriving from anywhere — the same part cannot appear
     * twice under a key that is its own id.
     */
    const seen = new Set<string>();
    const parts: StorageHit[] = [];
    for (const p of placements) {
      if (seen.has(p.partId)) continue;
      seen.add(p.partId);
      parts.push({ kind: 'part', id: p.partId, label: p.partName, unit: p.primaryUnit });
    }

    return [...places, ...parts];
  }, [text, tree, placements]);

  return (
    <Autocomplete
      options={options}
      loading={loading}
      // The field is a search, not a selection that sticks: picking navigates and the box clears.
      value={null}
      inputValue={text}
      onInputChange={(_, v, reason) => setText(reason === 'reset' ? '' : v)}
      onChange={(_, hit) => {
        if (!hit) return;
        onPick(hit);
        setText('');
      }}
      // Matching happens above — against unit names in memory and part names on the server. MUI's
      // own filter would then re-filter the server's results by their LABEL, hiding a part whose
      // match was on something the label does not show.
      filterOptions={(o) => o}
      groupBy={(o) => (o.kind === 'place' ? 'Locations' : 'Parts')}
      getOptionLabel={(o) => o.label}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      noOptionsText={
        text.trim().length < 2 ? 'Keep typing…' : `Nothing in storage matches “${text.trim()}”.`
      }
      renderOption={(props, o) => {
        const { key, ...rest } = props;
        return (
          <Box component="li" key={key} {...rest}>
            {/*
              A plain string child, not a stack of Typography.

              The option `li` carries MUI's own `display: flex`, so two block children laid
              themselves out side by side and rendered as `BUY-ORING-214Cabinet 3 › Shelf A` — one
              run-on line with no separator. Nothing on this row needs a second line any more: the
              part name IS the row, and where it lives is what the drawer is for.
            */}
            <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>
              {o.label}
            </Typography>
          </Box>
        );
      }}
      sx={{ width: { xs: '100%', sm: 380 } }}
      renderInput={(params) => (
        <TextField
          {...params}
          size="small"
          placeholder="Find a part or a location…"
          slotProps={{
            input: {
              ...params.InputProps,
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: (
                <>
                  {loading ? <CircularProgress size={16} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            },
          }}
        />
      )}
    />
  );
}
